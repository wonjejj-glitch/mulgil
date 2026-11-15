/**
 * 하수도 GIS(관거 선 + 맨홀 점 Shapefile) → 편집 가능한 하수 관망(SewerProject).
 *
 * 국가 하수도 GIS 표준 필드(SWL_PIPE_LM · SWL_MANH_PS)를 먼저 찾고, 없으면 흔한 한글·영문 이름을 찾는다.
 *  - 관거: FTR_IDN(번호) · STD_DIP(관경 mm) · STD_HOL×STD_VEL(박스 가로×세로 m) · BYC_LEN(연장)
 *          SBK_HSL / SBL_HSL(시점·종점 관저고) · BEG_DEP / END_DEP(시점·종점 토피) · BOM_IDN / EOM_IDN(시점·종점 맨홀 번호)
 *          SBA_CDE(용도: 001 합류 · 002 차집 · 003 우수 · 004 오수 — 자료로 추정한 해석)
 *  - 맨홀: FTR_IDN · MOS_HSL(지반고) · LMS_HSL(관저고)
 *
 * 1) buildGisNetwork: 관 끝점을 맨홀에 잇는다. 시점·종점 맨홀 번호가 있고 그 맨홀이 끝점 가까이 있으면 그것을,
 *    아니면 허용 거리 안의 가장 가까운 맨홀을, 그것도 없으면 끝점끼리 합친 가상 절점을 쓴다. 방향은 그려진 방향(시점 → 종점).
 * 2) extractSewerProject: 용도·구역(전체 / 처리분구 등 경계 / 하류 맨홀의 상류)으로 골라 수지상 관망으로 만든다.
 *    하수 설계 모듈은 맨홀마다 하류 관이 하나뿐인 수지상만 다루므로 분기·순환 관은 하나만 남기고 나머지는 빼며, 그 수를 보고한다.
 *
 * 좌표는 호출하는 쪽에서 하수 프로젝트 좌표(EPSG:5186, m)로 바꿔 넣는다.
 */
import { defaultConstraints, defaultOptions, type SewerConduit, type SewerNode, type SewerProject } from './types';

export type XY = [number, number];
type Props = Record<string, unknown>;

export interface GisPipeInput {
  coords: XY[];
  props: Props;
}
export interface GisPointInput {
  xy: XY;
  props: Props;
}

/* ------------------------------------------------------------------ 필드 */

const PIPE_FIELDS = {
  id: ['ftr_idn', 'id', 'pipe_id', '관번호', '관리번호', '관로번호'],
  diameter: ['std_dip', 'pip_dip', 'dip', 'diameter', 'dia', '관경', '구경'],
  width: ['std_hol', 'width', '가로', '폭'],
  height: ['std_vel', 'height', '세로', '높이'],
  length: ['byc_len', 'pip_len', 'length', 'len', '연장'],
  startInvert: ['sbk_hsl', 'st_il', 'beg_il', 'up_il', '시점관저고', '상류관저고'],
  endInvert: ['sbl_hsl', 'ed_il', 'end_il', 'dn_il', '종점관저고', '하류관저고'],
  startCover: ['beg_dep', '시점토피', '시점심도'],
  endCover: ['end_dep', '종점토피', '종점심도'],
  from: ['bom_idn', 'from', 'up_mh', 'st_mh', '시점맨홀', '상류맨홀'],
  to: ['eom_idn', 'to', 'dn_mh', 'ed_mh', '종점맨홀', '하류맨홀'],
  usage: ['sba_cde', 'usage', 'type', '용도', '관종', '하수구분'],
  label: ['pip_lbl'],
} as const;

const MANHOLE_FIELDS = {
  id: ['ftr_idn', 'id', 'mh_id', '맨홀번호', '번호'],
  ground: ['mos_hsl', 'gl', 'ground', 'rim', '지반고', '맨홀지반고'],
  invert: ['lms_hsl', 'il', 'invert', '관저고', '맨홀관저고'],
} as const;

function field(props: Props, aliases: readonly string[]): unknown {
  for (const key in props) if (aliases.includes(key.toLowerCase())) return props[key];
  return undefined;
}
/** 0·빈칸·숫자 아님은 '없음' (GIS 자료는 빈 값을 0 으로 채운 경우가 많다). */
function positive(props: Props, aliases: readonly string[]): number | null {
  const raw = field(props, aliases);
  const v = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}
