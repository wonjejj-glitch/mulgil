import { describe, expect, it } from 'vitest';
import sampleInp from '../../../public/samples/sample-district.inp?raw';
import { parseInp } from '../io/inpParser';
import { writeInp } from '../io/inpWriter';
import { checkCriteria, defaultCriteria, waterBalance } from './criteria';
import { runHydraulics } from './epanetRunner';
import { toSimulationResults } from './simulationManager';

describe('design criteria and water balance', async () => {
  const { model } = parseInp(sampleInp);
  const r = toSimulationResults(await runHydraulics(writeInp(model, { forEngine: true })), 0);

  it('flags nothing with loose limits and everything with impossible ones', () => {
    expect(checkCriteria(model, r, { minPressure: -1e9, maxPressure: 1e9, minVelocity: 0, maxVelocity: 1e9 })).toHaveLength(0);
    const tight = checkCriteria(model, r, { minPressure: 1e9, maxPressure: -1e9, minVelocity: 1e9, maxVelocity: -1 });
    const junctions = Object.values(model.nodes).filter((n) => n.type === 'junction').length;
    const pipes = Object.values(model.links).filter((l) => l.type === 'pipe').length;
    expect(tight.filter((h) => h.kind === 'lowPressure')).toHaveLength(junctions);
    expect(tight.filter((h) => h.kind === 'highPressure')).toHaveLength(junctions);
    expect(tight.filter((h) => h.kind === 'lowVelocity')).toHaveLength(pipes);
    expect(tight.filter((h) => h.kind === 'highVelocity')).toHaveLength(pipes);
  });

  it('reports the true minimum pressure of a flagged node', () => {
    const c = defaultCriteria(model);
    for (const h of checkCriteria(model, r, c).filter((x) => x.kind === 'lowPressure')) {
      const i = r.nodeIndex.get(h.id)!;
      const series = r.times.map((_, t) => r.node.pressure[t * r.nodeIds.length + i]);
      expect(h.value).toBeCloseTo(Math.min(...series), 6);
      expect(h.value).toBeLessThan(c.minPressure);
    }
  });

  it('balances supply and demand per source', () => {
    const b = waterBalance(model, r);
    expect(b.sources.length).toBeGreaterThan(0);
    // 배수지 저류 변화가 있어도 평균 공급 ≈ 평균 수요 (저류 변화만큼 차이)
    expect(Math.abs(b.totalSupply - b.totalDemand) / b.totalDemand).toBeLessThan(0.2);
    expect(b.sources.reduce((s, x) => s + x.zoneDemand, 0)).toBeLessThanOrEqual(b.totalDemand + 1e-6);
  });
});
