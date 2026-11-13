/**
 * 지반고 샘플링 (브라우저 전용): 온라인 지형 타일을 내려받아 읽거나, 수치지형도 Shapefile 로 보간기를 만든다.
 */
import { loadShapefiles } from '../core/io/loadShapefiles';
import type { LngLat } from '../core/model/types';
import {
  densify,
  elevationFromProperties,
  IdwInterpolator,
  lngLatToTilePixel,
  sampleTerrarium,
  TERRAIN_TILE_URL,
  type ElevationPoint,
} from '../core/terrain/elevation';
import { CRS_DEFS, detectCrs, toWgs84 } from '../utils/geoMath';

/** 지형 타일 줌. 13 ≈ 픽셀 15 m (국내 원자료 SRTM 30 m 보다 촘촘하므로 충분). */
const TERRAIN_ZOOM = 13;

async function loadTile(z: number, x: number, y: number): Promise<Uint8ClampedArray> {
  const url = TERRAIN_TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`지형 타일을 받지 못했습니다 (HTTP ${response.status}).`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

/** 여러 지점의 지반고(m)를 온라인 지형 타일에서 읽는다. 필요한 타일만, 동시에 6개씩 받는다. */
export async function sampleTerrainTiles(points: LngLat[], onProgress?: (done: number, total: number) => void): Promise<number[]> {
  const loc = points.map((p) => lngLatToTilePixel(p, TERRAIN_ZOOM));
  const keys = [...new Set(loc.map((l) => `${l.tx}/${l.ty}`))];
  const tiles = new Map<string, Uint8ClampedArray>();
  let done = 0;
  for (let i = 0; i < keys.length; i += 6) {
    await Promise.all(
      keys.slice(i, i + 6).map(async (key) => {
        const [x, y] = key.split('/').map(Number);
        tiles.set(key, await loadTile(TERRAIN_ZOOM, x, y));
        onProgress?.(++done, keys.length);
      }),
    );
  }
  return loc.map((l) => sampleTerrarium(tiles.get(`${l.tx}/${l.ty}`)!, l.px, l.py));
}

/**
 * 수치지형도 Shapefile(표고점·등고선, .shp/.dbf/.prj 또는 .zip)로 IDW 보간기를 만든다.
 * 표고는 속성(CONT·NUME·ELEV 등) 또는 도형의 Z 값에서 읽는다.
 */
export async function interpolatorFromShapefiles(files: File[], fallbackCrs: string | null): Promise<{ idw: IdwInterpolator; points: number; layers: string[] }> {
  const set = await loadShapefiles(await Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))));
  const raw: { xy: [number, number]; z: number }[] = [];
  for (const feature of set.collection.features) {
    const g = feature.geometry;
    if (!g) continue;
    const attrZ = elevationFromProperties(feature.properties as Record<string, unknown> | null);
    const push = (c: number[]) => {
      const z = attrZ ?? (c.length > 2 && Number.isFinite(c[2]) && c[2] !== 0 ? c[2] : undefined);
      if (z !== undefined) raw.push({ xy: [c[0], c[1]], z });
    };
    if (g.type === 'Point') push(g.coordinates);
    else if (g.type === 'MultiPoint') g.coordinates.forEach(push);
    else if (g.type === 'LineString' || g.type === 'MultiLineString') {
      const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      for (const line of lines) for (const c of line) push(c);
    }
  }
  if (raw.length === 0) throw new Error('표고 값을 찾지 못했습니다. 표고점·등고선 레이어(속성 CONT·NUME·ELEV 등 또는 Z 좌표)를 넣어 주세요.');
  const declared = set.crs ?? fallbackCrs;
  const code = declared && (declared === 'wgs84' || declared in CRS_DEFS) ? declared : detectCrs(raw.map((r) => r.xy));
  if (code === 'local') throw new Error('수치지형도의 좌표계를 알 수 없습니다. .prj 파일을 함께 넣어 주세요.');
  const crs = code === 'wgs84' ? ({ kind: 'wgs84' } as const) : ({ kind: 'epsg', code } as const);
  const points: ElevationPoint[] = [];
  raw.forEach((r) => points.push({ position: toWgs84(crs, r.xy), z: r.z }));
  // 등고선은 꼭짓점이 듬성할 수 있어 같은 선 위를 10 m 간격으로 채운다
  for (const feature of set.collection.features) {
    const g = feature.geometry;
    const z = elevationFromProperties(feature.properties as Record<string, unknown> | null);
    if (!g || z === undefined || (g.type !== 'LineString' && g.type !== 'MultiLineString')) continue;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
    for (const line of lines) {
      const ll = line.map((c) => toWgs84(crs, [c[0], c[1]]));
      for (const p of densify(ll, 10)) points.push({ position: p, z });
    }
  }
  return { idw: new IdwInterpolator(points, 300, 8), points: points.length, layers: set.layers };
}
