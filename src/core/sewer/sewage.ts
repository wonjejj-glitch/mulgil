/**
 * 수용가·건물·하수연결관 → 맨홀 오수 유입량(base_flow) 배분 (순수 함수).
 *
 * 오수량 (m³/일, 일평균)
 *   - 상수 사용량이 있으면: 사용량 × 오수전환율
 *   - 세대수가 있으면:     세대수 × 세대당 인원 × 1인 1일 오수량
 *   - 둘 다 없으면:        기본 세대수(건물·연결관 하나당)로 계산
 * 해석에 넣는 유량 = 일평균 × 첨두 배율 (시간최대 등, 사용자가 정함).
 *
 * 어느 맨홀로 보낼지
 *   1) 하수연결관이 있으면 수용가에서 가까운 연결관 끝(집 쪽)을 찾고, 반대쪽 끝(본관 쪽)이 닿는 맨홀 또는 관거로 보낸다.
 *   2) 없으면 가장 가까운 관거로 보낸다.
 *   관거로 보낼 때는 그 관의 상류 맨홀에 넣는다(그 관을 지나가는 유량으로 보아 안전 쪽).
 * 좌표는 하수 프로젝트 좌표(EPSG:5186, m).
 */
import type { SewerProject } from './types';

export type XY = [number, number];

export interface SewageSource {
  id: string;
  xy: XY;
  /** 상수 사용량 m³/일 */
  demand?: number;
  households?: number;
}

export interface SewageOptions {
  personsPerHousehold: number;
  /** 1인 1일 오수량 (L) */
  litersPerCapita: number;
  /** 오수전환율 (0~1) */
  conversion: number;
  /** 첨두 배율: 해석 유량 = 일평균 × 이 값 */
  peakFactor: number;
  /** 세대수·사용량이 없는 수용가·건물·연결관 하나당 세대수 */
  defaultHouseholds: number;
  /** 가장 가까운 관거를 찾을 최대 거리 (m) */
  maxDistance: number;
  /** 수용가에서 연결관 끝을 찾을 거리 (m) */
  connectionSnap: number;
}

export const DEFAULT_SEWAGE: SewageOptions = {
  personsPerHousehold: 2.3,
  litersPerCapita: 300,
  conversion: 0.9,
  peakFactor: 1,
  defaultHouseholds: 1,
  maxDistance: 100,
  connectionSnap: 20,
};

export interface NodeSewage {
  id: string;
  sources: number;
  households: number;
  /** 일평균 오수량 m³/일 */
  m3day: number;
}

export interface SewageResult {
  /** 맨홀 ID → 해석 유량 (m³/s, 첨두 배율 적용) */
  flows: Map<string, number>;
  perNode: NodeSewage[];
  stats: {
    sources: number;
    viaConnection: number;
    viaNearest: number;
    /** 관거가 너무 멀어 못 붙인 수 */
    unassigned: number;
    /** 사용량·세대수가 없어 기본 세대수를 쓴 수 */
    defaulted: number;
    /** 합계 m³/일 (일평균) */
    totalM3day: number;
  };
  unassignedIds: string[];
}

/* ------------------------------------------------------------------ 기하 */

class Grid<T> {
  private cells = new Map<string, T[]>();
  constructor(readonly size: number) {}
  private key(i: number, j: number) {
    return `${i},${j}`;
  }
  addBox(item: T, x0: number, y0: number, x1: number, y1: number) {
    for (let i = Math.floor(x0 / this.size); i <= Math.floor(x1 / this.size); i++) {
      for (let j = Math.floor(y0 / this.size); j <= Math.floor(y1 / this.size); j++) {
        const k = this.key(i, j);
        const list = this.cells.get(k);
        if (list) list.push(item);
        else this.cells.set(k, [item]);
      }
    }
  }
  near(x: number, y: number, r: number): Set<T> {
    const out = new Set<T>();
    const n = Math.ceil(r / this.size);
    const ci = Math.floor(x / this.size), cj = Math.floor(y / this.size);
    for (let i = ci - n; i <= ci + n; i++) for (let j = cj - n; j <= cj + n; j++) for (const t of this.cells.get(this.key(i, j)) ?? []) out.add(t);
    return out;
  }
}

function segmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/* ------------------------------------------------------------------ 배분 */

/** 수용가 하나의 일평균 오수량 (m³/일)과 세대수. */
export function sourceSewage(s: SewageSource, o: SewageOptions): { m3day: number; households: number; defaulted: boolean } {
  if (s.demand !== undefined && s.demand > 0) return { m3day: s.demand * o.conversion, households: s.households ?? 0, defaulted: false };
  const hh = s.households !== undefined && s.households > 0 ? s.households : o.defaultHouseholds;
  return { m3day: (hh * o.personsPerHousehold * o.litersPerCapita) / 1000, households: hh, defaulted: !(s.households !== undefined && s.households > 0) };
}

