import { describe, expect, it } from 'vitest';
import { designSewer } from './design';
import { reviewCsv, reviewSewer } from './review';
import { demoProject } from './types';

describe('sewer review list', () => {
  it('judges the demo design GOOD with HGL pending until simulation', () => {
    const design = designSewer(demoProject());
    const rows = reviewSewer(design, null);
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.verdict.overflow).toBe('GOOD');
      expect(r.verdict.adverse).toBe('GOOD');
      expect(r.verdict.hgl).toBe('-');
      expect(r.flow).toBeLessThanOrEqual(r.fullFlow);
    }
    // 시작관 4개(MH1, MH3, MH7 에서 시작) 중 3개 + 관말 1개
    expect(rows.filter((r) => r.isStart).map((r) => r.id).sort()).toEqual(['P01', 'P03', 'P06']);
    expect(rows.filter((r) => r.isEnd).map((r) => r.id)).toEqual(['P08']);
    // 누가 연장: 방류구 직전 관은 가장 긴 상류 경로 + 자기 연장
    expect(rows.find((r) => r.id === 'P08')!.cumLength).toBeCloseTo(125 + 141 + 115 + 115 + 130, 9);
  });

  it('flags min velocity, adverse slope and HGL above ground', () => {
    const design = designSewer(demoProject());
    const p = design.project;
    p.nodes.find((n) => n.id === 'MH8')!.invert += 2; // P07 역경사
    const sim = {
      continuity: {},
      warnings: [],
      quality_ok: true,
      link_summary: {},
      node_summary: { MH1: { max_depth: 5, max_hgl: p.nodes[0].ground + 0.5, flood_hours: 0, flood_volume_m3: 0, surcharged: true } },
    };
    const rows = reviewSewer(design, sim as never, { minVelocity: 5, maxVelocity: 10, hglAboveGround: 0, velocityBasis: 'actual' });
    expect(rows.find((r) => r.id === 'P07')!.verdict.adverse).toBe('NG');
    expect(rows.find((r) => r.id === 'P01')!.verdict.hgl).toBe('NG');
    expect(rows.every((r) => r.verdict.minVelocity === 'NG')).toBe(true);
    expect(reviewCsv(rows).split('\r\n')[0]).toContain('판정(역경사)');
  });
});
