/**
 * 맨홀 측량 성과(지반고·관저고·깊이) 반영과 현황 해석용 '설계 없는' 결과 만들기.
 *
 * - parseSurveyCsv: 맨홀번호 · 지반고 · 관저고 · 깊이 열을 머리글 이름으로 찾는다 (CSV·탭·공백 구분, 순서 무관).
 * - applySurveyLevels: 같은 ID 의 맨홀에 값을 넣는다. 관저고가 없고 깊이만 있으면 지반고 − 깊이.
 * - asBuiltDesign: 관경·관저고를 그대로 두고 지금 기하로 경사·유속·토피를 계산한다
 *   (자동 설계가 관저고를 다시 계산해 측량값을 덮어쓰지 않게, 기존 관거 현황 해석에 쓴다).
 */
import { LOW_VELOCITY_NOTE, type DesignResult, type DesignRow } from './design';
import { normalRatio, section } from './hydraulics';
import { accumulatedFlows, buildNetwork } from './topology';
import type { SewerProject } from './types';
import { revalidate } from './validate';

export interface SurveyRow {
  id: string;
  ground?: number;
  invert?: number;
  depth?: number;
}

const ID = /^(id|no|번호|맨홀|맨홀번호|맨홀명|mh|mh_?id|name|절점|node)/i;
const GROUND = /(지반|gl\b|ground|rim|지표|뚜껑)/i;
const INVERT = /(관저|il\b|invert|저고)/i;
const DEPTH = /(깊이|심도|depth|토심)/i;

/** 숫자 칸 하나: 1,234.5 같은 천 단위 쉼표는 없다고 본다(쉼표는 구분자). */
const num = (s: string | undefined) => {
  if (s === undefined) return undefined;
  const t = s.trim().replace(/^"|"$/g, '');
  if (t === '') return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
};

export function parseSurveyCsv(text: string): { rows: SurveyRow[]; columns: string[] } {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('측량 성과 표에 머리글과 값 줄이 있어야 합니다.');
  const sep = lines[0].includes(',') ? ',' : lines[0].includes('\t') ? '\t' : /\s+/;
  const split = (l: string) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
  const head = split(lines[0]);
  const find = (re: RegExp, skip: number[] = []) => head.findIndex((h, i) => !skip.includes(i) && re.test(h));
  // '맨홀 지반고' 같은 값 열이 번호 열로 잡히지 않게 값 열 이름은 뺀다
  const id = head.findIndex((h) => ID.test(h) && !GROUND.test(h) && !INVERT.test(h) && !DEPTH.test(h));
  // '관저고' 와 '지반고' 가 같은 열로 잡히지 않게 관저를 먼저 찾는다
  const invert = find(INVERT, [id]);
  const ground = find(GROUND, [id, invert]);
  const depth = find(DEPTH, [id, invert, ground]);
  if (id < 0) throw new Error('맨홀 번호 열을 찾지 못했습니다. 머리글에 ‘맨홀번호’·‘ID’·‘번호’ 중 하나를 쓰세요.');
  if (ground < 0 && invert < 0 && depth < 0) throw new Error('지반고·관저고·깊이 열을 찾지 못했습니다. 머리글에 ‘지반고’·‘관저고’·‘깊이’를 쓰세요.');
  const rows: SurveyRow[] = [];
  for (const line of lines.slice(1)) {
    const c = split(line);
    const key = c[id]?.trim();
    if (!key) continue;
    const row: SurveyRow = { id: key };
    const g = ground >= 0 ? num(c[ground]) : undefined;
    const iv = invert >= 0 ? num(c[invert]) : undefined;
    const d = depth >= 0 ? num(c[depth]) : undefined;
    if (g !== undefined) row.ground = g;
    if (iv !== undefined) row.invert = iv;
    if (d !== undefined) row.depth = d;
    if (g !== undefined || iv !== undefined || d !== undefined) rows.push(row);
  }
  const columns = [id, ground, invert, depth].filter((i) => i >= 0).map((i) => head[i]);
  return { rows, columns };
}

