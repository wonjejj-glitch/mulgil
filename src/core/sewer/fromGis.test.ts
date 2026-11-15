import { describe, expect, it } from 'vitest';
import { auditGroundWithTerrain, buildGisNetwork, extractSewerProject, insideRings, terrainBias, usageLabel, type GisPipeInput, type GisPointInput, type XY } from './fromGis';
import { buildNetwork } from './topology';
import { parseSewerProject } from './validate';

// 가상의 작은 자료: 맨홀 A(10,0) → B(20,0) → C(30,0) 오수 본선, D(20,10) → B 지선, 끝 C 에서 방류
const mh = (id: string, x: number, y: number, ground: number, invert: number): GisPointInput => ({ xy: [x, y], props: { FTR_IDN: id, MOS_HSL: ground, LMS_HSL: invert } });
const pipe = (id: string, coords: XY[], props: Record<string, unknown> = {}): GisPipeInput => ({ coords, props: { FTR_IDN: id, SBA_CDE: 'SBA004', STD_DIP: 300, ...props } });

const manholes = [mh('1', 10, 0, 12, 10), mh('2', 20, 0, 11.8, 9.8), mh('3', 30, 0, 11.5, 9.5), mh('4', 20, 10, 12.5, 0)];
const pipes = [
  pipe('101', [[10, 0], [20, 0]], { BOM_IDN: 1, EOM_IDN: 2, SBK_HSL: '10.0', SBL_HSL: '9.85', BYC_LEN: 10.2 }),
  // 종점 맨홀 번호가 엉뚱한(멀리 있는) 맨홀 → 거리로 3 번에 붙어야 한다
  pipe('102', [[20, 0], [25, 0.5], [30.4, 0]], { BOM_IDN: 2, EOM_IDN: 999 }),
  // 지선: 4 번 맨홀은 관저고가 0(없음) → 관 관저고·토피로 채운다
  pipe('103', [[20, 10], [20, 0.2]], { BOM_IDN: 4, EOM_IDN: 2, SBK_HSL: '10.6', SBL_HSL: '10.0' }),
  // 우수관 (용도 필터로 빠져야 함), 박스 2련 2.0×1.0
  pipe('201', [[10, 0], [10, -20]], { SBA_CDE: 'SBA003', STD_DIP: 0, STD_HOL: 2, STD_VEL: 1, PIP_LBL: '2005/RCB/2@2.0X1.0/L20' }),
];
const extra = [mh('999', 5000, 5000, 50, 48)];

describe('buildGisNetwork', () => {
  it('맨홀 번호 → 거리 → 가상 절점 순으로 끝점을 잇는다', () => {
    const net = buildGisNetwork(pipes, [...manholes, ...extra], { snap: 1 });
    expect(net.stats.byId).toBe(5); // 101 양끝, 102 시점, 103 양끝
    expect(net.stats.bySnap).toBe(2); // 102 종점(0.4 m), 201 시점
    expect(net.stats.virtual).toBe(1); // 201 종점
    const l102 = net.links.find((l) => l.id === 'P102')!;
    expect(net.nodes[l102.to].id).toBe('MH3');
    expect(net.usages.get('SBA004')).toBe(3);
    const box = net.links.find((l) => l.id === 'P201')!;
    expect(box.box).toBe(true);
    expect(box.diameter).toBeCloseTo(Math.sqrt((4 * 2 * 1 * 2) / Math.PI), 6);
  });
});

