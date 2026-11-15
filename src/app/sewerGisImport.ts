/**
 * 하수도 GIS Shapefile(관거·맨홀·처리분구 등) → 하수 관망 가져오기.
 * 파일을 읽어 레이어를 나누고(관거 선 · 맨홀 점 · 구역 면), 좌표를 하수 프로젝트 좌표(EPSG:5186)로 바꾼 뒤
 * core/sewer/fromGis.ts 로 관망을 이어 둔다. 용도·구역은 대화상자(SewerGisModal)에서 고른다.
 */
import type { Feature, Position } from 'geojson';
import { loadShapefiles } from '../core/io/loadShapefiles';
import { auditGroundWithTerrain, buildGisNetwork, extractSewerProject, terrainBias, type ExtractOptions, type GisPipeInput, type GisPointInput, type TerrainAuditOptions, type XY } from '../core/sewer/fromGis';
import { SEWER_CRS, xyToLngLat } from '../core/sewer/mapFrame';
import { interpolatorFromFiles, sampleTerrainTiles } from './terrainFetch';
import { CRS_DEFS, detectCrs, toWgs84, wgs84ToEpsg } from '../utils/geoMath';
import { useSewerGisStore, type GisArea } from '../store/useSewerGisStore';
import { useSewerStore } from '../store/useSewerStore';
import { useUIStore } from '../store/useUIStore';
import { fitToSewer } from './sewerMapActions';

const PARTS = /\.(shp|dbf|prj|cpg|shx|zip)$/i;
/** 관망에 쓰지 않는 레이어(주석·물받이·연결관·측구 등)는 읽지도 않는다 — 폴더 전체를 골라도 가볍게. */
const SKIP_LAYER = /(주석|물받이|연결관|측구|관정|심도|온천|환기|annot|anno)/i;

const prop = (f: Feature, key: string) => (f.properties ?? {})[key];
const odTable = (f: Feature) => String(prop(f, 'OD_TABLE') ?? '').toUpperCase();
const layerOf = (f: Feature) => String(prop(f, '__layer') ?? '');
const hasAny = (f: Feature, keys: string[]) => keys.some((k) => Object.keys(f.properties ?? {}).some((p) => p.toLowerCase() === k));

function isPipe(f: Feature): boolean {
  const g = f.geometry?.type;
  if (g !== 'LineString' && g !== 'MultiLineString') return false;
  if (odTable(f).includes('SWL_PIPE')) return true;
  if (odTable(f).startsWith('SWL_') || odTable(f).includes('SIDE')) return false;
  return /관거|관로|pipe|sewer/i.test(layerOf(f)) || hasAny(f, ['sbk_hsl', 'bom_idn', 'std_dip']);
}
function isManhole(f: Feature): boolean {
  const g = f.geometry?.type;
  if (g !== 'Point' && g !== 'MultiPoint') return false;
  if (odTable(f).includes('SWL_MANH')) return true;
  if (odTable(f).startsWith('SWL_')) return false;
  return /맨홀|manh/i.test(layerOf(f)) || hasAny(f, ['mos_hsl', 'lms_hsl']);
}
/** 구역 이름 필드: 처리분구 DDP_NAM, 배수분구 DDR_NAM, 그 밖에 *_NAM · 이름 · 명칭 */
function areaName(f: Feature): string {
  const p = f.properties ?? {};
  for (const key of ['DDP_NAM', 'DDR_NAM', 'NAME', 'NAM', '이름', '명칭', '구역명']) if (p[key]) return String(p[key]);
  for (const key in p) if (/_NAM$/i.test(key) && p[key]) return String(p[key]);
  return '';
}

/** Shapefile 묶음이 하수도 GIS(관거·맨홀) 자료인지 — 상수 쪽 '열기'에서 하수로 돌릴 때 쓴다. */
export function looksLikeSewerGis(features: Feature[]): boolean {
  return features.some((f) => odTable(f).startsWith('SWL_PIPE') || odTable(f).startsWith('SWL_MANH') || hasAny(f, ['sbk_hsl', 'bom_idn', 'mos_hsl']));
}

