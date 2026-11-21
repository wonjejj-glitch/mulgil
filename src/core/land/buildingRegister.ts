/**
 * 건축물대장(표제부) → 필지별 세대수 (순수 함수).
 * 건축물대장에는 좌표가 없으므로 지적도 필지(PNU·경계)와 지번으로 이어 붙여 필지 가운데에 놓는다.
 *
 * 세대수 (주건축물만, 부속건축물 제외)
 *  - 공동주택(아파트·연립·다세대): 세대수 → 없으면 호수
 *  - 단독주택(단독·다가구·다중): 가구수 → 세대수 → 1
 *  - 그 밖(근린생활·업무·교육 …): 연면적 ÷ 비주거 환산 면적 = 세대 환산값
 *  - 공장·창고·위험물·자동차 관련 등: 0 (생활용수 수요에서 뺀다 — 공업용수는 따로 다룬다)
 */
import { ringArea, type MapBuilding } from '../model/buildingEstimate';

export interface RegisterItem {
  sigunguCd: string;
  bjdongCd: string;
  /** 0 대지, 1 산 */
  platGbCd: string;
  bun: string;
  ji: string;
  /** 0 주건축물, 1 부속건축물 */
  mainAtchGbCd: string;
  mainPurpsCdNm: string;
  bldNm: string;
  dongNm: string;
  hhldCnt: number;
  fmlyCnt: number;
  hoCnt: number;
  grndFlrCnt: number;
  totArea: number;
}

export interface LotParcel {
  pnu: string;
  /** 필지 가운데 (호출 쪽 좌표 그대로) */
  center: [number, number];
}

export type RegisterCategory = '공동주택' | '단독주택' | '비주거' | '공장·창고';

/** 생활용수 수요에서 빼는 주용도 (건축법 시행령 별표1 용도 이름) */
export const EXCLUDED_PURPOSE = /공장|창고|위험물|자동차관련|동물및식물|자원순환|분뇨|묘지|발전시설|방송통신|교정|국방|군사/;

export interface LotHouseholds {
  pnu: string;
  center: [number, number];
  /** 세대수 (비주거 세대 환산값 포함) */
  households: number;
  residential: number;
  nonResidentialEquiv: number;
  buildings: number;
  /** 대표 건물 이름 (최대 3개) */
  names: string[];
}

/** PNU(19자리) → 시군구·법정동·대지/산·본번·부번. 대지/산: PNU 11번째 1 = 대지(0), 2 = 산(1). */
export function parsePnu(pnu: string): { sigungu: string; bjdong: string; plat: string; bun: string; ji: string } | null {
  if (!/^\d{19}$/.test(pnu)) return null;
  return { sigungu: pnu.slice(0, 5), bjdong: pnu.slice(5, 10), plat: pnu[10] === '2' ? '1' : '0', bun: pnu.slice(11, 15), ji: pnu.slice(15, 19) };
}

export const lotKey = (sigungu: string, bjdong: string, plat: string, bun: string, ji: string) =>
  `${sigungu}${bjdong}${plat || '0'}${String(bun).padStart(4, '0')}${String(ji).padStart(4, '0')}`;

export function householdsOf(item: RegisterItem, nonResidentialArea = 300): { households: number; category: RegisterCategory } {
  const purpose = item.mainPurpsCdNm ?? '';
  if (purpose.includes('공동주택')) return { households: item.hhldCnt || item.hoCnt || 1, category: '공동주택' };
  if (purpose.includes('단독주택')) return { households: item.fmlyCnt || item.hhldCnt || 1, category: '단독주택' };
  if (EXCLUDED_PURPOSE.test(purpose)) return { households: 0, category: '공장·창고' };
  return { households: (item.totArea || 0) / nonResidentialArea, category: '비주거' };
}

