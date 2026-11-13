import { describe, expect, it } from 'vitest';
import { loadShapefiles } from './loadShapefiles';
import { parseDbf, parseShp, prjToCrs, readShapefile } from './shapefile';
import { importGeoJson } from './shapefileImporter';
import { readZip } from './zip';

/* ------------------------------------------------------------------ 테스트용 파일 생성기 */

type XY = [number, number];

function writeShp(type: 1 | 3, shapes: XY[][]): ArrayBuffer {
  const contents = shapes.map((points) => {
    if (type === 1) {
      const buf = new DataView(new ArrayBuffer(20));
      buf.setInt32(0, 1, true);
      buf.setFloat64(4, points[0][0], true);
      buf.setFloat64(12, points[0][1], true);
      return buf.buffer;
    }
    const size = 44 + 4 + points.length * 16;
    const buf = new DataView(new ArrayBuffer(size));
    buf.setInt32(0, 3, true);
    buf.setInt32(36, 1, true); // parts
    buf.setInt32(40, points.length, true);
    buf.setInt32(44, 0, true);
    points.forEach(([x, y], i) => {
      buf.setFloat64(48 + i * 16, x, true);
      buf.setFloat64(56 + i * 16, y, true);
    });
    return buf.buffer;
  });
  const total = 100 + contents.reduce((sum, c) => sum + 8 + c.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setInt32(0, 9994, false);
  view.setInt32(24, total / 2, false);
  view.setInt32(28, 1000, true);
  view.setInt32(32, type, true);
  let at = 100;
  contents.forEach((content, i) => {
    view.setInt32(at, i + 1, false);
    view.setInt32(at + 4, content.byteLength / 2, false);
    out.set(new Uint8Array(content), at + 8);
    at += 8 + content.byteLength;
  });
  return out.buffer;
}

/** fields: [이름, 유형(C/N), 길이]. 이름·문자열은 encode 로 인코딩한다. */
function writeDbf(fields: [string, 'C' | 'N', number][], rows: (string | number)[][], encode: (s: string) => Uint8Array): ArrayBuffer {
  const headerLength = 32 + fields.length * 32 + 1;
  const recordLength = 1 + fields.reduce((sum, f) => sum + f[2], 0);
  const out = new Uint8Array(headerLength + rows.length * recordLength + 1);
  const view = new DataView(out.buffer);
  out[0] = 3;
  view.setUint32(4, rows.length, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  fields.forEach(([name, type, length], i) => {
    const at = 32 + i * 32;
    out.set(encode(name).subarray(0, 10), at);
    out[at + 11] = type.charCodeAt(0);
    out[at + 16] = length;
  });
  out[headerLength - 1] = 0x0d;
  rows.forEach((row, r) => {
    let at = headerLength + r * recordLength;
    out[at++] = 0x20;
    fields.forEach(([, type, length], i) => {
      const cell = new Uint8Array(length).fill(0x20);
      const bytes = encode(String(row[i]));
      if (type === 'N') cell.set(bytes.subarray(0, length), Math.max(0, length - bytes.length));
      else cell.set(bytes.subarray(0, length), 0);
      out.set(cell, at);
      at += length;
    });
  });
  out[out.length - 1] = 0x1a;
  return out.buffer;
}

/** 간이 CP949 인코더: 테스트에 쓰는 몇 글자만 표에 둔다. */
const CP949: Record<string, number[]> = { 관: [0xb0, 0xfc], 경: [0xb0, 0xe6], 상: [0xbb, 0xf3], 수: [0xbc, 0xf6], 도: [0xb5, 0xb5] };
function encodeCp949(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) bytes.push(...(CP949[ch] ?? [ch.charCodeAt(0)]));
  return new Uint8Array(bytes);
}
const utf8 = (s: string) => new TextEncoder().encode(s);

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 최소 ZIP 작성기 (첫 항목은 저장, 나머지는 deflate). CRC 는 읽기에서 검사하지 않으므로 0. */
async function writeZip(files: { name: string; data: ArrayBuffer }[]): Promise<ArrayBuffer> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < files.length; i++) {
    const name = utf8(files[i].name);
    const raw = new Uint8Array(files[i].data);
    const method = i === 0 ? 0 : 8;
    const body = method === 0 ? raw : await deflateRaw(raw);
    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out.buffer;
}

const PRJ_5186 =
  'PROJCS["Korea_2000_Korea_Central_Belt_2010",GEOGCS["GCS_Korea_2000",DATUM["D_Korea_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",200000.0],PARAMETER["False_Northing",600000.0],PARAMETER["Central_Meridian",127.0],PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",38.0],UNIT["Meter",1.0]]';
const PRJ_5179 =
  'PROJCS["Korea_2000_Korea_Unified_Coordinate_System",GEOGCS["GCS_Korea_2000",DATUM["D_Korea_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",1000000.0],PARAMETER["False_Northing",2000000.0],PARAMETER["Central_Meridian",127.5],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",38.0],UNIT["Meter",1.0]]';

/* ------------------------------------------------------------------ 테스트 */

