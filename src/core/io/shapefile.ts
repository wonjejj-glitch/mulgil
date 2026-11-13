/**
 * ESRI Shapefile 읽기 (.shp 도형 + .dbf 속성 + .prj 좌표계 + .cpg 인코딩).
 * 점·다중점·선(PolyLine) 계열과 Z/M 변형을 GeoJSON 으로 바꾼다. 면(Polygon)은 관망 요소가 아니므로 건너뛴다.
 * 국내 자료는 속성이 CP949(EUC-KR)인 경우가 많아 .cpg 가 없으면 UTF-8 → EUC-KR 순으로 시도한다.
 */
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';

export interface ShapefileParts {
  shp: ArrayBuffer;
  dbf?: ArrayBuffer;
  prj?: string;
  cpg?: string;
}

export interface ShapefileResult {
  collection: FeatureCollection;
  /** .prj 로부터 알아낸 좌표계 ('wgs84' 또는 'EPSG:xxxx'). 모르면 null. */
  crs: string | null;
  warnings: string[];
}

const SHAPE_NAMES: Record<number, string> = {
  0: 'Null', 1: 'Point', 3: 'PolyLine', 5: 'Polygon', 8: 'MultiPoint',
  11: 'PointZ', 13: 'PolyLineZ', 15: 'PolygonZ', 18: 'MultiPointZ',
  21: 'PointM', 23: 'PolyLineM', 25: 'PolygonM', 28: 'MultiPointM', 31: 'MultiPatch',
};

/* ------------------------------------------------------------------ .shp */

function readGeometry(view: DataView, offset: number, length: number): { geometry: Geometry | null; type: number } {
  const type = view.getInt32(offset, true);
  const end = offset + length;
  const hasZ = type === 11 || type === 13 || type === 18;
  switch (type) {
    case 0:
      return { geometry: null, type };
    case 1:
    case 11:
    case 21: {
      const coord: Position = [view.getFloat64(offset + 4, true), view.getFloat64(offset + 12, true)];
      if (type === 11) coord.push(view.getFloat64(offset + 20, true));
      return { geometry: { type: 'Point', coordinates: coord }, type };
    }
    case 8:
    case 18:
    case 28: {
      const count = view.getInt32(offset + 36, true);
      const pointsAt = offset + 40;
      const zAt = pointsAt + count * 16 + 16;
      const coords: Position[] = [];
      for (let i = 0; i < count; i++) {
        const c: Position = [view.getFloat64(pointsAt + i * 16, true), view.getFloat64(pointsAt + i * 16 + 8, true)];
        if (hasZ && zAt + i * 8 + 8 <= end) c.push(view.getFloat64(zAt + i * 8, true));
        coords.push(c);
      }
      return { geometry: { type: 'MultiPoint', coordinates: coords }, type };
    }
    case 3:
    case 13:
    case 23: {
      const numParts = view.getInt32(offset + 36, true);
      const numPoints = view.getInt32(offset + 40, true);
      const partsAt = offset + 44;
      const pointsAt = partsAt + numParts * 4;
      const zAt = pointsAt + numPoints * 16 + 16;
      const starts: number[] = [];
      for (let p = 0; p < numParts; p++) starts.push(view.getInt32(partsAt + p * 4, true));
      starts.push(numPoints);
      const lines: Position[][] = [];
      for (let p = 0; p < numParts; p++) {
        const line: Position[] = [];
        for (let i = starts[p]; i < starts[p + 1]; i++) {
          const c: Position = [view.getFloat64(pointsAt + i * 16, true), view.getFloat64(pointsAt + i * 16 + 8, true)];
          if (hasZ && zAt + i * 8 + 8 <= end) c.push(view.getFloat64(zAt + i * 8, true));
          line.push(c);
        }
        lines.push(line);
      }
      const geometry: Geometry = lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines };
      return { geometry, type };
    }
    default:
      return { geometry: null, type };
  }
}

export function parseShp(buffer: ArrayBuffer): { geometries: (Geometry | null)[]; skippedTypes: Map<string, number> } {
  const view = new DataView(buffer);
  if (buffer.byteLength < 100 || view.getInt32(0, false) !== 9994) throw new Error('.shp 파일 형식이 아닙니다.');
  const fileLength = Math.min(buffer.byteLength, view.getInt32(24, false) * 2);
  const geometries: (Geometry | null)[] = [];
  const skippedTypes = new Map<string, number>();
  let offset = 100;
  while (offset + 8 <= fileLength) {
    const contentLength = view.getInt32(offset + 4, false) * 2;
    const contentAt = offset + 8;
    if (contentAt + contentLength > buffer.byteLength) break;
    const { geometry, type } = readGeometry(view, contentAt, contentLength);
    if (!geometry && type !== 0) {
      const name = SHAPE_NAMES[type] ?? `유형 ${type}`;
      skippedTypes.set(name, (skippedTypes.get(name) ?? 0) + 1);
    }
    geometries.push(geometry);
    offset = contentAt + contentLength;
  }
  return { geometries, skippedTypes };
}

/* ------------------------------------------------------------------ .dbf */

function encodingFromCpg(cpg: string | undefined): string | null {
  if (!cpg) return null;
  const label = cpg.trim().toUpperCase();
  if (/UTF-?8/.test(label)) return 'utf-8';
  if (/949|EUC-?KR|KS_C_5601|KOREAN/.test(label)) return 'euc-kr';
  if (/1252|LATIN1|8859-1/.test(label)) return 'windows-1252';
  return null;
}

/** .cpg 가 없으면 레코드 영역이 UTF-8 로 올바른지 보고, 아니면 EUC-KR 로 읽는다. */
function pickEncoding(bytes: Uint8Array, cpg: string | undefined): string {
  const declared = encodingFromCpg(cpg);
  if (declared) return declared;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    return 'euc-kr';
  }
}

