import { describe, expect, it } from 'vitest';
import sewerInp from '../../../public/samples/sample-sewer.inp?raw';
import { designSewer } from './design';
import { sewerProjectFromSwmm } from './fromSwmmInp';
import { generateInp } from './inp';
import { sewerFrame } from './mapFrame';
import { demoProject } from './types';

const MIXED = [
  '[OPTIONS]',
  'FLOW_UNITS LPS',
  'LINK_OFFSETS ELEVATION',
  '[JUNCTIONS]',
  '1 10 0',
  '2 9.5 2.5',
  '[OUTFALLS]',
  'out 9 TIDAL curve1',
  '[STORAGE]',
  'ST1 9.2 3 0 FUNCTIONAL 100 0 0',
  '[CONDUITS]',
  '10 1 2 50 0.012 10.2 *',
  '11 2 ST1 40 0.013 0 0',
  '12 ST1 out 30 0.013 0 0',
  '[PUMPS]',
  'PU1 2 out curve ON',
  '[XSECTIONS]',
  '10 CIRCULAR 0.3 0 0 0',
  '11 RECT_CLOSED 0.8 1.2 0 0',
  '12 CIRCULAR 0.5 0 0 0',
  '[DWF]',
  '1 FLOW 2.5',
  '[SUBCATCHMENTS]',
  'A1 RG 1 1.5 40 60 0.8 0',
  'A2 RG out 1 40 60 0.8 0',
  '[COORDINATES]',
  '1 200000 500000',
  '2 200050 500000',
  'ST1 200090 500000',
  'out 200120 500000',
  '',
].join('\n');

describe('SWMM .inp → 하수 프로젝트', () => {
  it('샘플 우수관망: 절점·관거·유역과 5186 좌표를 옮긴다', () => {
    const { project, warnings, valid } = sewerProjectFromSwmm(sewerInp);
    expect(valid).toBe(true);
    expect(project.nodes.map((n) => `${n.id}:${n.kind}`)).toEqual(['J1:JUNCTION', 'J2:JUNCTION', 'J3:JUNCTION', 'J4:JUNCTION', 'J5:JUNCTION', 'J6:JUNCTION', 'O1:OUTFALL']);
    expect(project.nodes[0]).toMatchObject({ invert: 30, ground: 32 });
    expect(sewerFrame(project).kind).toBe('epsg');
    expect(project.conduits).toHaveLength(6);
    expect(project.conduits.find((c) => c.id === 'C5')).toMatchObject({ upstream: 'J4', downstream: 'J6', diameter: 0.6, length: 90 });
    expect(project.catchments.map((s) => [s.id, s.outlet])).toEqual([['S1', 'J1'], ['S2', 'J2'], ['S3', 'J3'], ['S4', 'J5']]);
    expect(project.catchments[0].area).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('유출계수'))).toBe(true);
  });

  it('우리 INP 생성기 출력은 값이 그대로 돌아온다 (예제 왕복)', () => {
    const original = demoProject();
    original.conduits[0].inlet_offset = 0.1;
    const { project, valid } = sewerProjectFromSwmm(generateInp(original));
    expect(valid).toBe(true);
    for (const n of original.nodes.filter((x) => x.kind === 'JUNCTION')) {
      const got = project.nodes.find((x) => x.id === n.id)!;
      expect(got.invert).toBeCloseTo(n.invert, 6);
      expect(got.ground).toBeCloseTo(n.ground, 6);
      expect(got.base_flow).toBeCloseTo(n.base_flow, 9);
    }
    expect(project.nodes.find((n) => n.id === 'OF1')).toMatchObject({ kind: 'OUTFALL', invert: 98.2, boundary: 'FREE' });
    for (const c of original.conduits) {
      expect(project.conduits.find((x) => x.id === c.id)).toMatchObject({ upstream: c.upstream, downstream: c.downstream, length: c.length, diameter: c.diameter, roughness: c.roughness, inlet_offset: c.inlet_offset });
    }
    expect(project.catchments).toHaveLength(original.catchments.length);
    expect(project.catchments[0]).toMatchObject({ outlet: 'MH1', impervious: 60, width: 80, slope: 1, horton_max: 75, horton_min: 5, horton_decay: 4 });
    // 도면 좌표(임의 평면)는 기준 위치에 놓인 뒤 5186 으로 바뀌고, 절점 간 거리는 유지된다
    expect(sewerFrame(project).kind).toBe('epsg');
    const a = project.nodes.find((n) => n.id === 'MH1')!;
    const b = project.nodes.find((n) => n.id === 'MH2')!;
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(125, 0);
    expect(designSewer(project, {}, 'practical').rows).toHaveLength(8);
  });

  it('옮길 수 없는 것은 경고로 알린다', () => {
    const { project, warnings, valid } = sewerProjectFromSwmm(MIXED, '시험');
    expect(valid).toBe(true);
    expect(project.name).toBe('시험');
    expect(project.nodes.map((n) => n.id)).toEqual(['N1', 'N2', 'out', 'ST1']);
    expect(project.nodes[0]).toMatchObject({ invert: 10, ground: 12, base_flow: 0.0025 });
    expect(project.nodes.find((n) => n.id === 'out')).toMatchObject({ kind: 'OUTFALL', boundary: 'FREE' });
    expect(project.conduits.map((c) => c.id)).toEqual(['C10', 'C11', 'C12']);
    // LINK_OFFSETS ELEVATION: 10.2 − 10 = 0.2, '*' = 0
    expect(project.conduits[0]).toMatchObject({ upstream: 'N1', downstream: 'N2', inlet_offset: 0.2, outlet_offset: 0, roughness: 0.012 });
    expect(project.conduits[1].diameter).toBe(0.8);
    expect(project.catchments.map((s) => [s.id, s.outlet])).toEqual([['A1', 'N1']]);
    const all = warnings.join('\n');
    for (const word of ['LPS', '최대 수심이 0', '저류조', 'TIDAL', '원형이 아닌', '펌프', '출구가 맨홀이 아닌', 'ID 5개']) expect(all).toContain(word);
  });
});
