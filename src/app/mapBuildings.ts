/**
 * 지도 건물 읽기 (수용가·세대수 개략 추정용). 브이월드 건물(도로명주소 건물, 지상 층수·건물명)을 먼저 쓰고,
 * 키가 없거나 브이월드에 연결하지 못하면(키가 등록되지 않은 사이트 등) OpenStreetMap 건물로 넘어간다.
 *
 * 한국에서는 브이월드 건물이 훨씬 빠짐없다 (김해 시내 표본: OpenStreetMap 은 브이월드의 5~11%).
 * 브이월드 건물은 건물관리번호로 필지를 알 수 있어, 건축물대장(공공데이터포털)을 법정동별로 받아 실제 세대수·용도를 붙인다.
 * 공장·창고만 있는 필지의 건물은 뺀다. 대장에서 찾지 못한 건물만 층수·이름('○○아파트' 등)으로 짐작한다.
 */
import { registerOverBuildings, type RegisterItem } from '../core/land/buildingRegister';
import { boxAround, boxAreaKm2, cellBox, cellsOf } from '../core/model/buildingCells';
import { vworldBuildingToMap, type MapBuilding } from '../core/model/buildingEstimate';
import type { LngLat } from '../core/model/types';
import { useUIStore } from '../store/useUIStore';
import { DATA_GO_KR_KEY, fetchRegisterDong } from './buildingRegister';
import { fetchOsmBuildings, MAX_BUILDING_AREA_KM2 } from './osmBuildings';
import { fetchBuildingsBox, type VworldBuilding } from './vworldData';

export type BuildingSource = 'vworld' | 'osm';

export const BUILDING_SOURCE_LABEL: Record<BuildingSource, string> = { vworld: '브이월드 건물', osm: '지도(OpenStreetMap) 건물' };

export interface MapBuildingsResult {
  buildings: MapBuilding[];
  /** OpenStreetMap 건물 부분에서 층수를 찾은 건물 수 (브이월드는 0) */
  partsUsed: number;
  source: BuildingSource;
  /** 화면·라벨에 덧붙일 안내 (예: 브이월드에 연결하지 못해 OpenStreetMap 으로 넘어감) */
  note?: string;
  /** 건축물대장을 받지 못해 건물 면적·층수로만 추정했는지 (화면이 눈에 띄게 알린다) */
  registerFailed?: boolean;
}

/** 브이월드 칸 하나에서 받는 최대 쪽수 (1쪽 1000동) — 아주 조밀한 1 km² 도 이 안에 든다. */
const MAX_PAGES_PER_CELL = 10;
const PARALLEL = 3;
/** 건축물대장 조회 상한 (쪽 = 100건). 하루 사용량을 모두 같이 쓰므로 한 번에 너무 많이 쓰지 않는다. */
const MAX_REGISTER_PAGES = 800;

/** 진행 알림: 받은 수, 전체 수, 무엇을 받는지 ('구역' · '건축물대장 법정동') */
export type BuildingProgress = (done: number, total: number, unit: string) => void;

async function fetchVworld(key: string, box: [number, number, number, number], onProgress?: BuildingProgress): Promise<{ buildings: MapBuilding[]; failed: number; total: number }> {
  const [w, s, e, n] = box;
  // 0.01° 칸으로 나누되 범위 밖은 잘라서 묻는다 (칸 경계에 걸친 건물은 id 로 한 번만)
  const pieces = cellsOf(box).map((c): [number, number, number, number] => {
    const [cw, cs, ce, cn] = cellBox(c);
    return [Math.max(w, cw), Math.max(s, cs), Math.min(e, ce), Math.min(n, cn)];
  });
  const byId = new Map<string, MapBuilding>();
  const queue = [...pieces];
  let done = 0, failed = 0;
  onProgress?.(0, pieces.length, '구역');
  const worker = async () => {
    for (let piece = queue.shift(); piece; piece = queue.shift()) {
      let list: VworldBuilding[] | null = null;
      for (let attempt = 0; attempt < 2 && !list; attempt++) {
        try {
          list = await fetchBuildingsBox(key, piece, MAX_PAGES_PER_CELL);
        } catch {
          list = null;
        }
      }
      if (!list) failed++;
      for (const v of list ?? []) {
        const b = vworldBuildingToMap(v);
        if (b && !byId.has(b.id)) byId.set(b.id, b);
      }
      onProgress?.(++done, pieces.length, '구역');
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, pieces.length) }, worker));
  return { buildings: [...byId.values()], failed, total: pieces.length };
}

