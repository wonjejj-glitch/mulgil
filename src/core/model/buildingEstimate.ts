/**
 * 지도 건물(OpenStreetMap 등) → 세대수 개략 추정, 그리고 수용가 → 상수 절점 수요량 배분 (순수 함수).
 *
 * 수용가 대장·건물 세대수·연결관 자료가 하나도 없을 때 참고용으로 쓴다. 정확도는 낮다:
 *  - 아파트·공동주택: 연면적(바닥면적 × 층수) × 0.8 ÷ 세대당 연면적
 *  - 단독·다가구 주택: 1세대 (연립·테라스는 바닥면적 ÷ 60 m²)
 *  - 용도 미상(building=yes): 200 m² 미만이면 1세대, 크면 연면적 ÷ 세대당 연면적
 *  - 상업·업무·공공 등: 연면적 ÷ 비주거 환산 면적 = 세대 환산값 (영업용 사용량을 세대로 근사)
 *  - 창고·차고·지붕만 있는 구조물 등은 뺀다
 * 층수(building:levels)가 없으면 종류별 기본 층수를 쓴다.
 */
import type { LngLat } from './types';

export interface BuildingEstimateOptions {
  /** 세대당 연면적 (m²) */
  areaPerHousehold: number;
  /** 비주거 연면적 이만큼을 1세대로 본다 (m²) */
  nonResidentialArea: number;
  /** 층수 정보가 없는 아파트 층수 */
  apartmentFloors: number;
  /** 층수 정보가 없는 그 밖의 건물 층수 */
  otherFloors: number;
}

export const DEFAULT_BUILDING_ESTIMATE: BuildingEstimateOptions = { areaPerHousehold: 100, nonResidentialArea: 300, apartmentFloors: 12, otherFloors: 2 };

export type BuildingCategory = '공동주택' | '단독주택' | '용도 미상' | '비주거';

const SKIP = /^(garage|garages|shed|roof|carport|parking|construction|ruins|greenhouse|hut|kiosk|bunker|tent|container|toilets|transformer_tower|water_tower|silo|storage_tank|no)$/;
const APARTMENT = /^(apartments|residential|dormitory)$/;
const HOUSE = /^(house|detached|semidetached_house|bungalow|farm|cabin|static_caravan)$/;
const TERRACE = /^(terrace|townhouse)$/;
const NON_RES = /^(commercial|retail|office|industrial|warehouse|school|university|college|kindergarten|church|temple|mosque|public|civic|government|hospital|clinic|hotel|train_station|transportation|sports_hall|supermarket|manufacture|service|fire_station|police)$/;

/** 경위도 다각형 면적 (m², 국지 평면 근사). */
export function ringArea(ring: LngLat[]): number {
  if (ring.length < 3) return 0;
  const lat0 = (ring.reduce((s, p) => s + p[1], 0) / ring.length) * (Math.PI / 180);
  const kx = 111320 * Math.cos(lat0), ky = 110574;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
  return Math.abs(a) / 2;
}

export function ringCenter(ring: LngLat[]): LngLat {
  let x = 0, y = 0;
  const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
  for (let i = 0; i < n; i++) {
    x += ring[i][0];
    y += ring[i][1];
  }
  return [x / n, y / n];
}

/** 건물 하나의 세대수(비주거는 세대 환산값). 빼야 하는 건물이면 null. */
export function estimateHouseholds(area: number, tags: Record<string, string>, options: BuildingEstimateOptions = DEFAULT_BUILDING_ESTIMATE): { households: number; category: BuildingCategory; floors: number } | null {
  const type = (tags.building ?? 'yes').toLowerCase();
  if (SKIP.test(type) || area < 15) return null;
  const levels = Number(tags['building:levels']);
  const known = Number.isFinite(levels) && levels > 0 ? Math.min(levels, 80) : null;
  if (APARTMENT.test(type)) {
    const floors = known ?? options.apartmentFloors;
    return { households: Math.max(1, (area * floors * 0.8) / options.areaPerHousehold), category: '공동주택', floors };
  }
  if (HOUSE.test(type)) return { households: 1, category: '단독주택', floors: known ?? 1 };
  if (TERRACE.test(type)) return { households: Math.max(1, area / 60), category: '단독주택', floors: known ?? 2 };
  if (NON_RES.test(type)) {
    const floors = known ?? options.otherFloors;
    return { households: (area * floors) / options.nonResidentialArea, category: '비주거', floors };
  }
  const floors = known ?? options.otherFloors;
  return { households: area < 200 ? 1 : (area * floors) / options.areaPerHousehold, category: '용도 미상', floors };
}

