import { describe, expect, it } from 'vitest';
import epanetInp from '../../../public/samples/sample-district.inp?raw';
import sewerInp from '../../../public/samples/sample-sewer.inp?raw';
import { distanceMeters } from '../../utils/geoMath';
import { looksLikeSwmm, readSwmmInp, routingOf, withRouting } from './inpReader';

describe('readSwmmInp', () => {
  const project = readSwmmInp(sewerInp);

  it('SWMM 과 EPANET 파일을 구별한다', () => {
    expect(looksLikeSwmm(sewerInp)).toBe(true);
    expect(looksLikeSwmm(epanetInp)).toBe(false);
  });

  it('절점·관거·유역·강우계를 읽고 좌표계를 변환한다', () => {
    expect(project.flowUnits).toBe('CMS');
    expect(project.us).toBe(false);
    expect(project.crsLabel).toContain('5186');
    expect(project.nodes.map((n) => `${n.id}:${n.kind}`)).toEqual(['J1:junction', 'J2:junction', 'J3:junction', 'J4:junction', 'J5:junction', 'J6:junction', 'O1:outfall']);
    expect(project.nodes[0]).toMatchObject({ invert: 30, maxDepth: 2 });
    for (const n of project.nodes) {
      expect(n.position[0]).toBeGreaterThan(127.3);
      expect(n.position[1]).toBeGreaterThan(36.3);
    }
    expect(project.links).toHaveLength(6);
    expect(project.links.find((l) => l.id === 'C5')).toMatchObject({ from: 'J4', to: 'J6', shape: 'CIRCULAR', geom1: 0.6, length: 90 });
    expect(project.links.find((l) => l.id === 'C4')!.vertices).toHaveLength(1);
    expect(project.subcatchments.map((s) => [s.id, s.outlet, s.polygon.length])).toEqual([['S1', 'J1', 4], ['S2', 'J2', 4], ['S3', 'J3', 4], ['S4', 'J5', 4]]);
    expect(project.gages).toHaveLength(1);
    expect(project.warnings).toEqual([]);
  });

  it('좌표가 전부 0 인 파일은 연장 기준 개략도로 배치한다', () => {
    const text = [
      '[OPTIONS]', 'FLOW_UNITS CMS', 'FLOW_ROUTING STEADY',
      '[JUNCTIONS]', 'A 10 1', 'B 9 1', 'C 8 1', 'D 8 1',
      '[OUTFALLS]', 'O 7 FREE NO',
      '[CONDUITS]', 'P1 A B 100 0.01 0 0 0', 'P2 B C 50 0.01 0 0 0', 'P3 D C 40 0.01 0 0 0', 'P4 C O 80 0.01 0 0 0',
      '[COORDINATES]', 'A 0 0', 'B 0 0', 'C 0 0', 'D 0 0', 'O 0 0',
    ].join('\n');
    const p = readSwmmInp(text);
    expect(p.crsLabel).toContain('개략');
    expect(p.warnings.some((w) => w.includes('좌표가 없어'))).toBe(true);
    expect(p.nodes).toHaveLength(5);
    const at = (id: string) => p.nodes.find((n) => n.id === id)!.position;
    const lengths: [string, string, number][] = [['A', 'B', 100], ['B', 'C', 50], ['D', 'C', 40], ['C', 'O', 80]];
    for (const [a, b, len] of lengths) {
      const d = distanceMeters(at(a), at(b));
      expect(d).toBeGreaterThan(len * 0.97);
      expect(d).toBeLessThan(len * 1.03);
    }
    // 모든 절점이 서로 다른 위치
    expect(new Set(p.nodes.map((n) => n.position.join(','))).size).toBe(5);
  });

  it('해석 직전 FLOW_ROUTING 을 바꾼 사본을 만들고 원문은 그대로 둔다', () => {
    const text = '[OPTIONS]\nFLOW_UNITS CMS\nFLOW_ROUTING STEADY\n\n[JUNCTIONS]\n';
    expect(routingOf(text)).toBe('STEADY');
    expect(withRouting(text, 'DYNWAVE')).toContain('FLOW_ROUTING DYNWAVE');
    expect(withRouting(text, 'original')).toBe(text);
    expect(withRouting('[OPTIONS]\nFLOW_UNITS CMS\n', 'KINWAVE')).toContain('FLOW_ROUTING KINWAVE');
    expect(routingOf('[OPTIONS]\nFLOW_UNITS CMS\n')).toBe('KINWAVE');
  });

  it('좌표가 없는 절점은 경고하고 건너뛴다', () => {
    const p = readSwmmInp('[JUNCTIONS]\nA 10 2 0 0 0\nB 9 2 0 0 0\n[CONDUITS]\nC1 A B 10 0.013 0 0\n[COORDINATES]\nA 127 37\n');
    expect(p.nodes).toHaveLength(1);
    expect(p.links).toHaveLength(0);
    expect(p.warnings.length).toBe(2);
  });
});
