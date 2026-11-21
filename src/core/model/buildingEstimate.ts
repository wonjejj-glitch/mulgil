/**
 * 지도 건물(OpenStreetMap 등) → 세대수 개략 추정, 그리고 수용가 → 상수 절점 수요량 배분 (순수 함수).
 *
 * 수용가 대장·건물 세대수·연결관 자료가 하나도 없을 때 참고용으로 쓴다. 정확도는 낮다:
 *  - 아파트·공동주택: 연면적(바닥면적 × 층수) × 0.8 ÷ 세대당 연면적
 *  - 단독·다가구 주택: 1세대 (연립·테라스는 바닥면적 ÷ 60 m²)
 *  - 용도 미상(building=yes): 200 m² 미만이면 1세대, 크면 연면적 ÷ 세대당 연면적
 *  - 상업·업무·공공 등: 연면적 ÷ 비주거 환산 면적 = 세대 환산값 (영업용 사용량을 세대로 근사)
 *  - 창고·차고·지붕만 있는 구조물 등은 뺀다
 * 층수: building:levels → 높이(height ÷ 3 m) → 건물 안 부분(building:part)의 최고 층수(호출 쪽에서 levels 로 넣음) → 종류별 기본값.
 * 용도 태그가 없어도 이름에 '아파트'가 있으면 공동주택, '빌라·연립·다세대·맨션'이면 저층 공동주택으로 본다.
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
  /** 층수 정보가 없는 빌라·연립·다세대(residential) 층수 */
  lowRiseFloors: number;
}

export const DEFAULT_BUILDING_ESTIMATE: BuildingEstimateOptions = { areaPerHousehold: 100, nonResidentialArea: 300, apartmentFloors: 12, otherFloors: 2, lowRiseFloors: 4 };

export type BuildingCategory = '공동주택' | '단독주택' | '용도 미상' | '비주거';

const SKIP = /^(garage|garages|shed|roof|carport|parking|construction|ruins|greenhouse|hut|kiosk|bunker|tent|container|toilets|transformer_tower|water_tower|silo|storage_tank|no)$/;
const APARTMENT = /^(apartments|dormitory)$/;
const LOW_RISE = /^(residential)$/;
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

/** 태그에서 층수: building:levels → height·building:height(m) ÷ 3. 모르면 null. */
export function floorsFromTags(tags: Record<string, string>): number | null {
  const levels = parseFloat(tags['building:levels'] ?? '');
  if (Number.isFinite(levels) && levels > 0) return Math.min(Math.round(levels), 80);
  const h = parseFloat((tags.height ?? tags['building:height'] ?? '').replace(/m$/i, ''));
  if (Number.isFinite(h) && h >= 2.5) return Math.min(Math.max(1, Math.round(h / 3)), 80);
  return null;
}

/** 건물 하나의 세대수(비주거는 세대 환산값). 빼야 하는 건물이면 null. floorsKnown: 층수를 자료에서 찾았는지. */
export function estimateHouseholds(area: number, tags: Record<string, string>, options: BuildingEstimateOptions = DEFAULT_BUILDING_ESTIMATE): { households: number; category: BuildingCategory; floors: number; floorsKnown: boolean } | null {
  // 건축물대장과 맞춘 건물: 대장의 세대수·용도를 그대로 쓴다 (registerOverBuildings)
  const fromRegister = tags['register:households'];
  if (fromRegister !== undefined) {
    const households = Number(fromRegister);
    if (!(households > 0)) return null;
    const c = tags['register:category'];
    const category: BuildingCategory = c === '공동주택' || c === '단독주택' || c === '비주거' ? c : '용도 미상';
    const levels = floorsFromTags(tags);
    return { households, category, floors: levels ?? 1, floorsKnown: levels !== null };
  }
  let type = (tags.building ?? 'yes').toLowerCase();
  if (SKIP.test(type) || area < 15) return null;
  const name = `${tags.name ?? ''} ${tags['name:ko'] ?? ''}`;
  if (type === 'yes' || type === 'residential') {
    if (/아파트|APT/i.test(name)) type = 'apartments';
    else if (type === 'yes' && /빌라|연립|다세대|맨션|하이츠|빌리지/.test(name)) type = 'residential';
  }
  const known = floorsFromTags(tags);
  const floorsKnown = known !== null;
  if (APARTMENT.test(type)) {
    const floors = known ?? options.apartmentFloors;
    return { households: Math.max(1, (area * floors * 0.8) / options.areaPerHousehold), category: '공동주택', floors, floorsKnown };
  }
  if (LOW_RISE.test(type)) {
    const floors = known ?? options.lowRiseFloors;
    return { households: Math.max(1, (area * floors * 0.8) / options.areaPerHousehold), category: '공동주택', floors, floorsKnown };
  }
  if (HOUSE.test(type)) return { households: 1, category: '단독주택', floors: known ?? 1, floorsKnown };
  if (TERRACE.test(type)) return { households: Math.max(1, area / 60), category: '단독주택', floors: known ?? 2, floorsKnown };
  if (NON_RES.test(type)) {
    const floors = known ?? options.otherFloors;
    return { households: (area * floors) / options.nonResidentialArea, category: '비주거', floors, floorsKnown };
  }
  const floors = known ?? options.otherFloors;
  return { households: area < 200 && !floorsKnown ? 1 : Math.max(1, (area * floors) / options.areaPerHousehold), category: '용도 미상', floors, floorsKnown };
}

