/**
 * OpenStreetMap 건물 외곽선 가져오기 (Overpass API) — 세대수 개략 추정용. 보내는 정보는 영역 경계 좌표뿐이다.
 * 한국 OSM 건물은 지역마다 빠진 곳이 많고 층수·용도 태그가 드물어 결과는 참고용이다.
 */
import type { MapBuilding } from '../core/model/buildingEstimate';
import type { LngLat } from '../core/model/types';
import { OVERPASS_SERVERS } from './osmRoads';

let cache: { key: string; buildings: MapBuilding[] } | null = null;

/** [서, 남, 동, 북] 경위도 범위 + 여유(m). 너무 넓으면(약 25 km² 초과) 거절한다. */
export async function fetchOsmBuildings(points: LngLat[], marginM = 100): Promise<MapBuilding[]> {
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
  if (cache?.key === key) return cache.buildings;
  const query = `[out:json][timeout:90];way["building"](${s},${w},${n},${e});out tags geom;`;
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
      const json = (await response.json()) as { elements?: { type: string; id: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }[] };
      const buildings = (json.elements ?? [])
        .filter((el) => el.type === 'way' && el.geometry && el.geometry.length >= 4)
        .map((el): MapBuilding => ({ id: `W${el.id}`, ring: el.geometry!.map((g): LngLat => [g.lon, g.lat]), tags: el.tags ?? {} }));
      cache = { key, buildings };
      return buildings;
    } catch (error) {
      errors.push(`${new URL(url).host} ${error instanceof DOMException && error.name === 'AbortError' ? '시간 초과' : '연결 실패'}`);
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw new Error(`지도(OpenStreetMap) 건물 서버에 연결하지 못했습니다 (${errors.join(', ')}). 잠시 뒤 다시 시도하세요.`);
}
