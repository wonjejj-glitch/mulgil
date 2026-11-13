import { describe, expect, it } from 'vitest';
import sampleInp from '../../../public/samples/sample-sewer.inp?raw';
import { linkValue, nodeValue, subValue } from './outReader';
import { runSwmm, SwmmRunError } from './swmmRunner';

describe('runSwmm (SWMM WASM)', () => {
  it('샘플 우수관망을 해석하고 .out 결과를 읽는다', async () => {
    const { output: out, engineVersion, report } = await runSwmm(sampleInp);
    expect(engineVersion).toContain('5.2');
    expect(report).toContain('Flow Routing Continuity');
    expect(out.nodeIds).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'O1']);
    expect(out.linkIds).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
    expect(out.subcatchIds).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(out.flowUnits).toBe('CMS');
    expect(out.reportStepSec).toBe(300);
    expect(out.periods).toBe(36); // 3시간 / 5분 (SWMM 은 시작 후 첫 보고 간격부터 기록한다)
    expect(out.days[1] - out.days[0]).toBeCloseTo(300 / 86400, 6);
    // 입력 속성: 방류구 유형 1, 관거 유형 0
    expect(out.nodeTypes[out.nodeIds.indexOf('O1')]).toBe(1);
    expect(out.linkTypes.every((t) => t === 0)).toBe(true);
    expect(out.nodeInvert[0]).toBeCloseTo(30, 3);

    // 강우 → 유출 → 관거 유량: 모든 값이 유한하고 비가 그친 뒤 감소한다
    expect(out.node.every((v) => Number.isFinite(v))).toBe(true);
    const s1 = out.subcatchIds.indexOf('S1');
    let peakRunoff = 0;
    for (let t = 0; t < out.periods; t++) peakRunoff = Math.max(peakRunoff, subValue(out, 'runoff', t, s1));
    expect(peakRunoff).toBeGreaterThan(0.01);
    const c6 = out.linkIds.indexOf('C6');
    const flows = Array.from({ length: out.periods }, (_, t) => linkValue(out, 'flow', t, c6));
    const peak = Math.max(...flows);
    expect(peak).toBeGreaterThan(0.05);
    expect(flows[out.periods - 1]).toBeLessThan(peak * 0.5);
    // 최하류 방류구의 총 유입은 마지막 관거 유량과 같다
    const o1 = out.nodeIds.indexOf('O1');
    const tPeak = flows.indexOf(peak);
    expect(nodeValue(out, 'totalInflow', tPeak, o1)).toBeCloseTo(peak, 2);
  });

  it('입력 오류는 보고서의 오류 문구와 함께 실패한다', async () => {
    const broken = sampleInp.replace('[CONDUITS]', '[CONDUITS]\nBAD J1');
    await expect(runSwmm(broken)).rejects.toBeInstanceOf(SwmmRunError);
    await runSwmm(broken).catch((error: SwmmRunError) => {
      expect(error.code).toBeGreaterThan(0);
      expect(error.message).toMatch(/ERROR \d+/);
    });
  });
});
