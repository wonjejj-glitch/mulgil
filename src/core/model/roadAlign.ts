/**
 * 도로 기준 위치 보정: 관로는 대개 도로 밑에 묻히므로, 관로 위의 점들이 도로 중심선에 가장 가까워지는
 * 평행 이동량(동·서, 남·북 m)을 찾는다. 좌표계 차이(예: EPSG:5174 ↔ 2097 은 동서 263 m)나
 * 도면 원점 오류처럼 관망 전체가 한 방향으로 밀린 경우를 바로잡는 용도다 (회전·축척은 보정하지 않는다).
 */
import type { LngLat } from './types';

export interface AlignOptions {
  /** 찾는 이동량 범위 (m, ±). */
  maxShift?: number;
  /** 도로에서 이 거리(m)보다 먼 점은 이 값으로 잘라 이상치 영향을 줄인다. */
  cap?: number;
  /** 관로를 따라 표본을 뽑는 간격 (m). */
  sampleSpacing?: number;
  maxSamples?: number;
}

export interface AlignResult {
  /** 동쪽(+)·북쪽(+) 이동량 (m). */
  dx: number;
  dy: number;
  /** 보정 전·후 표본점–도로 평균 거리 (m, cap 으로 자른 값). */
  before: number;
  after: number;
  /** 보정 후 도로에서 15 m 이내에 든 표본 비율. */
  matchedAfter: number;
  matchedBefore: number;
  samples: number;
  roadSegments: number;
}

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_EQ = 111320;

/** 관망 중심을 원점으로 한 평면(m) 좌표 변환. 수 km~수십 km 범위에서 충분히 정확하다. */
function makePlane(origin: LngLat) {
  const kx = M_PER_DEG_LNG_EQ * Math.cos((origin[1] * Math.PI) / 180);
  return {
    to: (p: LngLat): [number, number] => [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * M_PER_DEG_LAT],
    kx,
  };
}

/** 폴리라인들을 따라 일정 간격으로 점을 뽑는다 (평면 좌표). */
function samplePaths(paths: [number, number][][], spacing: number, maxSamples: number): [number, number][] {
  const out: [number, number][] = [];
  for (const path of paths) {
    for (let i = 0; i + 1 < path.length; i++) {
      const [ax, ay] = path[i];
      const [bx, by] = path[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.floor(len / spacing));
      for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
    if (path.length > 0) out.push(path[path.length - 1]);
  }
  if (out.length <= maxSamples) return out;
  const stride = out.length / maxSamples;
  return Array.from({ length: maxSamples }, (_, i) => out[Math.floor(i * stride)]);
}

/** 격자 해시로 선분을 묶어 '가까운 선분까지의 거리'를 빠르게 구한다. */
class SegmentIndex {
  private cells = new Map<string, number[]>();
  private segs: Float64Array;
  constructor(
    segments: [number, number, number, number][],
    private cell: number,
  ) {
    this.segs = new Float64Array(segments.length * 4);
    segments.forEach((s, i) => {
      this.segs.set(s, i * 4);
      const [x1, y1, x2, y2] = s;
      const cx0 = Math.floor(Math.min(x1, x2) / cell);
      const cx1 = Math.floor(Math.max(x1, x2) / cell);
      const cy0 = Math.floor(Math.min(y1, y2) / cell);
      const cy1 = Math.floor(Math.max(y1, y2) / cell);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = `${cx},${cy}`;
          const list = this.cells.get(key);
          if (list) list.push(i);
          else this.cells.set(key, [i]);
        }
      }
    });
  }

  /** 점에서 가장 가까운 선분까지의 거리. cap 안에 없으면 cap. */
  distance(x: number, y: number, cap: number): number {
    const r = Math.ceil(cap / this.cell);
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    let best = cap * cap;
    for (let i = cx - r; i <= cx + r; i++) {
      for (let j = cy - r; j <= cy + r; j++) {
        const list = this.cells.get(`${i},${j}`);
        if (!list) continue;
        for (const s of list) {
          const x1 = this.segs[s * 4], y1 = this.segs[s * 4 + 1], x2 = this.segs[s * 4 + 2], y2 = this.segs[s * 4 + 3];
          const dx = x2 - x1, dy = y2 - y1;
          const len2 = dx * dx + dy * dy;
          let t = len2 > 0 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = x1 + t * dx - x, ey = y1 + t * dy - y;
          const d2 = ex * ex + ey * ey;
          if (d2 < best) best = d2;
        }
      }
    }
    return Math.sqrt(best);
  }
}