/** 브이월드 건물에 건축물대장 세대수·용도를 붙인다. 실패하면 건물은 그대로 두고 안내만 돌려준다. */
async function withRegister(buildings: MapBuilding[], onProgress?: BuildingProgress): Promise<{ buildings: MapBuilding[]; note: string; failed?: boolean }> {
  if (!DATA_GO_KR_KEY) return { buildings, note: '건축물대장 인증키가 없어 세대수는 층수·면적·이름으로만 짐작했습니다(공장·상가도 세대로 잡힘).' };
  const dongs = [...new Set(buildings.map((b) => (b.tags['ref:pnu'] ?? '').slice(0, 10)).filter((d) => d.length === 10))];
  const items: RegisterItem[] = [];
  let pages = 0, done = 0, skipped = 0;
  onProgress?.(0, dongs.length, '건축물대장 법정동');
  try {
    for (const d of dongs) {
      if (pages >= MAX_REGISTER_PAGES) {
        skipped++;
        continue;
      }
      items.push(...(await fetchRegisterDong(d.slice(0, 5), d.slice(5), () => pages++)));
      onProgress?.(++done, dongs.length, '건축물대장 법정동');
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { buildings, failed: true, note: `건축물대장 조회 실패(${why}, 4번 다시 물어도 안 됨) — 세대수는 건물 면적·층수·이름으로만 추정했습니다. 공장·창고도 빠지지 않았으니 잠시 뒤 다시 누르세요.` };
  }
  const m = registerOverBuildings(buildings, items);
  const parts = [`건축물대장과 맞춘 건물 ${m.matched.toLocaleString()}동은 실제 세대수를 썼고, 공장·창고 등 ${m.excluded.toLocaleString()}동은 뺐습니다.`];
  if (m.unmatched > 0) parts.push(`대장에서 찾지 못한 ${m.unmatched.toLocaleString()}동은 층수·면적으로 짐작했습니다.`);
  if (skipped > 0) parts.push(`조회가 많아 법정동 ${skipped}곳은 대장을 받지 않았습니다(범위를 줄이면 받습니다).`);
  return { buildings: m.buildings, note: parts.join(' ') };
}

/**
 * 점들을 감싸는 범위 + 여유(m) 안의 건물. 브이월드 → (실패하면) OpenStreetMap.
 * onProgress(받은 구역, 전체 구역)
 */
export async function fetchMapBuildings(points: LngLat[], marginM = 100, onProgress?: BuildingProgress): Promise<MapBuildingsResult> {
  if (points.length === 0) throw new Error('관망이 비어 있습니다.');
  const box = boxAround(points, marginM);
  const km2 = boxAreaKm2(box);
  if (km2 > MAX_BUILDING_AREA_KM2) {
    throw new Error(`범위가 ${km2.toFixed(0)} km² 로 너무 넓습니다 (한 번에 ${MAX_BUILDING_AREA_KM2} km² 까지). 지도를 조금 확대하거나, 관망을 구역별로 나눠 하세요.`);
  }
  const key = useUIStore.getState().vworldKey;
  let fallbackNote = '브이월드 인증키가 없어 OpenStreetMap 건물로 만들었습니다 (빠진 건물이 많을 수 있음).';
  if (key) {
    const r = await fetchVworld(key, box, onProgress);
    if (r.failed < r.total) {
      const notes: string[] = [];
      if (r.failed > 0) notes.push(`브이월드 ${r.total}구역 중 ${r.failed}구역은 받지 못했습니다. 다시 누르면 다시 받습니다.`);
      const reg = await withRegister(r.buildings, onProgress);
      notes.push(reg.note);
      return { buildings: reg.buildings, partsUsed: 0, source: 'vworld', note: notes.join(' '), ...(reg.failed ? { registerFailed: true } : {}) };
    }
    fallbackNote = '브이월드 건물 자료에 연결하지 못해(인증키를 등록한 사이트가 아니거나 서버 문제) OpenStreetMap 건물로 만들었습니다 (빠진 건물이 많을 수 있음).';
  }
  const osm = await fetchOsmBuildings(points, marginM, (d, t) => onProgress?.(d, t, '구역'));
  return { ...osm, source: 'osm', note: fallbackNote };
}
