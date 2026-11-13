/**
 * 도로 따라 관로 형상 보정 (map matching).
 * 관로는 대개 도로 밑에 묻혀 있으므로
 *   1) 절점을 가까운 도로 중심선(교차점 우선) 위로 옮기고
 *   2) 양 끝이 도로 위에 놓인 관로는 도로망을 따라 가는 경로(최단 경로)로 꺾임점을 다시 만든다.
 * 도로에서 멀리 떨어진 절점·관로(논·산을 가로지르는 관로)는 그대로 둔다.
 * 순수 함수 — 입력 모델을 바꾸지 않고 바꿀 위치·꺾임점만 돌려준다.
 */
import type { LngLat, NetworkModel } from './types';

export interface SnapOptions {
  /** 절점을 옮길 최대 거리 (m). */
  tolerance?: number;
  /** 교차점으로 끌어당길 거리 (m). 이 안에 도로 교차점이 있으면 선분 위 투영점보다 우선한다. */
  intersectionTolerance?: number;
  /** 수원지·배수지도 옮길지. 기본 false (시설 위치는 보통 도로 밖). */
  moveSources?: boolean;
  /** 도로 경로가 원래 관로보다 이 배수 이상 길면 경로를 따르지 않는다. */
  maxDetourRatio?: number;
  /** 모델 길이 단위 1 의 m (SI 1, US 0.3048). .inp 연장과 도로 경로 길이를 비교할 때 쓴다. */
  metersPerLengthUnit?: number;
}

export interface SnapResult {
  /** 옮길 절점과 새 위치. */
  nodes: Map<string, LngLat>;
  /** 꺾임점을 새로 만든 링크와 새 꺾임점(시점·종점 제외). */
  vertices: Map<string, LngLat[]>;
  stats: {
    nodesConsidered: number;
    nodesMoved: number;
    /** 이미 도로 위(1 m 이내)에 있던 절점. */
    nodesOnRoad: number;
    meanMove: number;
    maxMove: number;
    linksRouted: number;
    linksConsidered: number;
    roadSegments: number;
  };
}

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_EQ = 111320;

export type XY = [number, number];

export function plane(origin: LngLat) {
  const kx = M_PER_DEG_LNG_EQ * Math.cos((origin[1] * Math.PI) / 180);
  return {
    to: (p: LngLat): XY => [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * M_PER_DEG_LAT],
    from: (p: XY): LngLat => [origin[0] + p[0] / kx, origin[1] + p[1] / M_PER_DEG_LAT],
  };
}

export const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 도로 그래프: OSM 길(way)은 교차점에서 같은 좌표의 점을 공유하므로 좌표로 꼭짓점을 합친다. */
export class RoadGraph {
  pts: XY[] = [];
  adj: { to: number; w: number }[][] = [];
  segA: number[] = [];
  segB: number[] = [];
  private key = new Map<string, number>();
  private cells = new Map<string, number[]>();
  constructor(private cell: number) {}