export interface SurveyResult {
  matched: number;
  groundChanged: number;
  invertChanged: number;
  /** 관망에 없는 맨홀 번호 */
  unknown: string[];
  /** 관저고가 지반고 이상이라 건너뛴 맨홀 */
  rejected: string[];
}

const mm = (x: number) => Math.round(x * 1000) / 1000;

export function applySurveyLevels(project: SewerProject, rows: SurveyRow[]): SurveyResult {
  const byId = new Map(project.nodes.map((n) => [n.id.toLowerCase(), n]));
  const r: SurveyResult = { matched: 0, groundChanged: 0, invertChanged: 0, unknown: [], rejected: [] };
  for (const row of rows) {
    const n = byId.get(row.id.toLowerCase());
    if (!n) {
      r.unknown.push(row.id);
      continue;
    }
    const ground = row.ground ?? n.ground;
    const invert = row.invert ?? (row.depth !== undefined ? ground - row.depth : row.ground !== undefined ? n.invert + (ground - n.ground) : n.invert);
    if (!(invert < ground)) {
      r.rejected.push(row.id);
      continue;
    }
    r.matched++;
    if (Math.abs(ground - n.ground) >= 0.0005) r.groundChanged++;
    if (Math.abs(invert - n.invert) >= 0.0005) r.invertChanged++;
    n.ground = mm(ground);
    n.invert = mm(invert);
  }
  return r;
}

/**
 * 관경·관저고·옵셋을 바꾸지 않고 지금 기하로 검토한 결과 (현황 해석용).
 * 경사 = (상류 관저 + 유입 옵셋 − 하류 관저 − 유출 옵셋) / 연장. 역경사·평탄은 0 이하로 남겨 '경사 범위' 위반으로 표시한다.
 */
export function asBuiltDesign(input: SewerProject): DesignResult {
  const p: SewerProject = revalidate(JSON.parse(JSON.stringify(input)) as SewerProject);
  const g = buildNetwork(p);
  const q = accumulatedFlows(p, g);
  const cst = p.constraints;
  const nodeOf = new Map(p.nodes.map((n) => [n.id, n]));
  const rows: DesignRow[] = [];
  const issues: string[] = [];
  const notes: string[] = [];
  for (const c of p.conduits) {
    const u = nodeOf.get(c.upstream)!;
    const v = nodeOf.get(c.downstream)!;
    const upIl = u.invert + c.inlet_offset;
    const downIl = v.invert + c.outlet_offset;
    const slope = (upIl - downIl) / c.length;
    const ratio = normalRatio(q[c.id], c.diameter, slope, c.roughness);
    const [a] = section(c.diameter, ratio);
    const vel = slope > 0 && a ? q[c.id] / a : 0;
    const cover = Math.min(u.ground - (upIl + c.diameter), v.ground - (downIl + c.diameter));
    const problems: string[] = [];
    if (slope <= 0) problems.push(slope < 0 ? '역경사' : '평탄');
    else if (slope < cst.min_slope - 1e-8 || slope > cst.max_slope + 1e-8) problems.push('경사 범위');
    if (cover < cst.min_cover - 1e-8) problems.push('최소 토피');
    if (ratio > cst.max_depth_ratio + 1e-7) problems.push('설계 d/D');
    if (vel > cst.max_velocity + 1e-7) problems.push('최대유속 초과');
    // 저유속은 위반이 아니라 참고 (역경사·평탄은 위에서 이미 위반으로 잡힌다)
    const slow = slope > 0 && q[c.id] > 0 && vel < cst.min_velocity - 1e-7;
    if (slow) notes.push(`${c.id}: 유속 ${vel.toFixed(2)} m/s — 최소 ${cst.min_velocity} m/s 미달`);
    if (problems.length > 0) issues.push(`${c.id}: ${problems.join(', ')} (현황)`);
    rows.push({ id: c.id, diameter: c.diameter, flow: q[c.id], slope, velocity: vel, depth_ratio: ratio, cover, status: (problems.length > 0 ? problems.join(' / ') : '적합') + (slow ? ` · ${LOW_VELOCITY_NOTE}` : '') });
  }
  return { project: p, rows, issues, feasible: issues.length === 0, asBuilt: true, ...(notes.length > 0 ? { notes } : {}) };
}