function text(props: Props, aliases: readonly string[]): string {
  const raw = field(props, aliases);
  return raw === null || raw === undefined ? '' : String(raw).trim();
}
/** 0 번 맨홀은 '없음' */
function refId(props: Props, aliases: readonly string[]): string {
  const t = text(props, aliases);
  return t === '' || t === '0' ? '' : t;
}

/** 관거 용도 코드 → 이름. 표준 코드 뜻은 자료(토구로 가는 관·관경·재질)로 추정한 것이다. */
const USAGE_CODES: Record<string, string> = { SBA001: '합류', SBA002: '차집', SBA003: '우수', SBA004: '오수' };

export function usageLabel(code: string): string {
  if (USAGE_CODES[code]) return USAGE_CODES[code];
  for (const word of ['합류', '차집', '우수', '오수']) if (code.includes(word)) return word;
  return code ? `기타 (${code})` : '미상';
}

/** 관경(m). 10 넘으면 mm 로 본다. 박스(가로×세로)는 같은 단면적의 원형으로 바꾼다. 다련 박스(n@가로X세로)는 단면적 × n. */
function pipeDiameter(props: Props): { d: number | null; box: boolean } {
  const dip = positive(props, PIPE_FIELDS.diameter);
  if (dip !== null) return { d: dip > 10 ? dip / 1000 : dip, box: false };
  let w = positive(props, PIPE_FIELDS.width);
  let h = positive(props, PIPE_FIELDS.height);
  if (w !== null && h !== null) {
    if (w > 20) w /= 1000;
    if (h > 20) h /= 1000;
    const barrels = Number(/(\d+)\s*@/.exec(text(props, PIPE_FIELDS.label))?.[1] ?? 1) || 1;
    return { d: Math.sqrt((4 * w * h * barrels) / Math.PI), box: true };
  }
  return { d: null, box: false };
}

/* ------------------------------------------------------------------ 공간 색인 */

class Grid {
  private cells = new Map<string, number[]>();
  constructor(private size: number) {}
  private key(x: number, y: number) {
    return `${Math.floor(x / this.size)},${Math.floor(y / this.size)}`;
  }
  add(i: number, x: number, y: number) {
    const k = this.key(x, y);
    const list = this.cells.get(k);
    if (list) list.push(i);
    else this.cells.set(k, [i]);
  }
  /** 반경 r(≤ size) 안의 후보 */
  near(x: number, y: number): number[] {
    const cx = Math.floor(x / this.size), cy = Math.floor(y / this.size);
    const out: number[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(...(this.cells.get(`${cx + i},${cy + j}`) ?? []));
    return out;
  }
}

/* ------------------------------------------------------------------ 1) 관망 만들기 */

export interface GisNode {
  id: string;
  x: number;
  y: number;
  ground: number | null;
  invert: number | null;
  /** 맨홀 레이어의 점이면 true, 관 끝점으로 만든 가상 절점이면 false */
  manhole: boolean;
}

export interface GisLink {
  id: string;
  from: number;
  to: number;
  length: number;
  diameter: number | null;
  box: boolean;
  startInvert: number | null;
  endInvert: number | null;
  startCover: number | null;
  endCover: number | null;
  usage: string;
  mid: XY;
}

export interface GisNetwork {
  nodes: GisNode[];
  links: GisLink[];
  /** 용도 코드 → 관 수 */
  usages: Map<string, number>;
  stats: {
    pipes: number;
    manholes: number;
    /** 맨홀 번호로 이은 끝점 */
    byId: number;
    /** 거리로 맨홀에 붙인 끝점 */
    bySnap: number;
    /** 맨홀이 없어 만든 가상 절점 */
    virtual: number;
    /** 길이 0·시종점 같음으로 뺀 관 */
    skipped: number;
  };
}

export interface BuildOptions {
  /** 관 끝점을 가장 가까운 맨홀에 붙이는 거리 (m) */
  snap: number;
  /** 맨홀 번호로 찾은 맨홀이 끝점에서 이 거리 안에 있어야 믿는다 (m) */
  idTolerance: number;
}

const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function polylineLength(coords: XY[]): number {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += dist(coords[i - 1], coords[i]);
  return s;
}

function midpoint(coords: XY[]): XY {
  const half = polylineLength(coords) / 2;
  let s = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = dist(coords[i - 1], coords[i]);
    if (s + d >= half && d > 0) {
      const t = (half - s) / d;
      return [coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]), coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1])];
    }
    s += d;
  }
  return coords[0];
}

