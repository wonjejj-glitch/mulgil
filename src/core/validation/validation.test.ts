import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import errorInp from '../../../public/samples/sample-errors.inp?raw';
import sampleInp from '../../../public/samples/sample-district.inp?raw';
import { parseInp } from '../io/inpParser';
import { addLink, addNode, splitPipe } from '../model/networkEdit';
import { createEmptyModel } from '../model/types';
import { applyAutoFix } from './autoFix';
import { countByType, DEFAULT_VALIDATION_OPTIONS, runValidation } from './index';

describe('runValidation', () => {
  it('정상 샘플에서는 오류가 없다', () => {
    expect(runValidation(parseInp(sampleInp).model)).toEqual([]);
  });

  it('오류 샘플에서 유형별 오류를 찾는다', () => {
    const issues = runValidation(parseInp(errorInp).model);
    const counts = countByType(issues);
    expect(counts.orphanNode).toBe(1);
    expect(counts.duplicatePipe).toBe(1);
    expect(counts.microPipe).toBe(1);
    // 단절 구역: 남쪽의 독립 블록 + 관로 위에 놓였지만 연결되지 않은 T자 가지
    expect(counts.disconnected).toBe(2);
    expect(counts.crossing).toBe(1);
    expect(counts.tee).toBe(1);

    expect(issues.find((i) => i.type === 'orphanNode')?.nodeIds).toEqual(['J901']);
    expect(issues.find((i) => i.type === 'duplicatePipe')?.linkIds[0]).toBe('P901');
    expect(issues.find((i) => i.type === 'microPipe')?.linkIds).toEqual(['P902']);
    const blocks = issues.filter((i) => i.type === 'disconnected').map((i) => [...i.nodeIds].sort());
    expect(blocks).toContainEqual(['J903', 'J904', 'J905']);
    expect(blocks).toContainEqual(['J906', 'J907']);
    expect([...(issues.find((i) => i.type === 'crossing')?.linkIds ?? [])].sort()).toEqual(['P905', 'P906']);
    expect(issues.find((i) => i.type === 'tee')?.nodeIds).toEqual(['J906']);
  });

  it('수원이 없으면 noSource 오류를 낸다', () => {
    const model = createEmptyModel();
    const a = addNode(model, 'junction', [127, 37]);
    const b = addNode(model, 'junction', [127.001, 37]);
    addLink(model, 'pipe', a.id, b.id);
    expect(runValidation(model).map((i) => i.type)).toEqual(['noSource']);
  });
});

describe('applyAutoFix', () => {
  it('보정 가능한 오류를 모두 고치고 단절 구역만 남긴다', () => {
    const model = parseInp(errorInp).model;
    const issues = runValidation(model);
    const totalDemandBefore = Object.values(model.nodes).reduce((s, n) => s + (n.type === 'junction' ? n.demand : 0), 0);

    let report;
    const fixed = produce(model, (draft) => {
      report = applyAutoFix(
        draft,
        issues,
        { orphanNode: true, duplicatePipe: true, microPipe: true, crossing: true, tee: true, selfLoop: true },
        DEFAULT_VALIDATION_OPTIONS,
      );
    });
    expect(report).toMatchObject({
      removedOrphans: 1,
      removedDuplicates: 1,
      mergedMicroPipes: 1,
      splitCrossings: 1,
      connectedTees: 1,
    });

    const remaining = runValidation(fixed);
    expect(remaining.map((i) => i.type)).toEqual(['disconnected']);
    expect(fixed.nodes.J901).toBeUndefined();
    expect(fixed.links.P901).toBeUndefined();
    expect(fixed.links.P902).toBeUndefined();
    expect(fixed.nodes.J902).toBeUndefined();
    // 교차점에 새 절점이 생기고 두 대각선 관로가 각각 둘로 나뉜다 (+1 절점, +2 관로)
    // T자 보정은 관로 1개를 둘로 나눈다 (+1 관로)
    const nodeDelta = Object.keys(fixed.nodes).length - Object.keys(model.nodes).length;
    const linkDelta = Object.keys(fixed.links).length - Object.keys(model.links).length;
    expect(nodeDelta).toBe(-1 /* 고립 */ - 1 /* 병합 */ + 1 /* 교차점 */);
    expect(linkDelta).toBe(-1 /* 중복 */ - 1 /* 미소 */ + 2 /* 교차 분할 */ + 1 /* T자 분할 */);
    // 미소 관로 병합 시 수요량은 보존된다
    const totalDemandAfter = Object.values(fixed.nodes).reduce((s, n) => s + (n.type === 'junction' ? n.demand : 0), 0);
    expect(totalDemandAfter).toBeCloseTo(totalDemandBefore, 6);
  });
});

describe('splitPipe', () => {
  it('관로를 나누면 연장 합이 보존되고 꺾임점이 양쪽에 나뉜다', () => {
    const model = createEmptyModel();
    const a = addNode(model, 'junction', [127.0, 37.0]);
    const b = addNode(model, 'junction', [127.002, 37.0]);
    a.elevation = 10;
    b.elevation = 20;
    const pipe = addLink(model, 'pipe', a.id, b.id, [[127.001, 37.0005]]);
    if (!pipe || pipe.type !== 'pipe') throw new Error('pipe');
    const total = pipe.length;
    const result = splitPipe(model, pipe.id, [127.0005, 37.00025]);
    expect(result).not.toBeNull();
    const left = model.links[pipe.id];
    const right = model.links[result!.newPipeId];
    if (left.type !== 'pipe' || right.type !== 'pipe') throw new Error('pipe');
    expect(left.endNodeId).toBe(result!.nodeId);
    expect(right.startNodeId).toBe(result!.nodeId);
    expect(left.vertices).toHaveLength(0);
    expect(right.vertices).toHaveLength(1);
    expect(left.length + right.length).toBeCloseTo(total, 1);
    const mid = model.nodes[result!.nodeId];
    expect(mid.elevation).toBeGreaterThan(10);
    expect(mid.elevation).toBeLessThan(20);
  });
});