  vertex(p: XY): number {
    const k = `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
    let i = this.key.get(k);
    if (i === undefined) {
      i = this.pts.length;
      this.pts.push(p);
      this.adj.push([]);
      this.key.set(k, i);
    }
    return i;
  }

  addSegment(a: number, b: number): void {
    if (a === b) return;
    const w = dist(this.pts[a], this.pts[b]);
    this.adj[a].push({ to: b, w });
    this.adj[b].push({ to: a, w });
    const s = this.segA.length;
    this.segA.push(a);
    this.segB.push(b);
    const [x1, y1] = this.pts[a];
    const [x2, y2] = this.pts[b];
    for (let cx = Math.floor(Math.min(x1, x2) / this.cell); cx <= Math.floor(Math.max(x1, x2) / this.cell); cx++) {
      for (let cy = Math.floor(Math.min(y1, y2) / this.cell); cy <= Math.floor(Math.max(y1, y2) / this.cell); cy++) {
        const k = `${cx},${cy}`;
        const list = this.cells.get(k);
        if (list) list.push(s);
        else this.cells.set(k, [s]);
      }
    }
  }

  /** 반경 안의 가장 가까운 도로 선분 위 점. */
  nearest(p: XY, radius: number): { seg: number; t: number; q: XY; d: number } | null {
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(p[0] / this.cell);
    const cy = Math.floor(p[1] / this.cell);
    let best: { seg: number; t: number; q: XY; d: number } | null = null;
    for (let i = cx - r; i <= cx + r; i++) {
      for (let j = cy - r; j <= cy + r; j++) {
        for (const s of this.cells.get(`${i},${j}`) ?? []) {
          const a = this.pts[this.segA[s]];
          const b = this.pts[this.segB[s]];
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const len2 = dx * dx + dy * dy;
          let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          const q: XY = [a[0] + t * dx, a[1] + t * dy];
          const d = dist(p, q);
          if (d <= radius && (!best || d < best.d)) best = { seg: s, t, q, d };
        }
      }
    }
    return best;
  }

  /** 반경 안의 가장 가까운 교차점(연결 3개 이상). */
  nearestIntersection(p: XY, radius: number): number | null {
    const near = this.nearest(p, radius);
    if (!near) return null;
    let best: number | null = null;
    let bestD = radius;
    for (const v of [this.segA[near.seg], this.segB[near.seg]]) {
      // 가까운 선분의 양 끝과, 그 끝에 이어진 이웃까지 본다
      for (const cand of [v, ...this.adj[v].map((e) => e.to)]) {
        if (this.adj[cand].length < 3) continue;
        const d = dist(p, this.pts[cand]);
        if (d < bestD) {
          bestD = d;
          best = cand;
        }
      }
    }
    return best;
  }

  /**
   * 두 도로 위 점 사이의 도로망 최단 경로 (점 목록). 거리 한도를 넘으면 null.
   * 시작·끝 점은 선분 위 임의 위치일 수 있어 선분 양 끝에서 출발·도착한다.
   */
  route(from: { seg: number; q: XY }, to: { seg: number; q: XY }, limit: number): { path: XY[]; length: number } | null {
    if (from.seg === to.seg) return { path: [from.q, to.q], length: dist(from.q, to.q) };
    const n = this.pts.length;
    const distMap = new Map<number, number>();
    const prev = new Map<number, number>();
    const heap: [number, number][] = [];
    const push = (d: number, v: number) => {
      heap.push([d, v]);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent][0] <= heap[i][0]) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
    };
    const pop = (): [number, number] | undefined => {
      if (heap.length === 0) return undefined;
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    const START = -1;
    for (const v of [this.segA[from.seg], this.segB[from.seg]]) {
      const d = dist(from.q, this.pts[v]);
      if (d < (distMap.get(v) ?? Infinity)) {
        distMap.set(v, d);
        prev.set(v, START);
        push(d, v);
      }
    }
    const endA = this.segA[to.seg];
    const endB = this.segB[to.seg];
    let bestEnd = -1;
    let bestTotal = Infinity;
    const done = new Set<number>();
    while (heap.length > 0) {
      const [d, v] = pop()!;
      if (done.has(v) || d > (distMap.get(v) ?? Infinity)) continue;
      if (d > limit || d >= bestTotal) break;
      done.add(v);
      if (v === endA || v === endB) {
        const total = d + dist(this.pts[v], to.q);
        if (total < bestTotal) {
          bestTotal = total;
          bestEnd = v;
        }
      }
      for (const e of this.adj[v]) {
        const nd = d + e.w;
        if (nd < (distMap.get(e.to) ?? Infinity) && nd <= limit) {
          distMap.set(e.to, nd);
          prev.set(e.to, v);
          push(nd, e.to);
        }
      }
      if (done.size > n) break;
    }
    if (bestEnd < 0 || bestTotal > limit) return null;
    const chain: XY[] = [];
    for (let v = bestEnd; v !== START; v = prev.get(v)!) chain.push(this.pts[v]);
    chain.reverse();
    return { path: [from.q, ...chain, to.q], length: bestTotal };
  }
}

function pathLength(path: XY[]): number {
  let s = 0;
  for (let i = 0; i + 1 < path.length; i++) s += dist(path[i], path[i + 1]);
  return s;
}

/** 거의 일직선 위의 점을 빼서 꺾임점 수를 줄인다 (Douglas–Peucker, 허용 1 m). */
export function simplify(path: XY[], tol = 1): XY[] {
  if (path.length <= 2) return path;
  const keep = new Array(path.length).fill(false);
  keep[0] = keep[path.length - 1] = true;
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    const [ax, ay] = path[i];
    const [bx, by] = path[j];
    const len = Math.hypot(bx - ax, by - ay) || 1e-9;
    let best = -1;
    let bestD = tol;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((bx - ax) * (ay - path[k][1]) - (ax - path[k][0]) * (by - ay)) / len;
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = true;
      stack.push([i, best], [best, j]);
    }
  }
  return path.filter((_, k) => keep[k]);
}

export function snapNetworkToRoads(model: Pick<NetworkModel, 'nodes' | 'links'>, roads: LngLat[][], options: SnapOptions = {}): SnapResult {
  const tolerance = options.tolerance ?? 25;
  const interTol = Math.min(options.intersectionTolerance ?? 12, tolerance);
  const maxDetour = options.maxDetourRatio ?? 1.5;
  const ids = Object.keys(model.nodes);
  const origin: LngLat = ids.length > 0 ? model.nodes[ids[0]].position : [127, 37];
  const P = plane(origin);

  const graph = new RoadGraph(Math.max(tolerance, 30));
  for (const road of roads) {
    let prevV = -1;
    for (const p of road) {
      const v = graph.vertex(P.to(p));
      if (prevV >= 0) graph.addSegment(prevV, v);
      prevV = v;
    }
  }

  // 1) 절점 → 도로
  const snapped = new Map<string, { seg: number; q: XY } | null>();
  const moves = new Map<string, LngLat>();
  const usedIntersections = new Set<number>();
  let moved = 0;
  let onRoad = 0;
  let considered = 0;
  let sumMove = 0;
  let maxMove = 0;
  for (const id of ids) {
    const node = model.nodes[id];
    if (node.type !== 'junction' && !options.moveSources) {
      snapped.set(id, null);
      continue;
    }
    considered++;
    const p = P.to(node.position);
    let target: { seg: number; q: XY; d: number } | null = null;
    const inter = graph.nearestIntersection(p, interTol);
    if (inter !== null && !usedIntersections.has(inter)) {
      usedIntersections.add(inter);
      const q = graph.pts[inter];
      const seg = graph.nearest(q, 0.01);
      if (seg) target = { seg: seg.seg, q, d: dist(p, q) };
    }
    target ??= graph.nearest(p, tolerance);
    if (!target) {
      snapped.set(id, null);
      continue;
    }
    snapped.set(id, { seg: target.seg, q: target.q });
    if (target.d < 1) {
      onRoad++;
      continue;
    }
    moves.set(id, P.from(target.q));
    moved++;
    sumMove += target.d;
    maxMove = Math.max(maxMove, target.d);
  }

  // 2) 관로 → 도로 경로
  const vertices = new Map<string, LngLat[]>();
  let routed = 0;
  let linksConsidered = 0;
  for (const linkId in model.links) {
    const link = model.links[linkId];
    if (link.type !== 'pipe') continue;
    const a = snapped.get(link.startNodeId);
    const b = snapped.get(link.endNodeId);
    if (!a || !b) continue;
    linksConsidered++;
    const startXY = P.to(model.nodes[link.startNodeId].position);
    const endXY = P.to(model.nodes[link.endNodeId].position);
    const drawnLen = pathLength([startXY, ...link.vertices.map(P.to), endXY]);
    // 기준 길이: 도면 형상 길이와 .inp 연장 중 짧은 쪽 — 도면이 실제보다 크게 그려진 구간에서 엉뚱한 길로 돌지 않게 한다
    const fileLen = link.length > 0 ? link.length * (options.metersPerLengthUnit ?? 1) : Infinity;
    const straight = dist(a.q, b.q);
    if (straight < 1) continue;
    const limit = Math.max(Math.min(drawnLen, fileLen), straight) * maxDetour + 30;
    const route = graph.route(a, b, limit);
    if (!route) continue;
    const simplified = simplify(route.path);
    const inner = simplified.slice(1, -1);
    // 직선과 다를 바 없으면(꺾임 없음) 꺾임점을 비운다
    vertices.set(linkId, inner.map(P.from));
    routed++;
  }

  return {
    nodes: moves,
    vertices,
    stats: {
      nodesConsidered: considered,
      nodesMoved: moved,
      nodesOnRoad: onRoad,
      meanMove: moved > 0 ? sumMove / moved : 0,
      maxMove,
      linksRouted: routed,
      linksConsidered,
      roadSegments: graph.segA.length,
    },
  };
}
