import { describe, expect, it } from 'vitest';
import { demoProject } from '../sewer/types';
import type { SwmmOutput } from '../swmm/outReader';
import { asciiGrid, cellOf, gridFrame, overflowSources } from './prepare';

describe('침수 해석 준비', () => {
  const p = demoProject();
  it('관망 + 여유를 덮는 격자, 셀 수 상한', () => {
    const f = gridFrame(p, 5, 100);
    expect(f.nx * f.cell).toBeGreaterThanOrEqual(610 + 200);
    expect(cellOf(f, 0, 0)).toBeGreaterThanOrEqual(0);
    const big = gridFrame(p, 0.5, 100, 10_000);
    expect(big.nx * big.ny).toBeLessThanOrEqual(10_000);
  });
  it('월류 시계열 → 유입원 (LPS → m³/s)', () => {
    const f = gridFrame(p, 5, 50);
    const nodeIds = ['MH1', 'MH2'];
    const nodeVars = 6;
    const periods = 3;
    const node = new Float32Array(periods * nodeIds.length * nodeVars);
    node[(1 * 2 + 1) * nodeVars + 5] = 100; // MH2, 2번째 기간 100 L/s
    const out = { flowUnits: 'LPS', nodeIds, nodeVars, periods, reportStepSec: 60, node } as unknown as SwmmOutput;
    const { sources, nodes } = overflowSources(p, out, f);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('MH2');
    expect(nodes[0].volume).toBeCloseTo(6, 6);
    expect(sources[0].times).toEqual([0, 60, 120, 180]);
    expect(sources[0].flows[2]).toBeCloseTo(0.1, 6);
  });
  it('ASCII Grid 머리글', () => {
    const f = { xmin: 0, ymax: 10, cell: 5, nx: 2, ny: 2 };
    expect(asciiGrid(f, [0, 0.5, 0, 0]).split('\n').slice(0, 7)).toEqual(['ncols 2', 'nrows 2', 'xllcorner 0.000', 'yllcorner 0.000', 'cellsize 5', 'NODATA_value -9999', '-9999 0.500']);
  });
});
