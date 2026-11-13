import { describe, expect, it } from 'vitest';
import { designSewer } from './design';
import {
  addSewerConduit, addSewerNode, applyGroundLevels, conduitProblem, deleteSewerConduit, deleteSewerNode, emptySewerProject, idProblem, moveSewerNode,
  nextSewerId, renameSewerNode, setSewerNodeKind, sewerSummary,
} from './edit';
import { nodeLngLat, sewerFrame, xyToLngLat } from './mapFrame';
import { demoProject } from './types';
import { parseSewerProject } from './validate';

const at = (x: number, y: number) => xyToLngLat({ kind: 'epsg' }, x, y);

describe('하수 ID 생성', () => {
  it('가장 큰 번호 다음을 쓴다', () => {
    expect(nextSewerId('MH', [])).toBe('MH001');
    expect(nextSewerId('MH', ['MH001', 'MH007', 'X1'])).toBe('MH008');
    expect(nextSewerId('MH', ['MH1', 'MH8'])).toBe('MH009');
    expect(nextSewerId('OF', ['OF1'], 1)).toBe('OF2');
    expect(nextSewerId('P', ['P01', 'P08'])).toBe('P009');
  });
  it('ID 규칙·중복 검사', () => {
    expect(idProblem(['A', 'B'], 'A', 'B')).toContain('이미');
    expect(idProblem(['A', 'B'], 'A', '1A')).toContain('영문');
    expect(idProblem(['A', 'B'], 'A', 'A')).toBeNull();
    expect(idProblem(['A', 'B'], 'A', 'C-1')).toBeNull();
  });
});

