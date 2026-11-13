import { describe, expect, it } from 'vitest';
import { parseInp } from '../io/inpParser';
import { renameLink, renameNode, splitPipe } from './networkEdit';

const TEXT = [
  '[JUNCTIONS]', ' A 10 1', ' B 10 1',
  '[TANKS]', ' T1 60 3 0 5 10 0',
  '[RESERVOIRS]', ' R 50',
  '[PIPES]', ' P1 R A 100 150 110 0 Open', ' P2 A B 100 150 110 0 Open', ' P3 B T1 100 150 110 0 Open',
  '[DEMANDS]', ' A 1 PAT1', ' A 2 PAT2',
  '[CONTROLS]', ' LINK P2 CLOSED IF NODE T1 ABOVE 4.5', ' LINK P3 OPEN AT TIME 6',
  '[RULES]', ' RULE 1', ' IF TANK T1 LEVEL BELOW 1', ' THEN PIPE P2 STATUS IS OPEN',
  '[REACTIONS]', ' Bulk P2 -0.7',
  '[OPTIONS]', ' Quality Trace T1',
  '[COORDINATES]', ' A 127.0 37.0', ' B 127.001 37.0', ' R 126.999 37.0', ' T1 127.002 37.0',
  '[END]',
].join('\n');

describe('renameNode / renameLink', () => {
  it('제어 규칙·원문 섹션·추적 절점의 ID 참조도 함께 바꾼다', () => {
    const { model } = parseInp(TEXT);
    expect(renameNode(model, 'T1', 'TANK_N')).toBe(true);
    expect(renameNode(model, 'A', 'J_A')).toBe(true);
    expect(renameLink(model, 'P2', 'MAIN2')).toBe(true);

    expect(model.extraSections.CONTROLS).toEqual(['LINK MAIN2 CLOSED IF NODE TANK_N ABOVE 4.5', 'LINK P3 OPEN AT TIME 6']);
    expect(model.extraSections.RULES).toEqual(['RULE 1', 'IF TANK TANK_N LEVEL BELOW 1', 'THEN PIPE MAIN2 STATUS IS OPEN']);
    expect(model.extraSections.DEMANDS).toEqual(['J_A 1 PAT1', 'J_A 2 PAT2']);
    expect(model.extraSections.REACTIONS).toEqual(['Bulk MAIN2 -0.7']);
    expect(model.options.quality.traceNode).toBe('TANK_N');
    expect(model.links.P3.endNodeId).toBe('TANK_N');
  });

  it('이미 있는 ID 나 공백이 든 ID 로는 바꾸지 않는다', () => {
    const { model } = parseInp(TEXT);
    expect(renameNode(model, 'A', 'B')).toBe(false);
    expect(renameLink(model, 'P1', 'P 1')).toBe(false);
  });
});

describe('splitPipe', () => {
  it('관로를 둘로 나누고 총 연장을 보존한다', () => {
    const { model } = parseInp(TEXT);
    const pipe = model.links.P2;
    const total = pipe.type === 'pipe' ? pipe.length : 0;
    const result = splitPipe(model, 'P2', [127.0005, 37.0]);
    expect(result).not.toBeNull();
    const left = model.links.P2;
    const right = model.links[result!.newPipeId];
    expect(left.endNodeId).toBe(result!.nodeId);
    expect(right.startNodeId).toBe(result!.nodeId);
    if (left.type === 'pipe' && right.type === 'pipe') {
      expect(left.length + right.length).toBeCloseTo(total, 1);
    }
  });
});
