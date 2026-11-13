/**
 * 성과품 내보내기: Shapefile(.zip: 절점·관로 레이어, .shp/.shx/.dbf/.prj/.cpg) 과 DXF(R12, CAD 용).
 * 좌표계: WGS84 경위도 또는 EPSG:5186(중부원점) 등 평면좌표. 해석 결과가 있으면 지금 시각의 수압·유량·유속을 속성에 넣는다.
 */
import { CRS_DEFS, wgs84ToEpsg } from '../../utils/geoMath';
import type { SimulationResults } from '../engine/simulationManager';
import { linkPath } from '../model/networkEdit';
import type { LngLat, NetworkModel } from '../model/types';

/* ------------------------------------------------------------------ zip (무압축 STORE) */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 이름
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/* ------------------------------------------------------------------ Shapefile */

type XY = [number, number];
export interface ShpField {
  name: string;
  type: 'C' | 'N';
  size: number;
  dec?: number;
}
export interface ShpFeature {
  geometry: XY | XY[];
  attrs: Record<string, string | number | null>;
}

function writeShp(kind: 'point' | 'polyline', features: ShpFeature[]): { shp: Uint8Array; shx: Uint8Array } {
  const shapeType = kind === 'point' ? 1 : 3;
  const contents = features.map((f) => (kind === 'point' ? 20 : 44 + 4 + 16 * (f.geometry as XY[]).length));
  const shpLen = 100 + contents.reduce((s, c) => s + 8 + c, 0);
  const shp = new DataView(new ArrayBuffer(shpLen));
  const shx = new DataView(new ArrayBuffer(100 + 8 * features.length));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of features) {
    for (const [x, y] of kind === 'point' ? [f.geometry as XY] : (f.geometry as XY[])) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (features.length === 0) minX = minY = maxX = maxY = 0;
  for (const [view, len] of [[shp, shpLen], [shx, 100 + 8 * features.length]] as const) {
    view.setInt32(0, 9994, false);
    view.setInt32(24, len / 2, false);
    view.setInt32(28, 1000, true);
    view.setInt32(32, shapeType, true);
    view.setFloat64(36, minX, true);
    view.setFloat64(44, minY, true);
    view.setFloat64(52, maxX, true);
    view.setFloat64(60, maxY, true);
  }
  let p = 100;
  features.forEach((f, i) => {
    shx.setInt32(100 + 8 * i, p / 2, false);
    shx.setInt32(104 + 8 * i, contents[i] / 2, false);
    shp.setInt32(p, i + 1, false);
    shp.setInt32(p + 4, contents[i] / 2, false);
    p += 8;
    shp.setInt32(p, shapeType, true);
    if (kind === 'point') {
      const [x, y] = f.geometry as XY;
      shp.setFloat64(p + 4, x, true);
      shp.setFloat64(p + 12, y, true);
      p += 20;
    } else {
      const pts = f.geometry as XY[];
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      shp.setFloat64(p + 4, Math.min(...xs), true);
      shp.setFloat64(p + 12, Math.min(...ys), true);
      shp.setFloat64(p + 20, Math.max(...xs), true);
      shp.setFloat64(p + 28, Math.max(...ys), true);
      shp.setInt32(p + 36, 1, true);
      shp.setInt32(p + 40, pts.length, true);
      shp.setInt32(p + 44, 0, true);
      let q = p + 48;
      for (const [x, y] of pts) {
        shp.setFloat64(q, x, true);
        shp.setFloat64(q + 8, y, true);
        q += 16;
      }
      p = q;
    }
  });
  return { shp: new Uint8Array(shp.buffer), shx: new Uint8Array(shx.buffer) };
}

function writeDbf(fields: ShpField[], features: ShpFeature[]): Uint8Array {
  const enc = new TextEncoder();
  const recLen = 1 + fields.reduce((s, f) => s + f.size, 0);
  const headLen = 32 + 32 * fields.length + 1;
  const out = new Uint8Array(headLen + recLen * features.length + 1);
  const dv = new DataView(out.buffer);
  const now = new Date();
  out[0] = 0x03;
  out[1] = now.getFullYear() - 1900;
  out[2] = now.getMonth() + 1;
  out[3] = now.getDate();
  dv.setUint32(4, features.length, true);
  dv.setUint16(8, headLen, true);
  dv.setUint16(10, recLen, true);
  fields.forEach((f, i) => {
    const o = 32 + 32 * i;
    out.set(enc.encode(f.name.slice(0, 10)), o);
    out[o + 11] = f.type.charCodeAt(0);
    out[o + 16] = f.size;
    out[o + 17] = f.dec ?? 0;
  });
  out[headLen - 1] = 0x0d;
  features.forEach((feat, r) => {
    let o = headLen + r * recLen;
    out[o++] = 0x20;
    for (const f of fields) {
      const v = feat.attrs[f.name];
      let s: string;
      if (f.type === 'N') s = v === null || v === undefined || !Number.isFinite(Number(v)) ? '' : Number(v).toFixed(f.dec ?? 0);
      else s = v === null || v === undefined ? '' : String(v);
      let bytes = enc.encode(s);
      if (bytes.length > f.size) bytes = bytes.slice(0, f.size);
      const cell = new Uint8Array(f.size).fill(0x20);
      if (f.type === 'N') cell.set(bytes, f.size - bytes.length);
      else cell.set(bytes, 0);
      out.set(cell, o);
      o += f.size;
    }
  });
  out[out.length - 1] = 0x1a;
  return out;
}

