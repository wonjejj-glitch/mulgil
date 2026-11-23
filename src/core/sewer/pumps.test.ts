import { describe, expect, it } from 'vitest';
import { runSwmm } from '../swmm/swmmRunner';
import { designSewer, WET_WELL_FREEBOARD } from './design';
import { sewerProjectFromSwmm } from './fromSwmmInp';
import { generateExportInp, generateInp } from './inp';
import { scaledSewerProject, summarizeFactor } from './peakSweep';
import { pumpCurve, pumpDuties } from './pumps';
import { parseReport, summarizeSimulation } from './report';
import { buildNetwork } from './topology';
import { demoProject, type SewerProject } from './types';
import { parseSewerProject } from './validate';

/** 예제 관망에서 MH6 → MH8 이 오르막이 되게 하고, 그 구간을 중계펌프장(습정 MH6 → 토출 MH8)으로 바꾼다. */
function liftProject(): SewerProject {
  const p = demoProject();
  const mh8 = p.nodes.find((n) => n.id === 'MH8')!;
  mh8.ground = 104.5;
  mh8.invert = 102.7;
  const of1 = p.nodes.find((n) => n.id === 'OF1')!;
  of1.ground = 104;
  of1.invert = 101.6;
  p.conduits = p.conduits.filter((c) => !(c.upstream === 'MH6' && c.downstream === 'MH8'));
  p.pumps = [{ id: 'PS1', wet_well: 'MH6', discharge: 'MH8', capacity: null, head: null, on_depth: 1.2, off_depth: 0.4, area: null }];
  return parseSewerProject(JSON.parse(JSON.stringify(p)));
}

describe('중계펌프장', () => {
  it('습정은 하류 관거 없이 펌프로만 빠지고, 다른 맨홀은 여전히 하류 관거가 하나여야 한다', () => {
    const p = liftProject();
    const g = buildNetwork(p);
    expect(g.pumps.get('MH6')?.discharge).toBe('MH8');
    expect(g.order.indexOf('MH6')).toBeLessThan(g.order.indexOf('MH8'));
    // 습정에 관거를 하나 더 달면 오류
    const bad = JSON.parse(JSON.stringify(p)) as SewerProject;
    bad.conduits.push({ ...bad.conduits[0], id: 'PX', upstream: 'MH6', downstream: 'MH8' });
    expect(() => buildNetwork(bad)).toThrow(/습정/);
    // 정지 수심이 가동 수심보다 높으면 검증 오류
    expect(() => parseSewerProject({ ...p, pumps: [{ ...p.pumps![0], off_depth: 2 }] })).toThrow(/정지 수심/);
  });

  it('자동 설계: 습정 바닥을 유입관보다 (가동 수심 + 여유) 낮추고, 토출 맨홀부터 다시 얕게 시작한다', () => {
    const design = designSewer(liftProject(), {}, 'practical');
    const node = new Map(design.project.nodes.map((n) => [n.id, n]));
    const into = design.project.conduits.filter((c) => c.downstream === 'MH6');
    expect(into.length).toBe(2);
    for (const c of into) {
      const pipeInvert = node.get('MH6')!.invert + c.outlet_offset;
      expect(pipeInvert - node.get('MH6')!.invert).toBeGreaterThanOrEqual(1.2 + WET_WELL_FREEBOARD - 1e-9);
    }
    // 토출 맨홀은 최소 토피로 다시 시작 (상류 깊이를 물려받지 않음)
    const mh8 = node.get('MH8')!;
    expect(mh8.ground - mh8.invert).toBeLessThan(2);
    const duty = pumpDuties(design.project)[0];
    expect(duty.auto).toEqual({ capacity: true, head: true, area: true });
    expect(duty.staticLift).toBeGreaterThan(2);
    expect(duty.head).toBeCloseTo(duty.staticLift + 2, 1);
    expect(duty.capacity).toBeGreaterThan(0.1);
  });

  it('펌프 곡선은 설계점(용량·양정)을 지나고 양정이 오를수록 유량이 준다', () => {
    const pts = pumpCurve(0.2, 10);
    const at = pts.find(([h]) => Math.abs(h - 10) < 1e-9)!;
    expect(at[1]).toBeCloseTo(0.2, 6);
    pts.forEach(([, q], i) => i > 0 && expect(q).toBeLessThan(pts[i - 1][1]));
    expect(pts[pts.length - 1][1]).toBeCloseTo(0, 6);
  });

  it('SWMM: 습정은 STORAGE, 펌프는 TYPE3 곡선으로 해석되고 습정이 넘치지 않는다', async () => {
    const design = designSewer(liftProject(), {}, 'practical');
    const inp = generateInp(design.project);
    expect(inp).toMatch(/\[STORAGE\]\nMH6 /);
    expect(inp).toMatch(/\[PUMPS\]\nPS1 MH6 MH8 PS1_CURVE ON 1\.2/);
    expect(inp).toMatch(/PS1_CURVE Pump3 /);
    expect(inp.split('[JUNCTIONS]')[1].split('\n\n')[0]).not.toMatch(/\nMH6 /);
    const { report } = await runSwmm(inp);
    const sim = summarizeSimulation(design.project, parseReport(report, design.project));
    const pump = sim.pump_summary!.PS1;
    expect(pump.utilized).toBeGreaterThan(0);
    expect(pump.max_flow).toBeGreaterThan(0.05);
    expect(sim.node_summary.MH6.flood_hours).toBe(0);
    // 펌프가 올린 물이 토출 맨홀 아래 관거로 흐른다
    const below = design.project.conduits.find((c) => c.upstream === 'MH8')!;
    expect(sim.link_summary[below.id].max_flow).toBeGreaterThan(0.05);
    expect(Math.abs(sim.continuity['Flow Routing Continuity'])).toBeLessThan(5);
  }, 60000);

  it('펌프가 없는 관망의 SWMM 입력은 예전과 같다 (STORAGE·PUMPS 블록 없음)', () => {
    const inp = generateInp(designSewer(demoProject()).project);
    expect(inp).not.toMatch(/\[STORAGE\]|\[PUMPS\]|\[CURVES\]/);
    expect('pumps' in parseSewerProject(JSON.parse(JSON.stringify(demoProject())))).toBe(false);
  });

  it('내보낸 inp 를 다시 열면 펌프장 설정(자동 값 포함)이 되살아난다', () => {
    const design = designSewer(liftProject(), {}, 'practical');
    const back = sewerProjectFromSwmm(generateExportInp(design.project));
    expect(back.project.pumps).toEqual(design.project.pumps);
    expect(back.valid).toBe(true);
  });
});

describe('첨두계수(오수량 배율) 비교', () => {
  it('배율을 키우면 오수 유입이 그만큼 늘고 관거 수심비가 커진다, 강우를 빼면 유역이 없다', async () => {
    const design = designSewer(liftProject(), {}, 'practical');
    const rows = [];
    for (const f of [1, 20]) {
      const p = scaledSewerProject(design.project, f, false);
      expect(p.catchments).toEqual([]);
      const { report } = await runSwmm(generateInp(p));
      rows.push(summarizeFactor(p, f, summarizeSimulation(p, parseReport(report, p))));
    }
    expect(rows[1].sewage / rows[0].sewage).toBeCloseTo(20, 6);
    expect(rows[1].maxDepthRatio).toBeGreaterThan(rows[0].maxDepthRatio);
    expect(rows[0].pumpUtilization).not.toBeNull();
    expect(rows[1].pumpUtilization!).toBeGreaterThan(rows[0].pumpUtilization!);
  }, 60000);
});
