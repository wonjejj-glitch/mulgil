import proj4 from 'proj4';
import { length as turfLength, lineString } from '@turf/turf';
import type { LngLat, SourceCrs } from '../core/model/types';

/** 국내에서 자주 쓰는 좌표계 정의 (X=동향/Easting, Y=북향/Northing). */
export const CRS_DEFS: Record<string, { label: string; def: string }> = {
  'EPSG:5186': {
    label: 'EPSG:5186 중부원점 (GRS80)',
    def: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
  },
  'EPSG:5185': {
    label: 'EPSG:5185 서부원점 (GRS80)',
    def: '+proj=tmerc +lat_0=38 +lon_0=125 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
  },
  'EPSG:5187': {
    label: 'EPSG:5187 동부원점 (GRS80)',
    def: '+proj=tmerc +lat_0=38 +lon_0=129 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
  },
  'EPSG:5188': {
    label: 'EPSG:5188 동해원점 (GRS80)',
    def: '+proj=tmerc +lat_0=38 +lon_0=131 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
  },
  'EPSG:5179': {
    label: 'EPSG:5179 UTM-K (GRS80)',
    def: '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs',
  },
  'EPSG:5181': {
    label: 'EPSG:5181 중부원점 (GRS80, 가산 500000)',
    def: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +units=m +no_defs',
  },
  'EPSG:5180': {
    label: 'EPSG:5180 서부원점 (GRS80, 가산 500000)',
    def: '+proj=tmerc +lat_0=38 +lon_0=125 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +units=m +no_defs',
  },
  'EPSG:5183': {
    label: 'EPSG:5183 동부원점 (GRS80, 가산 500000)',
    def: '+proj=tmerc +lat_0=38 +lon_0=129 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +units=m +no_defs',
  },
  'EPSG:2097': {
    label: 'EPSG:2097 구 중부원점 (Bessel, 경도 보정 없음)',
    def: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43',
  },
  'EPSG:5174': {
    label: 'EPSG:5174 구 중부원점 (Bessel)',
    def: '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43',
  },
};

for (const code in CRS_DEFS) proj4.defs(code, CRS_DEFS[code].def);

export type ImportCrsChoice = 'auto' | 'wgs84' | 'local' | keyof typeof CRS_DEFS;

export const DEFAULT_ANCHOR: LngLat = [126.978, 37.5665];

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_EQ = 111320;

export function epsgToWgs84(code: string, xy: [number, number]): LngLat {
  const [lng, lat] = proj4(code, 'WGS84', xy);
  return [lng, lat];
}

export function wgs84ToEpsg(code: string, lngLat: LngLat): [number, number] {
  const [x, y] = proj4('WGS84', code, lngLat);
  return [x, y];
}

/** 경위도 점을 동·북 방향으로 m 만큼 옮긴다 (수 km 이내의 작은 이동용). */
function offsetMeters(p: LngLat, dx: number, dy: number): LngLat {
  return [p[0] + dx / (M_PER_DEG_LNG_EQ * Math.cos((p[1] * Math.PI) / 180)), p[1] + dy / M_PER_DEG_LAT];
}

/** 원본 좌표 → WGS84. crs.shift(도로 기준 보정)가 있으면 그만큼 옮긴 위치. */
export function toWgs84(crs: SourceCrs, xy: [number, number]): LngLat {
  const base = toWgs84Raw(crs, xy);
  return crs.shift ? offsetMeters(base, crs.shift[0], crs.shift[1]) : base;
}

function toWgs84Raw(crs: SourceCrs, xy: [number, number]): LngLat {
  if (crs.kind === 'wgs84') return [xy[0], xy[1]];
  if (crs.kind === 'epsg') return epsgToWgs84(crs.code, xy);
  const cosLat = Math.cos((crs.anchor[1] * Math.PI) / 180);
  return [
    crs.anchor[0] + ((xy[0] - crs.origin[0]) * crs.metersPerUnit) / (M_PER_DEG_LNG_EQ * cosLat),
    crs.anchor[1] + ((xy[1] - crs.origin[1]) * crs.metersPerUnit) / M_PER_DEG_LAT,
  ];
}

/** WGS84 → 원본 좌표 (내보내기용). crs.shift 를 먼저 되돌려 파일의 원래 좌표를 돌려준다. */
export function fromWgs84(crs: SourceCrs, lngLat: LngLat): [number, number] {
  return fromWgs84Raw(crs, crs.shift ? offsetMeters(lngLat, -crs.shift[0], -crs.shift[1]) : lngLat);
}

function fromWgs84Raw(crs: SourceCrs, lngLat: LngLat): [number, number] {
  if (crs.kind === 'wgs84') return [lngLat[0], lngLat[1]];
  if (crs.kind === 'epsg') return wgs84ToEpsg(crs.code, lngLat);
  const cosLat = Math.cos((crs.anchor[1] * Math.PI) / 180);
  return [
    crs.origin[0] + ((lngLat[0] - crs.anchor[0]) * M_PER_DEG_LNG_EQ * cosLat) / crs.metersPerUnit,
    crs.origin[1] + ((lngLat[1] - crs.anchor[1]) * M_PER_DEG_LAT) / crs.metersPerUnit,
  ];
}