export interface MapBuilding {
  id: string;
  ring: LngLat[];
  tags: Record<string, string>;
}

/** 경위도 점이 고리 안에 있는지 (짝홀). */
function insideRing(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 층수 태그가 없는 건물에 그 안의 건물 부분(building:part)의 최고 층수·높이를 넣는다 (OSM 에서 고층 동은 부분으로 나눠 그리는 경우가 많다).
 * 바꾼 건물 수를 돌려준다. buildings 를 고친다.
 */
export function floorsFromParts(buildings: MapBuilding[], parts: MapBuilding[]): number {
  if (parts.length === 0) return 0;
  const withFloors = parts.flatMap((p) => {
    const f = floorsFromTags(p.tags);
    return f ? [{ c: ringCenter(p.ring), f }] : [];
  });
  let changed = 0;
  for (const b of buildings) {
    if (floorsFromTags(b.tags) !== null) continue;
    let lng0 = Infinity, lng1 = -Infinity, lat0 = Infinity, lat1 = -Infinity;
    for (const [x, y] of b.ring) {
      lng0 = Math.min(lng0, x);
      lng1 = Math.max(lng1, x);
      lat0 = Math.min(lat0, y);
      lat1 = Math.max(lat1, y);
    }
    let best = 0;
    for (const p of withFloors) if (p.c[0] >= lng0 && p.c[0] <= lng1 && p.c[1] >= lat0 && p.c[1] <= lat1 && insideRing(p.c, b.ring)) best = Math.max(best, p.f);
    if (best > 0) {
      b.tags = { ...b.tags, 'building:levels': String(best) };
      changed++;
    }
  }
  return changed;
}

export interface EstimatedBuilding {
  id: string;
  position: LngLat;
  households: number;
  category: BuildingCategory;
}

export function estimateBuildings(
  buildings: MapBuilding[],
  options: BuildingEstimateOptions = DEFAULT_BUILDING_ESTIMATE,
): { items: EstimatedBuilding[]; skipped: number; floorsKnown: number; byCategory: Record<BuildingCategory, { count: number; households: number }> } {
  const byCategory: Record<BuildingCategory, { count: number; households: number }> = {
    공동주택: { count: 0, households: 0 },
    단독주택: { count: 0, households: 0 },
    '용도 미상': { count: 0, households: 0 },
    비주거: { count: 0, households: 0 },
  };
  const items: EstimatedBuilding[] = [];
  let skipped = 0, floorsKnown = 0;
  for (const b of buildings) {
    const est = estimateHouseholds(ringArea(b.ring), b.tags, options);
    if (!est) {
      skipped++;
      continue;
    }
    if (est.floorsKnown) floorsKnown++;
    items.push({ id: b.id, position: ringCenter(b.ring), households: est.households, category: est.category });
    byCategory[est.category].count++;
    byCategory[est.category].households += est.households;
  }
  return { items, skipped, floorsKnown, byCategory };
}

/* ------------------------------------------------------------------ 상수: 수용가 → 절점 수요량 */

export interface DemandSource {
  id: string;
  position: LngLat;
  /** 사용량 m³/일 */
  demand?: number;
  households?: number;
  /**
   * 상가·업무 건물이면 true (가정이면 false). 정해져 있으면 applyBusinessRatio 가 영업·업무용수를
   * 가정용수 × 비율로 잡아 이 건물들에 나눈다 — households 는 그때 나누는 무게(연면적 환산)로만 쓴다.
   */
  business?: boolean;
}

export interface WaterDemandOptions {
  personsPerHousehold: number;
  /** 1인 1일 급수량 (L, 일평균) */
  litersPerCapita: number;
  /** 사용량·세대수가 없을 때 세대수 */
  defaultHouseholds: number;
  /** 가장 가까운 절점을 찾을 최대 거리 (m) */
  maxDistance: number;
  /**
   * 영업·업무용수 = 가정용수 × 이 비율(%). 수도정비기본계획은 업종별 용수를 가정용수에 대한 비율로 잡는 일이 많다.
   * 기본값은 예시 (전국 상수도 통계의 영업+업무 / 가정 사용량 비는 대략 30~45%). 사업 기본계획 값으로 바꿔 쓴다.
   */
  businessRatio: number;
}

export const DEFAULT_WATER_DEMAND: WaterDemandOptions = { personsPerHousehold: 2.3, litersPerCapita: 330, defaultHouseholds: 1, maxDistance: 150, businessRatio: 30 };

/**
 * 영업·업무용수를 가정용수 × 비율로 잡는다 (사용량이 정해진 수용가는 그대로).
 *  - 가정(business=false): 세대수 × 세대당 인원 × 1인 1일 급수량
 *  - 상가·업무(business=true): 가정용수 합 × 비율 을 상가·업무 건물에 무게(households = 연면적 환산) 비율로 나눈다.
 *    상가·업무 건물이 하나도 없으면 가정 쪽에 비율만큼 얹는다.
 * business 가 정해지지 않은 수용가는 바꾸지 않는다 (CSV·SHP 처럼 사용량·세대수를 그대로 쓰는 자료).
 */
export function applyBusinessRatio(sources: DemandSource[], options: Partial<WaterDemandOptions> = {}): DemandSource[] {
  const o = { ...DEFAULT_WATER_DEMAND, ...options };
  const perHousehold = (o.personsPerHousehold * o.litersPerCapita) / 1000;
  const free = (s: DemandSource) => s.business !== undefined && !(s.demand !== undefined && s.demand > 0);
  let home = 0, weight = 0;
  for (const s of sources) {
    if (!free(s)) continue;
    if (s.business) weight += Math.max(0, s.households ?? 0);
    else home += Math.max(0, s.households ?? 0) * perHousehold;
  }
  const business = (home * Math.max(0, o.businessRatio)) / 100;
  const homeScale = weight > 0 ? 1 : 1 + Math.max(0, o.businessRatio) / 100;
  return sources.flatMap((s): DemandSource[] => {
    if (!free(s)) return [s];
    if (s.business) {
      if (weight <= 0) return [];
      return [{ ...s, households: 0, demand: (business * Math.max(0, s.households ?? 0)) / weight }];
    }
    return [{ ...s, demand: Math.max(0, s.households ?? 0) * perHousehold * homeScale }];
  });
}

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

/** 브이월드 건물(도로명주소 건물 LT_C_SPBD) 한 동 — 세대수 추정에 쓰는 값만. */
export interface VworldBuildingLike {
  id: string;
  floors: number;
  hasFloors: boolean;
  name: string;
  polygons: LngLat[][][];
}

/**
 * 브이월드 건물 → 세대수 추정용 건물. 용도 자료가 없어 building=yes 로 두고, 지상 층수는 building:levels,
 * 건물명(+동)은 name 으로 넣는다 (이름의 '아파트'·'빌라' 등으로 용도를 맞춘다). 여러 조각이면 가장 큰 조각의 바깥 고리.
 */
export function vworldBuildingToMap(b: VworldBuildingLike): MapBuilding | null {
  let best: LngLat[] | null = null;
  let bestArea = 0;
  for (const poly of b.polygons) {
    const outer = poly[0];
    if (!outer || outer.length < 4) continue;
    const a = ringArea(outer);
    if (a > bestArea) {
      best = outer;
      bestArea = a;
    }
  }
  if (!best) return null;
  const tags: Record<string, string> = { building: 'yes' };
  if (b.hasFloors) tags['building:levels'] = String(b.floors);
  if (b.name) tags.name = b.name;
  // 건물관리번호 앞 19자리 = 건물이 선 필지의 PNU (건축물대장과 잇는 열쇠)
  if (/^\d{19}/.test(b.id)) tags['ref:pnu'] = b.id.slice(0, 19);
  return { id: `V${b.id || `${best[0][0].toFixed(6)},${best[0][1].toFixed(6)}`}`, ring: best, tags };
}
