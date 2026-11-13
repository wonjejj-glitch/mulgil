import { describe, expect, it } from 'vitest';
import sampleInp from '../../../public/samples/sample-district.inp?raw';
import { parseInp } from '../io/inpParser';
import { writeInp } from '../io/inpWriter';
import { runHydraulics, type RawSimulationResult } from './epanetRunner';
import { toSimulationResults } from './simulationManager';
import { computeSupplyZones, nodeContributions } from './supplyZones';

/** 유량만 지정한 가짜 결과. */
function fakeResults(nodeIds: string[], linkIds: string[], flows: number[]): RawSimulationResult {
  const zeros = (n: number) => new Float32Array(n);
  return {
    times: [0],
    nodeIds,
    linkIds,
    pressure: zeros(nodeIds.length),
    head: zeros(nodeIds.length),
    demand: zeros(nodeIds.length),
    flow: Float32Array.from(flows),
    velocity: zeros(linkIds.length),
    headloss: zeros(linkIds.length),
    unitHeadloss: zeros(linkIds.length),
    nodeQuality: zeros(0),
    linkQuality: zeros(0),
    quality: null,
    warnings: [],
    engineVersion: 'test',
  };
}

describe('computeSupplyZones', () => {
  it('두 수원의 유량 비율로 하류 절점의 기여율을 섞는다', () => {
    const { model } = parseInp(
      [
        '[JUNCTIONS]', ' A 0 0', ' B 0 0', ' C 0 0',
        '[RESERVOIRS]', ' R1 50',
        '[TANKS]', ' T1 40 3 0 5 10 0',
        '[PIPES]',
        ' P1 R1 A 100 150 110 0 Open',
        ' P2 A T1 100 150 110 0 Open', // T1 → A 로 흐름 (음수 유량)
        ' P3 A B 100 150 110 0 Open',
        ' P4 C B 100 150 110 0 Open', // 흐름 없음 → C 는 공급 없음
        '[COORDINATES]', ' A 127 37', ' B 127.001 37', ' C 127.002 37', ' R1 126.999 37', ' T1 127 37.001',
        '[END]',
      ].join('\n'),
    );
    const results = toSimulationResults(fakeResults(['A', 'B', 'C', 'R1', 'T1'], ['P1', 'P2', 'P3', 'P4'], [10, -5, 15, 0]), 0);
    const zones = computeSupplyZones(model, results, 0);
    expect(zones.sources).toEqual(['R1', 'T1']);
    const b = results.nodeIndex.get('B')!;
    expect(nodeContributions(zones, b)).toEqual([
      { sourceId: 'R1', fraction: expect.closeTo(2 / 3, 5) },
      { sourceId: 'T1', fraction: expect.closeTo(1 / 3, 5) },
    ]);
    expect(zones.dominant[b]).toBe(0);
    expect(zones.dominant[results.nodeIndex.get('C')!]).toBe(-1);
    expect(zones.unresolved).toBe(0);
  });

  it('샘플 관망: 공급되는 모든 절점의 기여율 합은 1', async () => {
    const { model } = parseInp(sampleInp);
    const results = toSimulationResults(await runHydraulics(writeInp(model, { forEngine: true })), 0);
    for (const step of [3, 8, 19]) {
      const zones = computeSupplyZones(model, results, step);
      const S = zones.sources.length;
      for (let i = 0; i < results.nodeIds.length; i++) {
        if (zones.dominant[i] < 0) continue;
        let sum = 0;
        for (let k = 0; k < S; k++) sum += zones.fractions[i * S + k];
        expect(sum).toBeCloseTo(1, 4);
      }
      // 수원지에 바로 붙은 J15 는 R1 물만 받는다
      expect(nodeContributions(zones, results.nodeIndex.get('J15')!)[0].sourceId).toBe('R1');
    }
  });
});
