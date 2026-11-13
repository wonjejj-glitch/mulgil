import { describe, expect, it } from 'vitest';
import { parseInp } from '../io/inpParser';
import { mergeSets, objectsInPolygon, pointInPolygon } from './selection';
import type { LngLat } from './types';

const SQUARE: LngLat[] = [
  [127, 37],
  [127.01, 37],
  [127.01, 37.01],
  [127, 37.01],
];

describe('pointInPolygon', () => {
  it('안과 밖을 구분한다', () => {
    expect(pointInPolygon([127.005, 37.005], SQUARE)).toBe(true);
    expect(pointInPolygon([127.02, 37.005], SQUARE)).toBe(false);
    // 오목 다각형
    const concave: LngLat[] = [[0, 0], [4, 0], [4, 4], [2, 1], [0, 4]];
    expect(pointInPolygon([2, 3], concave)).toBe(false);
    expect(pointInPolygon([1, 1], concave)).toBe(true);
  });
});

describe('objectsInPolygon', () => {
  const { model } = parseInp(
    [
      '[JUNCTIONS]', ' A 0 0', ' B 0 0', ' C 0 0',
      '[PIPES]', ' P1 A B 10 100 110 0 Open', ' P2 B C 10 100 110 0 Open',
      '[COORDINATES]', ' A 127.002 37.002', ' B 127.008 37.008', ' C 127.02 37.02',
      '[END]',
    ].join('\n'),
    { crs: 'wgs84' },
  );

  it('안의 절점과 양 끝이 모두 안에 있는 링크만 고른다', () => {
    const set = objectsInPolygon(model, SQUARE);
    expect(set.nodeIds.sort()).toEqual(['A', 'B']);
    expect(set.linkIds).toEqual(['P1']);
  });

  it('토글 병합은 이미 있는 항목을 뺀다', () => {
    const merged = mergeSets({ nodeIds: ['A', 'C'], linkIds: [] }, { nodeIds: ['A', 'B'], linkIds: ['P1'] }, 'toggle');
    expect(merged.nodeIds.sort()).toEqual(['B', 'C']);
    expect(merged.linkIds).toEqual(['P1']);
  });
});