describe('extractSewerProject', () => {
  const net = buildGisNetwork(pipes, manholes);

  it('용도로 골라 검증을 통과하는 수지상 관망을 만든다', () => {
    const { project, report } = extractSewerProject(net, { usages: ['SBA004'], region: { kind: 'all' }, minPipes: 1, name: 't', defaultDiameter: 0.3 });
    expect(() => parseSewerProject(project)).not.toThrow();
    expect(() => buildNetwork(project)).not.toThrow();
    expect(report.pipes).toBe(3);
    expect(report.outfalls).toBe(1);
    expect(project.nodes.find((n) => n.kind === 'OUTFALL')!.id).toBe('MH3');
    const c101 = project.conduits.find((c) => c.id === 'P101')!;
    expect(c101.length).toBe(10.2);
    expect(c101.diameter).toBe(0.3);
    // 4 번 맨홀: 관저고 없음 → 관 시점 관저고 10.6
    const n4 = project.nodes.find((n) => n.id === 'MH4')!;
    expect(n4.invert).toBe(10.6);
    expect(n4.ground).toBe(12.5);
    // 103 종점 10.0 은 2 번 맨홀 관저고 9.8 보다 0.2 높다 → 유출 옵셋
    expect(project.conduits.find((c) => c.id === 'P103')!.outlet_offset).toBeCloseTo(0.2, 6);
  });

  it('하류 관이 둘인 맨홀은 큰 관 하나만 남기고, 순환은 끊는다', () => {
    const more = [
      ...pipes,
      // 2 번에서 4 번으로 거꾸로 올라가는 관 → 2 번 하류가 둘 (102 600 mm 가 남아야)
      pipe('104', [[20, 0], [20, 10]], { BOM_IDN: 2, EOM_IDN: 4, STD_DIP: 200 }),
    ];
    const big = buildGisNetwork(more.map((p) => (p.props.FTR_IDN === '102' ? { ...p, props: { ...p.props, STD_DIP: 600 } } : p)), manholes);
    const { project, report } = extractSewerProject(big, { usages: ['SBA004'], region: { kind: 'all' }, minPipes: 1, name: 't', defaultDiameter: 0.3 });
    expect(report.diversions).toBe(1);
    expect(project.conduits.map((c) => c.id).sort()).toEqual(['P101', 'P102', 'P103']);
    expect(() => buildNetwork(project)).not.toThrow();
  });

  it('구역 경계 안의 관만, 하류 맨홀의 상류만 가져온다', () => {
    const rings: XY[][] = [[[5, -5], [22, -5], [22, 15], [5, 15]]];
    expect(insideRings([10, 0], rings)).toBe(true);
    expect(insideRings([25, 0], rings)).toBe(false);
    const area = extractSewerProject(net, { usages: ['SBA004'], region: { kind: 'area', rings }, minPipes: 1, name: 't', defaultDiameter: 0.3 });
    expect(area.project.conduits.map((c) => c.id).sort()).toEqual(['P101', 'P103']);
    expect(area.project.nodes.find((n) => n.kind === 'OUTFALL')!.id).toBe('MH2');

    const up = extractSewerProject(net, { usages: ['SBA004'], region: { kind: 'outlet', nodeId: '2' }, minPipes: 1, name: 't', defaultDiameter: 0.3 });
    expect(up.project.conduits.map((c) => c.id).sort()).toEqual(['P101', 'P103']);
    expect(() => extractSewerProject(net, { usages: [], region: { kind: 'outlet', nodeId: '777' }, minPipes: 1, name: 't', defaultDiameter: 0.3 })).toThrow(/맨홀이 없습니다/);
  });

  it('작은 조각을 버린다', () => {
    const { report } = extractSewerProject(net, { usages: [], region: { kind: 'all' }, minPipes: 2, name: 't', defaultDiameter: 0.3 });
    expect(report.small).toBe(1); // 우수 박스 1 개짜리 조각
  });

  it('용도 코드 이름', () => {
    expect(usageLabel('SBA004')).toBe('오수');
    expect(usageLabel('SBA003')).toBe('우수');
    expect(usageLabel('합류관')).toBe('합류');
    expect(usageLabel('')).toBe('미상');
  });
});

