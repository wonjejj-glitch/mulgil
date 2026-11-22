import { describe, expect, it } from 'vitest';
import sampleInp from '../../../public/samples/sample-district.inp?raw';
import { parseInp } from '../io/inpParser';
import { writeInp } from '../io/inpWriter';
import { runHydraulics } from './epanetRunner';
import { checkCriteria, defaultCriteria } from './criteria';
import { applyPressureFixes, DEFAULT_PRESSURE_FIX, proposePressureFixes, zoneOutcomes } from './pressureFix';
import { toSimulationResults, type SimulationResults } from './simulationManager';
import type { NetworkModel } from '../model/types';

async function solve(model: NetworkModel): Promise<SimulationResults> {
  return toSimulationResults(await runHydraulics(writeInp(model, { forEngine: true })), 0);
}

/** 수요 절점의 전 시간 최고·최저 수압 */
function extremes(model: NetworkModel, r: SimulationResults): { hi: number; lo: number; overMax: (m: number) => number; underMin: (m: number) => number } {
  const N = r.nodeIds.length;
  const per: { hi: number; lo: number }[] = [];
  for (const n of Object.values(model.nodes)) {
    if (n.type !== 'junction' || n.id.startsWith('PRV_') || n.id.startsWith('BP_')) continue;
    const ix = r.nodeIndex.get(n.id)!;
    let hi = -Infinity, lo = Infinity;
    for (let s = 0; s < r.stepCount; s++) {
      const p = r.node.pressure[s * N + ix];
      hi = Math.max(hi, p);
      lo = Math.min(lo, p);
    }
    per.push({ hi, lo });
  }
  return {
    hi: Math.max(...per.map((p) => p.hi)),
    lo: Math.min(...per.map((p) => p.lo)),
    overMax: (m) => per.filter((p) => p.hi > m).length,
    underMin: (m) => per.filter((p) => p.lo < m).length,
  };
}

describe('감압·가압 후보 제안', () => {
  it('고수압 구역에 감압밸브를 두면 다시 해석했을 때 최고 수압이 기준 안으로 내려온다', async () => {
    const model = parseInp(sampleInp).model;
    const before = await solve(model);
    const b = extremes(model, before);
    // 샘플의 최고 수압보다 낮은 기준을 주어 일부러 고수압 구역을 만든다
    const maxPressure = Math.floor(b.hi) - 8;
    const o = { ...DEFAULT_PRESSURE_FIX, minPressure: 10, maxPressure, minZoneNodes: 2 };
    const r = proposePressureFixes(model, before, o);
    expect(r.highNodes).toBe(b.overMax(maxPressure));
    const prv = r.candidates.filter((c) => c.kind === 'prv');
    expect(prv.length).toBeGreaterThan(0);
    for (const c of prv) {
      expect(c.prvSetting!).toBeGreaterThan(0);
      expect(c.zoneNodeIds).toContain(c.zoneNodeId);
      expect(model.links[c.entryPipeId]).toBeDefined();
    }
    const after = structuredClone(model);
    const s = applyPressureFixes(after, prv);
    expect(s.prv).toBe(prv.length);
    expect(Object.values(after.links).filter((l) => l.type === 'valve' && l.valveType === 'PRV').length).toBeGreaterThanOrEqual(prv.length);
    const res = await solve(after);
    const a = extremes(after, res);
    expect(a.overMax(maxPressure)).toBeLessThan(b.overMax(maxPressure));
    // 구역별 확인: 구역은 전에는 기준을 넘었고, 추천 후보의 구역은 적용 뒤 기준 안
    const outcomes = zoneOutcomes(prv, before, res, { minPressure: 10, maxPressure });
    expect(outcomes).toHaveLength(prv.length);
    for (const z of outcomes) expect(z.before).toBeGreaterThan(maxPressure);
    for (const z of outcomes.filter((_, i) => prv[i].recommended)) {
      expect(z.ok).toBe(true);
      expect(z.after).toBeLessThanOrEqual(maxPressure + 0.05);
    }
    // 원래 관로 연장은 그대로
    for (const c of prv) expect((after.links[c.entryPipeId] as { length: number }).length).toBeCloseTo((model.links[c.entryPipeId] as { length: number }).length, 6);
  });

  it('저수압 구역에는 가압펌프(양정·유량·동력)를 제안하고, 적용하면 최저 수압이 올라간다', async () => {
    const model = parseInp(sampleInp).model;
    const before = await solve(model);
    const b = extremes(model, before);
    const minPressure = Math.ceil(b.lo) + 6;
    const o = { ...DEFAULT_PRESSURE_FIX, minPressure, maxPressure: 999, minZoneNodes: 1 };
    const r = proposePressureFixes(model, before, o);
    const bp = r.candidates.filter((c) => c.kind === 'booster');
    expect(bp.length).toBeGreaterThan(0);
    for (const c of bp) {
      expect(c.pumpHead!).toBeGreaterThan(0);
      expect(c.designFlow).toBeGreaterThan(0);
      expect(c.pumpPowerKw!).toBeGreaterThan(0);
    }
    const after = structuredClone(model);
    applyPressureFixes(after, bp);
    expect(Object.values(after.links).some((l) => l.type === 'pump' && l.headCurve.endsWith('_H'))).toBe(true);
    const res = await solve(after);
    expect(extremes(after, res).lo).toBeGreaterThan(b.lo);
  });

  it('기본 기준으로 가압 후보를 적용하면 설계기준 검토에도 펌프 자리 절점(BP_)이 남지 않는다', async () => {
    const model = parseInp(sampleInp).model;
    const c = defaultCriteria(model);
    const before = await solve(model);
    const lowBefore = checkCriteria(model, before, c).filter((h) => h.kind === 'lowPressure').length;
    const r = proposePressureFixes(model, before, { ...DEFAULT_PRESSURE_FIX, minPressure: c.minPressure, maxPressure: c.maxPressure });
    const chosen = r.candidates.filter((x) => x.recommended);
    if (chosen.length === 0) return; // 샘플이 바뀌어 후보가 없으면 건너뛴다
    const after = structuredClone(model);
    const s = applyPressureFixes(after, chosen);
    const res = await solve(after);
    const hits = checkCriteria(after, res, c);
    expect(hits.some((h) => s.nodes.includes(h.id))).toBe(false);
    expect(hits.filter((h) => h.kind === 'lowPressure').length).toBeLessThanOrEqual(lowBefore);
  });
});

