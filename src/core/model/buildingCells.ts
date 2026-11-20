/**
 * 3D 건물 표시용 — 화면 범위를 고정 칸(약 1 km)으로 나누고, 받은 건물을 지도 레이어용 GeoJSON 으로 만든다.
 * 칸 단위로 받아 두면 지도를 조금 움직여도 같은 칸을 다시 받지 않는다.
 */
import type { LngLat } from './types';

/** 칸 크기 (도). 위도 35° 에서 약 0.9 × 1.1 km */
export const CELL_DEG = 0.01;
/** 층당 높이 (m) — 개략 */
export const FLOOR_HEIGHT = 3.3;

export interface BuildingShape {
  /** 건물관리번호 (없으면 빈 문자열) */
  id: string;
  /** 지상 층수 */
  floors: number;
  polygons: LngLat[][][];
}

/** 화면 범위 [서, 남, 동, 북] 에 걸치는 칸 이름('ix,iy') 목록. */
export function cellsOf(bounds: [number, number, number, number], size = CELL_DEG): string[] {
  const [w, s, e, n] = bounds;
  const out: string[] = [];
  for (let ix = Math.floor(w / size); ix <= Math.floor(e / size); ix++) {
    for (let iy = Math.floor(s / size); iy <= Math.floor(n / size); iy++) out.push(`${ix},${iy}`);
  }
  return out;
}

export function cellBox(cell: string, size = CELL_DEG): [number, number, number, number] {
  const [ix, iy] = cell.split(',').map(Number);
  return [ix * size, iy * size, (ix + 1) * size, (iy + 1) * size];
}

export interface BuildingFeatureCollection {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: { height: number; floors: number };
    geometry: { type: 'MultiPolygon'; coordinates: LngLat[][][] };
  }[];
}

/** 여러 칸의 건물을 한 GeoJSON 으로. 칸 경계에 걸쳐 두 번 받은 건물(같은 id)은 한 번만 넣는다. */
export function buildingsGeoJson(groups: Iterable<BuildingShape[]>): BuildingFeatureCollection {
  const seen = new Set<string>();
  const features: BuildingFeatureCollection['features'] = [];
  for (const group of groups) {
    for (const b of group) {
      if (b.id) {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
      }
      features.push({
        type: 'Feature',
        properties: { height: Math.round(b.floors * FLOOR_HEIGHT * 10) / 10, floors: b.floors },
        geometry: { type: 'MultiPolygon', coordinates: b.polygons },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
