import type { StyleSpecification } from 'maplibre-gl';
import type { BasemapId } from '../../store/useUIStore';

export const BASEMAP_OPTIONS: { id: BasemapId; label: string; needsKey?: boolean }[] = [
  { id: 'osm', label: '일반지도 (OpenStreetMap)' },
  { id: 'satellite', label: '위성지도 (Esri)' },
  { id: 'vworld-base', label: '브이월드 일반', needsKey: true },
  { id: 'vworld-satellite', label: '브이월드 위성', needsKey: true },
  { id: 'vworld-hybrid', label: '브이월드 위성+주기', needsKey: true },
  { id: 'none', label: '배경 없음' },
];

const BACKGROUND = '#0f1318';

function vworldTiles(key: string, layer: 'Base' | 'Satellite' | 'Hybrid'): string {
  const ext = layer === 'Satellite' ? 'jpeg' : 'png';
  return `https://api.vworld.kr/req/wmts/1.0.0/${encodeURIComponent(key)}/${layer}/{z}/{y}/{x}.${ext}`;
}

/** 배경지도 선택에 맞는 MapLibre 스타일을 만든다. */
export function buildMapStyle(basemap: BasemapId, vworldKey: string): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': BACKGROUND } }],
  };
  const addRaster = (id: string, tiles: string[], attribution: string, maxzoom: number, opacity = 1, minzoom = 0) => {
    style.sources[id] = { type: 'raster', tiles, tileSize: 256, attribution, minzoom, maxzoom };
    style.layers.push({ id, type: 'raster', source: id, paint: { 'raster-opacity': opacity } });
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
  return style;
}
