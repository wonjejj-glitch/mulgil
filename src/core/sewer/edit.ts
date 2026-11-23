/**
 * 지도 편집용 하수 프로젝트 연산 (순수 함수). 모두 넘겨받은 프로젝트를 제자리에서 고친다 —
 * useSewerStore.edit(recipe) 안에서 부르면 실행 취소가 된다. 스키마(SewerProject)는 바꾸지 않는다.
 */
import type { LngLat } from '../model/types';
import { georeference, lngLatToXy, sewerFrame } from './mapFrame';
import { defaultConstraints, defaultOptions, type SewerCatchment, type SewerConduit, type SewerNode, type SewerNodeKind, type SewerProject } from './types';

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
  if ((project.pumps ?? []).some((p) => p.wet_well === upstream)) return `${upstream} 은(는) 펌프장 습정이라 펌프로만 빠집니다.`;
  // 하류에서 계속 내려가 상류 절점으로 돌아오면 순환
  const next = downstreamMap(project);
  let at: string | undefined = downstream;
  for (let i = 0; at !== undefined && i <= project.conduits.length; i++) {
    if (at === upstream) return '순환 관망이 됩니다. 흐름 방향(상류 → 하류)을 확인하세요.';
    at = next.get(at);
  }
  return null;
}

/** 절점 → 바로 하류 절점 (관거 또는 펌프) */
function downstreamMap(project: SewerProject): Map<string, string> {
  const next = new Map(project.conduits.map((c) => [c.upstream, c.downstream]));
  for (const p of project.pumps ?? []) next.set(p.wet_well, p.discharge);
  return next;
}

/**
 * 중계펌프장을 둘 수 없는 이유 (둘 수 있으면 null).
 * 습정 맨홀에 이미 하류 관거가 있으면, 그 관거가 토출 맨홀로 가는 경우에만 펌프로 바꾼다.
 */
export function pumpProblem(project: SewerProject, wetWell: string, discharge: string): string | null {
  const w = project.nodes.find((n) => n.id === wetWell);
  const d = project.nodes.find((n) => n.id === discharge);
  if (!w || !d) return '절점을 찾을 수 없습니다.';
  if (wetWell === discharge) return '같은 맨홀에는 둘 수 없습니다.';
  if (w.kind === 'OUTFALL') return '방류구는 습정이 될 수 없습니다. 펌프장 습정이 될 맨홀을 먼저 누르세요.';
  if ((project.pumps ?? []).some((p) => p.wet_well === wetWell)) return `${wetWell} 에는 이미 펌프장이 있습니다.`;
  const out = project.conduits.find((c) => c.upstream === wetWell);
  if (out && out.downstream !== discharge) return `${wetWell} 의 하류 관거 ${out.id}(→ ${out.downstream})를 먼저 지우세요. 습정은 펌프로만 빠집니다.`;
  const next = downstreamMap(project);
  if (out) next.delete(wetWell);
  let at: string | undefined = discharge;
  for (let i = 0; at !== undefined && i <= project.nodes.length; i++) {
    if (at === wetWell) return '순환 관망이 됩니다. 토출 맨홀이 습정의 하류 쪽인지 확인하세요.';
    at = next.get(at);
  }
  return null;
}

/** 중계펌프장을 넣는다 (용량·양정·습정 면적 자동, 가동 1.5 m · 정지 0.5 m). 같은 구간 관거는 펌프로 바꾼다. */
export function addSewerPump(project: SewerProject, wetWell: string, discharge: string): string | null {
  if (pumpProblem(project, wetWell, discharge)) return null;
  project.conduits = project.conduits.filter((c) => !(c.upstream === wetWell && c.downstream === discharge));
  const taken = [...project.conduits.map((c) => c.id), ...(project.pumps ?? []).map((p) => p.id)];
  const id = nextSewerId('PS', taken, 2);
  const w = project.nodes.find((n) => n.id === wetWell)!;
  const depth = w.ground - w.invert;
  const on = Math.min(1.5, Math.max(0.3, Math.round(depth * 0.6 * 10) / 10));
  const off = Math.round(Math.min(0.5, on / 3) * 10) / 10;
  project.pumps = [...(project.pumps ?? []), { id, wet_well: wetWell, discharge, capacity: null, head: null, on_depth: on, off_depth: off, area: null }];
  return id;
}

export function deleteSewerPump(project: SewerProject, id: string): boolean {
  const before = project.pumps?.length ?? 0;
  const rest = (project.pumps ?? []).filter((p) => p.id !== id);
  if (rest.length === before) return false;
  if (rest.length > 0) project.pumps = rest;
  else delete project.pumps;
  return true;
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
  for (const p of project.pumps ?? []) if (p.wet_well === id || p.discharge === id) deleteSewerPump(project, p.id);
  reassignCatchments(project, id);
  return true;
}

/** 출구 맨홀이 사라지거나 방류구가 된 유역: 그린 경계가 있으면 가장 가까운 다른 맨홀로 옮기고, 없으면 지운다. */
function reassignCatchments(project: SewerProject, outlet: string): void {
  project.catchments = project.catchments.filter((s) => {
    if (s.outlet !== outlet) return true;
    if (!s.polygon) return false;
    const [cx, cy] = ringCentroid(s.polygon);
    const next = nearestJunction(project, cx, cy, outlet);
    if (!next) return false;
    s.outlet = next.id;
    return true;
  });
}

