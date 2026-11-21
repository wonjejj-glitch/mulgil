import { describe, expect, it } from 'vitest';
import { boxAreaKm2, buildingsGeoJson, cellBox, cellsOf, splitBox } from './buildingCells';

describe('3D 건물 칸 나누기', () => {
  it('화면 범위에 걸치는 칸을 모두 고른다', () => {
    const cells = cellsOf([128.875, 35.221, 128.892, 35.229]);
    expect(cells.sort()).toEqual(['12887,3522', '12888,3522', '12889,3522']);
    const [w, s, e, n] = cellBox('12887,3522');
    expect(w).toBeCloseTo(128.87, 9);
    expect(s).toBeCloseTo(35.22, 9);
    expect(e).toBeCloseTo(128.88, 9);
    expect(n).toBeCloseTo(35.23, 9);
  });
  it('높이는 층수 × 3.3 m 이고, 두 칸에서 겹쳐 받은 건물은 한 번만 넣는다', () => {
    const ring: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 0]];
    const a = { id: 'B1', floors: 10, polygons: [[ring]] };
    const fc = buildingsGeoJson([[a, { id: '', floors: 1, polygons: [[ring]] }], [a, { id: 'B2', floors: 3, polygons: [[ring]] }]]);
    expect(fc.features.map((f) => f.properties.height)).toEqual([33, 3.3, 9.9]);
  });
  it('넓은 범위는 한 조각이 한도 이하인 격자로 빈틈없이 나눈다', () => {
    const box: [number, number, number, number] = [128.83, 35.2, 128.9, 35.26]; // 김해 시내 약 42 km²
    const area = boxAreaKm2(box);
    expect(area).toBeGreaterThan(40);
    const tiles = splitBox(box, 6);
    expect(tiles.length).toBeGreaterThanOrEqual(Math.ceil(area / 6));
    // 조각마다 자기 위도로 넓이를 재므로 1% 안쪽 오차는 있다
    for (const t of tiles) expect(boxAreaKm2(t)).toBeLessThanOrEqual(6 * 1.01);
    expect(Math.abs(tiles.reduce((sum, t) => sum + boxAreaKm2(t), 0) / area - 1)).toBeLessThan(0.001);
    expect(Math.min(...tiles.map((t) => t[0]))).toBe(128.83);
    expect(Math.max(...tiles.map((t) => t[3]))).toBeCloseTo(35.26, 12);
    expect(splitBox([128.88, 35.22, 128.89, 35.23], 6)).toHaveLength(1);
  });
});