describe('자료 점검 · 지형 자료', () => {
  const net = buildGisNetwork(pipes, manholes);
  const opts = { usages: ['SBA004'], region: { kind: 'all' as const }, minPipes: 1, name: 't', defaultDiameter: 0.3 };

  it('채우거나 뺀 것을 점검 목록으로 돌려준다', () => {
    const { notes } = extractSewerProject(net, opts);
    expect(notes.some((n) => n.id === 'MH4' && n.issue === '관저고 없음')).toBe(true);
    const diverted = extractSewerProject(buildGisNetwork([...pipes, pipe('104', [[20, 0], [20, 10]], { BOM_IDN: 2, EOM_IDN: 4, STD_DIP: 200 })], manholes), opts);
    expect(diverted.notes.find((n) => n.issue === '분기 관 뺌')).toMatchObject({ id: 'P104', removed: true });
  });

  it('지반고가 없으면 토피 다음으로 지형값을 쓴다', () => {
    // 맨홀 없이 관만: 끝점 지반고가 없고 토피도 없다
    const lone = buildGisNetwork([pipe('1', [[0, 0], [10, 0]], { SBK_HSL: '5', SBL_HSL: '4.9' })], []);
    const ids = lone.nodes.map((n) => n.id);
    const terrain = new Map([[ids[0], 7.2], [ids[1], 7.0]]);
    const { project, notes } = extractSewerProject(lone, { ...opts, terrain });
    expect(project.nodes.map((n) => n.ground)).toEqual([7.2, 7]);
    expect(notes.filter((n) => n.issue === '지반고 없음' && n.detail.includes('지형 자료'))).toHaveLength(2);
  });

  it('지형과 차이가 큰 지반고를 표시하거나 바꾼다', () => {
    const { project } = extractSewerProject(net, opts);
    const terrain = new Map([['MH1', 12.1], ['MH2', 14.0], ['MH3', 10.1]]);
    expect(terrainBias(project, terrain).samples).toBe(3);
    const shown = auditGroundWithTerrain(structuredClone(project), terrain, { threshold: 1, replace: false });
    expect(shown.notes.map((n) => n.id)).toEqual(['MH2', 'MH3']);
    expect(shown.changed).toBe(0);
    const p = structuredClone(project);
    // MH3 지형 10.1 은 관저고 9.5 + 관경 0.3 + 5 cm 보다 높으니 바뀌고, MH2 14.0 도 바뀐다
    const fixed = auditGroundWithTerrain(p, terrain, { threshold: 1, replace: true });
    expect(fixed.changed).toBe(2);
    expect(p.nodes.find((n) => n.id === 'MH3')!.ground).toBe(10.1);
    expect(() => parseSewerProject(p)).not.toThrow();
    // 관 꼭대기보다 낮은 지형값은 바꾸지 않는다
    const low = structuredClone(project);
    const r = auditGroundWithTerrain(low, new Map([['MH3', 9.6]]), { threshold: 1, replace: true });
    expect(r.changed).toBe(0);
    expect(r.notes[0].detail).toContain('바꾸지 않았습니다');
  });
});

describe('거꾸로 그려진 관', () => {
  it('하류 관이 둘인 맨홀에서 관저고가 거꾸로인 관은 빼지 않고 뒤집는다', () => {
    const net = buildGisNetwork([...pipes, pipe('105', [[20, 0], [20, -10]], { BOM_IDN: 2, EOM_IDN: 5, SBK_HSL: '9.9', SBL_HSL: '10.4' })], [...manholes, mh('5', 20, -10, 12.4, 10.4)]);
    const { project, report, notes } = extractSewerProject(net, { usages: ['SBA004'], region: { kind: 'all' }, minPipes: 1, name: 't', defaultDiameter: 0.3 });
    expect(report.flipped).toBe(1);
    expect(report.diversions).toBe(0);
    expect(project.conduits.find((c) => c.id === 'P105')).toMatchObject({ upstream: 'MH5', downstream: 'MH2' });
    expect(notes.some((n) => n.issue === '방향 뒤집음' && n.id === 'P105')).toBe(true);
    // 원본 관망은 바뀌지 않는다
    expect(net.nodes[net.links.find((l) => l.id === 'P105')!.from].id).toBe('MH2');
    expect(() => buildNetwork(project)).not.toThrow();
  });
});