/** 이동 없이 지금 위치에서의 도로 일치도만 잰다 (좌표계 후보 비교용, 빠름). */
export function roadFitScore(pipePaths: LngLat[][], roads: LngLat[][], options: AlignOptions = {}): { mean: number; matched: number } | null {
  const fit = prepareFit(pipePaths, roads, options);
  return fit ? { mean: fit.score(0, 0), matched: fit.matched(0, 0) } : null;
}

/**
 * 관로 경로(경위도)와 도로 중심선(경위도)으로 최적 평행 이동량을 찾는다.
 * 거친 격자 탐색(25 m) → 세밀 탐색(5 m → 1 m) 순서로 평균 거리를 최소화한다.
 */
export function estimateRoadShift(pipePaths: LngLat[][], roads: LngLat[][], options: AlignOptions = {}): AlignResult | null {
  const maxShift = options.maxShift ?? 400;
  const fit = prepareFit(pipePaths, roads, options);
  if (!fit) return null;
  const { score, matched } = fit;

  let best = { x: 0, y: 0, s: score(0, 0) };
  const before = best.s;
  const search = (cx: number, cy: number, radius: number, step: number) => {
    for (let x = cx - radius; x <= cx + radius + 1e-9; x += step) {
      for (let y = cy - radius; y <= cy + radius + 1e-9; y += step) {
        const s = score(x, y);
        if (s < best.s - 1e-9) best = { x, y, s };
      }
    }
  };
  search(0, 0, maxShift, 25);
  search(best.x, best.y, 25, 5);
  search(best.x, best.y, 5, 1);

  return {
    dx: best.x,
    dy: best.y,
    before,
    after: best.s,
    matchedBefore: matched(0, 0),
    matchedAfter: matched(best.x, best.y),
    samples: fit.samples,
    roadSegments: fit.segments,
  };
}

function prepareFit(pipePaths: LngLat[][], roads: LngLat[][], options: AlignOptions) {
  const cap = options.cap ?? 60;
  const spacing = options.sampleSpacing ?? 40;
  const maxSamples = options.maxSamples ?? 1500;
  const all = pipePaths.flat();
  if (all.length < 2 || roads.length === 0) return null;
  const origin: LngLat = [all.reduce((s, p) => s + p[0], 0) / all.length, all.reduce((s, p) => s + p[1], 0) / all.length];
  const plane = makePlane(origin);

  const samples = samplePaths(pipePaths.map((p) => p.map(plane.to)), spacing, maxSamples);
  const segments: [number, number, number, number][] = [];
  for (const road of roads) {
    for (let i = 0; i + 1 < road.length; i++) {
      const a = plane.to(road[i]);
      const b = plane.to(road[i + 1]);
      segments.push([a[0], a[1], b[0], b[1]]);
    }
  }
  if (samples.length === 0 || segments.length === 0) return null;
  const index = new SegmentIndex(segments, Math.max(cap, 50));

  const score = (sx: number, sy: number) => {
    let sum = 0;
    for (const [x, y] of samples) sum += index.distance(x + sx, y + sy, cap);
    return sum / samples.length;
  };
  const matched = (sx: number, sy: number) => {
    let n = 0;
    for (const [x, y] of samples) if (index.distance(x + sx, y + sy, 15) < 15) n++;
    return n / samples.length;
  };
  return { score, matched, samples: samples.length, segments: segments.length };
}

/** 이동량(m)을 경위도 점에 적용한다. */
export function shiftLngLat(p: LngLat, dx: number, dy: number): LngLat {
  return [p[0] + dx / (M_PER_DEG_LNG_EQ * Math.cos((p[1] * Math.PI) / 180)), p[1] + dy / M_PER_DEG_LAT];
}
