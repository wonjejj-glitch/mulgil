import { describe, expect, it } from 'vitest';
import { assignWaterDemand, estimateBuildings, estimateHouseholds, ringArea, ringCenter } from './buildingEstimate';
import type { LngLat } from './types';

// 위도 37° 부근 약 20 m × 20 m 사각형
const square = (lng: number, lat: number, m: number): LngLat[] => {
  const dx = m / (111320 * Math.cos((lat * Math.PI) / 180)), dy = m / 110574;
  return [[lng, lat], [lng + dx, lat], [lng + dx, lat + dy], [lng, lat + dy], [lng, lat]];
};

describe('세대수 개략 추정', () => {
  it('면적 계산', () => {
    expect(ringArea(square(127, 37, 20))).toBeCloseTo(400, 0);
    expect(ringCenter(square(127, 37, 20))[0]).toBeGreaterThan(127);
  });

  it('종류별 규칙', () => {
    expect(estimateHouseholds(400, { building: 'apartments', 'building:levels': '10' })).toMatchObject({ households: 32, category: '공동주택', floors: 10 });
    expect(estimateHouseholds(400, { building: 'apartments' })!.households).toBeCloseTo((400 * 12 * 0.8) / 100, 6);
    expect(estimateHouseholds(120, { building: 'house' })).toMatchObject({ households: 1, category: '단독주택' });
    expect(estimateHouseholds(150, { building: 'yes' })!.households).toBe(1);
    expect(estimateHouseholds(500, { building: 'yes', 'building:levels': '3' })!.households).toBeCloseTo(15, 6);
    expect(estimateHouseholds(600, { building: 'office' })).toMatchObject({ households: 4, category: '비주거' });
    expect(estimateHouseholds(40, { building: 'garage' })).toBeNull();
    expect(estimateHouseholds(10, { building: 'yes' })).toBeNull();
  });

  it('건물 목록 집계', () => {
    const r = estimateBuildings([
      { id: 'a', ring: square(127, 37, 20), tags: { building: 'apartments', 'building:levels': '5' } },
      { id: 'b', ring: square(127.001, 37, 10), tags: { building: 'house' } },
      { id: 'c', ring: square(127.002, 37, 8), tags: { building: 'shed' } },
    ]);
    expect(r.items).toHaveLength(2);
    expect(r.skipped).toBe(1);
    expect(r.byCategory.공동주택.households).toBeCloseTo(16, 0);
    expect(r.byCategory.단독주택.count).toBe(1);
  });
});

describe('상수 절점 수요량 배분', () => {
  const j = [
    { id: 'J1', position: [127, 37] as LngLat },
    { id: 'J2', position: [127.002, 37] as LngLat },
  ];
  it('가장 가까운 절점에 사용량·세대수로 배분하고 먼 것은 뺀다', () => {
    const r = assignWaterDemand(j, [
      { id: 'a', position: [127.0002, 37], demand: 2 },
      { id: 'b', position: [127.0019, 37.0001], households: 2 },
      { id: 'c', position: [127.0021, 37] },
      { id: 'far', position: [127.05, 37] },
    ]);
    expect(r.assigned).toBe(3);
    expect(r.unassigned).toBe(1);
    expect(r.defaulted).toBe(1);
    expect(r.perNode.find((n) => n.id === 'J1')!.m3day).toBe(2);
    expect(r.perNode.find((n) => n.id === 'J2')!.m3day).toBeCloseTo((3 * 2.3 * 330) / 1000, 9);
  });
});