export function assignSewage(project: SewerProject, sources: SewageSource[], connections: XY[][], options: Partial<SewageOptions> = {}): SewageResult {
  const o = { ...DEFAULT_SEWAGE, ...options };
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  const junctions = project.nodes.filter((n) => n.kind === 'JUNCTION');

  // 관거 선분 색인
  const segs = project.conduits.map((c) => {
    const a = nodes.get(c.upstream)!, b = nodes.get(c.downstream)!;
    return { up: c.upstream, a: [a.x, a.y] as XY, b: [b.x, b.y] as XY };
  });
  const segGrid = new Grid<number>(50);
  segs.forEach((s, i) => segGrid.addBox(i, Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1])));
  const nodeGrid = new Grid<string>(20);
  for (const n of junctions) nodeGrid.addBox(n.id, n.x, n.y, n.x, n.y);

  /** 점에서 가장 가까운 관거의 상류 맨홀 (maxD 안) */
  const nearestConduitNode = (p: XY, maxD: number): string | null => {
    let best: string | null = null, bestD = maxD;
    for (const i of segGrid.near(p[0], p[1], maxD)) {
      const d = segmentDistance(p, segs[i].a, segs[i].b);
      if (d <= bestD) [best, bestD] = [segs[i].up, d];
    }
    return best;
  };
  /** 본관 쪽 끝이 맨홀(3 m 안)에 닿으면 그 맨홀, 아니면 가까운 관거 */
  const targetAt = (p: XY): string | null => {
    let best: string | null = null, bestD = 3;
    for (const id of nodeGrid.near(p[0], p[1], 3)) {
      const n = nodes.get(id)!;
      const d = dist(p, [n.x, n.y]);
      if (d <= bestD) [best, bestD] = [id, d];
    }
    return best ?? nearestConduitNode(p, 15);
  };

  // 연결관: 관거에 가까운 끝 = 본관 쪽, 먼 끝 = 집 쪽
  const conn: { house: XY; target: string }[] = [];
  for (const line of connections) {
    if (line.length < 2) continue;
    const a = line[0], b = line[line.length - 1];
    const da = nearestDistance(a), db = nearestDistance(b);
    const [house, main] = da <= db ? [b, a] : [a, b];
    const target = targetAt(main);
    if (target) conn.push({ house, target });
  }
  function nearestDistance(p: XY): number {
    let best = Infinity;
    for (const i of segGrid.near(p[0], p[1], 30)) best = Math.min(best, segmentDistance(p, segs[i].a, segs[i].b));
    return best;
  }
  const connGrid = new Grid<number>(Math.max(5, o.connectionSnap));
  conn.forEach((c, i) => connGrid.addBox(i, c.house[0], c.house[1], c.house[0], c.house[1]));

  const per = new Map<string, NodeSewage>();
  const stats = { sources: sources.length, viaConnection: 0, viaNearest: 0, unassigned: 0, defaulted: 0, totalM3day: 0 };
  const unassignedIds: string[] = [];
  for (const s of sources) {
    let target: string | null = null;
    if (conn.length > 0) {
      let best = -1, bestD = o.connectionSnap;
      for (const i of connGrid.near(s.xy[0], s.xy[1], o.connectionSnap)) {
        const d = dist(s.xy, conn[i].house);
        if (d <= bestD) [best, bestD] = [i, d];
      }
      if (best >= 0) {
        target = conn[best].target;
        stats.viaConnection++;
      }
    }
    if (!target) {
      target = nearestConduitNode(s.xy, o.maxDistance);
      if (target) stats.viaNearest++;
    }
    if (!target) {
      stats.unassigned++;
      unassignedIds.push(s.id);
      continue;
    }
    const { m3day, households, defaulted } = sourceSewage(s, o);
    if (defaulted) stats.defaulted++;
    const row = per.get(target) ?? { id: target, sources: 0, households: 0, m3day: 0 };
    row.sources++;
    row.households += households;
    row.m3day += m3day;
    per.set(target, row);
    stats.totalM3day += m3day;
  }
  const flows = new Map<string, number>();
  for (const r of per.values()) flows.set(r.id, (r.m3day * o.peakFactor) / 86400);
  return { flows, perNode: [...per.values()].sort((a, b) => b.m3day - a.m3day), stats, unassignedIds };
}

/** 연결관만 있고 건물·수용가 자료가 없을 때: 이 관망에 닿는 연결관 하나를 수용가 하나(집 쪽 끝)로 본다. */
export function sourcesFromConnections(project: SewerProject, connections: XY[][]): SewageSource[] {
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  const segs = project.conduits.map((c) => [nodes.get(c.upstream)!, nodes.get(c.downstream)!].map((n) => [n.x, n.y] as XY));
  const grid = new Grid<number>(50);
  segs.forEach(([a, b], i) => grid.addBox(i, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])));
  const near = (p: XY) => {
    let best = Infinity;
    for (const i of grid.near(p[0], p[1], 30)) best = Math.min(best, segmentDistance(p, segs[i][0], segs[i][1]));
    return best;
  };
  // 본관 쪽 끝이 이 관망의 관거에서 15 m 넘게 떨어진 연결관(다른 구역)은 뺀다
  const out: SewageSource[] = [];
  connections.forEach((l, i) => {
    if (l.length < 2) return;
    const a = l[0], b = l[l.length - 1];
    const da = near(a), db = near(b);
    if (Math.min(da, db) > 15) return;
    out.push({ id: `C${i + 1}`, xy: da <= db ? b : a });
  });
  return out;
}

/** 맨홀별 배분 결과 CSV (엑셀용 BOM 포함). */
export function sewageCsv(result: SewageResult, peakFactor: number): string {
  const lines = ['맨홀,수용가·건물 수,세대수,일평균 오수량(m³/일),해석 유량(L/s)'];
  for (const r of result.perNode) lines.push([r.id, r.sources, round(r.households, 10), round(r.m3day, 1000), round(((r.m3day * peakFactor) / 86400) * 1000, 1000)].join(','));
  return String.fromCharCode(0xfeff) + lines.join('\n') + '\n';
}

const round = (v: number, k: number) => Math.round(v * k) / k;
