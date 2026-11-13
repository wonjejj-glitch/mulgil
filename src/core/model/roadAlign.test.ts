import { describe, expect, it } from 'vitest';
import { estimateRoadShift, shiftLngLat } from './roadAlign';
import type { LngLat } from './types';

/** 전남 서부 기준점에서 (동, 북) m 만큼 떨어진 경위도. */
const O: LngLat = [126.48, 35.08];
const at = (e: number, n: number): LngLat => shiftLngLat(O, e, n);

/** 격자 도로망: 동서·남북 방향 도로가 300 m 간격. */
function gridRoads(): LngLat[][] {
  const roads: LngLat[][] = [];
  for (let k = -3; k <= 3; k++) {
    roads.push([at(-1000, k * 300 + 37), at(1000, k * 300 + 37)]);
    roads.push([at(k * 300 + 11, -1000), at(k * 300 + 11, 1000)]);
  }
  // 대각선 도로 하나 (격자 주기 때문에 생기는 여러 해를 하나로 좁힌다)
  roads.push([at(-900, -800), at(900, 700)]);
  return roads;
}

/** 도로를 따라 묻힌 관로를 (sx, sy) m 만큼 밀어 둔 것. */
function pipesShifted(sx: number, sy: number): LngLat[][] {
  return [
    [at(-600 + sx, 37 + sy), at(600 + sx, 37 + sy)],
    [at(311 + sx, -600 + sy), at(311 + sx, 600 + sy)],
    [at(-289 + sx, -300 + sy), at(-289 + sx, 300 + sy)],
    [at(-500 + sx, -563 + sy), at(500 + sx, -563 + sy)],
    // 대각선 도로 위 관로
    [at(-450 + sx, -425 + sy), at(450 + sx, 325 + sy)],
  ];
}

describe('estimateRoadShift', () => {
  it('관망 전체가 밀린 만큼(동 263 m) 되돌리는 이동량을 찾는다', () => {
    const result = estimateRoadShift(pipesShifted(263, 0), gridRoads())!;
    expect(result.dx).toBeCloseTo(-263, -0.5); // ±약 1 m
    expect(Math.abs(result.dy)).toBeLessThan(2);
    expect(result.after).toBeLessThan(2);
    expect(result.before).toBeGreaterThan(20);
    expect(result.matchedAfter).toBeGreaterThan(0.95);
  });

  it('남북·동서가 섞인 이동도 찾는다', () => {
    const result = estimateRoadShift(pipesShifted(-120, 85), gridRoads())!;
    expect(Math.abs(result.dx - 120)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(result.dy + 85)).toBeLessThanOrEqual(1.5);
  });

  it('이미 도로 위에 있으면 이동량은 거의 0', () => {
    const result = estimateRoadShift(pipesShifted(0, 0), gridRoads())!;
    expect(Math.hypot(result.dx, result.dy)).toBeLessThan(1.5);
    expect(result.before).toBeLessThan(1);
  });

  it('도로가 없으면 null', () => {
    expect(estimateRoadShift(pipesShifted(0, 0), [])).toBeNull();
  });
});
