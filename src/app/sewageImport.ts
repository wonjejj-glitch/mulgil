/**
 * 수용가 CSV · 건물 SHP · 하수연결관 SHP 읽기 → 하수 프로젝트 좌표(EPSG:5186)의 오수 유입원·연결관.
 * 배분 계산은 core/sewer/sewage.ts, 화면은 components/modals/SewageModal.tsx.
 */
import type { Feature, Position } from 'geojson';
import { guessMapping, parseCsv } from '../core/io/customerCsv';
import { loadShapefiles } from '../core/io/loadShapefiles';
import { SEWER_CRS } from '../core/sewer/mapFrame';
import type { SewageSource, XY } from '../core/sewer/sewage';
import { detectCrs, toWgs84, wgs84ToEpsg } from '../utils/geoMath';

export interface SewageInput {
  /** 수용가(CSV) · 건물(SHP 점·면) */
  sources: SewageSource[];
  /** 하수연결관 (선) */
  connections: XY[][];
  /** 우수 연결관이라 뺀 수 */
  stormConnections: number;
  labels: string[];
  warnings: string[];
}

const HOUSEHOLD = /^(세대수|세대|가구수|가구|호수|hhld_?cnt|hhldcnt|households?|fmly_?cnt|ho_?cnt)$/i;
const DEMAND = /^(사용량|월사용량|일사용량|급수량|demand|usage|사용수량)$/i;
const norm = (s: string) => s.replace(/[\s_()[\]·.-]/g, '');