/** SWMM ID: 영문 시작, 영문·숫자·_·- 만, 31자 이하. 겹치면 _2, _3… */
function uniqueId(prefix: string, raw: string, used: Set<string>): string {
  const body = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || '1';
  let id = `${prefix}${body}`;
  for (let k = 2; used.has(id); k++) id = `${prefix}${body}_${k}`;
  used.add(id);
  return id;
}

export function buildGisNetwork(pipes: GisPipeInput[], manholes: GisPointInput[], options: Partial<BuildOptions> = {}): GisNetwork {
  const snap = options.snap ?? 1;
  const idTolerance = options.idTolerance ?? 3;
  const nodes: GisNode[] = [];
  const nodeIds = new Set<string>();
  const byRawId = new Map<string, number[]>();
  const grid = new Grid(Math.max(snap, idTolerance, 1));

  for (const m of manholes) {
    const raw = refId(m.props, MANHOLE_FIELDS.id);
    const ground = positive(m.props, MANHOLE_FIELDS.ground);
    let invert = positive(m.props, MANHOLE_FIELDS.invert);
    // 지반고와 관저고가 같거나 거꾸로면 관저고는 믿지 않는다
    if (ground !== null && invert !== null && ground - invert < 0.1) invert = null;
    const i = nodes.length;
    nodes.push({ id: uniqueId('MH', raw || String(i + 1), nodeIds), x: m.xy[0], y: m.xy[1], ground, invert, manhole: true });
    grid.add(i, m.xy[0], m.xy[1]);
    if (raw) {
      const list = byRawId.get(raw);
      if (list) list.push(i);
      else byRawId.set(raw, [i]);
    }
  }
  const manholeCount = nodes.length;
  const stats = { pipes: 0, manholes: manholeCount, byId: 0, bySnap: 0, virtual: 0, skipped: 0 };

  const nearest = (p: XY, maxDistance: number, onlyManholes: boolean): number => {
    let best = -1, bestD = maxDistance;
    for (const i of grid.near(p[0], p[1])) {
      if (onlyManholes && !nodes[i].manhole) continue;
      const d = dist(p, [nodes[i].x, nodes[i].y]);
      if (d <= bestD) [best, bestD] = [i, d];
    }
    return best;
  };
  const endpoint = (p: XY, raw: string): number => {
    if (raw) {
      let best = -1, bestD = idTolerance;
      for (const i of byRawId.get(raw) ?? []) {
        const d = dist(p, [nodes[i].x, nodes[i].y]);
        if (d <= bestD) [best, bestD] = [i, d];
      }
      if (best >= 0) {
        stats.byId++;
        return best;
      }
    }
    const m = nearest(p, snap, true);
    if (m >= 0) {
      stats.bySnap++;
      return m;
    }
    const v = nearest(p, Math.min(snap, 0.05) || 0.05, false);
    if (v >= 0) return v;
    const i = nodes.length;
    nodes.push({ id: uniqueId('J', String(i - manholeCount + 1), nodeIds), x: p[0], y: p[1], ground: null, invert: null, manhole: false });
    grid.add(i, p[0], p[1]);
    stats.virtual++;
    return i;
  };

  const links: GisLink[] = [];
  const linkIds = new Set<string>();
  const usages = new Map<string, number>();
  for (const pipe of pipes) {
    const coords = pipe.coords;
    const geometric = polylineLength(coords);
    if (coords.length < 2 || geometric <= 0) {
      stats.skipped++;
      continue;
    }
    const from = endpoint(coords[0], refId(pipe.props, PIPE_FIELDS.from));
    const to = endpoint(coords[coords.length - 1], refId(pipe.props, PIPE_FIELDS.to));
    if (from === to) {
      stats.skipped++;
      continue;
    }
    const { d, box } = pipeDiameter(pipe.props);
    const usage = text(pipe.props, PIPE_FIELDS.usage);
    usages.set(usage, (usages.get(usage) ?? 0) + 1);
    links.push({
      id: uniqueId('P', refId(pipe.props, PIPE_FIELDS.id) || String(links.length + 1), linkIds),
      from,
      to,
      length: positive(pipe.props, PIPE_FIELDS.length) ?? geometric,
      diameter: d,
      box,
      startInvert: positive(pipe.props, PIPE_FIELDS.startInvert),
      endInvert: positive(pipe.props, PIPE_FIELDS.endInvert),
      startCover: positive(pipe.props, PIPE_FIELDS.startCover),
      endCover: positive(pipe.props, PIPE_FIELDS.endCover),
      usage,
      mid: midpoint(coords),
    });
  }
  stats.pipes = links.length;
  return { nodes, links, usages, stats };
}

