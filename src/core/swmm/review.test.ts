import { describe, expect, it } from 'vitest';
import sampleInp from '../../../public/samples/sample-sewer.inp?raw';
import { readSwmmInp } from './inpReader';
import { linkValue, nodeValue } from './outReader';
import { reviewSwmm } from './review';
import { runSwmm } from './swmmRunner';

describe('SWMM results review', async () => {
  const project = readSwmmInp(sampleInp);
  const { output: out } = await runSwmm(sampleInp);

  it('flags exactly the nodes that flood, with their peak flooding', () => {
    const hits = reviewSwmm(project, out);
    const flooded = out.nodeIds.filter((_, i) => Array.from({ length: out.periods }, (_, t) => nodeValue(out, 'flooding', t, i)).some((v) => v > 1e-6));
    expect(hits.filter((h) => h.kind === 'flooding').map((h) => h.id).sort()).toEqual(flooded.sort());
    for (const h of hits.filter((x) => x.kind === 'flooding')) {
      const i = out.nodeIds.indexOf(h.id);
      expect(h.value).toBeCloseTo(Math.max(...Array.from({ length: out.periods }, (_, t) => nodeValue(out, 'flooding', t, i))), 6);
      expect(h.hours).toBeGreaterThan(0);
    }
  });

  it('judges conduits by full ratio and max velocity', () => {
    const strict = reviewSwmm(project, out, { minVelocity: 100, maxVelocity: 0, fullRatio: 0 });
    const conduits = out.linkIds.length;
    expect(strict.filter((h) => h.kind === 'fullPipe')).toHaveLength(conduits);
    expect(strict.filter((h) => h.kind === 'highVelocity')).toHaveLength(conduits);
    const loose = reviewSwmm(project, out, { minVelocity: 0, maxVelocity: 100, fullRatio: 2 });
    expect(loose.filter((h) => h.target === 'link')).toHaveLength(0);
    const c6 = out.linkIds.indexOf('C6');
    const vmax = Math.max(...Array.from({ length: out.periods }, (_, t) => Math.abs(linkValue(out, 'velocity', t, c6))));
    expect(strict.find((h) => h.kind === 'highVelocity' && h.id === 'C6')!.value).toBeCloseTo(vmax, 6);
  });
});
