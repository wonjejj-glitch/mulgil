import { describe, expect, it } from 'vitest';
import { designSewer } from './design';
import { BUSAN_2026_SEWAGE } from './standards';
import { demoProject } from './types';
import { parseSewerProject } from './validate';

describe('Busan 2026 sewage preset', () => {
  const withPreset = () => {
    const p = demoProject();
    Object.assign(p.constraints, BUSAN_2026_SEWAGE.constraints);
    return parseSewerProject(JSON.parse(JSON.stringify(p)));
  };

  it('is a valid project and designs with the stricter depth ratio', () => {
    const p = withPreset();
    const d = designSewer(p, {}, 'practical', BUSAN_2026_SEWAGE.rules);
    for (const r of d.rows) if (r.status.startsWith('적합')) expect(r.depth_ratio).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(Math.min(...d.project.conduits.map((c) => c.diameter))).toBeGreaterThanOrEqual(0.2);
  });

  it('rounds tiny design flows up to 0.001 m³/s', () => {
    const p = withPreset();
    for (const n of p.nodes) n.base_flow = n.kind === 'OUTFALL' ? 0 : 0.00001;
    p.catchments = [];
    const d = designSewer(p, {}, 'practical', BUSAN_2026_SEWAGE.rules);
    expect(Math.min(...d.rows.map((r) => r.flow))).toBeCloseTo(0.001, 9);
    const raw = designSewer(p, {}, 'practical', {});
    expect(Math.min(...raw.rows.map((r) => r.flow))).toBeLessThan(0.001);
  });

  it('labels small steps as 단차 and flags steps over 1.5 m', () => {
    const p = withPreset();
    // 평지에서 간선은 최소 경사로 길게 내려가 깊어지고, 짧은 지선(P06)은 얕게 들어온다 → 맨홀 안 낙차
    p.constraints.min_slope = 0.01;
    p.constraints.max_slope = 0.02;
    p.conduits.find((c) => c.id === 'P06')!.length = 5;
    const d = designSewer(p, {}, 'practical', BUSAN_2026_SEWAGE.rules);
    const dropped = d.rows.filter((r) => (r.drop ?? 0) > 0);
    expect(dropped.length).toBeGreaterThan(0);
    for (const r of dropped) {
      expect(r.status).toContain(r.drop! >= 0.6 ? '부관 낙차' : '· 단차');
      expect(r.status.includes('단차 1.5 m 초과')).toBe(r.drop! > 1.5);
      // 관은 최대 경사 이내로 두되, 최소 토피를 지키려면 더 가팔라야 하는 곳은 '경사 범위' 위반으로 남는다
      if (r.slope > p.constraints.max_slope + 1e-9) expect(r.status).toContain('경사 범위');
    }
  });
});
