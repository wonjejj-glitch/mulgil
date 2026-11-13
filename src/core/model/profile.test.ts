import { describe, expect, it } from 'vitest';
import sampleInp from '../../../public/samples/sample-district.inp?raw';
import { parseInp } from '../io/inpParser';
import { pathThrough, shortestPath } from './profile';

describe('shortestPath', () => {
  const { model } = parseInp(sampleInp);

  it('관로 연장 기준 최단 경로와 누적 거리를 돌려준다', () => {
    const path = shortestPath(model, 'R1', 'J35')!;
    expect(path.nodeIds[0]).toBe('R1');
    expect(path.nodeIds[path.nodeIds.length - 1]).toBe('J35');
    expect(path.linkIds).toHaveLength(path.nodeIds.length - 1);
    expect(path.distances[0]).toBe(0);
    // 누적 거리는 단조 증가하고 마지막 값은 경로 관로 연장의 합
    let sum = 0;
    for (let i = 0; i < path.linkIds.length; i++) {
      const link = model.links[path.linkIds[i]];
      sum += link.type === 'pipe' ? link.length : 0;
      expect(path.distances[i + 1]).toBeCloseTo(sum, 6);
      // 연속한 절점은 실제로 그 링크로 이어져 있다
      const ends = [link.startNodeId, link.endNodeId];
      expect(ends).toContain(path.nodeIds[i]);
      expect(ends).toContain(path.nodeIds[i + 1]);
    }
  });

  it('직접 연결된 두 절점은 링크 하나로 잇는다', () => {
    const path = shortestPath(model, 'J1', 'J2')!;
    expect(path.linkIds).toEqual(['P1']);
  });

  it('연결되지 않은 절점이나 없는 절점은 null', () => {
    const copy = structuredClone(model);
    copy.nodes.X = { id: 'X', type: 'junction', position: [127, 37], elevation: 0, demand: 0, pattern: '' };
    expect(shortestPath(copy, 'J1', 'X')).toBeNull();
    expect(shortestPath(model, 'J1', 'NOPE')).toBeNull();
  });

  it('경유 절점을 차례로 잇는다', () => {
    const path = pathThrough(model, ['J1', 'J7', 'J35'])!;
    expect(path.nodeIds[0]).toBe('J1');
    expect(path.nodeIds).toContain('J7');
    expect(path.nodeIds[path.nodeIds.length - 1]).toBe('J35');
    const direct = shortestPath(model, 'J1', 'J35')!;
    expect(path.distances[path.distances.length - 1]).toBeGreaterThanOrEqual(direct.distances[direct.distances.length - 1]);
  });
});
