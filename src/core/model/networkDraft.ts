/**
 * 수용가 위치 + 도로망으로 관망 초안 만들기.
 *
 * 관은 대개 도로 밑에 묻히므로
 *   1) 도로 중심선을 촘촘히 나눈 그래프를 만들고
 *   2) 각 수용가를 가장 가까운 도로 위 지점에 붙인 뒤(급수관·연결관 자리)
 *   3) 수원(상수) 또는 방류구(하수)에서 도로망 최단 경로 나무(shortest-path tree)를 만들어
 *      수용가가 붙은 지점까지 가는 길만 남긴다.
 *   4) 분기점·말단·수용가 접속점·최대 관 길이마다 절점을 두고 그 사이를 관 하나로 묶는다.
 * 하수는 지반고를 주면 오르막(하류로 갈수록 높아지는 길)에 벌점을 줘서 자연 유하 쪽 경로를 고른다.
 *
 * 결과는 가지형(수지상) 초안이다. 상수 관망의 환상(loop)·밸브 배치, 하수의 펌프장은 사람이 판단한다.
 * 순수 함수 — 네트워크 요청·지형 조회는 app/draftActions 가 맡는다.
 */
import type { Customer } from '../io/customerCsv';
import { dist, plane, RoadGraph, simplify, type XY } from './roadSnap';
import type { LngLat } from './types';

export type DraftMode = 'water' | 'sewer';

export interface DraftOptions {
  mode: DraftMode;
  /** 수원(배수지·수도 접속점) 또는 방류구(처리장·간선 접속점) 위치. */
  source: LngLat;
  /** 수용가에서 도로까지 이 거리(m)보다 멀면 연결하지 않는다. */
  maxServiceDistance: number;
  /** 관 하나의 최대 길이(m). 넘으면 중간에 절점(맨홀)을 넣는다. */
  maxPipeLength: number;
  /** 도로 선분을 나누는 간격(m). 수용가 접속 위치의 정밀도. */
  spacing: number;
  /** 하수: 오르막 1 m 를 관 길이 몇 m 로 칠지 (지반고가 있을 때만). */
  uphillPenalty: number;
  /** 이보다 짧은 관은 하류 절점으로 합친다 (m, 기본 5). */
  minLinkLength?: number;
}

export function defaultDraftOptions(mode: DraftMode, source: LngLat): DraftOptions {
  return { mode, source, maxServiceDistance: 80, maxPipeLength: mode === 'sewer' ? 75 : 300, spacing: 15, uphillPenalty: 40 };
}

/** 도로 그래프 (지반고를 따로 조회할 수 있게 꼭짓점 좌표를 내보낸다). */
export interface PreparedRoads {
  graph: RoadGraph;
  origin: LngLat;
  vertices: LngLat[];
}

/** 도로 중심선 → 일정 간격으로 나눈 그래프. */
export function prepareRoads(roads: LngLat[][], origin: LngLat, spacing: number): PreparedRoads {
  const P = plane(origin);
  const graph = new RoadGraph(50);
  for (const road of roads) {
    let prev = -1;
    let prevXY: XY | null = null;
    for (const p of road) {
      const xy = P.to(p);
      if (prevXY) {
        const n = Math.max(1, Math.ceil(dist(prevXY, xy) / spacing));
        for (let k = 1; k <= n; k++) {
          const q: XY = [prevXY[0] + ((xy[0] - prevXY[0]) * k) / n, prevXY[1] + ((xy[1] - prevXY[1]) * k) / n];
          const v = graph.vertex(q);
          graph.addSegment(prev, v);
          prev = v;
        }
      } else prev = graph.vertex(xy);
      prevXY = xy;
    }
  }
  return { graph, origin, vertices: graph.pts.map(P.from) };
}

export interface DraftNode {
  key: number;
  position: LngLat;
  /** 이 절점에 붙은 수용가 사용량 합 (m³/일). */
  demand: number;
  customers: string[];
  isSource: boolean;
  ground: number | null;
}

export interface DraftLink {
  /** 상류(수원·방류구에서 먼 쪽) 절점 key. */
  from: number;
  /** 하류(수원·방류구 쪽) 절점 key. */
  to: number;
  /** from → to 형상 (양 끝 포함). */
  path: LngLat[];
  length: number;
  /** 이 관을 지나는 수용가 사용량 합 (m³/일) = 상류 쪽 모든 절점 수요 합. */
  carried: number;
}

export interface DraftResult {
  nodes: DraftNode[];
  links: DraftLink[];
  /** 도로에서 너무 멀거나 수원과 이어진 도로가 없어 빠진 수용가. */
  unserved: { id: string; reason: string }[];
  stats: { customers: number; served: number; totalDemand: number; servedDemand: number; totalLength: number; sourceSnap: number };
}