export function householdsByLot(
  parcels: LotParcel[],
  items: RegisterItem[],
  nonResidentialArea = 300,
): { lots: LotHouseholds[]; matched: number; unmatched: number; byCategory: Record<RegisterCategory, { count: number; households: number }> } {
  const byKey = new Map<string, LotParcel>();
  for (const p of parcels) {
    const k = parsePnu(p.pnu);
    if (k) byKey.set(lotKey(k.sigungu, k.bjdong, k.plat, k.bun, k.ji), p);
  }
  const lots = new Map<string, LotHouseholds>();
  const byCategory: Record<RegisterCategory, { count: number; households: number }> = {
    공동주택: { count: 0, households: 0 },
    단독주택: { count: 0, households: 0 },
    비주거: { count: 0, households: 0 },
    '공장·창고': { count: 0, households: 0 },
  };
  let matched = 0, unmatched = 0;
  for (const it of items) {
    if (it.mainAtchGbCd && it.mainAtchGbCd !== '0') continue;
    const parcel = byKey.get(lotKey(it.sigunguCd, it.bjdongCd, it.platGbCd, it.bun, it.ji));
    if (!parcel) {
      unmatched++;
      continue;
    }
    matched++;
    const { households, category } = householdsOf(it, nonResidentialArea);
    byCategory[category].count++;
    byCategory[category].households += households;
    const lot = lots.get(parcel.pnu) ?? { pnu: parcel.pnu, center: parcel.center, households: 0, residential: 0, nonResidentialEquiv: 0, buildings: 0, names: [] };
    lot.households += households;
    if (category === '비주거' || category === '공장·창고') lot.nonResidentialEquiv += households;
    else lot.residential += households;
    lot.buildings++;
    const name = [it.bldNm, it.dongNm].filter(Boolean).join(' ').trim();
    if (name && lot.names.length < 3 && !lot.names.includes(name)) lot.names.push(name);
    lots.set(parcel.pnu, lot);
  }
  return { lots: [...lots.values()].filter((l) => l.households > 0), matched, unmatched, byCategory };
}

export interface RegisterMatchResult {
  /** 공장·창고만 있는 필지의 건물을 뺀 목록. 대장과 맞춘 건물에는 register:households·register:category 태그가 붙는다. */
  buildings: MapBuilding[];
  /** 대장과 맞춘 건물 수 */
  matched: number;
  /** 공장·창고 등이라 뺀 건물 수 */
  excluded: number;
  /** 대장에서 찾지 못한 건물 수 (층수·면적 추정을 그대로 쓴다) */
  unmatched: number;
}

/**
 * 지도 건물(ref:pnu 태그 = 건물이 선 필지의 PNU)에 건축물대장 표제부의 실제 세대수·용도를 붙인다.
 * 대장은 필지(지번) 단위로 묶고, 한 필지의 세대수를 그 필지 위 건물들에 연면적(바닥 × 층수) 비율로 나눈다.
 * 필지의 주건축물이 모두 공장·창고 등이면 그 필지의 건물은 뺀다.
 */
export function registerOverBuildings(buildings: MapBuilding[], items: RegisterItem[], nonResidentialArea = 300): RegisterMatchResult {
  const byLot = new Map<string, RegisterItem[]>();
  for (const it of items) {
    if (it.mainAtchGbCd && it.mainAtchGbCd !== '0') continue;
    const key = lotKey(it.sigunguCd, it.bjdongCd, it.platGbCd, it.bun, it.ji);
    const list = byLot.get(key) ?? [];
    list.push(it);
    byLot.set(key, list);
  }
  const groups = new Map<string, MapBuilding[]>();
  const out: MapBuilding[] = [];
  let unmatched = 0;
  for (const b of buildings) {
    const k = parsePnu(b.tags['ref:pnu'] ?? '');
    const key = k ? lotKey(k.sigungu, k.bjdong, k.plat, k.bun, k.ji) : '';
    if (!key || !byLot.has(key)) {
      unmatched++;
      out.push(b);
      continue;
    }
    const list = groups.get(key) ?? [];
    list.push(b);
    groups.set(key, list);
  }
  let matched = 0, excluded = 0;
  for (const [key, list] of groups) {
    let res = 0, non = 0, apt = false, all = 0, factories = 0;
    for (const it of byLot.get(key)!) {
      const h = householdsOf(it, nonResidentialArea);
      all++;
      if (h.category === '공장·창고') factories++;
      else if (h.category === '비주거') non += h.households;
      else {
        res += h.households;
        if (h.category === '공동주택') apt = true;
      }
    }
    if (factories === all) {
      excluded += list.length;
      continue;
    }
    const total = res + non;
    const category = res >= non ? (apt ? '공동주택' : '단독주택') : '비주거';
    const weight = (b: MapBuilding) => ringArea(b.ring) * Math.max(1, Number(b.tags['building:levels']) || 1);
    const sum = list.reduce((acc, b) => acc + weight(b), 0) || list.length;
    for (const b of list) {
      const share = (total * (sum === list.length ? 1 : weight(b))) / sum;
      out.push({ ...b, tags: { ...b.tags, 'register:households': String(share), 'register:category': category } });
      matched++;
    }
  }
  return { buildings: out, matched, excluded, unmatched };
}