function numberProp(props: Record<string, unknown>, re: RegExp): number | undefined {
  for (const key in props) {
    if (!re.test(norm(key)) && !re.test(key)) continue;
    const v = Number(String(props[key] ?? '').replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

/** 좌표 변환기: 원본 좌표계 → EPSG:5186. crs 가 'auto' 면 좌표 범위로 추정(TM 원점은 preferTm). */
function converter(crs: string, sample: XY[], preferTm: string | null): (c: Position) => XY {
  let code = crs;
  if (code === 'auto') {
    const d = detectCrs(sample);
    if (d === 'local') throw new Error('좌표계를 알 수 없습니다. 대화상자에서 좌표계를 고르세요.');
    code = d === 'EPSG:5186' && preferTm ? preferTm : d;
  }
  return (c) => {
    const xy: XY = [c[0], c[1]];
    if (code === SEWER_CRS) return xy;
    const p = wgs84ToEpsg(SEWER_CRS, code === 'wgs84' ? xy : toWgs84({ kind: 'epsg', code }, xy));
    return [p[0], p[1]];
  };
}

const centroid = (ring: Position[]): Position => {
  let x = 0, y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
};

/**
 * crs: 'auto' | 'EPSG:xxxx' | 'wgs84' — CSV 와 .prj 없는 SHP 에 쓴다. preferTm: 좌표 범위가 TM 일 때 쓸 원점(예: 하수 GIS 의 EPSG:5187).
 * stormCodes: 이 용도 코드(예: SBA003 우수)의 연결관은 오수 배분에서 뺀다.
 */
export async function readSewageFiles(files: File[], crs: string, preferTm: string | null, stormCodes: string[] = ['SBA003']): Promise<SewageInput> {
  const out: SewageInput = { sources: [], connections: [], stormConnections: 0, labels: [], warnings: [] };
  // 1) 수용가 CSV·TXT
  for (const f of files.filter((f) => /\.(csv|txt|tsv)$/i.test(f.name))) {
    const table = parseCsv(new Uint8Array(await f.arrayBuffer()));
    const map = guessMapping(table.headers);
    if (map.x < 0 || map.y < 0) {
      out.warnings.push(`${f.name}: X·Y(경도·위도) 열을 찾지 못해 건너뛰었습니다. 머리글에 X, Y 또는 경도, 위도를 쓰세요.`);
      continue;
    }
    const hhCol = table.headers.findIndex((h) => HOUSEHOLD.test(norm(h)));
    const factor = map.demandUnit === 'm3/month' ? 1 / 30.4 : map.demandUnit === 'L/s' ? 86.4 : 1;
    const num = (v: string | undefined) => (v === undefined || v.trim() === '' ? NaN : Number(v.replace(/,/g, '')));
    const rows: { id: string; xy: XY; demand?: number; households?: number }[] = [];
    let skipped = 0;
    table.rows.forEach((row, i) => {
      const x = num(row[map.x]), y = num(row[map.y]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) {
        skipped++;
        return;
      }
      const d = map.demand >= 0 ? num(row[map.demand]) : NaN;
      const hh = hhCol >= 0 ? num(row[hhCol]) : NaN;
      rows.push({
        id: (map.id >= 0 ? row[map.id] : '') || `C${i + 1}`,
        xy: [x, y],
        demand: Number.isFinite(d) && d >= 0 ? d * factor : undefined,
        households: Number.isFinite(hh) && hh > 0 ? hh : undefined,
      });
    });
    const records = rows;
    const toXy = converter(crs, rows.slice(0, 200).map((r) => r.xy), preferTm);
    for (const r of rows) out.sources.push({ ...r, xy: toXy(r.xy) });
    out.labels.push(`${f.name} — 수용가 ${records.length.toLocaleString()}곳${map.demand >= 0 ? ` (사용량 열: ${table.headers[map.demand]})` : ''}${hhCol >= 0 ? ` (세대수 열: ${table.headers[hhCol]})` : ''}`);
    if (skipped > 0) out.warnings.push(`${f.name}: 좌표를 읽지 못한 ${skipped}줄을 건너뛰었습니다.`);
  }

  // 2) SHP: 선 = 연결관, 점·면 = 건물·수용가
  const shp = files.filter((f) => /\.(shp|dbf|prj|cpg|shx|zip)$/i.test(f.name));
  if (shp.some((f) => /\.(shp|zip)$/i.test(f.name))) {
    const set = await loadShapefiles(await Promise.all(shp.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))), { polygons: true });
    out.warnings.push(...set.warnings);
    const feats = set.collection.features;
    const sample: XY[] = [];
    for (const f of feats.slice(0, 300)) {
      const g = f.geometry;
      if (g?.type === 'Point') sample.push(g.coordinates as XY);
      else if (g?.type === 'LineString') sample.push(g.coordinates[0] as XY);
      else if (g?.type === 'Polygon') sample.push(g.coordinates[0][0] as XY);
    }
    const toXy = converter(set.crs ?? crs, sample, preferTm);
    let buildings = 0, lines = 0;
    feats.forEach((f: Feature, i) => {
      const g = f.geometry;
      const p = (f.properties ?? {}) as Record<string, unknown>;
      if (!g) return;
      if (g.type === 'LineString' || g.type === 'MultiLineString') {
        const usage = String(p.SBA_CDE ?? p.sba_cde ?? '');
        if (stormCodes.includes(usage)) {
          out.stormConnections++;
          return;
        }
        for (const line of g.type === 'LineString' ? [g.coordinates] : g.coordinates) {
          out.connections.push(line.map(toXy));
          lines++;
        }
        return;
      }
      const pt = g.type === 'Point' ? g.coordinates : g.type === 'Polygon' ? centroid(g.coordinates[0]) : g.type === 'MultiPoint' ? g.coordinates[0] : null;
      if (!pt) return;
      out.sources.push({ id: String(p.FTR_IDN ?? p.ID ?? p.id ?? `B${i + 1}`), xy: toXy(pt), households: numberProp(p, HOUSEHOLD), demand: numberProp(p, DEMAND) });
      buildings++;
    });
    out.labels.push(`Shapefile ${set.layers.join(', ')} — 건물·수용가 ${buildings.toLocaleString()}곳, 연결관 ${lines.toLocaleString()}개${out.stormConnections ? ` (우수 연결관 ${out.stormConnections.toLocaleString()}개 뺌)` : ''}`);
  }
  if (out.sources.length === 0 && out.connections.length === 0) throw new Error('수용가(CSV)·건물(SHP 점·면)·하수연결관(SHP 선) 중 읽은 것이 없습니다.');
  return out;
}