class MinHeap {
  private a: [number, number][] = [];
  get size() {
    return this.a.length;
  }
  push(d: number, v: number) {
    const a = this.a;
    a.push([d, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * 관망 초안 생성.
 * @param ground 도로 꼭짓점별 지반고 (prepared.vertices 와 같은 순서). 없으면 거리만으로 경로를 고른다.
 */
export function buildDraft(prepared: PreparedRoads, customers: Customer[], options: DraftOptions, ground?: number[]): DraftResult {
  const { graph, origin } = prepared;
  const P = plane(origin);
  const n = graph.pts.length;
  if (n === 0) throw new Error('영역 안에 도로 자료가 없습니다.');

  const nearestVertex = (xy: XY, radius: number): { v: number; d: number } | null => {
    const near = graph.nearest(xy, radius);
    if (!near) return null;
    const a = graph.segA[near.seg];
    const b = graph.segB[near.seg];
    const v = dist(xy, graph.pts[a]) <= dist(xy, graph.pts[b]) ? a : b;
    return { v, d: dist(xy, graph.pts[v]) };
  };

  // 수원 → 가장 가까운 도로
  const srcXY = P.to(options.source);
  const src = nearestVertex(srcXY, 2000);
  if (!src) throw new Error('수원·방류구 위치에서 2 km 안에 도로가 없습니다. 위치를 다시 고르세요.');

  // 나무에서 각 꼭짓점까지의 비용 (Dijkstra, 나무가 커질 때마다 새 부분에서 이어서 푼다).
  // 하수는 흐름 방향(먼 쪽 → 나무 쪽)으로 오르막이면 벌점.
  const distTo = new Float64Array(n).fill(Infinity);
  const toward = new Int32Array(n).fill(-1);
  const penalize = options.mode === 'sewer' && ground && ground.length === n;
  const grow = (seeds: number[]) => {
    const heap = new MinHeap();
    for (const s of seeds) {
      distTo[s] = 0;
      heap.push(0, s);
    }
    while (heap.size > 0) {
      const [d, u] = heap.pop();
      if (d > distTo[u]) continue;
      for (const e of graph.adj[u]) {
        // 물은 e.to(상류) → u(하류)로 흐른다. 하류가 더 높으면 오르막.
        const climb = penalize ? Math.max(0, ground![u] - ground![e.to]) : 0;
        const nd = d + e.w + climb * options.uphillPenalty;
        if (nd < distTo[e.to]) {
          distTo[e.to] = nd;
          toward[e.to] = u;
          heap.push(nd, e.to);
        }
      }
    }
  };
  grow([src.v]);

  // 수용가 → 도로 접속점
  const demandAt = new Map<number, { demand: number; ids: string[] }>();
  const unserved: DraftResult['unserved'] = [];
  let totalDemand = 0;
  let servedDemand = 0;
  for (const c of customers) {
    totalDemand += c.demand;
    const hit = nearestVertex(P.to(c.position), options.maxServiceDistance);
    if (!hit) {
      unserved.push({ id: c.id, reason: `도로에서 ${options.maxServiceDistance} m 넘게 떨어짐` });
      continue;
    }
    if (!Number.isFinite(distTo[hit.v])) {
      unserved.push({ id: c.id, reason: '수원·방류구와 이어진 도로가 없음' });
      continue;
    }
    const slot = demandAt.get(hit.v) ?? { demand: 0, ids: [] };
    slot.demand += c.demand;
    slot.ids.push(c.id);
    demandAt.set(hit.v, slot);
    servedDemand += c.demand;
  }
  if (demandAt.size === 0) throw new Error('도로에 연결할 수 있는 수용가가 없습니다. 최대 연결 거리나 좌표계를 확인하세요.');

  // 탐욕적 스타이너 나무 (Takahashi–Matsuyama): 지금 나무에서 가장 가까운 수용가 접속점부터
  // 나무까지의 최소 경로를 붙인다. 최단 경로 나무보다 총연장이 짧고 같은 길을 두 번 깔지 않는다.
  const parent = new Int32Array(n).fill(-1);
  const inTree = new Uint8Array(n);
  inTree[src.v] = 1;
  const pending = new Set(demandAt.keys());
  pending.delete(src.v);
  while (pending.size > 0) {
    let best = -1;
    for (const t of pending) if (best < 0 || distTo[t] < distTo[best]) best = t;
    pending.delete(best);
    if (inTree[best]) continue;
    const added: number[] = [];
    for (let v = best; !inTree[v]; v = toward[v]) {
      inTree[v] = 1;
      parent[v] = toward[v];
      added.push(v);
    }
    grow(added);
  }
  const childCount = new Int32Array(n);
  for (let v = 0; v < n; v++) if (inTree[v] && v !== src.v) childCount[parent[v]]++;

  // 절점이 될 꼭짓점: 수원, 수용가 접속점, 분기점(자식 2개 이상), 말단(자식 0)
  const isKey = (v: number) => v === src.v || demandAt.has(v) || childCount[v] !== 1;
  const keyIndex = new Map<number, number>();
  const nodes: DraftNode[] = [];
  const addNode = (v: number | null, xy: XY, isSource: boolean): number => {
    const key = nodes.length;
    const slot = v !== null ? demandAt.get(v) : undefined;
    nodes.push({
      key,
      position: P.from(xy),
      demand: slot?.demand ?? 0,
      customers: slot?.ids ?? [],
      isSource,
      ground: v !== null && ground ? (ground[v] ?? null) : null,
    });
    if (v !== null) keyIndex.set(v, key);
    return key;
  };
  addNode(src.v, graph.pts[src.v], true);
  for (let v = 0; v < n; v++) if (inTree[v] && v !== src.v && isKey(v)) addNode(v, graph.pts[v], false);

  // 절점 사이 사슬 → 관 (길면 나눈다)
  const links: DraftLink[] = [];
  const chainLength = (path: XY[]) => path.reduce((s, p, i) => (i === 0 ? 0 : s + dist(path[i - 1], p)), 0);
  // 나누면서 생기는 절점도 keyIndex 에 들어가므로, 처음 목록으로만 돈다
  for (const [v, key] of [...keyIndex]) {
    if (v === src.v) continue;
    const chain: number[] = [v];
    let u = parent[v];
    while (!keyIndex.has(u)) {
      chain.push(u);
      u = parent[u];
    }
    chain.push(u);
    const xy = chain.map((i) => graph.pts[i]);
    const total = chainLength(xy);
    const pieces = Math.max(1, Math.ceil(total / options.maxPipeLength - 1e-9));
    // 나눌 자리: 사슬 위 꼭짓점 중 등분 거리에 가장 가까운 점
    const cuts: number[] = [0];
    if (pieces > 1) {
      let acc = 0;
      let next = 1;
      for (let i = 1; i < chain.length - 1 && next < pieces; i++) {
        acc += dist(xy[i - 1], xy[i]);
        if (acc >= (total * next) / pieces - options.spacing / 2) {
          cuts.push(i);
          next++;
        }
      }
    }
    cuts.push(chain.length - 1);
    let fromKey = key;
    for (let c = 0; c + 1 < cuts.length; c++) {
      const a = cuts[c];
      const b = cuts[c + 1];
      const toKey = c + 2 === cuts.length ? keyIndex.get(chain[b])! : addNode(chain[b], xy[b], false);
      const part = simplify(xy.slice(a, b + 1));
      links.push({ from: fromKey, to: toKey, path: part.map(P.from), length: chainLength(xy.slice(a, b + 1)), carried: 0 });
      fromKey = toKey;
    }
  }

  // 아주 짧은 관(교차점 옆 접속점 등)은 하류 절점으로 합친다 — 해석에서 '낙차가 연장보다 큼' 경고를 막는다
  const minLink = options.minLinkLength ?? 5;
  for (let guard = 0; guard < links.length; guard++) {
    const k = links.findIndex((l) => l.length < minLink && !nodes[l.from].isSource);
    if (k < 0) break;
    const short = links[k];
    const gone = nodes[short.from];
    const keep = nodes[short.to];
    keep.demand += gone.demand;
    keep.customers.push(...gone.customers);
    for (const l of links) {
      if (l.to === gone.key) {
        l.to = keep.key;
        l.path = [...l.path.slice(0, -1), keep.position];
        l.length += short.length;
      }
    }
    links.splice(k, 1);
    gone.key = -1;
  }
  // 지운 절점을 빼고 번호를 다시 매긴다
  const alive = nodes.filter((nd) => nd.key >= 0);
  const renum = new Map(alive.map((nd, i) => [nd.key, i]));
  for (const l of links) {
    l.from = renum.get(l.from)!;
    l.to = renum.get(l.to)!;
  }
  alive.forEach((nd, i) => (nd.key = i));
  nodes.length = 0;
  nodes.push(...alive);

  // 누적 사용량: 하류 방향으로 더한다 (from → to 를 따라 위상 순서)
  const down = new Map<number, number>();
  for (const l of links) down.set(l.from, l.to);
  const sub = nodes.map((nd) => nd.demand);
  const depth = (k: number) => {
    let d = 0;
    for (let x = k; down.has(x); x = down.get(x)!) d++;
    return d;
  };
  const order = nodes.map((nd) => nd.key).sort((a, b) => depth(b) - depth(a));
  for (const k of order) {
    const to = down.get(k);
    if (to !== undefined) sub[to] += sub[k];
  }
  for (const l of links) l.carried = sub[l.from];

  return {
    nodes,
    links,
    unserved,
    stats: {
      customers: customers.length,
      served: customers.length - unserved.length,
      totalDemand,
      servedDemand,
      totalLength: links.reduce((s, l) => s + l.length, 0),
      sourceSnap: src.d,
    },
  };
}
