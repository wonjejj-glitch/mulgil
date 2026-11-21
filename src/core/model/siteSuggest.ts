/**
 * 관망 초안용 배수지·방류구 후보 (순수 함수). 실제 배수지·처리장 자료가 있으면 그것을 쓰고, 없을 때 '어디쯤, 얼마나 높이, 얼마나 크게'의
 * 출발점을 준다. 땅 쓰임(산림·사유지·도시계획)은 모르므로 후보 자리는 반드시 현장·도면으로 확인한다.
 *
 * 배수지
 *  - 필요 수위: 수용가마다 (지반고 + 최소 수압 + 후보에서 그 수용가까지 거리 × 손실수두 기울기) 의 최댓값.
 *    후보 땅의 (지반고 + 배수지 깊이) 가 이 값 이상이면 자연유하로 공급할 수 있는 자리다.
 *  - 고르기: 가능한 자리 중 '필요보다 남는 높이 + 수요 중심까지 거리' 가 작은 순으로, 서로 400 m 이상 떨어진 3곳.
 *    남는 높이가 크면 낮은 곳 수압이 기준을 넘으므로 '감압 필요'로 표시한다.
 *  - 자리가 없으면 가장 덜 모자란 곳 + 모자란 만큼의 가압 양정.
 *  - 용량: 계획 1일 최대 급수량(평균 × 일최대 비) 의 12시간분 (상수도시설기준의 배수지 유효용량 기준, 비율은 예시).
 * 방류구
 *  - 범위 가장자리(조금 바깥)와 수용가 자리 중 가장 낮은 곳 3곳 (서로 300 m 이상). 자연유하는 낮은 쪽으로 모이므로 출발점이 된다.
 */
import type { LngLat } from './types';

export interface GroundPoint {
  position: LngLat;
  ground: number;
}

export interface ReservoirSuggestOptions {
  /** 최소 수압 (m) */
  minPressure: number;
  /** 최대 수압 (m) — 넘으면 감압 필요 표시 */
  maxPressure: number;
  /** 배수지 깊이 = 고수위 − 지반고 (m) */
  tankDepth: number;
  /** 손실수두 기울기 (m/km, 개략) */
  headlossPerKm: number;
  /** 계획 1일 최대 / 1일 평균 */
  peakDayFactor: number;
  /** 배수지 유효용량 = 계획 1일 최대의 이 시간분 */
  storageHours: number;
}

export const DEFAULT_RESERVOIR_SUGGEST: ReservoirSuggestOptions = {
  minPressure: 15.3,
  maxPressure: 71.4,
  tankDepth: 5,
  headlossPerKm: 2,
  peakDayFactor: 1.3,
  storageHours: 12,
};

export interface ReservoirSite extends GroundPoint {
  /** 고수위 (m) = 지반고 + 배수지 깊이 */
  hwl: number;
  /** 이 자리에서 필요한 최소 고수위 (m) */
  requiredHwl: number;
  /** 수요 중심까지 거리 (km) */
  distanceKm: number;
  /** 가장 낮은 수용가의 정수압 (m) = 고수위 − 최저 지반고 */
  maxStaticPressure: number;
  needsPrv: boolean;
}

export interface ReservoirSuggestion {
  sites: ReservoirSite[];
  /** 자연유하 자리가 없을 때: 가장 덜 모자란 자리와 필요한 가압 양정 (m) */
  booster: (GroundPoint & { head: number; hwl: number }) | null;
  customers: number;
  /** 일평균 수요 (m³/일) */
  dailyAverage: number;
  /** 계획 1일 최대 (m³/일) */
  dailyMax: number;
  /** 배수지 유효용량 (m³) */
  volume: number;
  minGround: number;
  maxGround: number;
}

function planar(origin: LngLat) {
  const kx = 111320 * Math.cos((origin[1] * Math.PI) / 180);
  const ky = 110574;
  return (p: LngLat): [number, number] => [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * ky];
}

