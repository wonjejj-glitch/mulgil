/**
 * OpenStreetMap 건물 외곽선 가져오기 (Overpass API) — 세대수 개략 추정용. 보내는 정보는 영역 경계 좌표뿐이다.
 * 한국 OSM 건물은 지역마다 빠진 곳이 많고 층수·용도 태그가 드물어 결과는 참고용이다.
 */
import { floorsFromParts, type MapBuilding } from '../core/model/buildingEstimate';
import { boxAreaKm2, splitBox } from '../core/model/buildingCells';
import type { LngLat } from '../core/model/types';
import { OVERPASS_SERVERS } from './osmRoads';

let cache: { key: string; buildings: MapBuilding[]; partsUsed: number } | null = null;

/** 한 번에 받는 최대 넓이 (km²) — 이보다 넓으면 조각으로 나눠 차례로 받는다. */
const TILE_KM2 = 25;
/** 동시에 받는 조각 수 — 공개 Overpass 서버는 IP 당 동시 요청 2개 정도를 허용한다. */
const PARALLEL = 2;
/** 전체 상한 (km²) — 이보다 넓으면 건물이 수십만 동이 되어 브라우저가 버거워진다. */
export const MAX_BUILDING_AREA_KM2 = 100;

type OsmGeom = { lat: number; lon: number }[];
interface OsmElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: OsmGeom;
  members?: { type: string; role: string; geometry?: OsmGeom }[];
}
const ring = (g: OsmGeom): LngLat[] => g.map((p): LngLat => [p.lon, p.lat]);
const closed = (g: OsmGeom) => g.length >= 4 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;

/** 한 조각(경위도 사각형)의 건물·건물 부분 원소를 받는다. 서버를 차례로 바꿔 가며 시도한다. */
async function fetchTile([w, s, e, n]: [number, number, number, number]): Promise<OsmElement[]> {
  const bb = `(${s},${w},${n},${e})`;
  // 건물(선·다각형 관계) + 층수를 담은 건물 부분(building:part)
  const query = `[out:json][timeout:90];(way["building"]${bb};relation["building"]${bb};way["building:part"]${bb};);out tags geom;`;
  const errors: string[] = [];
  for (const url of OVERPASS_SERVERS) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      if (!response.ok) {
        errors.push(`${new URL(url).host} HTTP ${response.status}`);
        continue;
      }
      const json = (await response.json()) as { elements?: OsmElement[] };
      return json.elements ?? [];
    } catch (error) {
      errors.push(`${new URL(url).host} ${error instanceof DOMException && error.name === 'AbortError' ? '시간 초과' : '연결 실패'}`);
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw new Error(`지도(OpenStreetMap) 건물 서버에 연결하지 못했습니다 (${errors.join(', ')}). 잠시 뒤 다시 시도하세요.`);
}

/**
 * 점들을 감싸는 범위 + 여유(m) 안의 건물. 범위가 넓으면 25 km² 이하 조각으로 나눠 두 개씩 받고 합친다
 * (조각 경계에 걸친 건물은 한 번만). 전체가 100 km² 를 넘으면 거절한다.
 * onProgress(받은 조각, 전체 조각)
 */
export async function fetchOsmBuildings(
  points: LngLat[],
  marginM = 100,
  onProgress?: (done: number, total: number) => void,
): Promise<{ buildings: MapBuilding[]; partsUsed: number }> {
  if (points.length === 0) throw new Error('관망이 비어 있습니다.');
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of points) {
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  }
  const lat = ((s + n) / 2) * (Math.PI / 180);
  const dLng = marginM / (111320 * Math.cos(lat)), dLat = marginM / 110574;
  const box: [number, number, number, number] = [w - dLng, s - dLat, e + dLng, n + dLat];
  const km2 = boxAreaKm2(box);
  if (km2 > MAX_BUILDING_AREA_KM2) {
    throw new Error(`범위가 ${km2.toFixed(0)} km² 로 너무 넓습니다 (한 번에 ${MAX_BUILDING_AREA_KM2} km² 까지). 지도를 조금 확대하거나, 관망을 구역별로 나눠 하세요.`);
  }
  const key = box.map((v) => v.toFixed(5)).join(',');
  if (cache?.key === key) return { buildings: cache.buildings.map((b) => ({ ...b })), partsUsed: cache.partsUsed };

  const tiles = splitBox(box, TILE_KM2);
  const buildings = new Map<string, MapBuilding>();
  const parts = new Map<string, MapBuilding>();
  onProgress?.(0, tiles.length);
  const queue = [...tiles];
  let done = 0;
  const worker = async () => {
    for (let tile = queue.shift(); tile; tile = queue.shift()) {
      for (const el of await fetchTile(tile)) {
        const tags = el.tags ?? {};
        if (el.type === 'way' && el.geometry && el.geometry.length >= 4) {
          if (tags.building) buildings.set(`W${el.id}`, { id: `W${el.id}`, ring: ring(el.geometry), tags });
          else if (tags['building:part']) parts.set(`P${el.id}`, { id: `P${el.id}`, ring: ring(el.geometry), tags });
        } else if (el.type === 'relation' && tags.building) {
          // 다각형 관계: 닫힌 바깥 고리마다 건물 하나 (관계의 태그를 씀)
          (el.members ?? [])
            .filter((m) => m.role === 'outer' && m.geometry && closed(m.geometry))
            .forEach((m, i) => buildings.set(`R${el.id}_${i + 1}`, { id: `R${el.id}_${i + 1}`, ring: ring(m.geometry!), tags }));
        }
      }
      onProgress?.(++done, tiles.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, tiles.length) }, worker));
  // 건물 부분은 이웃 조각의 건물에 속할 수 있어, 다 모은 뒤 한 번에 맞춘다
  const list = [...buildings.values()];
  const partsUsed = floorsFromParts(list, [...parts.values()]);
  cache = { key, buildings: list, partsUsed };
  return { buildings: list.map((b) => ({ ...b })), partsUsed };
}