/* ------------------------------------------------------------------ 2) 고르기 → 수지상 하수 관망 */

export type GisRegion = { kind: 'all' } | { kind: 'area'; rings: XY[][] } | { kind: 'outlet'; nodeId: string };

export interface ExtractOptions {
  /** 가져올 용도 코드 (빈 배열이면 전부) */
  usages: string[];
  region: GisRegion;
  /** 관 수가 이보다 적은 조각은 버린다 */
  minPipes: number;
  name: string;
  /** 관경이 없는 관에 넣을 값 (m) */
  defaultDiameter: number;
}

export interface ExtractReport {
  pipes: number;
  manholes: number;
  outfalls: number;
  /** 맨홀 하나에서 하류 관이 여럿이라 뺀 관 */
  diversions: number;
  /** 순환을 끊으려고 뺀 관 */
  cycles: number;
  /** 작은 조각이라 뺀 관 */
  small: number;
  /** 관경이 없어 기본값을 넣은 관 */
  noDiameter: number;
  /** 박스를 원형으로 바꾼 관 */
  boxes: number;
  /** 지반고를 이웃·관 자료로 채운 절점 */
  filledGround: number;
  /** 관저고를 추정한 절점 */
  filledInvert: number;
  /** 시점 관저고가 종점보다 낮은 관 (역경사) */
  adverse: number;
  /** 관 꼭대기가 지반고보다 높아 지반고를 올린 절점 */
  raisedGround: number;
}