/** 서로 sepM 이상 떨어진 것만 앞에서부터 n 개 */
function spread<T extends GroundPoint>(sorted: T[], n: number, sepM: number): T[] {
  if (sorted.length === 0) return [];
  const xy = planar(sorted[0].position);
  const out: T[] = [];
  for (const s of sorted) {
    const [x, y] = xy(s.position);
    if (out.every((o) => Math.hypot(xy(o.position)[0] - x, xy(o.position)[1] - y) >= sepM)) out.push(s);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * customers: 수용가 (지반고, 일평균 사용량 m³/일). grid: 후보 땅 (범위 주변을 고르게 짚은 점과 지반고).
 */
export function suggestReservoirSites(
  customers: (GroundPoint & { demand: number })[],
  grid: GroundPoint[],
  options: Partial<ReservoirSuggestOptions> = {},
): ReservoirSuggestion {
  const o = { ...DEFAULT_RESERVOIR_SUGGEST, ...options };
  const valid = customers.filter((c) => Number.isFinite(c.ground));
  const dailyAverage = valid.reduce((s, c) => s + Math.max(0, c.demand), 0);
  const dailyMax = dailyAverage * o.peakDayFactor;
  const base: ReservoirSuggestion = {
    sites: [],
    booster: null,
    customers: valid.length,
    dailyAverage,
    dailyMax,
    volume: (dailyMax * o.storageHours) / 24,
    minGround: Math.min(...valid.map((c) => c.ground)),
    maxGround: Math.max(...valid.map((c) => c.ground)),
  };
  if (valid.length === 0 || grid.length === 0) return base;
  const xy = planar(valid[0].position);
  const cxy = valid.map((c) => xy(c.position));
  // 수요 가중 중심
  const wsum = valid.reduce((s, c) => s + Math.max(1e-9, c.demand), 0);
  const cx = valid.reduce((s, c, i) => s + cxy[i][0] * Math.max(1e-9, c.demand), 0) / wsum;
  const cy = valid.reduce((s, c, i) => s + cxy[i][1] * Math.max(1e-9, c.demand), 0) / wsum;
  const k = o.headlossPerKm / 1000;

  const scored = grid
    .filter((g) => Number.isFinite(g.ground))
    .map((g) => {
      const [gx, gy] = xy(g.position);
      let req = -Infinity;
      for (let i = 0; i < valid.length; i++) {
        const need = valid[i].ground + o.minPressure + k * Math.hypot(cxy[i][0] - gx, cxy[i][1] - gy);
        if (need > req) req = need;
      }
      const hwl = g.ground + o.tankDepth;
      const distanceKm = Math.hypot(gx - cx, gy - cy) / 1000;
      return { ...g, hwl, requiredHwl: req, distanceKm, excess: hwl - req };
    });
  const feasible = scored.filter((s) => s.excess >= 0).sort((a, b) => a.excess + 5 * a.distanceKm - (b.excess + 5 * b.distanceKm));
  base.sites = spread(feasible, 3, 400).map((s) => {
    const maxStaticPressure = s.hwl - base.minGround;
    return {
      position: s.position,
      ground: Math.round(s.ground * 10) / 10,
      hwl: Math.round(s.hwl * 10) / 10,
      requiredHwl: Math.round(s.requiredHwl * 10) / 10,
      distanceKm: Math.round(s.distanceKm * 100) / 100,
      maxStaticPressure: Math.round(maxStaticPressure * 10) / 10,
      needsPrv: maxStaticPressure > o.maxPressure,
    };
  });
  if (base.sites.length === 0) {
    const best = [...scored].sort((a, b) => b.excess - a.excess)[0];
    if (best) base.booster = { position: best.position, ground: Math.round(best.ground * 10) / 10, hwl: Math.round(best.hwl * 10) / 10, head: Math.round(-best.excess * 10) / 10 };
  }
  return base;
}

/** 범위 가장자리와 수용가 자리 중 가장 낮은 곳 3곳 (방류구 후보). */
export function suggestOutfallSites(candidates: (GroundPoint & { kind: 'edge' | 'customer' })[]): (GroundPoint & { kind: 'edge' | 'customer' })[] {
  const sorted = candidates.filter((c) => Number.isFinite(c.ground)).sort((a, b) => a.ground - b.ground);
  return spread(sorted, 3, 300).map((c) => ({ ...c, ground: Math.round(c.ground * 10) / 10 }));
}

/** 범위 [서, 남, 동, 북] 를 여유(m)만큼 넓혀 고르게 짚은 점 (최대 maxPoints 개) */
export function gridAround(box: [number, number, number, number], marginM: number, maxPoints = 2500): LngLat[] {
  const [w, s, e, n] = box;
  const lat = ((s + n) / 2) * (Math.PI / 180);
  const dLng = marginM / (111320 * Math.cos(lat)), dLat = marginM / 110574;
  const W = w - dLng, S = s - dLat, E = e + dLng, Nn = n + dLat;
  const widthM = (E - W) * 111320 * Math.cos(lat), heightM = (Nn - S) * 110574;
  const step = Math.max(80, Math.sqrt((widthM * heightM) / maxPoints));
  const nx = Math.max(2, Math.ceil(widthM / step)), ny = Math.max(2, Math.ceil(heightM / step));
  const out: LngLat[] = [];
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) out.push([W + ((E - W) * i) / nx, S + ((Nn - S) * j) / ny]);
  return out;
}

/** 범위 가장자리(바깥으로 marginM)를 stepM 간격으로 짚은 점 */
export function edgeAround(box: [number, number, number, number], marginM: number, stepM = 50): LngLat[] {
  const [w, s, e, n] = box;
  const lat = ((s + n) / 2) * (Math.PI / 180);
  const dLng = marginM / (111320 * Math.cos(lat)), dLat = marginM / 110574;
  const W = w - dLng, S = s - dLat, E = e + dLng, N = n + dLat;
  const corners: LngLat[] = [[W, S], [E, S], [E, N], [W, N], [W, S]];
  const out: LngLat[] = [];
  for (let k = 0; k < 4; k++) {
    const [a, b] = [corners[k], corners[k + 1]];
    const len = Math.hypot((b[0] - a[0]) * 111320 * Math.cos(lat), (b[1] - a[1]) * 110574);
    const m = Math.max(1, Math.ceil(len / stepM));
    for (let i = 0; i < m; i++) out.push([a[0] + ((b[0] - a[0]) * i) / m, a[1] + ((b[1] - a[1]) * i) / m]);
  }
  return out;
}