const WKT: Record<string, string> = {
  wgs84: 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
  'EPSG:5186':
    'PROJCS["Korea_2000_Korea_Central_Belt_2010",GEOGCS["GCS_Korea_2000",DATUM["D_Korea_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",200000.0],PARAMETER["False_Northing",600000.0],PARAMETER["Central_Meridian",127.0],PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",38.0],UNIT["Meter",1.0]]',
};

export type ExportCrs = 'wgs84' | 'EPSG:5186';

function projector(crs: ExportCrs): (p: LngLat) => XY {
  return crs === 'wgs84' ? (p) => [p[0], p[1]] : (p) => wgs84ToEpsg(crs, p);
}

export function shapefileLayer(name: string, kind: 'point' | 'polyline', fields: ShpField[], features: ShpFeature[], crs: ExportCrs) {
  const { shp, shx } = writeShp(kind, features);
  const enc = new TextEncoder();
  return [
    { name: `${name}.shp`, data: shp },
    { name: `${name}.shx`, data: shx },
    { name: `${name}.dbf`, data: writeDbf(fields, features) },
    { name: `${name}.prj`, data: enc.encode(WKT[crs]) },
    { name: `${name}.cpg`, data: enc.encode('UTF-8') },
  ];
}

const resultAt = (r: SimulationResults | null, kind: 'node' | 'link', variable: string, step: number, id: string): number | null => {
  if (!r) return null;
  const index = kind === 'node' ? r.nodeIndex.get(id) : r.linkIndex.get(id);
  if (index === undefined) return null;
  const count = kind === 'node' ? r.nodeIds.length : r.linkIds.length;
  const arr = (kind === 'node' ? r.node : r.link) as Record<string, Float32Array>;
  return arr[variable]?.[step * count + index] ?? null;
};

/** 관망 → Shapefile zip (nodes, links 두 레이어). */
export function networkShapefileZip(model: NetworkModel, results: SimulationResults | null, step: number, crs: ExportCrs): Uint8Array {
  const P = projector(crs);
  const dec = crs === 'wgs84' ? 8 : 3;
  const nodeFields: ShpField[] = [
    { name: 'ID', type: 'C', size: 32 },
    { name: 'TYPE', type: 'C', size: 10 },
    { name: 'ELEV', type: 'N', size: 14, dec: 3 },
    { name: 'DEMAND', type: 'N', size: 16, dec: 5 },
    { name: 'X', type: 'N', size: 19, dec },
    { name: 'Y', type: 'N', size: 19, dec },
    ...(results ? ([{ name: 'PRESSURE', type: 'N', size: 14, dec: 3 }, { name: 'HEAD', type: 'N', size: 14, dec: 3 }] as ShpField[]) : []),
  ];
  const nodes: ShpFeature[] = Object.values(model.nodes).map((n) => {
    const xy = P(n.position);
    return {
      geometry: xy,
      attrs: {
        ID: n.id,
        TYPE: n.type.toUpperCase(),
        ELEV: n.elevation,
        DEMAND: n.type === 'junction' ? n.demand : null,
        X: xy[0],
        Y: xy[1],
        PRESSURE: resultAt(results, 'node', 'pressure', step, n.id),
        HEAD: resultAt(results, 'node', 'head', step, n.id),
      },
    };
  });
  const linkFields: ShpField[] = [
    { name: 'ID', type: 'C', size: 32 },
    { name: 'TYPE', type: 'C', size: 6 },
    { name: 'FROM_NODE', type: 'C', size: 32 },
    { name: 'TO_NODE', type: 'C', size: 32 },
    { name: 'DIAMETER', type: 'N', size: 12, dec: 2 },
    { name: 'LENGTH', type: 'N', size: 14, dec: 3 },
    { name: 'ROUGHNESS', type: 'N', size: 12, dec: 4 },
    ...(results ? ([{ name: 'FLOW', type: 'N', size: 16, dec: 5 }, { name: 'VELOCITY', type: 'N', size: 12, dec: 4 }, { name: 'HEADLOSS', type: 'N', size: 14, dec: 5 }] as ShpField[]) : []),
  ];
  const links: ShpFeature[] = Object.values(model.links)
    .map((l) => ({ l, path: linkPath(model, l) }))
    .filter(({ path }) => path.length >= 2)
    .map(({ l, path }) => ({
      geometry: path.map(P),
      attrs: {
        ID: l.id,
        TYPE: l.type.toUpperCase(),
        FROM_NODE: l.startNodeId,
        TO_NODE: l.endNodeId,
        DIAMETER: l.type === 'pump' ? null : l.diameter,
        LENGTH: l.type === 'pipe' ? l.length : null,
        ROUGHNESS: l.type === 'pipe' ? l.roughness : null,
        FLOW: resultAt(results, 'link', 'flow', step, l.id),
        VELOCITY: resultAt(results, 'link', 'velocity', step, l.id),
        HEADLOSS: resultAt(results, 'link', 'unitHeadloss', step, l.id),
      },
    }));
  return zipStore([...shapefileLayer('nodes', 'point', nodeFields, nodes, crs), ...shapefileLayer('links', 'polyline', linkFields, links, crs)]);
}