export interface MapBuilding {
  id: string;
  ring: LngLat[];
  tags: Record<string, string>;
}

export interface EstimatedBuilding {
  id: string;
  position: LngLat;
  households: number;
  category: BuildingCategory;
}

export function estimateBuildings(buildings: MapBuilding[], options: BuildingEstimateOptions = DEFAULT_BUILDING_ESTIMATE): { items: EstimatedBuilding[]; skipped: number; byCategory: Record<BuildingCategory, { count: number; households: number }> } {
  const byCategory: Record<BuildingCategory, { count: number; households: number }> = {
    공동주택: { count: 0, households: 0 },
    단독주택: { count: 0, households: 0 },
    '용도 미상': { count: 0, households: 0 },
    비주거: { count: 0, households: 0 },
  };
  const items: EstimatedBuilding[] = [];
  let skipped = 0;
  for (const b of buildings) {
    const est = estimateHouseholds(ringArea(b.ring), b.tags, options);
    if (!est) {
      skipped++;
      continue;
    }
    items.push({ id: b.id, position: ringCenter(b.ring), households: est.households, category: est.category });
    byCategory[est.category].count++;
    byCategory[est.category].households += est.households;
  }
  return { items, skipped, byCategory };
}

/* ------------------------------------------------------------------ 상수: 수용가 → 절점 수요량 */

export interface DemandSource {
  id: string;
  position: LngLat;
  /** 사용량 m³/일 */
  demand?: number;
  households?: number;
}

export interface WaterDemandOptions {
  personsPerHousehold: number;
  /** 1인 1일 급수량 (L, 일평균) */
  litersPerCapita: number;
  /** 사용량·세대수가 없을 때 세대수 */
  defaultHouseholds: number;
  /** 가장 가까운 절점을 찾을 최대 거리 (m) */
  maxDistance: number;
}

export const DEFAULT_WATER_DEMAND: WaterDemandOptions = { personsPerHousehold: 2.3, litersPerCapita: 330, defaultHouseholds: 1, maxDistance: 150 };

export interface WaterDemandResult {
  /** 절점 ID → 일평균 m³/일 */
  perNode: { id: string; sources: number; households: number; m3day: number }[];
  totalM3day: number;
  assigned: number;
  unassigned: number;
  defaulted: number;
}

/** 수용가마다 가장 가까운 절점(junction)에 일평균 사용량을 더한다. */
export function assignWaterDemand(junctions: { id: string; position: LngLat }[], sources: DemandSource[], options: Partial<WaterDemandOptions> = {}): WaterDemandResult {
  const o = { ...DEFAULT_WATER_DEMAND, ...options };
  const res: WaterDemandResult = { perNode: [], totalM3day: 0, assigned: 0, unassigned: 0, defaulted: 0 };
  if (junctions.length === 0) {
    res.unassigned = sources.length;
    return res;
  }
  const lat0 = (junctions.reduce((s, j) => s + j.position[1], 0) / junctions.length) * (Math.PI / 180);
  const kx = 111320 * Math.cos(lat0), ky = 110574;
  const xy = (p: LngLat): [number, number] => [p[0] * kx, p[1] * ky];
  const cell = Math.max(50, o.maxDistance);
  const grid = new Map<string, number[]>();
  const pts = junctions.map((j) => xy(j.position));
  pts.forEach(([x, y], i) => {
    const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  });
  const per = new Map<number, { id: string; sources: number; households: number; m3day: number }>();
  for (const s of sources) {
    const [x, y] = xy(s.position);
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    let best = -1, bestD = o.maxDistance;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const k of grid.get(`${cx + i},${cy + j}`) ?? []) {
          const d = Math.hypot(pts[k][0] - x, pts[k][1] - y);
          if (d <= bestD) [best, bestD] = [k, d];
        }
      }
    }
    if (best < 0) {
      res.unassigned++;
      continue;
    }
    let m3day: number, hh: number;
    if (s.demand !== undefined && s.demand > 0) {
      m3day = s.demand;
      hh = s.households ?? 0;
    } else {
      hh = s.households !== undefined && s.households > 0 ? s.households : o.defaultHouseholds;
      if (!(s.households !== undefined && s.households > 0)) res.defaulted++;
      m3day = (hh * o.personsPerHousehold * o.litersPerCapita) / 1000;
    }
    const row = per.get(best) ?? { id: junctions[best].id, sources: 0, households: 0, m3day: 0 };
    row.sources++;
    row.households += hh;
    row.m3day += m3day;
    per.set(best, row);
    res.assigned++;
    res.totalM3day += m3day;
  }
  res.perNode = [...per.values()].sort((a, b) => b.m3day - a.m3day);
  return res;
}
