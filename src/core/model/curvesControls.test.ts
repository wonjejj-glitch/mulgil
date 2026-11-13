import { describe, expect, it } from 'vitest';
import { parseInp } from '../io/inpParser';
import { writeInp } from '../io/inpWriter';
import {
  buildControlLine,
  checkControls,
  checkCurve,
  curveUsages,
  deleteCurve,
  patternUsageCount,
  renameCurve,
  renamePattern,
} from './curvesControls';

const TEXT = [
  '[JUNCTIONS]', ' A 10 1 PAT1', ' B 10 1',
  '[TANKS]', ' T1 60 3 0 5 10 0 VOL1',
  '[RESERVOIRS]', ' R 50',
  '[PIPES]', ' P1 A B 100 150 110 0 Open', ' P2 B T1 100 150 110 0 Open',
  '[PUMPS]', ' PU1 R A HEAD C1 PATTERN PAT1',
  '[CURVES]', ' C1 10 40', ' VOL1 0 0', ' VOL1 5 100',
  '[PATTERNS]', ' PAT1 1 1.2 0.8',
  '[ENERGY]', ' Pump PU1 Pattern PAT1',
  '[COORDINATES]', ' A 127.0 37.0', ' B 127.001 37.0', ' R 126.999 37.0', ' T1 127.002 37.0',
  '[END]',
].join('\n');

describe('곡선', () => {
  it('참조를 찾고, 이름을 바꾸면 참조도 따라간다', () => {
    const { model } = parseInp(TEXT);
    expect(curveUsages(model, 'C1')).toEqual([{ kind: 'pump', id: 'PU1' }]);
    expect(curveUsages(model, 'VOL1')).toEqual([{ kind: 'tank', id: 'T1' }]);
    expect(renameCurve(model, 'C1', 'PUMPCURVE')).toBe(true);
    expect(model.links.PU1.type === 'pump' && model.links.PU1.headCurve).toBe('PUMPCURVE');
    expect(model.curves.PUMPCURVE).toEqual([[10, 40]]);
    expect(renameCurve(model, 'PUMPCURVE', 'VOL1')).toBe(false);
  });

  it('지우면 펌프는 정동력 펌프로 바뀌고 직렬화가 유효하다', () => {
    const { model } = parseInp(TEXT);
    deleteCurve(model, 'C1');
    const pump = model.links.PU1;
    expect(pump.type === 'pump' && pump.headCurve).toBe('');
    expect(pump.type === 'pump' && pump.power).toBeGreaterThan(0);
    expect(writeInp(model)).toMatch(/PU1\s+R\s+A\s+POWER/);
  });

  it('곡선 형식을 검사한다', () => {
    expect(checkCurve([[10, 40]], true).ok).toBe(true);
    expect(checkCurve([[0, 50], [10, 40], [20, 25]], true).ok).toBe(true);
    expect(checkCurve([[0, 50], [10, 40]], true).ok).toBe(false);
    expect(checkCurve([[0, 50], [10, 60], [20, 25]], true).ok).toBe(false);
    expect(checkCurve([[0, 0], [0, 10]], false).ok).toBe(false);
    expect(checkCurve([[0, 0], [5, 100]], false).ok).toBe(true);
  });
});

describe('패턴', () => {
  it('이름을 바꾸면 절점·펌프·[ENERGY] 참조가 따라간다', () => {
    const { model } = parseInp(TEXT);
    expect(patternUsageCount(model, 'PAT1')).toBe(2);
    expect(renamePattern(model, 'PAT1', 'DAY')).toBe(true);
    expect(model.nodes.A.type === 'junction' && model.nodes.A.pattern).toBe('DAY');
    expect(model.links.PU1.type === 'pump' && model.links.PU1.pattern).toBe('DAY');
    expect(model.extraSections.ENERGY).toEqual(['Pump PU1 Pattern DAY']);
  });
});

describe('제어 규칙', () => {
  const { model } = parseInp(TEXT);

  it('단순 제어 줄을 만들고 검사한다', () => {
    const a = buildControlLine('P1', 'CLOSED', 0, { kind: 'time', hours: 6.5 });
    expect(a).toBe('LINK P1 CLOSED AT TIME 6:30');
    const b = buildControlLine('PU1', 'OPEN', 0, { kind: 'node', nodeId: 'T1', comparison: 'BELOW', value: 1.5 });
    expect(b).toBe('LINK PU1 OPEN IF NODE T1 BELOW 1.5');
    expect(checkControls(model, 'CONTROLS', [a, b])).toEqual([]);
  });

  it('없는 객체와 잘못된 형식을 알려 준다', () => {
    const issues = checkControls(model, 'CONTROLS', ['LINK P9 OPEN AT TIME 2', 'LINK P1 SHUT AT TIME 2', '; 주석만 있는 줄']);
    expect(issues.some((i) => i.line === 0 && i.message.includes('P9'))).toBe(true);
    expect(issues.some((i) => i.line === 1)).toBe(true);
    expect(issues.some((i) => i.line === 2)).toBe(false);
    const rules = checkControls(model, 'RULES', ['RULE 1', 'IF TANK T9 LEVEL BELOW 1', 'THEN PUMP PU1 STATUS IS OPEN']);
    expect(rules).toEqual([{ line: 1, message: "절점 'T9' 이(가) 없습니다." }]);
  });
});
