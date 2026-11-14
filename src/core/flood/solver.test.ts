import { describe, expect, it } from 'vitest';
import { floodAreas, simulateFlood, type FloodGrid } from './solver';

function grid(nx: number, ny: number, cell: number, zf: (i: number, j: number) => number): FloodGrid {
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = zf(i, j);
  return { nx, ny, cell, z };
}

describe('2차원 지표 침수 확산', () => {
  it('평평한 그릇: 넣은 물이 보존되고 대칭으로 퍼진다', () => {
    // 가장자리가 높은 그릇이라 밖으로 나가지 않는다
    const g = grid(41, 41, 5, (i, j) => (i === 0 || j === 0 || i === 40 || j === 40 ? 10 : 0));
    const c = 20 * 41 + 20;
    const r = simulateFlood(g, [{ index: c, times: [0, 600], flows: [0.5, 0.5] }], { manning: 0.035, duration: 1800, frameInterval: 300 });
    expect(r.injected).toBeCloseTo(300, 0);
    expect(Math.abs(r.injected - r.stored - r.outflow) / r.injected).toBeLessThan(1e-6);
    expect(r.outflow).toBe(0);
    const at = (i: number, j: number) => r.maxDepth[j * 41 + i];
    expect(at(25, 20)).toBeCloseTo(at(15, 20), 4);
    expect(at(20, 25)).toBeCloseTo(at(20, 15), 4);
    expect(r.frames.length).toBe(7);
  });

  it('경사면: 물은 낮은 쪽(동쪽)으로 흘러가 가장자리로 빠진다', () => {
    const g = grid(60, 11, 5, (i) => 10 - i * 0.05);
    const r = simulateFlood(g, [{ index: 5 * 60 + 5, times: [0, 300], flows: [0.3, 0.3] }], { manning: 0.03, duration: 3600, frameInterval: 600 });
    const east = r.maxDepth[5 * 60 + 40];
    const west = r.maxDepth[5 * 60 + 1];
    expect(east).toBeGreaterThan(0.005);
    expect(east).toBeGreaterThan(west);
    expect(r.outflow).toBeGreaterThan(0);
    expect(Math.abs(r.injected - r.stored - r.outflow) / r.injected).toBeLessThan(1e-6);
  });

  it('면적 집계', () => {
    const a = floodAreas([0, 0.1, 0.3, 0.6, 1.5], 2);
    expect(a.classes).toEqual([4, 4, 4, 4]);
    expect(a.max).toBe(1.5);
  });
});