export type DetectedCrs = 'wgs84' | 'EPSG:5186' | 'EPSG:5179' | 'local';

/**
 * 좌표 값의 범위로 좌표계를 추정한다.
 * - 한반도 경위도 범위 → WGS84
 * - 중부원점 계열 TM 범위 → EPSG:5186 (서부/동부/동해 원점은 범위만으로 구분할 수 없어 사용자가 선택)
 * - UTM-K 범위 → EPSG:5179
 * - 그 외 → 임의 평면 좌표
 */
export function detectCrs(points: [number, number][]): DetectedCrs {
  if (points.length === 0) return 'wgs84';
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const lonLatRange = minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90;
  if (lonLatRange) {
    const inKorea = minX >= 123 && maxX <= 133 && minY >= 32 && maxY <= 44;
    // 경위도처럼 보이더라도 범위가 지나치게 넓으면 도면 좌표(예: EPANET 예제)로 본다.
    const compact = maxX - minX <= 3 && maxY - minY <= 3;
    if (inKorea || compact) return 'wgs84';
    return 'local';
  }
  if (minX >= 60000 && maxX <= 420000 && minY >= 50000 && maxY <= 1050000) return 'EPSG:5186';
  if (minX >= 700000 && maxX <= 1500000 && minY >= 1300000 && maxY <= 2800000) return 'EPSG:5179';
  return 'local';
}

/** Turf.js 기반 폴리라인 연장(m). */
export function pathLengthMeters(path: LngLat[]): number {
  if (path.length < 2) return 0;
  return turfLength(lineString(path), { units: 'kilometers' }) * 1000;
}

/** 두 점 사이 평면 근사 거리(m) — 짧은 거리 반복 계산용. */
export function distanceMeters(a: LngLat, b: LngLat): number {
  const cosLat = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dx = (b[0] - a[0]) * M_PER_DEG_LNG_EQ * cosLat;
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** 위도 lat0 기준의 국소 평면(m) 투영기. 교차 검사 등 평면 기하 연산용. */
export function makeLocalProjector(lat0: number) {
  const kx = M_PER_DEG_LNG_EQ * Math.cos((lat0 * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  return {
    forward: (p: LngLat): [number, number] => [p[0] * kx, p[1] * ky],
    inverse: (p: [number, number]): LngLat => [p[0] / kx, p[1] / ky],
  };
}

export type BBox = [number, number, number, number];

export function bboxOf(points: Iterable<LngLat>): BBox | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of points) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

export function centerOf(points: LngLat[]): LngLat {
  const box = bboxOf(points);
  if (!box) return DEFAULT_ANCHOR;
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
}

/**
 * 폴리라인의 중간 지점과 그 지점의 진행 방향.
 * angle 은 동쪽(+x)을 0° 로 하는 반시계 방향 각도(웹 메르카토르 화면 기준)이다.
 */
export function midpointOfPath(path: LngLat[]): { position: LngLat; angle: number } {
  if (path.length === 0) return { position: DEFAULT_ANCHOR, angle: 0 };
  if (path.length === 1) return { position: path[0], angle: 0 };
  const segLengths: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const d = distanceMeters(path[i], path[i + 1]);
    segLengths.push(d);
    total += d;
  }
  let remaining = total / 2;
  let index = 0;
  while (index < segLengths.length - 1 && remaining > segLengths[index]) {
    remaining -= segLengths[index];
    index++;
  }
  const a = path[index];
  const b = path[index + 1];
  const t = segLengths[index] > 0 ? remaining / segLengths[index] : 0.5;
  const position: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const cosLat = Math.cos((position[1] * Math.PI) / 180);
  const angle = (Math.atan2(b[1] - a[1], (b[0] - a[0]) * cosLat) * 180) / Math.PI;
  return { position, angle };
}

export interface PathProjection {
  /** 가장 가까운 선분의 시작 인덱스 (path[i] → path[i+1]). */
  segmentIndex: number;
  point: LngLat;
  /** 시점에서 투영점까지의 거리 비율 (0~1). */
  ratio: number;
  distance: number;
}

/** 점을 폴리라인 위로 투영한다. */
export function projectOntoPath(path: LngLat[], point: LngLat): PathProjection {
  const proj = makeLocalProjector(point[1]);
  const p = proj.forward(point);
  const pts = path.map(proj.forward);
  let best: PathProjection = { segmentIndex: 0, point: path[0], ratio: 0, distance: Infinity };
  let walked = 0;
  let total = 0;
  const segLen: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    segLen.push(d);
    total += d;
  }
  let bestAlong = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + dx * t;
    const qy = ay + dy * t;
    const dist = Math.hypot(p[0] - qx, p[1] - qy);
    if (dist < best.distance) {
      best = { segmentIndex: i, point: proj.inverse([qx, qy]), ratio: 0, distance: dist };
      bestAlong = walked + segLen[i] * t;
    }
    walked += segLen[i];
  }
  best.ratio = total > 0 ? bestAlong / total : 0;
  return best;
}

export function formatLngLat(p: LngLat): string {
  return `${p[0].toFixed(6)}, ${p[1].toFixed(6)}`;
}
