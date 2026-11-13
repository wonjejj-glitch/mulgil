import { describe, expect, it } from 'vitest';
import { parseInp } from '../io/inpParser';
import { shiftLngLat } from './roadAlign';
import { snapNetworkToRoads } from './roadSnap';
import type { LngLat } from './types';
import { distanceMeters } from '../../utils/geoMath';

const O: LngLat = [126.5, 35.07];
const at = (e: number, n: number): LngLat => shiftLngLat(O, e, n);

/** ㄱ자 도로 (서→동 300 m 후 북쪽으로 300 m) + 교차로 하나(동서 도로가 x=150 에서 남북 도로와 만남). */
const ROADS: LngLat[][] = [
  [at(0, 0), at(150, 0), at(300, 0), at(300, 300)],
  [at(150, -200), at(150, 0), at(150, 200)],
];

function model(points: Record<string, [number, number]>, pipes: [string, string, string][], extra = '') {
  const lines = ['[JUNCTIONS]', ...Object.keys(points).map((id) => ` ${id} 10 1`), extra, '[PIPES]', ...pipes.map(([id, a, b]) => ` ${id} ${a} ${b} 100 150 110 0 Open`), '[COORDINATES]'];
  for (const [id, [e, n]] of Object.entries(points)) {
    const p = at(e, n);
    lines.push(` ${id} ${p[0]} ${p[1]}`);
  }
  lines.push('[END]');
  return parseInp(lines.join('\n'), { crs: 'wgs84' }).model;
}

describe('snapNetworkToRoads', () => {
  it('도로 옆 절점을 도로 위로 옮기고, 관로는 도로를 따라 모퉁이를 돈다', () => {
    // A 는 도로 남쪽 8 m, B 는 북쪽으로 꺾인 도로 동쪽 6 m. 관로 A–B 는 원래 대각선 직선.
    const m = model({ A: [60, -8], B: [306, 220] }, [['P1', 'A', 'B']]);
    const r = snapNetworkToRoads(m, ROADS, { tolerance: 25 });
    expect(r.stats.nodesMoved).toBe(2);
    expect(distanceMeters(r.nodes.get('A')!, at(60, 0))).toBeLessThan(0.5);
    expect(distanceMeters(r.nodes.get('B')!, at(300, 220))).toBeLessThan(0.5);
    const v = r.vertices.get('P1')!;
    // 모퉁이(300, 0) 를 지난다
    expect(v.some((p) => distanceMeters(p, at(300, 0)) < 0.5)).toBe(true);
    expect(r.stats.linksRouted).toBe(1);
  });

  it('교차로 근처 절점은 교차점으로 끌어당긴다', () => {
    const m = model({ X: [158, 7], Y: [150, 150] }, [['P1', 'X', 'Y']]);
    const r = snapNetworkToRoads(m, ROADS, { tolerance: 25, intersectionTolerance: 12 });
    expect(distanceMeters(r.nodes.get('X')!, at(150, 0))).toBeLessThan(0.5);
  });

  it('도로에서 먼 절점과 그 관로는 그대로 둔다', () => {
    const m = model({ A: [60, -8], F: [60, -150] }, [['P1', 'A', 'F']]);
    const r = snapNetworkToRoads(m, ROADS, { tolerance: 25 });
    expect(r.nodes.has('F')).toBe(false);
    expect(r.vertices.has('P1')).toBe(false);
  });

  it('도로로 돌아가는 길이 너무 길면 관로 경로는 바꾸지 않는다', () => {
    // 두 절점 모두 도로 근처지만, 도로로 가면 600 m 를 돌아야 하는 150 m 짜리 관로
    const roads: LngLat[][] = [[at(0, 0), at(0, 300), at(150, 300), at(150, 0)]];
    const m = model({ A: [5, 0], B: [145, 0] }, [['P1', 'A', 'B']]);
    const r = snapNetworkToRoads(m, roads, { tolerance: 25, maxDetourRatio: 1.5 });
    expect(r.stats.nodesMoved).toBe(2);
    expect(r.vertices.has('P1')).toBe(false);
  });

  it('.inp 연장보다 훨씬 긴 도로 경로는 따르지 않는다 (도면이 크게 그려진 구간)', () => {
    // ㄷ자 도로: A–B 사이 도로 경로는 750 m. 관로는 도면에 위로 크게 휘어 그려져 있다(약 580 m).
    const roads: LngLat[][] = [[at(0, 0), at(0, 300), at(150, 300), at(150, 0)]];
    const m = model({ A: [5, 0], B: [145, 0] }, [['P1', 'A', 'B']]);
    m.links.P1.vertices = [at(75, 280)];
    const pipe = m.links.P1;
    if (pipe.type === 'pipe') pipe.length = 760; // .inp 연장이 도로 경로와 비슷하면 → 도로를 따른다
    expect(snapNetworkToRoads(m, roads, { tolerance: 25 }).vertices.has('P1')).toBe(true);
    if (pipe.type === 'pipe') pipe.length = 150; // .inp 연장은 직선 거리 정도 → 도면이 과장된 것, 도로로 돌지 않는다
    expect(snapNetworkToRoads(m, roads, { tolerance: 25 }).vertices.has('P1')).toBe(false);
  });

  it('수원지·배수지는 기본적으로 옮기지 않는다', () => {
    const m = model({ A: [60, -8] }, [], '[RESERVOIRS]\n R 50');
    m.nodes.R.position = at(100, -5);
    const r = snapNetworkToRoads(m, ROADS, { tolerance: 25 });
    expect(r.nodes.has('R')).toBe(false);
    expect(r.nodes.has('A')).toBe(true);
  });
});
