/**
 * 곡선([CURVES])·패턴([PATTERNS])·제어 규칙([CONTROLS]/[RULES]) 편집 보조 함수.
 * 모두 전달받은 model 을 직접 변경하므로 immer draft 에 대해서만 호출한다.
 */
import { isValidId } from './networkEdit';
import type { NetworkModel } from './types';

/* ------------------------------------------------------------------ 곡선 */

export interface CurveUsage {
  kind: 'pump' | 'tank' | 'valve';
  id: string;
}

/** 곡선을 참조하는 펌프(양정)·배수지(체적)·GPV 밸브. */
export function curveUsages(model: NetworkModel, curveId: string): CurveUsage[] {
  const usages: CurveUsage[] = [];
  for (const id in model.links) {
    const link = model.links[id];
    if (link.type === 'pump' && link.headCurve === curveId) usages.push({ kind: 'pump', id });
    if (link.type === 'valve' && link.valveType === 'GPV' && link.setting === curveId) usages.push({ kind: 'valve', id });
  }
  for (const id in model.nodes) {
    const node = model.nodes[id];
    if (node.type === 'tank' && node.volumeCurve === curveId) usages.push({ kind: 'tank', id });
  }
  return usages;
}

export function renameCurve(model: NetworkModel, oldId: string, newId: string): boolean {
  if (oldId === newId) return true;
  if (!(oldId in model.curves) || newId in model.curves || !isValidId(newId)) return false;
  model.curves[newId] = model.curves[oldId];
  delete model.curves[oldId];
  for (const usage of curveUsages(model, oldId)) {
    if (usage.kind === 'pump') {
      const link = model.links[usage.id];
      if (link.type === 'pump') link.headCurve = newId;
    } else if (usage.kind === 'valve') {
      const link = model.links[usage.id];
      if (link.type === 'valve') link.setting = newId;
    } else {
      const node = model.nodes[usage.id];
      if (node.type === 'tank') node.volumeCurve = newId;
    }
  }
  renameTokenInSections(model, ['ENERGY'], oldId, newId);
  return true;
}

/** 곡선을 지우고 참조를 해제한다. 양정 곡선을 잃은 펌프는 정동력(POWER) 펌프가 된다. */
export function deleteCurve(model: NetworkModel, curveId: string): void {
  for (const usage of curveUsages(model, curveId)) {
    if (usage.kind === 'pump') {
      const link = model.links[usage.id];
      if (link.type === 'pump') {
        link.headCurve = '';
        if (!(link.power > 0)) link.power = 10;
      }
    } else if (usage.kind === 'tank') {
      const node = model.nodes[usage.id];
      if (node.type === 'tank') node.volumeCurve = '';
    }
    // GPV 는 곡선 없이는 해석할 수 없으므로 설정값을 그대로 두어 해석 시 오류로 알린다.
  }
  delete model.curves[curveId];
}

export interface CurveCheck {
  ok: boolean;
  message?: string;
}