/* ------------------------------------------------------------------ 유역 (지도에서 그리기) */

/** 다각형 면적 (m², 신발끈 공식). 꼭짓점은 닫지 않은 목록. */
export function ringArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function ringCentroid(ring: [number, number][]): [number, number] {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function nearestJunction(project: SewerProject, x: number, y: number, except?: string): SewerNode | null {
  let best: SewerNode | null = null;
  let bestD = Infinity;
  for (const n of project.nodes) {
    if (n.kind !== 'JUNCTION' || n.id === except) continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bestD) [best, bestD] = [n, d];
  }
  return best;
}

/**
 * 유역 출구 맨홀 고르기: 경계 안 맨홀 중 가장 하류(관저고가 가장 낮은) 맨홀, 안에 없으면 중심에서 가장 가까운 맨홀.
 */
export function pickCatchmentOutlet(project: SewerProject, ring: [number, number][]): SewerNode | null {
  const inside = project.nodes.filter((n) => n.kind === 'JUNCTION' && pointInRing(n.x, n.y, ring));
  if (inside.length > 0) return inside.reduce((a, b) => (b.invert < a.invert ? b : a));
  const [cx, cy] = ringCentroid(ring);
  return nearestJunction(project, cx, cy);
}

/** 경계 모양으로 면적(ha)·폭(m)을 다시 계산한다. 폭 = 면적 / 최장 흐름 길이(≈ 경계 지름의 절반)의 근사. */
export function updateCatchmentGeometry(c: SewerCatchment): void {
  if (!c.polygon || c.polygon.length < 3) return;
  const m2 = ringArea(c.polygon);
  c.area = Math.max(0.0001, Math.round((m2 / 10000) * 10000) / 10000);
  let diameter = 0;
  for (const a of c.polygon) for (const b of c.polygon) diameter = Math.max(diameter, Math.hypot(a[0] - b[0], a[1] - b[1]));
  const flowLength = Math.max(1, diameter / 2);
  c.width = Math.max(1, Math.round(m2 / flowLength));
}

/**
 * 지도에서 그린 경계(경위도)로 유역을 추가한다. 출구 맨홀이 없으면 null.
 * 불투수율·유출계수·Horton 값은 같은 관망의 마지막 유역 값(없으면 기본값)을 따른다.
 */
export function addSewerCatchment(project: SewerProject, ringLngLat: LngLat[]): { id: string; outlet: string } | null {
  if (ringLngLat.length < 3) return null;
  georeference(project);
  const frame = sewerFrame(project);
  const ring = ringLngLat.map((p) => lngLatToXy(frame, p)).map(([x, y]) => [mm(x), mm(y)] as [number, number]);
  if (ringArea(ring) < 1) return null;
  const outlet = pickCatchmentOutlet(project, ring);
  if (!outlet) return null;
  const like = project.catchments[project.catchments.length - 1];
  const id = nextSewerId('S', project.catchments.map((c) => c.id), 1);
  const c: SewerCatchment = {
    id,
    outlet: outlet.id,
    area: 0,
    impervious: like?.impervious ?? 60,
    width: 100,
    slope: like?.slope ?? 1,
    runoff_coefficient: like?.runoff_coefficient ?? 0.65,
    horton_max: like?.horton_max ?? 75,
    horton_min: like?.horton_min ?? 5,
    horton_decay: like?.horton_decay ?? 4,
    polygon: ring,
  };
  updateCatchmentGeometry(c);
  project.catchments.push(c);
  return { id, outlet: outlet.id };
}

export function deleteSewerCatchment(project: SewerProject, id: string): boolean {
  const before = project.catchments.length;
  project.catchments = project.catchments.filter((c) => c.id !== id);
  return project.catchments.length < before;
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
  for (const p of project.pumps ?? []) {
    if (p.wet_well === id) p.wet_well = next;
    if (p.discharge === id) p.discharge = next;
  }
  return true;
}

/** 관거·펌프는 같은 ID 공간을 쓴다 */
function linkIds(project: SewerProject): string[] {
  return [...project.conduits.map((c) => c.id), ...(project.pumps ?? []).map((p) => p.id)];
}

export function renameSewerConduit(project: SewerProject, id: string, next: string): boolean {
  const conduit = project.conduits.find((c) => c.id === id);
  if (!conduit || idProblem(linkIds(project), id, next)) return false;
  conduit.id = next;
  return true;
}

export function renameSewerPump(project: SewerProject, id: string, next: string): boolean {
  const pump = project.pumps?.find((p) => p.id === id);
  if (!pump || idProblem(linkIds(project), id, next)) return false;
  pump.id = next;
  return true;
}

/** 맨홀 ↔ 방류구 전환. 방류구는 직접 유입·유역 출구를 가질 수 없으므로 함께 정리한다. */
export function setSewerNodeKind(project: SewerProject, id: string, kind: SewerNodeKind): void {
  const node = project.nodes.find((n) => n.id === id);
  if (!node || node.kind === kind) return;
  node.kind = kind;
  if (kind === 'OUTFALL') {
    node.base_flow = 0;
    for (const p of project.pumps ?? []) if (p.wet_well === id) deleteSewerPump(project, p.id);
    reassignCatchments(project, id);
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
