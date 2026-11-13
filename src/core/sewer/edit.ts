/**
 * 지도 편집용 하수 프로젝트 연산 (순수 함수). 모두 넘겨받은 프로젝트를 제자리에서 고친다 —
 * useSewerStore.edit(recipe) 안에서 부르면 실행 취소가 된다. 스키마(SewerProject)는 바꾸지 않는다.
 */
import type { LngLat } from '../model/types';
import { georeference, lngLatToXy, sewerFrame } from './mapFrame';
import { defaultConstraints, defaultOptions, type SewerConduit, type SewerNode, type SewerNodeKind, type SewerProject } from './types';

/** 새 맨홀의 임시 매설 깊이 (지반고 − 관저고, m). 자동 설계가 다시 정한다. */
export const PLACEHOLDER_DEPTH = 1.8;
/** 새 방류구의 임시 깊이 (m). '방류구 깊이 맞춤'으로 다시 정한다. */
export const OUTFALL_DEPTH = 2.5;

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,30}$/;
const mm = (v: number) => Math.round(v * 1000) / 1000;
const cm = (v: number) => Math.round(v * 100) / 100;

/** prefix + 숫자 형태 ID 중 가장 큰 번호 다음 번호를 돌려준다 (MH001, P001, OF1 …). */
export function nextSewerId(prefix: string, taken: Iterable<string>, pad = 3): string {
  const used = new Set(taken);
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const id of used) {
    const m = pattern.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  let id = `${prefix}${String(n).padStart(pad, '0')}`;
  while (used.has(id)) id = `${prefix}${String(++n).padStart(pad, '0')}`;
  return id;
}