/** EPANET 이 받아들이는 곡선인지: X 값이 엄격히 증가해야 하고, 양정 곡선은 1·3점 또는 X 증가·Y 감소. */
export function checkCurve(points: [number, number][], asPumpCurve: boolean): CurveCheck {
  if (points.length === 0) return { ok: false, message: '점이 하나 이상 있어야 합니다.' };
  for (let i = 1; i < points.length; i++) {
    if (!(points[i][0] > points[i - 1][0])) return { ok: false, message: `${i + 1}번째 점의 X 값이 앞 점보다 커야 합니다.` };
  }
  if (asPumpCurve) {
    if (points.length === 2) return { ok: false, message: '양정 곡선은 1점(설계점), 3점 또는 4점 이상이어야 합니다.' };
    for (let i = 1; i < points.length; i++) {
      if (!(points[i][1] < points[i - 1][1])) return { ok: false, message: '양정 곡선은 유량이 늘수록 양정이 줄어야 합니다.' };
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ 패턴 */

export function patternUsageCount(model: NetworkModel, patternId: string): number {
  let count = 0;
  for (const id in model.nodes) {
    const node = model.nodes[id];
    if (node.type !== 'tank' && node.pattern === patternId) count++;
    if (node.source?.pattern === patternId) count++;
  }
  for (const id in model.links) {
    const link = model.links[id];
    if (link.type === 'pump' && link.pattern === patternId) count++;
  }
  return count;
}

export function renamePattern(model: NetworkModel, oldId: string, newId: string): boolean {
  if (oldId === newId) return true;
  if (!(oldId in model.patterns) || newId in model.patterns || !isValidId(newId)) return false;
  model.patterns[newId] = model.patterns[oldId];
  delete model.patterns[oldId];
  for (const id in model.nodes) {
    const node = model.nodes[id];
    if (node.type !== 'tank' && node.pattern === oldId) node.pattern = newId;
    if (node.source?.pattern === oldId) node.source.pattern = newId;
  }
  for (const id in model.links) {
    const link = model.links[id];
    if (link.type === 'pump' && link.pattern === oldId) link.pattern = newId;
  }
  // [DEMANDS] "절점 수요 패턴", [ENERGY] "... PATTERN id"
  for (const line of ['DEMANDS'] as const) {
    const lines = model.extraSections[line];
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      const tokens = lines[i].split(/\s+/);
      if (tokens[2] === oldId) {
        tokens[2] = newId;
        lines[i] = tokens.join(' ');
      }
    }
  }
  renameTokenInSections(model, ['ENERGY'], oldId, newId);
  return true;
}

function renameTokenInSections(model: NetworkModel, sections: string[], oldId: string, newId: string): void {
  for (const name of sections) {
    const lines = model.extraSections[name];
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      const tokens = lines[i].split(/\s+/);
      let changed = false;
      for (let t = 1; t < tokens.length; t++) {
        if (tokens[t] === oldId && /^(PATTERN|EFFIC|EFFICIENCY)$/i.test(tokens[t - 1])) {
          tokens[t] = newId;
          changed = true;
        }
      }
      if (changed) lines[i] = tokens.join(' ');
    }
  }
}

/* ------------------------------------------------------------------ 제어 규칙 */

export interface ControlIssue {
  /** 0 부터 시작하는 줄 번호. */
  line: number;
  message: string;
}

const NODE_WORDS = /^(NODE|JUNCTION|RESERVOIR|TANK)$/i;
const LINK_WORDS = /^(LINK|PIPE|PUMP|VALVE)$/i;
const SIMPLE_CONTROL =
  /^LINK\s+\S+\s+(OPEN|CLOSED|ACTIVE|-?[\d.]+)\s+(AT\s+(TIME|CLOCKTIME)\s+\S+(\s+(AM|PM))?|IF\s+NODE\s+\S+\s+(ABOVE|BELOW)\s+-?[\d.]+)$/i;

/** 제어 규칙 원문의 객체 참조와 (단순 제어의) 문법을 검사한다. 엔진 실행 전 빠른 안내용. */
export function checkControls(model: NetworkModel, section: 'CONTROLS' | 'RULES', lines: string[]): ControlIssue[] {
  const issues: ControlIssue[] = [];
  lines.forEach((raw, index) => {
    const line = raw.split(';')[0].trim();
    if (!line) return;
    const tokens = line.split(/\s+/);
    for (let t = 1; t < tokens.length; t++) {
      const prev = tokens[t - 1];
      if (NODE_WORDS.test(prev) && !(tokens[t] in model.nodes)) issues.push({ line: index, message: `절점 '${tokens[t]}' 이(가) 없습니다.` });
      if (LINK_WORDS.test(prev) && !(tokens[t] in model.links)) issues.push({ line: index, message: `링크 '${tokens[t]}' 이(가) 없습니다.` });
    }
    if (section === 'CONTROLS' && !SIMPLE_CONTROL.test(line)) {
      issues.push({ line: index, message: '형식: LINK <ID> <OPEN|CLOSED|설정값> AT TIME <시각> 또는 IF NODE <ID> <ABOVE|BELOW> <값>' });
    }
  });
  return issues;
}

export type ControlAction = 'OPEN' | 'CLOSED' | 'SETTING';
export type ControlTrigger =
  | { kind: 'time'; hours: number }
  | { kind: 'clock'; hours: number }
  | { kind: 'node'; nodeId: string; comparison: 'ABOVE' | 'BELOW'; value: number };

/** 단순 제어 한 줄을 만든다. */
export function buildControlLine(linkId: string, action: ControlAction, setting: number, trigger: ControlTrigger): string {
  const act = action === 'SETTING' ? String(setting) : action;
  if (trigger.kind === 'node') return `LINK ${linkId} ${act} IF NODE ${trigger.nodeId} ${trigger.comparison} ${trigger.value}`;
  const h = Math.floor(trigger.hours);
  const m = Math.round((trigger.hours - h) * 60);
  const time = `${h}:${String(m).padStart(2, '0')}`;
  return `LINK ${linkId} ${act} AT ${trigger.kind === 'time' ? 'TIME' : 'CLOCKTIME'} ${time}`;
}