/** 짝홀 규칙으로 점이 경계 안에 있는지 (구멍·여러 조각 경계 모두 처리). */
export function insideRings(p: XY, rings: XY[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

const round = (v: number, k = 1000) => Math.round(v * k) / k;

export function extractSewerProject(net: GisNetwork, options: ExtractOptions): { project: SewerProject; report: ExtractReport } {
  const report: ExtractReport = { pipes: 0, manholes: 0, outfalls: 0, diversions: 0, cycles: 0, small: 0, noDiameter: 0, boxes: 0, filledGround: 0, filledInvert: 0, adverse: 0, raisedGround: 0 };
  const usageOk = (l: GisLink) => options.usages.length === 0 || options.usages.includes(l.usage);
  const N = net.nodes.length;
  const keep = new Set<number>(); // 링크 인덱스

  if (options.region.kind === 'outlet') {
    // 하류 맨홀에서 거슬러 올라가며 처음 닿은 관을 그 절점의 하류 관으로 삼는다 (순환·분기는 자연히 끊긴다)
    const wanted = options.region.nodeId.trim();
    const target = net.nodes.findIndex((n) => n.id === wanted || n.id === `MH${wanted}`);
    if (target < 0) throw new Error(`${wanted}: 그런 맨홀이 없습니다. 맨홀 번호(예: 234035 또는 MH234035)를 확인하세요.`);
    const incoming = new Map<number, number[]>();
    net.links.forEach((l, k) => {
      if (!usageOk(l)) return;
      const list = incoming.get(l.to);
      if (list) list.push(k);
      else incoming.set(l.to, [k]);
    });
    const seen = new Set<number>([target]);
    let frontier = [target];
    let extra = 0;
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const v of frontier) {
        for (const k of incoming.get(v) ?? []) {
          const u = net.links[k].from;
          if (seen.has(u)) {
            extra++;
            continue;
          }
          seen.add(u);
          keep.add(k);
          next.push(u);
        }
      }
      frontier = next;
    }
    report.diversions = extra;
  } else {
    const region = options.region;
    net.links.forEach((l, k) => {
      if (!usageOk(l)) return;
      if (region.kind === 'area' && !insideRings(l.mid, region.rings)) return;
      keep.add(k);
    });
    // 하류 관이 여럿이면 하나만: 큰 관경 → 낮은 종점 관저고
    const outs = new Map<number, number[]>();
    for (const k of keep) {
      const l = net.links[k];
      const list = outs.get(l.from);
      if (list) list.push(k);
      else outs.set(l.from, [k]);
    }
    for (const list of outs.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => (net.links[b].diameter ?? 0) - (net.links[a].diameter ?? 0) || (net.links[a].endInvert ?? Infinity) - (net.links[b].endInvert ?? Infinity));
      for (const k of list.slice(1)) {
        keep.delete(k);
        report.diversions++;
      }
    }
    // 순환 끊기: 절점마다 하류 관이 하나이므로 따라가다 다시 만나면 순환
    const down = new Map<number, number>();
    for (const k of keep) down.set(net.links[k].from, k);
    const state = new Uint8Array(N); // 0 미방문, 1 경로 위, 2 끝
    for (const start of down.keys()) {
      if (state[start]) continue;
      const path: number[] = [];
      let v = start;
      while (v !== undefined && state[v] === 0 && down.has(v)) {
        state[v] = 1;
        path.push(v);
        v = net.links[down.get(v)!].to;
      }
      if (state[v] === 1) {
        // v 에서 시작하는 순환: 가장 거꾸로 기운(종점이 높은) 관을 뺀다
        const cycle = path.slice(path.indexOf(v));
        let worst = cycle[0], worstRise = -Infinity;
        for (const u of cycle) {
          const l = net.links[down.get(u)!];
          const rise = (l.endInvert ?? 0) - (l.startInvert ?? 0);
          if (rise > worstRise) [worst, worstRise] = [u, rise];
        }
        keep.delete(down.get(worst)!);
        down.delete(worst);
        report.cycles++;
      }
      for (const u of path) state[u] = 2;
    }
  }

  // 작은 조각 버리기: 하류로 따라가 같은 방류 절점에 닿는 관끼리 한 조각
  const down = new Map<number, number>();
  for (const k of keep) down.set(net.links[k].from, k);
  const rootOf = new Map<number, number>();
  const findRoot = (v: number): number => {
    const path: number[] = [];
    let u = v;
    while (down.has(u) && !rootOf.has(u)) {
      path.push(u);
      u = net.links[down.get(u)!].to;
    }
    const r = rootOf.get(u) ?? u;
    for (const p of path) rootOf.set(p, r);
    rootOf.set(u, r);
    return r;
  };
  const size = new Map<number, number>();
  for (const k of keep) {
    const r = findRoot(net.links[k].from);
    size.set(r, (size.get(r) ?? 0) + 1);
  }
  for (const k of [...keep]) {
    if ((size.get(findRoot(net.links[k].from)) ?? 0) < options.minPipes) {
      keep.delete(k);
      report.small++;
    }
  }
  if (keep.size === 0) throw new Error('고른 용도·구역에 가져올 관거가 없습니다.');

  // 남은 관·절점
  const links = [...keep].sort((a, b) => a - b).map((k) => net.links[k]);
  const used = new Set<number>();
  for (const l of links) {
    used.add(l.from);
    used.add(l.to);
  }
  const outDeg = new Map<number, number>();
  for (const l of links) outDeg.set(l.from, (outDeg.get(l.from) ?? 0) + 1);
  const touching = new Map<number, GisLink[]>();
  for (const l of links) {
    for (const v of [l.from, l.to]) {
      const list = touching.get(v);
      if (list) list.push(l);
      else touching.set(v, [l]);
    }
  }
  const diameterOf = (l: GisLink) => l.diameter ?? options.defaultDiameter;

  // 지반고: 맨홀 값 → 관저고 + 관경 + 토피 → 이웃 평균
  const ground = new Map<number, number>();
  const invert0 = new Map<number, number>();
  for (const v of used) {
    const n = net.nodes[v];
    if (n.invert !== null) invert0.set(v, n.invert);
    if (n.ground !== null) {
      ground.set(v, n.ground);
      continue;
    }
    const guesses: number[] = [];
    for (const l of touching.get(v) ?? []) {
      const atStart = l.from === v;
      const inv = atStart ? l.startInvert : l.endInvert;
      const cover = atStart ? l.startCover : l.endCover;
      if (inv !== null && cover !== null) guesses.push(inv + diameterOf(l) + cover);
    }
    if (guesses.length > 0) {
      ground.set(v, guesses.reduce((a, b) => a + b, 0) / guesses.length);
      report.filledGround++;
    }
  }
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    for (const v of used) {
      if (ground.has(v)) continue;
      const near: number[] = [];
      for (const l of touching.get(v) ?? []) {
        const g = ground.get(l.from === v ? l.to : l.from);
        if (g !== undefined) near.push(g);
      }
      if (near.length > 0) {
        ground.set(v, near.reduce((a, b) => a + b, 0) / near.length);
        report.filledGround++;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 관저고: 맨홀 값과 이 절점에 닿는 관 관저고 중 가장 낮은 값
  const invert = new Map<number, number>();
  for (const v of used) {
    const values: number[] = [];
    const ref = invert0.get(v);
    let g = ground.get(v);
    if (ref !== undefined) values.push(ref);
    for (const l of touching.get(v) ?? []) {
      const inv = l.from === v ? l.startInvert : l.endInvert;
      // 맨홀 관저고와 3 m 넘게 다르거나 지반고보다 높은 관 관저고는 입력 오류로 보고 쓰지 않는다
      if (inv === null || (ref !== undefined && Math.abs(inv - ref) > 3) || (g !== undefined && (inv >= g || inv < g - 20))) continue;
      values.push(inv);
    }
    if (values.length > 0) {
      const iv = Math.min(...values);
      invert.set(v, iv);
      if (!invert0.has(v)) report.filledInvert++;
      if (g === undefined) {
        g = iv + 1.5;
        ground.set(v, g);
        report.filledGround++;
      }
    } else {
      const maxD = Math.max(...(touching.get(v) ?? []).map(diameterOf));
      if (g === undefined) {
        g = 10;
        ground.set(v, g);
        report.filledGround++;
      }
      invert.set(v, g - 1 - maxD);
      report.filledInvert++;
    }
  }

  const nodes: SewerNode[] = [...used]
    .sort((a, b) => a - b)
    .map((v) => {
      const n = net.nodes[v];
      const iv = invert.get(v)!;
      const maxD = Math.max(...(touching.get(v) ?? []).map(diameterOf));
      // 지반고는 관저고 + 관경보다 높아야 한다 (설계 모듈 검증)
      const g = Math.max(ground.get(v)!, iv + maxD + 0.05);
      if (g > ground.get(v)! + 1e-9) report.raisedGround++;
      const outfall = !outDeg.has(v);
      return {
        id: n.id,
        x: round(n.x),
        y: round(n.y),
        ground: round(g),
        invert: round(iv),
        kind: outfall ? 'OUTFALL' : 'JUNCTION',
        base_flow: 0,
        boundary: 'FREE',
        stage: null,
      } satisfies SewerNode;
    });
  const conduits: SewerConduit[] = links.map((l) => {
    const d = diameterOf(l);
    if (l.diameter === null) report.noDiameter++;
    if (l.box) report.boxes++;
    // 관 관저고가 절점 관저고보다 낮거나 3 m 넘게 높거나 지반고 이상이면 입력 오류로 보고 절점 관저고를 쓴다
    const at = (inv: number | null, v: number) => {
      const base = invert.get(v)!;
      return inv !== null && inv >= base - 1e-6 && inv - base <= 3 && inv < ground.get(v)! ? inv : base;
    };
    const upInv = at(l.startInvert, l.from);
    const dnInv = at(l.endInvert, l.to);
    if (l.startInvert !== null && l.endInvert !== null && l.startInvert < l.endInvert) report.adverse++;
    return {
      id: l.id,
      upstream: net.nodes[l.from].id,
      downstream: net.nodes[l.to].id,
      length: round(Math.max(l.length, 0.1), 100),
      diameter: round(d),
      roughness: 0.013,
      inlet_offset: round(Math.max(0, upInv - invert.get(l.from)!)),
      outlet_offset: round(Math.max(0, dnInv - invert.get(l.to)!)),
    };
  });
  report.pipes = conduits.length;
  report.outfalls = nodes.filter((n) => n.kind === 'OUTFALL').length;
  report.manholes = nodes.length - report.outfalls;

  const project: SewerProject = {
    schema_version: 1,
    name: options.name,
    nodes,
    conduits,
    catchments: [],
    options: defaultOptions(),
    constraints: defaultConstraints(),
  };
  return { project, report };
}
