import { describe, expect, it } from 'vitest';
import { assignSewage, sewageCsv, sourceSewage, sourcesFromConnections, DEFAULT_SEWAGE, type XY } from './sewage';
import { defaultConstraints, defaultOptions, type SewerProject } from './types';

// MH1(0,0) → MH2(100,0) → MH3(200,0) → OF(300,0)
const node = (id: string, x: number, kind: 'JUNCTION' | 'OUTFALL' = 'JUNCTION') => ({ id, x, y: 0, ground: 10, invert: 8, kind, base_flow: 0, boundary: 'FREE' as const, stage: null });
const project: SewerProject = {
  schema_version: 1,
  name: 't',
  nodes: [node('MH1', 0), node('MH2', 100), node('MH3', 200), node('OF', 300, 'OUTFALL')],
  conduits: [
    { id: 'C1', upstream: 'MH1', downstream: 'MH2', length: 100, diameter: 0.3, roughness: 0.013, inlet_offset: 0, outlet_offset: 0 },
    { id: 'C2', upstream: 'MH2', downstream: 'MH3', length: 100, diameter: 0.3, roughness: 0.013, inlet_offset: 0, outlet_offset: 0 },
    { id: 'C3', upstream: 'MH3', downstream: 'OF', length: 100, diameter: 0.3, roughness: 0.013, inlet_offset: 0, outlet_offset: 0 },
  ],
  catchments: [],
  options: defaultOptions(),
  constraints: defaultConstraints(),
};

describe('sourceSewage', () => {
  it('사용량 × 전환율, 없으면 세대수 × 인원 × 원단위, 그것도 없으면 기본 세대수', () => {
    expect(sourceSewage({ id: 'a', xy: [0, 0], demand: 10 }, DEFAULT_SEWAGE).m3day).toBeCloseTo(9, 9);
    expect(sourceSewage({ id: 'b', xy: [0, 0], households: 4 }, DEFAULT_SEWAGE).m3day).toBeCloseTo((4 * 2.3 * 300) / 1000, 9);
    const d = sourceSewage({ id: 'c', xy: [0, 0] }, { ...DEFAULT_SEWAGE, defaultHouseholds: 2 });
    expect(d).toEqual({ m3day: (2 * 2.3 * 300) / 1000, households: 2, defaulted: true });
  });
});

describe('assignSewage', () => {
  it('연결관이 없으면 가장 가까운 관거의 상류 맨홀로 보낸다', () => {
    const r = assignSewage(project, [
      { id: 'h1', xy: [150, 10], households: 1 }, // C2 옆 → MH2
      { id: 'h2', xy: [250, -5], demand: 1 }, // C3 옆 → MH3 (방류구 아님)
      { id: 'far', xy: [150, 500] },
    ], []);
    expect(r.stats).toMatchObject({ viaNearest: 2, viaConnection: 0, unassigned: 1 });
    expect(r.unassignedIds).toEqual(['far']);
    expect(r.flows.get('MH2')).toBeCloseTo((2.3 * 300) / 1000 / 86400, 12);
    expect(r.flows.get('MH3')).toBeCloseTo(0.9 / 86400, 12);
    expect(r.flows.has('OF')).toBe(false);
  });

  it('연결관이 있으면 본관 쪽 끝이 닿는 맨홀로 보낸다 (가장 가까운 관거보다 우선)', () => {
    // 집은 C1 옆(50,15)에 있지만 연결관은 MH3(200,0) 으로 간다
    const conn: XY[][] = [[[52, 15], [120, 15], [200, 1]]];
    const r = assignSewage(project, [{ id: 'h', xy: [50, 15], households: 3 }], conn, { peakFactor: 2 });
    expect(r.stats.viaConnection).toBe(1);
    expect(r.perNode).toEqual([{ id: 'MH3', sources: 1, households: 3, m3day: (3 * 2.3 * 300) / 1000 }]);
    expect(r.flows.get('MH3')).toBeCloseTo((2 * 3 * 2.3 * 300) / 1000 / 86400, 12);
  });

  it('연결관만 있으면 연결관 하나를 수용가 하나로 본다', () => {
    const conn: XY[][] = [[[150, 0.2], [150, 12]], [[30, 18], [30, 0.5]], [[150, 400], [150, 420]]];
    const sources = sourcesFromConnections(project, conn);
    expect(sources.map((s) => s.xy)).toEqual([[150, 12], [30, 18]]);
    const r = assignSewage(project, sources, conn);
    expect(r.stats.viaConnection).toBe(2);
    expect(r.perNode.map((n) => n.id).sort()).toEqual(['MH1', 'MH2']);
    expect(sewageCsv(r, 1)).toContain('MH1,1,1,');
  });
});
