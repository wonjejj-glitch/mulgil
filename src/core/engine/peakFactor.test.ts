import { describe, expect, it } from 'vitest';
import sample from '../../../public/samples/sample-district.inp?raw';
import { parseInp } from '../io/inpParser';
import { writeInp } from '../io/inpWriter';
import { defaultCriteria } from './criteria';
import { runHydraulics } from './epanetRunner';
import { demandMultiplier, modelWithFactor, parseFactors, pressureInsensitive, summarizeScenario, withDemandMultiplier } from './peakFactor';
import { toSimulationResults } from './simulationManager';

describe('시간최대계수(수요 배율)', () => {
  it('OPTIONS 원문에서 읽고 바꾼다', () => {
    expect(demandMultiplier([])).toBe(1);
    expect(demandMultiplier(['Pattern 1', 'DEMAND MULTIPLIER 1.5'])).toBe(1.5);
    const next = withDemandMultiplier(['Pattern 1', 'Demand Multiplier 1.2'], 1.8);
    expect(next).toEqual(['Pattern 1', 'Demand Multiplier 1.8']);
    expect(withDemandMultiplier(next, 1)).toEqual(['Pattern 1']);
  });
  it('계수 목록 입력을 정리한다', () => {
    expect(parseFactors('2, 1.5 1.5; abc -1 1.0')).toEqual([1, 1.5, 2]);
  });
});

describe('시간최대계수 비교 해석', () => {
  it('계수를 키우면 총 수요가 그 배율로 늘고 최저 수압은 내려간다', async () => {
    const model = parseInp(sample).model;
    const c = defaultCriteria(model);
    const rows = [];
    for (const f of [1, 2]) {
      const r = toSimulationResults(await runHydraulics(writeInp(modelWithFactor(model, f), { forEngine: true })), 0);
      rows.push(summarizeScenario(model, r, c, f));
    }
    expect(rows[1].totalDemand / rows[0].totalDemand).toBeCloseTo(2, 2);
    expect(rows[1].minPressure).toBeLessThan(rows[0].minPressure - 1);
    expect(pressureInsensitive(rows)).toBe(false);
    expect(pressureInsensitive([rows[0], { ...rows[0], factor: 2 }])).toBe(true);
  });
});