describe('prjToCrs', () => {
  it('국내 TM·UTM-K·경위도 WKT 를 판별한다', () => {
    expect(prjToCrs(PRJ_5186)).toBe('EPSG:5186');
    expect(prjToCrs(PRJ_5179)).toBe('EPSG:5179');
    expect(prjToCrs('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]]]')).toBe('wgs84');
    expect(prjToCrs('PROJCS["Unknown",PROJECTION["Lambert_Conformal_Conic"]]')).toBeNull();
  });
});

describe('parseShp / parseDbf', () => {
  it('선과 점 도형을 읽는다', () => {
    const lines = parseShp(writeShp(3, [[[0, 0], [10, 0], [20, 5]]]));
    expect(lines.geometries[0]).toEqual({ type: 'LineString', coordinates: [[0, 0], [10, 0], [20, 5]] });
    const points = parseShp(writeShp(1, [[[3, 4]]]));
    expect(points.geometries[0]).toEqual({ type: 'Point', coordinates: [3, 4] });
  });

  it('.cpg 가 없어도 CP949 속성을 읽는다', () => {
    const dbf = writeDbf([['FTR_IDN', 'C', 10], ['관경', 'N', 6]], [['상수도1', 150]], encodeCp949);
    const { records, encoding } = parseDbf(dbf);
    expect(encoding).toBe('euc-kr');
    expect(records[0]).toEqual({ FTR_IDN: '상수도1', 관경: 150 });
  });

  it('.cpg 가 UTF-8 이면 UTF-8 로 읽는다', () => {
    const dbf = writeDbf([['NAME', 'C', 12]], [['관로A']], utf8);
    expect(parseDbf(dbf, 'UTF-8').records[0].NAME).toBe('관로A');
  });
});

describe('Shapefile → 관망', () => {
  // EPSG:5186 의 대전 부근 좌표 (약 100 m 간격)
  const pipeShp = writeShp(3, [
    [[234000, 417000], [234100, 417000]],
    [[234100, 417000], [234100, 417100]],
  ]);
  const pipeDbf = writeDbf([['FTR_IDN', 'C', 8], ['PIP_DIP', 'N', 6], ['PIP_LEN', 'N', 8]], [['W1', 200, 100.0], ['W2', 150, 100.0]], utf8);
  const nodeShp = writeShp(1, [[[234100, 417000]]]);
  const nodeDbf = writeDbf([['GL', 'N', 8]], [[42.5]], utf8);

  it('관로 선·절점 점 레이어를 합쳐 좌표계를 변환해 관망으로 만든다', async () => {
    const set = await loadShapefiles([
      { name: 'WTL_PIPE_LM.shp', data: pipeShp },
      { name: 'WTL_PIPE_LM.dbf', data: pipeDbf },
      { name: 'WTL_PIPE_LM.prj', data: utf8(PRJ_5186).buffer as ArrayBuffer },
      { name: 'nodes.shp', data: nodeShp },
      { name: 'nodes.dbf', data: nodeDbf },
    ]);
    expect(set.crs).toBe('EPSG:5186');
    expect(set.layers).toEqual(['WTL_PIPE_LM (2)', 'nodes (1)']);
    const { model, crsLabel } = importGeoJson(set.collection, { declaredCrs: set.crs, sourceLabel: 'Shapefile' });
    expect(crsLabel).toContain('5186');
    expect(Object.keys(model.links).sort()).toEqual(['W1', 'W2']);
    const w1 = model.links.W1;
    expect(w1.type === 'pipe' && w1.diameter).toBe(200);
    expect(w1.type === 'pipe' && w1.length).toBeCloseTo(100, 1);
    expect(Object.keys(model.nodes)).toHaveLength(3); // 공유 끝점 1개 + 양 끝 2개
    const shared = Object.values(model.nodes).find((n) => n.elevation === 42.5);
    expect(shared).toBeDefined();
    expect(shared!.position[0]).toBeGreaterThan(127.3);
    expect(shared!.position[1]).toBeGreaterThan(36.3);
  });

  it('ZIP(저장·deflate 혼합) 안의 Shapefile 을 읽는다', async () => {
    const zip = await writeZip([
      { name: 'pipes/WTL_PIPE_LM.prj', data: utf8(PRJ_5186).buffer as ArrayBuffer },
      { name: 'pipes/WTL_PIPE_LM.shp', data: pipeShp },
      { name: 'pipes/WTL_PIPE_LM.dbf', data: pipeDbf },
    ]);
    const entries = await readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['pipes/WTL_PIPE_LM.prj', 'pipes/WTL_PIPE_LM.shp', 'pipes/WTL_PIPE_LM.dbf']);
    expect(entries[1].data.byteLength).toBe(pipeShp.byteLength);
    const set = await loadShapefiles([{ name: 'network.zip', data: zip }]);
    expect(set.crs).toBe('EPSG:5186');
    expect(set.collection.features).toHaveLength(2);
  });

  it('.dbf 가 없으면 경고하고 도형만 읽는다', () => {
    const result = readShapefile({ shp: pipeShp }, 'pipes');
    expect(result.collection.features).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('.dbf'))).toBe(true);
  });
});
