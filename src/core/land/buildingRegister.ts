/**
 * 건축물대장(표제부) → 필지별 세대수 (순수 함수).
 * 건축물대장에는 좌표가 없으므로 지적도 필지(PNU·경계)와 지번으로 이어 붙여 필지 가운데에 놓는다.
 *
 * 세대수 (주건축물만, 부속건축물 제외)
 *  - 공동주택(아파트·연립·다세대): 세대수 → 없으면 호수
 *  - 단독주택(단독·다가구·다중): 가구수 → 세대수 → 1
 *  - 그 밖(근린생활·업무·교육 …): 연면적 ÷ 비주거 환산 면적 = 세대 환산값
 */

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

export type RegisterCategory = '공동주택' | '단독주택' | '비주거';

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
  const byCategory: Record<RegisterCategory, { count: number; households: number }> = { 공동주택: { count: 0, households: 0 }, 단독주택: { count: 0, households: 0 }, 비주거: { count: 0, households: 0 } };
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
    if (category === '비주거') lot.nonResidentialEquiv += households;
    else lot.residential += households;
    lot.buildings++;
    const name = [it.bldNm, it.dongNm].filter(Boolean).join(' ').trim();
    if (name && lot.names.length < 3 && !lot.names.includes(name)) lot.names.push(name);
    lots.set(parcel.pnu, lot);
  }
  return { lots: [...lots.values()].filter((l) => l.households > 0), matched, unmatched, byCategory };
}
