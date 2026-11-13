/**
 * GIS 데이터 임포트/익스포트와 속성 매핑.
 * GeoJSON(또는 Shapefile 을 읽어 만든 GeoJSON)의 선형(LineString)은 관로로, 선의 끝점은 절점으로 변환한다.
 * Shapefile 읽기 자체는 shapefile.ts / loadShapefiles 가 맡는다.
 */
import type { Feature, FeatureCollection, GeoJSON, Geometry, Position } from 'geojson';
import { CRS_DEFS, detectCrs, toWgs84 } from '../../utils/geoMath';
import { addLink, addNode, isValidId, linkPath } from '../model/networkEdit';
import { createEmptyModel, type LngLat, type NetworkModel, type SourceCrs } from '../model/types';

export interface GeoJsonImportResult {
  model: NetworkModel;
  warnings: string[];
  crsLabel: string;
}

/** 속성 이름 별칭 (소문자 비교). 국가 상수도 GIS 표준(WTL_PIPE_LM 등)의 필드 이름을 포함한다. */
const FIELD_ALIASES = {
  id: ['id', 'name', 'ftr_idn', 'fid', '관리번호', '관번호'],
  diameter: ['diameter', 'diam', 'dia', 'dip', 'pip_dip', 'std_dip', '관경', '구경'],
  length: ['length', 'len', 'pip_len', 'shape_leng', 'shape_length', '연장'],
  roughness: ['roughness', 'rough', 'hwc', 'c', '조도', '조도계수'],
  elevation: ['elevation', 'elev', 'ele', 'z', 'gl', 'hgt', 'gnd_hgt', '표고', '지반고'],
  demand: ['demand', 'dem', 'q', '수요량', '수요'],
} as const;

type FieldName = keyof typeof FIELD_ALIASES;

function readField(properties: Record<string, unknown> | null | undefined, field: FieldName): unknown {
  if (!properties) return undefined;
  const aliases: readonly string[] = FIELD_ALIASES[field];
  for (const key in properties) {
    if (aliases.includes(key.toLowerCase())) return properties[key];
  }
  return undefined;
}

