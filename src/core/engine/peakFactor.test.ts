import { describe, expect, it } from 'vitest';
import { demandMultiplier, parseFactors, withDemandMultiplier } from './peakFactor';

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
