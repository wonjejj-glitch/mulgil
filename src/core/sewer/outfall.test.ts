import { describe, expect, it } from 'vitest';
import { designSewer } from './design';
import { fitOutfallInverts } from './outfall';
import { reviewSewer } from './review';
import { demoProject } from './types';

describe('outfall depth fitting', () => {
  it('lowers a too-shallow outfall so the last pipe keeps its required slope', () => {
    const p = demoProject();
    const of = p.nodes.find((n) => n.kind === 'OUTFALL')!;
    of.invert = of.ground - 0.5; // 너무 얕음
    const before = reviewSewer(designSewer(p, {}, 'practical'), null).find((r) => r.id === 'P08')!;
    expect(before.verdict.adverse).toBe('NG');

    const { project, changes } = fitOutfallInverts(p, 'practical');
    expect(changes).toHaveLength(1);
    expect(changes[0].to).toBeLessThan(changes[0].from);
    const design = designSewer(project, {}, 'practical');
    const last = reviewSewer(design, null).find((r) => r.id === 'P08')!;
    expect(last.verdict.adverse).toBe('GOOD');
    expect(last.verdict.overflow).toBe('GOOD');
    expect(last.slopePermil / 1000).toBeGreaterThanOrEqual(project.constraints.min_slope - 1e-9);
    // 상류 설계는 방류구 깊이와 무관하다
    const ref = designSewer({ ...p, nodes: p.nodes.map((n) => (n.kind === 'OUTFALL' ? { ...n, invert: n.ground - 30 } : n)) }, {}, 'practical');
    const mh8 = (d: typeof design) => d.project.nodes.find((n) => n.id === 'MH8')!.invert;
    expect(mh8(design)).toBeCloseTo(mh8(ref), 9);
  });

  it('leaves the input untouched', () => {
    const p = demoProject();
    const copy = JSON.stringify(p);
    fitOutfallInverts(p);
    expect(JSON.stringify(p)).toBe(copy);
  });
});
