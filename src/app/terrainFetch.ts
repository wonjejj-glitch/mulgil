/**
 * 지반고 샘플링 (브라우저 전용): 온라인 지형 타일을 내려받아 읽거나, 수치지형도 Shapefile 로 보간기를 만든다.
 */
import { parseDxfElevations, type DxfElevation } from '../core/io/dxfElevation';
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
export async function sampleTerrainTiles(points: LngLat[], onProgress?: (done: number, total: number) => void, zoom = TERRAIN_ZOOM): Promise<number[]> {
  const loc = points.map((p) => lngLatToTilePixel(p, zoom));
  const keys = [...new Set(loc.map((l) => `${l.tx}/${l.ty}`))];
  const tiles = new Map<string, Uint8ClampedArray>();
  let done = 0;
  for (let i = 0; i < keys.length; i += 6) {
    await Promise.all(
      keys.slice(i, i + 6).map(async (key) => {
        const [x, y] = key.split('/').map(Number);
        tiles.set(key, await loadTile(zoom, x, y));
        onProgress?.(++done, keys.length);
      }),
    );
  }
  return loc.map((l) => sampleTerrarium(tiles.get(`${l.tx}/${l.ty}`)!, l.px, l.py));
}

/**
 * 표고점 텍스트(XYZ/CSV/TXT: 줄마다 X Y Z, 쉼표·공백·탭 구분, 머리글 줄은 건너뜀)로 IDW 보간기를 만든다.
 * 측량 성과, CAD 점고도, DEM 을 점으로 내보낸 자료 등. 좌표계는 자동 감지하고 모르면 fallbackCrs 를 쓴다.
 */
export async function interpolatorFromXyz(files: File[], fallbackCrs: string | null): Promise<{ idw: IdwInterpolator; points: number; layers: string[] }> {
  const raw: { xy: [number, number]; z: number }[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('euc-kr').decode(bytes);
    }
    for (const line of text.split(/\r?\n/)) {
      const parts = line.trim().split(/[\s,;]+/).map(Number);
      if (parts.length < 3 || parts.slice(0, 3).some((v) => !Number.isFinite(v))) continue;
      // 점번호가 앞에 붙은 형식(번호 X Y Z)이면 마지막 세 값을 쓴다
      const [x, y, z] = parts.length >= 4 ? parts.slice(-3) : parts;
      raw.push({ xy: [x, y], z });
    }
  }
  if (raw.length === 0) throw new Error('표고점을 읽지 못했습니다. 줄마다 X Y Z (또는 번호 X Y Z) 형식인지 확인하세요.');
  const detected = detectCrs(raw.map((r) => r.xy));
  const code = detected === 'local' ? fallbackCrs : detected;
  if (!code || code === 'local') throw new Error('표고점 좌표계를 알 수 없습니다. 왼쪽 패널 ‘가져오기 좌표계’를 맞추거나 EPSG 좌표로 된 자료를 넣으세요.');
  const crs = code === 'wgs84' ? ({ kind: 'wgs84' } as const) : ({ kind: 'epsg', code } as const);
  const points: ElevationPoint[] = raw.map((r) => ({ position: toWgs84(crs, r.xy), z: r.z }));
  return { idw: new IdwInterpolator(points, 300, 8), points: points.length, layers: files.map((f) => f.name) };
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

/** 수치지형도 DXF(등고선·표고점)로 IDW 보간기를 만든다. 등고선은 선 위를 10 m 간격으로 채운다. */
export async function interpolatorFromDxf(files: File[], fallbackCrs: string | null): Promise<{ idw: IdwInterpolator; points: number; layers: string[] }> {
  const raw: DxfElevation[] = [];
  const layers: string[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('euc-kr').decode(bytes);
    }
    const parsed = parseDxfElevations(text);
    raw.push(...parsed.points.map((p) => ({ ...p, line: p.line < 0 ? -1 : p.line + raw.length * 1e6 })));
    layers.push(...parsed.layers.map((l) => `${file.name}:${l}`));
  }
  if (raw.length === 0) throw new Error('DXF 에서 표고 값을 찾지 못했습니다. 등고선(고도 값이 있는 폴리선)·표고점이 들어 있는 수치지형도 DXF 인지 확인하세요.');
  const detected = detectCrs(raw.map((r) => r.xy));
  const code = detected === 'local' ? fallbackCrs : detected;
  if (!code || code === 'local') throw new Error('DXF 좌표계를 알 수 없습니다. 왼쪽 패널 ‘가져오기 좌표계’를 수치지형도 좌표계(보통 EPSG:5186 중부원점)로 맞추세요.');
  const crs = code === 'wgs84' ? ({ kind: 'wgs84' } as const) : ({ kind: 'epsg', code } as const);
  const points: ElevationPoint[] = [];
  const byLine = new Map<number, DxfElevation[]>();
  for (const r of raw) {
    if (r.line < 0) points.push({ position: toWgs84(crs, r.xy), z: r.z });
    else byLine.set(r.line, [...(byLine.get(r.line) ?? []), r]);
  }
  for (const line of byLine.values()) {
    const ll = line.map((r) => toWgs84(crs, r.xy));
    for (const pt of line.length > 1 ? densify(ll, 10) : ll) points.push({ position: pt, z: line[0].z });
  }
  return { idw: new IdwInterpolator(points, 300, 8), points: points.length, layers };
}

/** 파일 확장자로 표고점 텍스트 · DXF · Shapefile 을 골라 보간기를 만든다. */
export async function interpolatorFromFiles(files: File[], fallbackCrs: string | null): Promise<{ idw: IdwInterpolator; points: number; layers: string[] }> {
  if (files.length === 0) throw new Error('수치지형도(.dxf · .shp 묶음 · .zip) 또는 표고점 텍스트(.xyz·.txt·.csv)를 고르세요.');
  if (files.every((f) => /\.(xyz|txt|csv|pts)$/i.test(f.name))) return interpolatorFromXyz(files, fallbackCrs);
  if (files.every((f) => /\.dxf$/i.test(f.name))) return interpolatorFromDxf(files, fallbackCrs);
  if (files.some((f) => /\.dxf$/i.test(f.name))) throw new Error('DXF 와 다른 형식을 섞어 넣을 수 없습니다. 한 가지 형식만 고르세요.');
  return interpolatorFromShapefiles(files, fallbackCrs);
}