function readNumber(properties: Record<string, unknown> | null | undefined, field: FieldName): number | undefined {
  const raw = readField(properties, field);
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function collectFeatures(input: GeoJSON): Feature[] {
  if (input.type === 'FeatureCollection') return (input as FeatureCollection).features;
  if (input.type === 'Feature') return [input as Feature];
  return [{ type: 'Feature', geometry: input as Geometry, properties: {} }];
}

function namedCrs(input: unknown): string | null {
  const name = (input as { crs?: { properties?: { name?: unknown } } })?.crs?.properties?.name;
  if (typeof name !== 'string') return null;
  const match = /EPSG:{1,2}(\d+)/i.exec(name);
  if (!match) return null;
  const code = `EPSG:${match[1]}`;
  return code in CRS_DEFS ? code : null;
}

export interface ImportGeoJsonOptions {
  /** 원본 좌표계를 이미 알 때 ('wgs84' 또는 'EPSG:xxxx'). 없으면 crs 멤버 → 좌표 범위 순으로 정한다. */
  declaredCrs?: string | null;
  title?: string;
  /** 경고 문구에 쓰는 원본 형식 이름. */
  sourceLabel?: string;
}

export function importGeoJson(input: string | GeoJSON, options: ImportGeoJsonOptions = {}): GeoJsonImportResult {
  const parsed = typeof input === 'string' ? (JSON.parse(input) as GeoJSON) : input;
  const sourceLabel = options.sourceLabel ?? 'GeoJSON';
  const features = collectFeatures(parsed);
  const warnings: string[] = [];

  const lines: { coords: Position[]; properties: Record<string, unknown> | null }[] = [];
  const points: { coord: Position; properties: Record<string, unknown> | null }[] = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === 'LineString') lines.push({ coords: geometry.coordinates, properties: feature.properties });
    else if (geometry.type === 'MultiLineString') {
      for (const part of geometry.coordinates) lines.push({ coords: part, properties: feature.properties });
    } else if (geometry.type === 'Point') points.push({ coord: geometry.coordinates, properties: feature.properties });
    else if (geometry.type === 'MultiPoint') {
      for (const coord of geometry.coordinates) points.push({ coord, properties: feature.properties });
    }
  }
  if (lines.length === 0 && points.length === 0) {
    throw new Error(`${sourceLabel} 에 점(Point) 또는 선(LineString) 도형이 없습니다.`);
  }

  // 좌표계: crs 멤버 → 좌표 범위 추정 순으로 결정
  const sample: [number, number][] = [];
  for (const line of lines) for (const c of line.coords) sample.push([c[0], c[1]]);
  for (const point of points) sample.push([point.coord[0], point.coord[1]]);
  const declared = options.declaredCrs ?? namedCrs(parsed);
  const detected = declared && (declared === 'wgs84' || declared in CRS_DEFS) ? declared : detectCrs(sample);
  let crs: SourceCrs;
  let crsLabel: string;
  if (detected === 'wgs84' || detected === 'local') {
    crs = { kind: 'wgs84' };
    crsLabel = 'WGS84 경위도';
    if (detected === 'local') warnings.push('좌표계를 알 수 없어 경위도로 처리했습니다. 위치가 맞지 않으면 원본 좌표계를 확인하세요.');
  } else {
    crs = { kind: 'epsg', code: detected };
    crsLabel = CRS_DEFS[detected].label;
  }
  if (declared && detected === declared) crsLabel += ' — 파일에 명시';
  const convert = (c: Position): LngLat => toWgs84(crs, [c[0], c[1]]);

  const model = createEmptyModel();
  model.title = [options.title ?? `${sourceLabel} 에서 가져온 관망`];
  model.crs = crs;

  // 끝점 스냅: 약 0.1 m 격자로 반올림해 같은 위치의 끝점을 하나의 절점으로 합친다.
  const nodeAt = new Map<string, string>();
  const keyOf = (p: LngLat) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const ensureNode = (p: LngLat): string => {
    const key = keyOf(p);
    const existing = nodeAt.get(key);
    if (existing) return existing;
    const node = addNode(model, 'junction', p);
    nodeAt.set(key, node.id);
    return node.id;
  };

  let skipped = 0;
  for (const line of lines) {
    if (line.coords.length < 2) {
      skipped++;
      continue;
    }
    const path = line.coords.map(convert);
    const startId = ensureNode(path[0]);
    const endId = ensureNode(path[path.length - 1]);
    if (startId === endId) {
      skipped++;
      continue;
    }
    const rawId = readField(line.properties, 'id');
    const wantedId = rawId !== undefined && rawId !== null ? String(rawId) : '';
    const id = wantedId && isValidId(wantedId) && !model.links[wantedId] ? wantedId : undefined;
    const link = addLink(model, 'pipe', startId, endId, path.slice(1, -1), id);
    if (!link || link.type !== 'pipe') continue;
    const diameter = readNumber(line.properties, 'diameter');
    if (diameter !== undefined && diameter > 0) link.diameter = diameter;
    const roughness = readNumber(line.properties, 'roughness');
    if (roughness !== undefined && roughness > 0) link.roughness = roughness;
    const length = readNumber(line.properties, 'length');
    if (length !== undefined && length > 0) {
      // 속성의 연장이 형상 연장과 2% 넘게 다르면 수동 입력 값으로 고정한다.
      const geometric = link.length;
      link.isCustomLength = Math.abs(length - geometric) / Math.max(geometric, 1e-6) > 0.02;
      link.length = length;
    }
  }
  if (skipped > 0) warnings.push(`길이가 0 이거나 시점과 종점이 같은 선 ${skipped}개를 제외했습니다.`);

  for (const point of points) {
    const position = convert(point.coord);
    const key = keyOf(position);
    let nodeId = nodeAt.get(key);
    if (!nodeId) {
      nodeId = addNode(model, 'junction', position).id;
      nodeAt.set(key, nodeId);
    }
    const node = model.nodes[nodeId];
    const elevation = readNumber(point.properties, 'elevation') ?? (point.coord.length > 2 ? Number(point.coord[2]) : undefined);
    if (elevation !== undefined && Number.isFinite(elevation)) node.elevation = elevation;
    const demand = readNumber(point.properties, 'demand');
    if (demand !== undefined && node.type === 'junction') node.demand = demand;
  }

  warnings.push(`${sourceLabel} 에는 수원 정보가 없습니다. 수원지 또는 배수지를 추가한 뒤 해석하세요.`);
  return { model, warnings, crsLabel };
}

/** 관망을 GeoJSON FeatureCollection 으로 내보낸다 (좌표는 WGS84). */
export function exportGeoJson(model: NetworkModel): FeatureCollection {
  const features: Feature[] = [];
  for (const id in model.nodes) {
    const node = model.nodes[id];
    const { position, ...properties } = node;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: position }, properties: { layer: 'node', ...properties } });
  }
  for (const id in model.links) {
    const link = model.links[id];
    const { vertices: _vertices, ...properties } = link;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: linkPath(model, link) },
      properties: { layer: 'link', ...properties },
    });
  }
  return { type: 'FeatureCollection', features };
}