export async function openSewerGisFiles(files: File[]): Promise<void> {
  const ui = useUIStore.getState();
  const parts = files.filter((f) => PARTS.test(f.name) && !SKIP_LAYER.test(f.name));
  if (!parts.some((f) => /\.(shp|zip)$/i.test(f.name))) {
    ui.pushToast({ level: 'warning', title: '관거·맨홀 .shp 를 함께 고르세요', message: '하수관거(선)·하수맨홀(점) .shp 와 같은 이름의 .dbf·.prj 를 함께, 또는 .zip 으로 고릅니다. 처리분구·배수분구(면)를 넣으면 구역별로 가져올 수 있습니다.' });
    return;
  }
  const store = useSewerGisStore.getState();
  store.setBusy('Shapefile 읽는 중…');
  ui.openModal('sewerGis');
  try {
    await new Promise((r) => setTimeout(r, 0));
    const set = await loadShapefiles(await Promise.all(parts.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))), { polygons: true });
    const features = set.collection.features;
    const pipesRaw = features.filter(isPipe);
    const manholesRaw = features.filter(isManhole);
    if (pipesRaw.length === 0) throw new Error('관거(선) 레이어를 찾지 못했습니다. 하수관거 .shp·.dbf 를 함께 고르세요.');

    // 좌표계: 좌측 패널 지정 → .prj → 좌표 범위
    const choice = ui.importCrs;
    let crs = choice !== 'auto' && choice !== 'local' ? choice : set.crs;
    if (!crs) {
      const sample: [number, number][] = [];
      for (const f of pipesRaw.slice(0, 200)) {
        const g = f.geometry;
        if (g.type === 'LineString') sample.push(g.coordinates[0] as [number, number]);
      }
      const detected = detectCrs(sample);
      crs = detected === 'local' ? null : detected;
    }
    if (!crs) throw new Error('좌표계를 알 수 없습니다. .prj 를 함께 넣거나 왼쪽 패널 ‘가져오기 좌표계’를 지정하세요.');
    const code = crs;
    const toXy = (c: Position): XY => {
      const xy: XY = [c[0], c[1]];
      if (code === SEWER_CRS) return xy;
      const p = wgs84ToEpsg(SEWER_CRS, code === 'wgs84' ? xy : toWgs84({ kind: 'epsg', code }, xy));
      return [p[0], p[1]];
    };

    store.setBusy(`관거 ${pipesRaw.length.toLocaleString()}개 · 맨홀 ${manholesRaw.length.toLocaleString()}개 잇는 중…`);
    await new Promise((r) => setTimeout(r, 0));
    const pipes: GisPipeInput[] = [];
    for (const f of pipesRaw) {
      const g = f.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const line of lines) pipes.push({ coords: line.map(toXy), props: f.properties ?? {} });
    }
    const manholes: GisPointInput[] = [];
    for (const f of manholesRaw) {
      const g = f.geometry;
      const points = g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : [];
      for (const p of points) manholes.push({ xy: toXy(p), props: f.properties ?? {} });
    }
    const net = buildGisNetwork(pipes, manholes);

    const areas: GisArea[] = [];
    for (const f of features) {
      if (f.geometry?.type !== 'Polygon') continue;
      const name = areaName(f);
      const layer = layerOf(f);
      const rings = f.geometry.coordinates.map((ring) => ring.map(toXy));
      // 같은 이름 조각은 한 구역으로 묶는다
      const existing = areas.find((a) => a.layer === layer && a.name === (name || '(이름 없음)'));
      if (existing) existing.rings.push(...rings);
      else areas.push({ layer, name: name || '(이름 없음)', rings });
    }
    areas.sort((a, b) => a.layer.localeCompare(b.layer) || a.name.localeCompare(b.name, 'ko'));
    const crsLabel = code === 'wgs84' ? 'WGS84 경위도' : (CRS_DEFS[code as keyof typeof CRS_DEFS]?.label ?? code);
    store.setData({ net, areas, crsLabel, crs: code, layers: set.layers, warnings: set.warnings, label: parts.find((f) => /\.(shp|zip)$/i.test(f.name))?.name ?? 'GIS' });
  } catch (error) {
    store.setError(error instanceof Error ? error.message : String(error));
  } finally {
    useSewerGisStore.getState().setBusy(null);
  }
}

export type TerrainChoice = { kind: 'none' } | { kind: 'files'; files: File[] } | { kind: 'tiles' };