describe('하수 관망 지도 편집', () => {
  it('빈 관망에 맨홀·방류구·관거를 그리면 검증과 자동 설계를 통과한다', () => {
    const p = emptySewerProject();
    const a = addSewerNode(p, 'JUNCTION', at(234000, 417000));
    const b = addSewerNode(p, 'JUNCTION', at(234030, 417040));
    const o = addSewerNode(p, 'OUTFALL', at(234030, 417100));
    expect([a, b, o]).toEqual(['MH001', 'MH002', 'OF1']);
    expect(p.nodes[0]).toMatchObject({ ground: 0, invert: -1.8, kind: 'JUNCTION' });
    expect(p.nodes[0].x).toBeCloseTo(234000, 2);
    expect(addSewerConduit(p, a, b)).toBe('P001');
    expect(addSewerConduit(p, b, o)).toBe('P002');
    expect(p.conduits[0].length).toBeCloseTo(50, 1);
    expect(p.conduits[1].length).toBeCloseTo(60, 1);
    p.nodes[0].base_flow = 0.004;
    const parsed = parseSewerProject(JSON.parse(JSON.stringify(p)));
    expect(designSewer(parsed, {}, 'practical').rows).toHaveLength(2);
    expect(sewerSummary(p)).toMatchObject({ manholes: 2, outfalls: 1, conduits: 2 });
    expect(sewerSummary(p).totalLength).toBeCloseTo(110, 1);
  });

  it('새 맨홀의 지반고는 가장 가까운 절점에서 가져온다', () => {
    const p = emptySewerProject();
    addSewerNode(p, 'JUNCTION', at(234000, 417000));
    p.nodes[0].ground = 35;
    addSewerNode(p, 'JUNCTION', at(234500, 417000));
    p.nodes[1].ground = 20;
    const id = addSewerNode(p, 'JUNCTION', at(234100, 417000));
    expect(p.nodes.find((n) => n.id === id)).toMatchObject({ ground: 35, invert: 33.2 });
  });

  it('가지형 규칙에 어긋나는 관거는 거절한다', () => {
    const p = demoProject();
    expect(conduitProblem(p, 'MH1', 'MH1')).toContain('같은');
    expect(conduitProblem(p, 'OF1', 'MH1')).toContain('방류구');
    expect(conduitProblem(p, 'MH1', 'MH2')).toContain('이미 관거');
    expect(conduitProblem(p, 'MH1', 'MH5')).toContain('하류 관거');
    deleteSewerConduit(p, 'P08'); // MH8 → OF1
    expect(conduitProblem(p, 'MH8', 'MH1')).toContain('순환');
    expect(addSewerConduit(p, 'MH8', 'MH1')).toBeNull();
    expect(addSewerConduit(p, 'MH8', 'OF1')).toBe('P008');
  });

  it('절점을 옮기면 붙은 관거 연장만 다시 계산한다', () => {
    const p = demoProject();
    // 예제는 도면 좌표 — 옮기는 순간 전체가 5186 으로 바뀌고 절점 간 거리는 유지된다
    const frame = sewerFrame(p);
    const target = nodeLngLat(frame, { x: 125, y: 220 }); // MH2(125,120) 를 북쪽으로 100 m
    expect(moveSewerNode(p, 'MH2', target)).toBe(true);
    expect(sewerFrame(p).kind).toBe('epsg');
    const len = (id: string) => p.conduits.find((c) => c.id === id)!.length;
    expect(len('P01')).toBeCloseTo(Math.hypot(125, 100), 1); // MH1 → MH2
    expect(len('P02')).toBeCloseTo(Math.hypot(125, 155), 1); // MH2 → MH5
    expect(len('P03')).toBe(125); // 관계없는 관거는 그대로
    expect(moveSewerNode(p, '없음', target)).toBe(false);
  });

  it('맨홀을 지우면 붙은 관거와 유역도 지운다', () => {
    const p = demoProject();
    expect(deleteSewerNode(p, 'MH5')).toBe(true);
    expect(p.nodes.some((n) => n.id === 'MH5')).toBe(false);
    expect(p.conduits.map((c) => c.id)).toEqual(['P01', 'P03', 'P06', 'P07', 'P08']);
    expect(p.catchments.some((s) => s.outlet === 'MH5')).toBe(false);
    expect(deleteSewerNode(p, 'MH5')).toBe(false);
  });

  it('ID 변경은 관거·유역 참조를 함께 바꾼다', () => {
    const p = demoProject();
    expect(renameSewerNode(p, 'MH5', 'J-5')).toBe(true);
    expect(p.conduits.filter((c) => c.upstream === 'J-5' || c.downstream === 'J-5')).toHaveLength(3);
    expect(p.catchments.find((s) => s.id === 'S5')!.outlet).toBe('J-5');
    expect(renameSewerNode(p, 'MH1', 'MH2')).toBe(false);
    expect(() => parseSewerProject(JSON.parse(JSON.stringify(p)))).not.toThrow();
  });

  it('방류구로 바꾸면 직접 유입과 유역 출구를 정리한다', () => {
    const p = demoProject();
    setSewerNodeKind(p, 'MH8', 'OUTFALL');
    expect(p.nodes.find((n) => n.id === 'MH8')).toMatchObject({ kind: 'OUTFALL', base_flow: 0 });
    expect(p.catchments.some((s) => s.outlet === 'MH8')).toBe(false);
  });

  it('지반고 보정: 깊이 유지 / 지반고만', () => {
    const keep = demoProject();
    const values = keep.nodes.map((n) => n.ground + 2);
    values[1] = NaN;
    const r1 = applyGroundLevels(keep, values, true);
    expect(r1).toMatchObject({ changed: 8, invertAdjusted: 0 });
    expect(r1.meanAbs).toBeCloseTo(2, 6);
    expect(keep.nodes[0]).toMatchObject({ ground: 106, invert: 104.2 });
    expect(keep.nodes[1].ground).toBe(103.4);

    const only = demoProject();
    const r2 = applyGroundLevels(only, only.nodes.map((n, i) => (i === 0 ? n.invert - 1 : n.ground)), false);
    expect(r2).toMatchObject({ changed: 1, invertAdjusted: 1 });
    expect(only.nodes[0].ground).toBeCloseTo(101.2, 6);
    expect(only.nodes[0].invert).toBeCloseTo(99.4, 6);
    expect(() => parseSewerProject(JSON.parse(JSON.stringify(only)))).not.toThrow();
  });
});
