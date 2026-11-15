/**
 * OpenStreetMap 건물 외곽선 가져오기 (Overpass API) — 세대수 개략 추정용. 보내는 정보는 영역 경계 좌표뿐이다.
 * 한국 OSM 건물은 지역마다 빠진 곳이 많고 층수·용도 태그가 드물어 결과는 참고용이다.
 */
import { floorsFromParts, type MapBuilding } from '../core/model/buildingEstimate';
import type { LngLat } from '../core/model/types';
import { OVERPASS_SERVERS } from './osmRoads';

let cache: { key: string; buildings: MapBuilding[]; partsUsed: number } | null = null;

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

/** [서, 남, 동, 북] 경위도 범위 + 여유(m). 너무 넓으면(약 25 km² 초과) 거절한다. */
export async function fetchOsmBuildings(points: LngLat[], marginM = 100): Promise<{ buildings: MapBuilding[]; partsUsed: number }> {
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
  [w, e, s, n] = [w - dLng, e + dLng, s - dLat, n + dLat];
  const km2 = ((e - w) * 111.32 * Math.cos(lat)) * ((n - s) * 110.574);
  if (km2 > 25) throw new Error(`관망 범위가 ${km2.toFixed(0)} km² 로 너무 넓어 지도 건물을 한 번에 받을 수 없습니다. 구역을 나눠(처리분구 등) 관망을 만든 뒤 하세요.`);
  const key = [s, w, n, e].map((v) => v.toFixed(5)).join(',');
  if (cache?.key === key) return { buildings: cache.buildings.map((b) => ({ ...b })), partsUsed: cache.partsUsed };
  // 건물(선·다각형 관계) + 층수를 담은 건물 부분(building:part)
  const bb = `(${s},${w},${n},${e})`;
  const query = `[out:json][timeout:90];(way["building"]${bb};relation["building"]${bb};way["building:part"]${bb};);out tags geom;`;
  const errors: string[] = [];
  for (const url of OVERPASS_SERVERS) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 60000);
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
      const buildings: MapBuilding[] = [];
      const parts: MapBuilding[] = [];
      for (const el of json.elements ?? []) {
        const tags = el.tags ?? {};
        if (el.type === 'way' && el.geometry && el.geometry.length >= 4) {
          if (tags.building) buildings.push({ id: `W${el.id}`, ring: ring(el.geometry), tags });
          else if (tags['building:part']) parts.push({ id: `P${el.id}`, ring: ring(el.geometry), tags });
        } else if (el.type === 'relation' && tags.building) {
          // 다각형 관계: 닫힌 바깥 고리마다 건물 하나 (관계의 태그를 씀)
          (el.members ?? [])
            .filter((m) => m.role === 'outer' && m.geometry && closed(m.geometry))
            .forEach((m, i) => buildings.push({ id: `R${el.id}_${i + 1}`, ring: ring(m.geometry!), tags }));
        }
      }
      const partsUsed = floorsFromParts(buildings, parts);
      cache = { key, buildings, partsUsed };
      return { buildings: buildings.map((b) => ({ ...b })), partsUsed };
    } catch (error) {
      errors.push(`${new URL(url).host} ${error instanceof DOMException && error.name === 'AbortError' ? '시간 초과' : '연결 실패'}`);
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw new Error(`지도(OpenStreetMap) 건물 서버에 연결하지 못했습니다 (${errors.join(', ')}). 잠시 뒤 다시 시도하세요.`);
}