/** 절점 위치의 지형 지반고 (수치지형도 파일 또는 온라인 지형 타일). */
async function sampleTerrain(nodes: { id: string; x: number; y: number }[], choice: TerrainChoice, crs: string): Promise<{ terrain: Map<string, number>; label: string }> {
  const points = nodes.map((n) => xyToLngLat({ kind: 'epsg' }, n.x, n.y));
  const terrain = new Map<string, number>();
  if (choice.kind === 'files') {
    // 수치지형도에 .prj 가 없으면 좌표 범위만으로는 원점을 모르므로 하수 GIS 와 같은 원점으로 본다
    const { idw, points: count, layers } = await interpolatorFromFiles(choice.files, crs === 'wgs84' ? SEWER_CRS : crs, crs);
    nodes.forEach((n, i) => {
      const v = idw.at(points[i]);
      if (v) terrain.set(n.id, v.z);
    });
    return { terrain, label: `수치지형도 (${layers.slice(0, 3).join(', ')}${layers.length > 3 ? ' …' : ''} · 표고 ${count.toLocaleString()}점)` };
  }
  const values = await sampleTerrainTiles(points, (d, t) => useSewerGisStore.getState().setBusy(`지형 타일 받는 중… ${d}/${t}`));
  nodes.forEach((n, i) => Number.isFinite(values[i]) && terrain.set(n.id, values[i]));
  return { terrain, label: '온라인 지형 타일 (SRTM 30 m 급 — 개략)' };
}

/** 고른 용도·구역으로 하수 관망을 만들어 연다. 지형 자료를 주면 빈 지반고를 채우고 차이가 큰 맨홀을 점검 목록에 올린다. */
export async function createSewerFromGis(options: ExtractOptions, choice: TerrainChoice = { kind: 'none' }, audit: TerrainAuditOptions = { threshold: 1, replace: false }): Promise<boolean> {
  const ui = useUIStore.getState();
  const gis = useSewerGisStore.getState();
  const data = gis.data;
  if (!data || gis.busy) return false;
  try {
    let built = extractSewerProject(data.net, options);
    let terrainLabel = '';
    let replaced = 0;
    if (choice.kind !== 'none') {
      gis.setBusy('지형 자료 읽는 중…');
      const { terrain, label } = await sampleTerrain(built.project.nodes, choice, data.crs);
      if (terrain.size === 0) throw new Error('관망 위치에 지형 자료가 없습니다. 수치지형도 범위·좌표계(원점)를 확인하세요.');
      const bias = terrainBias(built.project, terrain);
      if (Math.abs(bias.median) > 20) {
        throw new Error(`맨홀 지반고와 지형 자료가 평균 ${bias.median.toFixed(1)} m 차이 납니다. 수치지형도 좌표계(중부·동부원점 등)가 하수 GIS 와 같은지 확인하세요.`);
      }
      built = extractSewerProject(data.net, { ...options, terrain });
      const checked = auditGroundWithTerrain(built.project, terrain, audit);
      built.notes.push(...checked.notes);
      replaced = checked.changed;
      terrainLabel = `${label} · 맨홀 ${terrain.size.toLocaleString()}/${built.project.nodes.length.toLocaleString()}곳 비교, 지반고 차 중앙값 ${bias.median >= 0 ? '+' : ''}${bias.median.toFixed(2)} m`;
    }
    const { project, report, notes } = built;
    const sewer = useSewerStore.getState();
    sewer.setProject(project);
    sewer.select(null);
    useSewerGisStore.getState().setAudit({ projectName: project.name, notes, terrainLabel });
    ui.setDomain('sewer');
    ui.setTool('select');
    ui.openModal(null);
    ui.setSewerBottomTab('audit');
    fitToSewer();
    const diffs = notes.filter((n) => n.issue === '지반고 ↔ 지형 차이').length;
    ui.pushToast({
      level: notes.length > 0 ? 'warning' : 'success',
      title: `하수 GIS → 관망: 관거 ${report.pipes.toLocaleString()}개 · 맨홀 ${report.manholes.toLocaleString()}개 · 방류구 ${report.outfalls}곳`,
      message:
        `좌표계 ${data.crsLabel} → EPSG:5186. 아래 ‘자료 점검’ 탭에 확인·보완할 곳 ${notes.length.toLocaleString()}건을 모았습니다` +
        (terrainLabel ? ` (지형과 지반고 차이 ${diffs}곳${audit.replace ? ` 중 ${replaced}곳을 지형값으로 바꿈` : ''})` : '') +
        '. 유입량이 없으니 유역을 그리거나(A) 맨홀 유입량을 넣고 ‘현황 해석’을 하세요.',
    });
    return true;
  } catch (error) {
    useSewerGisStore.getState().setError(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    useSewerGisStore.getState().setBusy(null);
  }
}