export function parseDbf(buffer: ArrayBuffer, cpg?: string): { records: Record<string, string | number | boolean | null>[]; encoding: string } {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const recordCount = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const encoding = pickEncoding(bytes.subarray(32, Math.min(bytes.length, headerLength + recordCount * recordLength)), cpg);
  const decoder = new TextDecoder(encoding);

  const fields: { name: string; type: string; length: number }[] = [];
  for (let at = 32; at + 32 <= headerLength && bytes[at] !== 0x0d; at += 32) {
    let nameEnd = at;
    while (nameEnd < at + 11 && bytes[nameEnd] !== 0) nameEnd++;
    fields.push({
      name: decoder.decode(bytes.subarray(at, nameEnd)).trim(),
      type: String.fromCharCode(bytes[at + 11]),
      length: bytes[at + 16],
    });
  }

  const records: Record<string, string | number | boolean | null>[] = [];
  for (let r = 0; r < recordCount; r++) {
    const start = headerLength + r * recordLength;
    if (start + recordLength > bytes.length) break;
    const record: Record<string, string | number | boolean | null> = {};
    let at = start + 1; // 삭제 표시 바이트
    for (const field of fields) {
      const raw = decoder.decode(bytes.subarray(at, at + field.length)).trim();
      at += field.length;
      if (field.type === 'N' || field.type === 'F') {
        const value = raw === '' ? NaN : Number(raw);
        record[field.name] = Number.isFinite(value) ? value : null;
      } else if (field.type === 'L') {
        record[field.name] = /^[YyTt]$/.test(raw) ? true : /^[NnFf]$/.test(raw) ? false : null;
      } else {
        record[field.name] = raw === '' ? null : raw;
      }
    }
    records.push(record);
  }
  return { records, encoding };
}

/* ------------------------------------------------------------------ .prj */

function wktParameter(wkt: string, name: string): number | null {
  const match = new RegExp(`PARAMETER\\[\\s*"${name}"\\s*,\\s*(-?[\\d.eE+-]+)`, 'i').exec(wkt);
  return match ? Number(match[1]) : null;
}

const near = (a: number | null, b: number, tolerance = 1e-6) => a !== null && Math.abs(a - b) <= tolerance;

/** .prj(WKT) 에서 좌표계를 알아낸다. 국내 TM/UTM-K 와 경위도만 판별한다. */
export function prjToCrs(wkt: string): string | null {
  const text = wkt.trim();
  if (!text) return null;
  const authority = /AUTHORITY\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]\s*\]\s*$/i.exec(text);
  if (authority) {
    const code = Number(authority[1]);
    if (code === 4326 || code === 4737) return 'wgs84';
    if ([5174, 5179, 5185, 5186, 5187, 5188].includes(code)) return `EPSG:${code}`;
  }
  if (!/^PROJCS/i.test(text)) return /^GEOGCS/i.test(text) ? 'wgs84' : null;
  if (!/Transverse_Mercator/i.test(text)) return null;
  const bessel = /Bessel/i.test(text);
  const cm = wktParameter(text, 'central_meridian');
  const fe = wktParameter(text, 'false_easting');
  const fn = wktParameter(text, 'false_northing');
  const k = wktParameter(text, 'scale_factor');
  if (!bessel && near(cm, 127.5) && near(k, 0.9996) && near(fe, 1000000, 1) && near(fn, 2000000, 1)) return 'EPSG:5179';
  if (!bessel && near(fe, 200000, 1) && near(fn, 600000, 1)) {
    if (near(cm, 125)) return 'EPSG:5185';
    if (near(cm, 127)) return 'EPSG:5186';
    if (near(cm, 129)) return 'EPSG:5187';
    if (near(cm, 131)) return 'EPSG:5188';
  }
  if (bessel && near(cm, 127.0028902777778, 1e-4) && near(fe, 200000, 1) && near(fn, 500000, 1)) return 'EPSG:5174';
  return null;
}

/* ------------------------------------------------------------------ 결합 */

export function readShapefile(parts: ShapefileParts, layerName = ''): ShapefileResult {
  const warnings: string[] = [];
  const { geometries, skippedTypes } = parseShp(parts.shp);
  let records: Record<string, string | number | boolean | null>[] = [];
  if (parts.dbf) {
    const dbf = parseDbf(parts.dbf, parts.cpg);
    records = dbf.records;
    if (dbf.records.length !== geometries.length) {
      warnings.push(`${layerName || '레이어'}: 도형(${geometries.length})과 속성(${dbf.records.length}) 개수가 다릅니다.`);
    }
  } else {
    warnings.push(`${layerName || '레이어'}: .dbf 가 없어 속성(관경·표고 등)을 읽지 못했습니다.`);
  }
  for (const [name, count] of skippedTypes) {
    warnings.push(`${layerName || '레이어'}: ${name} 도형 ${count}개는 관망 요소가 아니어서 건너뛰었습니다.`);
  }

  const features: Feature[] = [];
  geometries.forEach((geometry, index) => {
    if (!geometry) return;
    features.push({ type: 'Feature', geometry, properties: { ...(records[index] ?? {}), ...(layerName ? { __layer: layerName } : {}) } });
  });

  let crs: string | null = null;
  if (parts.prj !== undefined) {
    crs = prjToCrs(parts.prj);
    if (!crs) warnings.push(`${layerName || '레이어'}: .prj 좌표계를 판별하지 못해 좌표 범위로 추정합니다.`);
  }
  return { collection: { type: 'FeatureCollection', features }, crs, warnings };
}
