import { describe, expect, it } from 'vitest';
import { addLink, addNode } from './networkEdit';
import { mergeNearbyNodes, mergeSeriesPipes, renumber } from './networkTools';
import { plane } from './roadSnap';
import { createEmptyModel, type Junction, type LngLat } from './types';

const P = plane([127, 37.5]);
const at = (x: number, y: number): LngLat => P.from([x, y]);

function line() {
  // R1 — J1 — J2 — J3 (일직선 100 m 간격), J2 는 수요 0
  const m = createEmptyModel();
  const r = addNode(m, 'reservoir', at(0, 0), 'R1');
  const j1 = addNode(m, 'junction', at(100, 0), 'J1') as Junction;
  const j2 = addNode(m, 'junction', at(200, 0), 'J2') as Junction;
  const j3 = addNode(m, 'junction', at(300, 0), 'J3') as Junction;
  j1.demand = 1;
  j3.demand = 2;
  addLink(m, 'pipe', r.id, j1.id);
  addLink(m, 'pipe', j1.id, j2.id);
  addLink(m, 'pipe', j3.id, j2.id); // 방향이 반대인 관
  return m;
}

describe('network tools', () => {
  it('merges series pipes through zero-demand junctions only', () => {
    const m = line();
    expect(mergeSeriesPipes(m)).toBe(1);
    expect(m.nodes.J2).toBeUndefined();
    expect(Object.keys(m.links)).toHaveLength(2);
    const merged = Object.values(m.links).find((l) => l.startNodeId === 'J1' || l.endNodeId === 'J1' ? l.startNodeId !== 'R1' && l.endNodeId !== 'R1' : false)!;
    expect(merged.type === 'pipe' && Math.round(merged.length)).toBe(200);
    // 수요가 있는 J1 은 남는다
    expect(m.nodes.J1).toBeDefined();
  });

  it('does not merge pipes with different properties', () => {
    const m = line();
    const p = Object.values(m.links).find((l) => l.endNodeId === 'J2' && l.startNodeId === 'J1')!;
    if (p.type === 'pipe') p.diameter += 50;
    expect(mergeSeriesPipes(m)).toBe(0);
  });

  it('merges nearby nodes, keeping sources and summing demand', () => {
    const m = line();
    const near = addNode(m, 'junction', at(100.5, 0.3), 'JX') as Junction;
    near.demand = 5;
    const nearSource = addNode(m, 'junction', at(0.2, 0), 'JR') as Junction;
    nearSource.demand = 0;
    expect(mergeNearbyNodes(m, 1)).toBe(2);
    expect(m.nodes.R1).toBeDefined();
    expect(m.nodes.JR).toBeUndefined();
    const j1 = (m.nodes.J1 ?? m.nodes.JX) as Junction;
    expect(j1.demand).toBe(6);
  });

  it('renumbers ids with prefix and digits, swapping safely', () => {
    const m = line();
    expect(renumber(m, 'node', ['J3', 'J2', 'J1'], { prefix: 'J', digits: 1, start: 1, step: 1 })).toBe(3);
    expect((m.nodes.J1 as Junction).demand).toBe(2); // 옛 J3
    expect(renumber(m, 'link', Object.keys(m.links), { prefix: 'PIPE_', digits: 3, start: 10, step: 10 })).toBe(3);
    expect(Object.keys(m.links).sort()).toEqual(['PIPE_010', 'PIPE_020', 'PIPE_030']);
    // 대상이 아닌 객체와 이름이 겹치면 거부
    expect(renumber(m, 'node', ['J2'], { prefix: 'R', digits: 1, start: 1, step: 1 })).toBe(-1);
  });
});
