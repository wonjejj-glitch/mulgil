import { describe, expect, it } from 'vitest';
import { buildingsGeoJson, cellBox, cellsOf } from './buildingCells';

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
});
