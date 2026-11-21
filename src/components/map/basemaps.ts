import type { StyleSpecification } from 'maplibre-gl';
import type { BasemapId } from '../../store/useUIStore';

export const BASEMAP_OPTIONS: { id: BasemapId; label: string; needsKey?: boolean }[] = [
  { id: 'vworld-base', label: '브이월드 일반', needsKey: true },
  { id: 'vworld-satellite', label: '브이월드 위성', needsKey: true },
  { id: 'vworld-hybrid', label: '브이월드 위성+주기', needsKey: true },
  { id: 'osm', label: '일반지도 (OpenStreetMap)' },
  { id: 'satellite', label: '위성지도 (Esri)' },
  { id: 'none', label: '배경 없음' },
];

const BACKGROUND = '#0f1318';

/** 3D 건물용 벡터 타일 (OpenFreeMap — 키 없이 쓰는 OpenStreetMap 기반 공개 타일, OpenMapTiles 스키마). */
const BUILDING_TILES = 'https://tiles.openfreemap.org/planet';
/** 건물이 보이기 시작하는 줌 */
export const BUILDINGS_MIN_ZOOM = 14;

function vworldTiles(key: string, layer: 'Base' | 'Satellite' | 'Hybrid'): string {
  const ext = layer === 'Satellite' ? 'jpeg' : 'png';
  return `https://api.vworld.kr/req/wmts/1.0.0/${encodeURIComponent(key)}/${layer}/{z}/{y}/{x}.${ext}`;
}

/** 배경지도 선택에 맞는 MapLibre 스타일을 만든다. */
/**
 * @param dim 배경 밝기 배율 (0.1~1.5, 1 = 기본). 관망이 잘 보이도록 배경을 흐리게/진하게 한다.
 * @param gray 흑백 (채도 제거) — 색 있는 관망·결과 색과 겹치지 않게.
 * @param buildings3d 건물을 높이만큼 세워 그린다. 높이는 OpenStreetMap 의 높이·층수이고, 없는 건물은 낮은 상자(약 5 m)로 나온다.
 */
export function buildMapStyle(basemap: BasemapId, vworldKey: string, dim = 1, gray = false, buildings3d = false): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': BACKGROUND } }],
  };
  const addRaster = (id: string, tiles: string[], attribution: string, maxzoom: number, opacity = 1, minzoom = 0) => {
    style.sources[id] = { type: 'raster', tiles, tileSize: 256, attribution, minzoom, maxzoom };
    style.layers.push({ id, type: 'raster', source: id, paint: { 'raster-opacity': Math.min(1, opacity * dim), 'raster-saturation': gray ? -1 : 0 } });
  };

  const vworldAttribution = '© <a href="https://www.vworld.kr" target="_blank" rel="noreferrer">VWorld 국토교통부</a>';
  switch (basemap) {
    case 'osm':
      addRaster(
        'osm',
        ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> 기여자',
        19,
        0.55,
      );
      break;
    case 'satellite':
      addRaster(
        'satellite',
        ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        'Imagery © Esri, Maxar, Earthstar Geographics',
        19,
        0.85,
      );
      break;
    case 'vworld-base':
      if (vworldKey) addRaster('vworld-base', [vworldTiles(vworldKey, 'Base')], vworldAttribution, 19, 0.6, 6);
      break;
    case 'vworld-satellite':
      if (vworldKey) addRaster('vworld-satellite', [vworldTiles(vworldKey, 'Satellite')], vworldAttribution, 19, 0.85, 6);
      break;
    case 'vworld-hybrid':
      if (vworldKey) {
        addRaster('vworld-satellite', [vworldTiles(vworldKey, 'Satellite')], vworldAttribution, 19, 0.85, 6);
        addRaster('vworld-hybrid', [vworldTiles(vworldKey, 'Hybrid')], vworldAttribution, 19, 1, 6);
      }
      break;
    case 'none':
      break;
  }
  if (buildings3d) {
    style.sources.buildings = {
      type: 'vector',
      url: BUILDING_TILES,
      attribution: '건물 © <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> · OpenMapTiles · OpenStreetMap',
    };
    style.layers.push({
      id: 'buildings-3d',
      type: 'fill-extrusion',
      source: 'buildings',
      'source-layer': 'building',
      minzoom: BUILDINGS_MIN_ZOOM,
      paint: {
        // 낮은 건물은 어둡게, 높은 건물은 밝게 — 관망 색(파랑·초록·빨강)과 겹치지 않는 회색 계열
        'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 5], 0, '#5d6673', 30, '#8b95a3', 100, '#b9c2cf'],
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 5],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.8,
      },
    });
  }
  return style;
}