export function planarLength(a: Pick<SewerNode, 'x' | 'y'>, b: Pick<SewerNode, 'x' | 'y'>): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function nearestNode(project: SewerProject, x: number, y: number): SewerNode | null {
  let best: SewerNode | null = null;
  let bestD = Infinity;
  for (const n of project.nodes) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

/**
 * 맨홀(JUNCTION) 또는 방류구(OUTFALL)를 지도 위치에 추가하고 새 ID 를 돌려준다.
 * 지반고는 가장 가까운 절점 값(없으면 0), 관저고는 지반고 − 임시 깊이.
 */
export function addSewerNode(project: SewerProject, kind: SewerNodeKind, position: LngLat): string {
  georeference(project);
  const [x, y] = lngLatToXy(sewerFrame(project), position);
  const ground = nearestNode(project, x, y)?.ground ?? 0;
  const ids = project.nodes.map((n) => n.id);
  const id = kind === 'OUTFALL' ? nextSewerId('OF', ids, 1) : nextSewerId('MH', ids);
  project.nodes.push({
    id,
    x: mm(x),
    y: mm(y),
    ground,
    invert: mm(ground - (kind === 'OUTFALL' ? OUTFALL_DEPTH : PLACEHOLDER_DEPTH)),
    kind,
    base_flow: 0,
    boundary: 'FREE',
    stage: null,
  });
  return id;
}

/** 관거를 이을 수 없는 이유 (이을 수 있으면 null). 가지형 관망 규칙을 미리 알려 준다. */
export function conduitProblem(project: SewerProject, upstream: string, downstream: string): string | null {
  const up = project.nodes.find((n) => n.id === upstream);
  const down = project.nodes.find((n) => n.id === downstream);
  if (!up || !down) return '절점을 찾을 수 없습니다.';
  if (upstream === downstream) return '같은 절점에는 이을 수 없습니다.';
  if (up.kind === 'OUTFALL') return '방류구는 하류 끝입니다. 상류 맨홀을 먼저 클릭하세요.';
  if (project.conduits.some((c) => (c.upstream === upstream && c.downstream === downstream) || (c.upstream === downstream && c.downstream === upstream))) {
    return '두 절점 사이에 이미 관거가 있습니다.';
  }
  if (project.conduits.some((c) => c.upstream === upstream)) return `${upstream} 에는 이미 하류 관거가 있습니다 (맨홀의 하류 관거는 1개).`;
  // 하류에서 계속 내려가 상류 절점으로 돌아오면 순환
  const next = new Map(project.conduits.map((c) => [c.upstream, c.downstream]));
  let at: string | undefined = downstream;
  for (let i = 0; at !== undefined && i <= project.conduits.length; i++) {
    if (at === upstream) return '순환 관망이 됩니다. 흐름 방향(상류 → 하류)을 확인하세요.';
    at = next.get(at);
  }
  return null;
}

/** 상류 → 하류 관거를 추가한다. 연장은 평면 거리(m). 이을 수 없으면 null. */
export function addSewerConduit(project: SewerProject, upstream: string, downstream: string): string | null {
  if (conduitProblem(project, upstream, downstream)) return null;
  const up = project.nodes.find((n) => n.id === upstream)!;
  const down = project.nodes.find((n) => n.id === downstream)!;
  const last: SewerConduit | undefined = project.conduits[project.conduits.length - 1];
  const id = nextSewerId('P', project.conduits.map((c) => c.id));
  project.conduits.push({
    id,
    upstream,
    downstream,
    length: Math.max(0.01, cm(planarLength(up, down))),
    diameter: project.constraints.diameters[0] ?? 0.25,
    roughness: last?.roughness ?? 0.013,
    inlet_offset: 0,
    outlet_offset: 0,
  });
  return id;
}

/** 절점을 옮기고 연결된 관거의 연장을 평면 거리로 다시 계산한다. */
export function moveSewerNode(project: SewerProject, id: string, position: LngLat): boolean {
  georeference(project);
  const node = project.nodes.find((n) => n.id === id);
  if (!node) return false;
  const [x, y] = lngLatToXy(sewerFrame(project), position);
  node.x = mm(x);
  node.y = mm(y);
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  for (const c of project.conduits) {
    if (c.upstream !== id && c.downstream !== id) continue;
    const a = byId.get(c.upstream);
    const b = byId.get(c.downstream);
    if (a && b) c.length = Math.max(0.01, cm(planarLength(a, b)));
  }
  return true;
}

/** 절점과 거기에 붙은 관거, 그 절점으로 나가는 유역을 지운다. */
export function deleteSewerNode(project: SewerProject, id: string): boolean {
  const index = project.nodes.findIndex((n) => n.id === id);
  if (index < 0) return false;
  project.nodes.splice(index, 1);
  project.conduits = project.conduits.filter((c) => c.upstream !== id && c.downstream !== id);
  project.catchments = project.catchments.filter((s) => s.outlet !== id);
  return true;
}

export function deleteSewerConduit(project: SewerProject, id: string): boolean {
  const index = project.conduits.findIndex((c) => c.id === id);
  if (index < 0) return false;
  project.conduits.splice(index, 1);
  return true;
}

/** ID 를 바꿀 수 없는 이유 (가능하면 null). */
export function idProblem(taken: string[], current: string, next: string): string | null {
  if (!ID_PATTERN.test(next)) return 'ID 는 영문으로 시작하고 영문·숫자·_·- 만 쓸 수 있습니다 (최대 31자).';
  if (next !== current && taken.includes(next)) return `${next} 은(는) 이미 쓰고 있습니다.`;
  return null;
}

/** 절점 ID 를 바꾸고 관거·유역의 참조도 함께 바꾼다. */
export function renameSewerNode(project: SewerProject, id: string, next: string): boolean {
  const node = project.nodes.find((n) => n.id === id);
  if (!node || idProblem(project.nodes.map((n) => n.id), id, next)) return false;
  node.id = next;
  for (const c of project.conduits) {
    if (c.upstream === id) c.upstream = next;
    if (c.downstream === id) c.downstream = next;
  }
  for (const s of project.catchments) if (s.outlet === id) s.outlet = next;
  return true;
}

export function renameSewerConduit(project: SewerProject, id: string, next: string): boolean {
  const conduit = project.conduits.find((c) => c.id === id);
  if (!conduit || idProblem(project.conduits.map((c) => c.id), id, next)) return false;
  conduit.id = next;
  return true;
}

/** 맨홀 ↔ 방류구 전환. 방류구는 직접 유입·유역 출구를 가질 수 없으므로 함께 정리한다. */
export function setSewerNodeKind(project: SewerProject, id: string, kind: SewerNodeKind): void {
  const node = project.nodes.find((n) => n.id === id);
  if (!node || node.kind === kind) return;
  node.kind = kind;
  if (kind === 'OUTFALL') {
    node.base_flow = 0;
    project.catchments = project.catchments.filter((s) => s.outlet !== id);
  } else {
    node.boundary = 'FREE';
    node.stage = null;
  }
}

export interface GroundUpdate {
  changed: number;
  /** 지반고가 관저고 이하가 되어 관저고를 임시 깊이로 내린 절점 수 */
  invertAdjusted: number;
  meanAbs: number;
  maxAbs: number;
}

/**
 * 절점 지반고를 새 값으로 바꾼다. values[i] 는 project.nodes[i] 의 지반고(유한하지 않으면 건너뜀).
 * keepDepth 가 true 면 관저고도 같은 만큼 옮겨 매설 깊이를 유지하고, false 면 지반고만 바꾼다.
 */
export function applyGroundLevels(project: SewerProject, values: number[], keepDepth: boolean): GroundUpdate {
  let changed = 0;
  let invertAdjusted = 0;
  let sum = 0;
  let maxAbs = 0;
  project.nodes.forEach((n, i) => {
    const z = values[i];
    if (z === undefined || !Number.isFinite(z)) return;
    const ground = cm(z);
    const delta = ground - n.ground;
    if (Math.abs(delta) < 0.005) return;
    changed++;
    sum += Math.abs(delta);
    maxAbs = Math.max(maxAbs, Math.abs(delta));
    n.ground = ground;
    if (keepDepth) n.invert = mm(n.invert + delta);
    else if (n.invert >= ground) {
      n.invert = mm(ground - (n.kind === 'OUTFALL' ? OUTFALL_DEPTH : PLACEHOLDER_DEPTH));
      invertAdjusted++;
    }
  });
  return { changed, invertAdjusted, meanAbs: changed > 0 ? sum / changed : 0, maxAbs };
}

/** 관망 요약 (우측 패널). */
export function sewerSummary(project: SewerProject): { manholes: number; outfalls: number; conduits: number; totalLength: number } {
  let outfalls = 0;
  for (const n of project.nodes) if (n.kind === 'OUTFALL') outfalls++;
  return {
    manholes: project.nodes.length - outfalls,
    outfalls,
    conduits: project.conduits.length,
    totalLength: project.conduits.reduce((a, c) => a + c.length, 0),
  };
}

/** 빈 하수 프로젝트 (지도에서 처음부터 그릴 때). 설계 조건은 기본 예제값. */
export function emptySewerProject(name = '새 하수 관망'): SewerProject {
  return { schema_version: 1, name, nodes: [], conduits: [], catchments: [], options: defaultOptions(), constraints: defaultConstraints() };
}
