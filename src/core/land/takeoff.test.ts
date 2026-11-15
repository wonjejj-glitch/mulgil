import { describe, expect, it } from 'vitest';
import { clipConvex, corridorPieces, jimokOf, landTakeoff, polygonArea, ringArea, takeoffCsv, type Parcel, type XY } from './takeoff';

const rect = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const parcel = (pnu: string, jibun: string, ring: XY[], price = 100000): Parcel => ({ pnu, jibun, addr: `김해시 내동 ${jibun.replace(/\D+$/, '')}`, price, priceDate: '2025.01', polygons: [[ring]] });

describe('기하', () => {
  it('볼록 자르기', () => {
    const cut = clipConvex(rect(0, 0, 10, 10), rect(5, 5, 20, 20));
    expect(Math.abs(ringArea(cut))).toBeCloseTo(25, 9);
    expect(polygonArea([rect(0, 0, 10, 10), rect(2, 2, 4, 4)])).toBeCloseTo(96, 9);
  });

  it('곧은 띠 = 길이 × 폭, 꺾인 띠도 겹침·틈 없이 중심선 길이 × 폭', () => {
    const straight = corridorPieces([[0, 0], [10, 0]], 2);
    expect(straight.reduce((s, q) => s + Math.abs(ringArea(q)), 0)).toBeCloseTo(20, 9);
    const bent = corridorPieces([[0, 0], [10, 0], [10, 10]], 2);
    // 마이터 이음: 면적 = 중심선 길이(20) × 폭(2)
    expect(bent.reduce((s, q) => s + Math.abs(ringArea(q)), 0)).toBeCloseTo(40, 9);
  });

  it('지목', () => {
    expect(jimokOf('1163도')).toEqual({ code: '도', name: '도로' });
    expect(jimokOf('45-2대').name).toBe('대');
    expect(jimokOf('12').name).toBe('');
  });
});

describe('편입토지조서', () => {
  // 도로 필지(0~100 × 0~10) 와 그 위쪽 대지(0~100 × 10~30). 관로는 y=9 를 따라가 폭 4 m → 도로 3 m, 대지 1 m 편입
  const road = parcel('1', '100도', rect(0, 0, 100, 10), 500000);
  const lot = parcel('2', '101대', rect(0, 10, 100, 30), 800000);
  const result = landTakeoff([road, lot], [{ id: 'P1', path: [[10, 9], [60, 9]], width: 4 }], 1.5);

  it('필지별 편입 면적과 보상비', () => {
    expect(result.rows).toHaveLength(2);
    const r = result.rows.find((x) => x.pnu === '1')!;
    const l = result.rows.find((x) => x.pnu === '2')!;
    expect(r.takenArea).toBeCloseTo(150, 6); // 50 m × 3 m
    expect(l.takenArea).toBeCloseTo(50, 6); // 50 m × 1 m
    expect(r).toMatchObject({ jimok: '도로', isPublic: true, routes: ['P1'] });
    expect(l.isPublic).toBe(false);
    expect(l.cost).toBeCloseTo(50 * 800000 * 1.5, 0);
    expect(result.totalCost).toBeCloseTo(l.cost, 0); // 도로는 보상비 합계에서 뺀다
    expect(result.publicTaken).toBeCloseTo(150, 6);
    expect(result.uncovered).toBeCloseTo(0, 6);
  });

  it('지적이 없는 곳으로 나간 띠는 따로 센다', () => {
    const r = landTakeoff([road], [{ id: 'P1', path: [[90, 5], [130, 5]], width: 2 }]);
    expect(r.rows[0].takenArea).toBeCloseTo(20, 6);
    expect(r.uncovered).toBeCloseTo(60, 6);
  });

  it('CSV', () => {
    const csv = takeoffCsv(result, '시험');
    expect(csv).toContain('번호,소재지,지번,지목');
    expect(csv).toContain('101대');
    expect(csv).toContain('공공용지(도로 등)');
  });
});