/* ------------------------------------------------------------------ DXF (R12 ASCII) */

/** 관망 → DXF. 레이어: 관로·펌프·밸브·절점·수원지·배수지·ID 문자. 절점은 원, 관로는 폴리라인, 관로 옆에 ID·관경 문자. */
export function networkDxf(model: NetworkModel, crs: Exclude<ExportCrs, 'wgs84'> = 'EPSG:5186', textHeight = 1.5): string {
  if (!(crs in CRS_DEFS)) throw new Error(`지원하지 않는 좌표계: ${crs}`);
  const P = projector(crs);
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), typeof value === 'number' ? value.toFixed(4) : value);
  const LAYERS: [string, number][] = [
    ['WN_PIPE', 5], ['WN_PUMP', 6], ['WN_VALVE', 3], ['WN_JUNCTION', 4], ['WN_RESERVOIR', 1], ['WN_TANK', 2], ['WN_LABEL', 7],
  ];
  g(0, 'SECTION');
  g(2, 'TABLES');
  g(0, 'TABLE');
  g(2, 'LAYER');
  out.push('70', String(LAYERS.length));
  for (const [name, color] of LAYERS) {
    g(0, 'LAYER');
    g(2, name);
    out.push('70', '0', '62', String(color));
    g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'ENTITIES');
  const text = (layer: string, [x, y]: XY, s: string, angle = 0) => {
    g(0, 'TEXT');
    g(8, layer);
    g(10, x);
    g(20, y);
    g(30, 0);
    g(40, textHeight);
    g(1, s);
    if (angle) g(50, angle);
  };
  for (const l of Object.values(model.links)) {
    const path = linkPath(model, l).map(P);
    if (path.length < 2) continue;
    const layer = l.type === 'pipe' ? 'WN_PIPE' : l.type === 'pump' ? 'WN_PUMP' : 'WN_VALVE';
    g(0, 'POLYLINE');
    g(8, layer);
    out.push('66', '1');
    g(10, 0);
    g(20, 0);
    g(30, 0);
    for (const [x, y] of path) {
      g(0, 'VERTEX');
      g(8, layer);
      g(10, x);
      g(20, y);
      g(30, 0);
    }
    g(0, 'SEQEND');
    g(8, layer);
    // 가장 긴 구간 가운데에 ID·관경
    let k = 0;
    let best = -1;
    for (let i = 0; i + 1 < path.length; i++) {
      const d = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
      if (d > best) [best, k] = [d, i];
    }
    const [a, b] = [path[k], path[k + 1]];
    let angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;
    const label = l.type === 'pipe' ? `${l.id} D${l.diameter} L${l.length}` : l.id;
    text('WN_LABEL', [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + textHeight * 0.3], label, angle);
  }
  for (const n of Object.values(model.nodes)) {
    const xy = P(n.position);
    const layer = n.type === 'junction' ? 'WN_JUNCTION' : n.type === 'reservoir' ? 'WN_RESERVOIR' : 'WN_TANK';
    g(0, 'CIRCLE');
    g(8, layer);
    g(10, xy[0]);
    g(20, xy[1]);
    g(30, 0);
    g(40, n.type === 'junction' ? textHeight * 0.4 : textHeight);
    text('WN_LABEL', [xy[0] + textHeight * 0.6, xy[1] + textHeight * 0.6], n.id);
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}
