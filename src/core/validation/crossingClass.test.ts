import { describe, expect, it } from 'vitest';
import { addLink, addNode } from '../model/networkEdit';
import { plane } from '../model/roadSnap';
import { createEmptyModel, type LngLat, type Pipe } from '../model/types';
import { applyAutoFix } from './autoFix';
import { runValidation } from './index';
import { DEFAULT_VALIDATION_OPTIONS } from './types';

const P = plane([127, 37.5]);
const at = (x: number, y: number): LngLat => P.from([x, y]);

function pipe(m: ReturnType<typeof createEmptyModel>, id: string, a: [number, number], b: [number, number], diameter: number, vertices: [number, number][] = []) {
  const s = addNode(m, 'junction', at(...a), `${id}a`);
  const e = addNode(m, 'junction', at(...b), `${id}b`);
  const l = addLink(m, 'pipe', s.id, e.id, vertices.map((v) => at(...v)), id) as Pipe;
  l.diameter = diameter;
  return l;
}

describe('crossing classification', () => {
  it('reports one issue per pipe pair and calls zigzagging parallel pipes an overlap', () => {
    const m = createEmptyModel();
    pipe(m, 'A', [0, 0], [100, 0], 150, [[20, 1], [40, -1], [60, 1], [80, -1]]);
    pipe(m, 'B', [0, 0.5], [100, 0.5], 150);
    const issues = runValidation(m).filter((i) => ['crossing', 'overpass', 'overlap'].includes(i.type));
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('overlap');
    expect(issues[0].severity).toBe('info');
    expect(issues[0].fixable).toBe(false);
  });

  it('separates likely overpasses (main vs branch) from real missing splits', () => {
    const m = createEmptyModel();
    pipe(m, 'MAIN', [0, 0], [100, 0], 300);
    pipe(m, 'SVC', [50, -50], [50, 50], 80);
    pipe(m, 'X1', [0, 200], [100, 200], 150);
    pipe(m, 'X2', [50, 150], [50, 250], 150);
    const issues = runValidation(m);
    expect(issues.filter((i) => i.type === 'overpass').map((i) => i.linkIds)).toEqual([['MAIN', 'SVC']]);
    expect(issues.filter((i) => i.type === 'crossing').map((i) => i.linkIds)).toEqual([['X1', 'X2']]);

    // 일괄 보정에서 crossing 만 고르면 입체교차 추정은 그대로 남는다
    applyAutoFix(m, issues, { crossing: true }, DEFAULT_VALIDATION_OPTIONS);
    expect(Object.keys(m.links)).toContain('MAIN');
    expect(Object.keys(m.links).filter((id) => id.startsWith('X') || /^P\d/.test(id)).length).toBeGreaterThan(2);
    const after = runValidation(m);
    expect(after.filter((i) => i.type === 'crossing')).toHaveLength(0);
    expect(after.filter((i) => i.type === 'overpass')).toHaveLength(1);
  });

  it('merges a zero-length pipe keeping demand and control references', () => {
    const m = createEmptyModel();
    const r = addNode(m, 'reservoir', at(-50, 0), 'R');
    const a = addNode(m, 'junction', at(0, 0), 'JA');
    const b = addNode(m, 'junction', at(0, 0), 'JB');
    const c = addNode(m, 'junction', at(50, 0), 'JC');
    if (a.type === 'junction') a.demand = 1;
    if (b.type === 'junction') b.demand = 2;
    addLink(m, 'pipe', r.id, a.id, [], 'P1');
    const zero = addLink(m, 'pipe', a.id, b.id, [], 'Z') as Pipe;
    zero.length = 0;
    addLink(m, 'pipe', b.id, c.id, [], 'P2');
    m.extraSections.CONTROLS = ['LINK P2 CLOSED IF NODE JB BELOW 10'];
    const issues = runValidation(m).filter((i) => i.type === 'microPipe');
    applyAutoFix(m, issues, { microPipe: true }, DEFAULT_VALIDATION_OPTIONS);
    const kept = m.nodes.JA ?? m.nodes.JB;
    expect(Object.keys(m.nodes).filter((id) => id === 'JA' || id === 'JB')).toHaveLength(1);
    expect(kept.type === 'junction' && kept.demand).toBe(3);
    // 관망이 끊기지 않는다: R → kept → JC
    expect(Object.values(m.links).map((l) => [l.startNodeId, l.endNodeId].sort().join('-')).sort()).toEqual([[kept.id, 'JC'].sort().join('-'), ['R', kept.id].sort().join('-')].sort());
    expect(m.extraSections.CONTROLS[0]).toContain(`NODE ${kept.id}`);
  });
});
