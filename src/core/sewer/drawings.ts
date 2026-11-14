/**
 * 하수 성과품: 종단면도·평면도 DXF(R12)와 수량 산출.
 *
 * - 종단면도: 가로 1:1(m), 세로 과장(기본 10배). 지반고선·관정·관저선·맨홀 세로선·최대 수두(해석했으면)와
 *   아래 기입란(측점, 추가거리, 지반고, 관저고, 토피, 관경, 경사, 연장). 오른쪽에 관경별 터파기 표준 횡단면.
 * - 평면도: EPSG:5186 좌표로 맨홀·방류구·관거·유역 경계, 관거 옆에 'D300 L=45.2 i=5.0‰'.
 * - 수량: 관경별 연장, 맨홀 규격·깊이 구간별 개수, 개략 토공(굴착·되메우기·잔토)·포장 면적.
 *
 * 터파기 폭·여유·맨홀 규격은 일반적인 예시값이다. 사업 표준도·내역 기준으로 바꿔 쓴다.
 * 한글 문자는 \U+XXXX 로 적어 CAD 의 코드 페이지와 관계없이 읽히게 한다.
 */
import type { DesignResult } from './design';
import { buildNetwork } from './topology';
import type { SewerConduit, SewerProject } from './types';

/* ------------------------------------------------------------------ DXF 작성기 */

type XY = [number, number];

function dxfText(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c < 128 ? ch : `\\U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

class Dxf {
  private out: string[] = [];
  constructor(private layers: [string, number][]) {}
  private g(code: number, value: string | number) {
    this.out.push(String(code), typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(4) : '0') : value);
  }
  line(layer: string, a: XY, b: XY) {
    this.g(0, 'LINE');
    this.g(8, layer);
    this.g(10, a[0]);
    this.g(20, a[1]);
    this.g(30, 0);
    this.g(11, b[0]);
    this.g(21, b[1]);
    this.g(31, 0);
  }
  poly(layer: string, pts: XY[], closed = false) {
    if (pts.length < 2) return;
    this.g(0, 'POLYLINE');
    this.g(8, layer);
    this.out.push('66', '1', '70', closed ? '1' : '0');
    this.g(10, 0);
    this.g(20, 0);
    this.g(30, 0);
    for (const [x, y] of pts) {
      this.g(0, 'VERTEX');
      this.g(8, layer);
      this.g(10, x);
      this.g(20, y);
      this.g(30, 0);
    }
    this.g(0, 'SEQEND');
    this.g(8, layer);
  }
  circle(layer: string, c: XY, r: number) {
    this.g(0, 'CIRCLE');
    this.g(8, layer);
    this.g(10, c[0]);
    this.g(20, c[1]);
    this.g(30, 0);
    this.g(40, r);
  }
  /** align: 0 왼쪽, 1 가운데, 2 오른쪽 (가로 맞춤, 세로는 기준선) */
  text(layer: string, at: XY, height: number, s: string, angle = 0, align: 0 | 1 | 2 = 0) {
    this.g(0, 'TEXT');
    this.g(8, layer);
    this.g(10, at[0]);
    this.g(20, at[1]);
    this.g(30, 0);
    this.g(40, height);
    this.g(1, dxfText(s));
    if (angle) this.g(50, angle);
    if (align) {
      this.out.push('72', String(align));
      this.g(11, at[0]);
      this.g(21, at[1]);
      this.g(31, 0);
    }
  }
  toString(): string {
    const head: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC', '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(this.layers.length)];
    for (const [name, color] of this.layers) head.push('0', 'LAYER', '2', name, '70', '0', '62', String(color), '6', 'CONTINUOUS');
    head.push('0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES');
    return [...head, ...this.out, '0', 'ENDSEC', '0', 'EOF'].join('\r\n') + '\r\n';
  }
}

/* ------------------------------------------------------------------ 종단 경로 */

export interface ProfileStation {
  id: string;
  distance: number;
  ground: number;
  /** 맨홀 관저고 (맨홀 바닥) */
  invert: number;
  /** 이 맨홀에서 하류로 나가는 관 (마지막 절점은 없음) */
  next?: { conduit: SewerConduit; upIl: number; downIl: number; slope: number };
  hgl?: number | null;
}

/** 시작 절점(없으면 가장 먼 상류)에서 방류구까지 하류로 따라간 측점 목록. */
export function profileStations(project: SewerProject, startId?: string, hgl?: Record<string, number | null>): ProfileStation[] {
  const graph = buildNetwork(project);
  const depth = new Map<string, number>();
  for (const id of [...graph.order].reverse()) {
    const outs = graph.out.get(id)!;
    depth.set(id, outs.length === 0 ? 0 : Math.max(...outs.map((e) => (depth.get(e.to) ?? 0) + e.conduit.length)));
  }
  const start = startId && graph.nodes.has(startId) ? startId : [...graph.nodes.keys()].sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0))[0];
  const out: ProfileStation[] = [];
  let id: string | undefined = start;
  let distance = 0;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const n = graph.nodes.get(id)!;
    const e: { to: string; conduit: SewerConduit } | undefined = graph.out.get(id)![0];
    const st: ProfileStation = { id, distance, ground: n.ground, invert: n.invert, hgl: hgl?.[id] ?? null };
    if (e) {
      const v = graph.nodes.get(e.to)!;
      const upIl = n.invert + e.conduit.inlet_offset;
      const downIl = v.invert + e.conduit.outlet_offset;
      st.next = { conduit: e.conduit, upIl, downIl, slope: (upIl - downIl) / e.conduit.length };
    }
    out.push(st);
    if (!e) break;
    distance += e.conduit.length;
    id = e.to;
  }
  return out;
}

/* ------------------------------------------------------------------ 종단면도 DXF */

export interface ProfileDxfOptions {
  /** 세로 과장 배율 (기본 10) */
  vScale?: number;
  /** 문자 높이 (도면 단위 m, 기본 2.5) */
  textHeight?: number;
  title?: string;
}

const fx = (v: number, d = 2) => v.toFixed(d);

/** 관경별 터파기 표준 폭 (m): 관 외경 근사(D×1.2) + 양쪽 여유 0.3 m, 최소 0.8 m. */
export function trenchWidth(d: number): number {
  return Math.max(0.8, Math.round((d * 1.2 + 0.6) * 100) / 100);
}
/** 기초(모래) 두께 (m) — 관 아래 */
export const BEDDING = 0.1;

export function profileDxf(project: SewerProject, stations: ProfileStation[], options: ProfileDxfOptions = {}): string {
  const vs = options.vScale ?? 10;
  const th = options.textHeight ?? 2.5;
  const dxf = new Dxf([
    ['SW_GROUND', 32], ['SW_PIPE', 5], ['SW_MANHOLE', 7], ['SW_HGL', 30], ['SW_GRID', 8], ['SW_TABLE', 7], ['SW_TEXT', 7], ['SW_SECTION', 3],
  ]);
  if (stations.length < 2) return dxf.toString();
  const elevs = stations.flatMap((s) => [s.ground, s.invert, ...(s.hgl != null ? [s.hgl] : [])]);
  const datum = Math.floor(Math.min(...elevs) - 2);
  const top = Math.ceil(Math.max(...elevs) + 1);
  const Y = (z: number) => (z - datum) * vs;
  const L = stations[stations.length - 1].distance;

  // 표고 눈금 (1 m 간격, 5 m 마다 굵게 쓰지 않고 숫자만)
  for (let z = datum; z <= top; z += 1) {
    dxf.line('SW_GRID', [-5, Y(z)], [L, Y(z)]);
    if ((z - datum) % (vs >= 10 ? 1 : 5) === 0) dxf.text('SW_GRID', [-6, Y(z) - th / 2], th * 0.8, `${z.toFixed(0)}`, 0, 2);
  }
  dxf.text('SW_GRID', [-6, Y(top) + th * 1.5], th * 0.8, `EL.(m) 세로 1:${vs} 과장`, 0, 2);
  dxf.text('SW_TEXT', [L / 2, Y(top) + th * 4], th * 1.6, options.title ?? `${project.name} 종단면도 (${stations[0].id} → ${stations[stations.length - 1].id})`, 0, 1);

  // 지반고선
  dxf.poly('SW_GROUND', stations.map((s) => [s.distance, Y(s.ground)]));
  // 관 (관정·관저) — 관마다 따로 (부관·옵셋이 있으면 끊김이 보이도록)
  for (const s of stations) {
    if (!s.next) continue;
    const x1 = s.distance;
    const x2 = s.distance + s.next.conduit.length;
    const d = s.next.conduit.diameter;
    dxf.line('SW_PIPE', [x1, Y(s.next.upIl)], [x2, Y(s.next.downIl)]);
    dxf.line('SW_PIPE', [x1, Y(s.next.upIl + d)], [x2, Y(s.next.downIl + d)]);
  }
  // 맨홀 (세로선 두 줄, 폭 1.2 m 가정)
  for (const s of stations) {
    const w = 0.6;
    dxf.poly('SW_MANHOLE', [[s.distance - w, Y(s.ground)], [s.distance - w, Y(s.invert)], [s.distance + w, Y(s.invert)], [s.distance + w, Y(s.ground)]]);
    dxf.text('SW_TEXT', [s.distance, Y(s.ground) + th], th, s.id, 90);
  }
  // 최대 수두
  const hgl = stations.filter((s) => s.hgl != null).map((s) => [s.distance, Y(s.hgl as number)] as XY);
  if (hgl.length >= 2) dxf.poly('SW_HGL', hgl);

  // 기입란
  const rows: [string, (s: ProfileStation, i: number) => string | null, 'node' | 'pipe'][] = [
    ['측점', (s) => s.id, 'node'],
    ['추가거리 (m)', (s) => fx(s.distance), 'node'],
    ['지반고 (m)', (s) => fx(s.ground, 3), 'node'],
    ['관저고 (m)', (s) => fx(s.invert, 3), 'node'],
    ['토피 (m)', (s, i) => {
      const prev = stations[i - 1]?.next;
      const d = Math.max(s.next?.conduit.diameter ?? 0, prev?.conduit.diameter ?? 0);
      return fx(s.ground - s.invert - d);
    }, 'node'],
    ['관경 (mm)', (s) => (s.next ? `D${Math.round(s.next.conduit.diameter * 1000)}` : null), 'pipe'],
    ['경사 (‰)', (s) => (s.next ? fx(s.next.slope * 1000) : null), 'pipe'],
    ['연장 (m)', (s) => (s.next ? fx(s.next.conduit.length) : null), 'pipe'],
  ];
  // 측점 간격이 좁으면 절점 값을 세로로 쓰고 그 줄을 높인다 (글자가 겹치지 않게)
  const minGap = Math.min(...stations.slice(1).map((s, i) => s.distance - stations[i].distance));
  const vertical = minGap < th * 0.85 * 8;
  const nodeH = vertical ? th * 0.85 * 9 : th * 3;
  const heights = rows.map(([, , kind]) => (kind === 'node' ? nodeH : th * 3));
  const tops = heights.map((_, r) => -th * 2 - heights.slice(0, r).reduce((a, b) => a + b, 0));
  const tableTop = -th * 2;
  const bottom = tableTop - heights.reduce((a, b) => a + b, 0);
  const left = -40;
  dxf.line('SW_TABLE', [left, tableTop], [L, tableTop]);
  tops.forEach((t, r) => dxf.line('SW_TABLE', [left, t - heights[r]], [L, t - heights[r]]));
  dxf.line('SW_TABLE', [left, tableTop], [left, bottom]);
  dxf.line('SW_TABLE', [-5, tableTop], [-5, bottom]);
  dxf.line('SW_TABLE', [L, tableTop], [L, bottom]);
  rows.forEach(([label, value, kind], r) => {
    const rowH = heights[r];
    const top = tops[r];
    const y = top - rowH / 2 - th / 2;
    dxf.text('SW_TABLE', [left + 1, y], th, label);
    stations.forEach((s, i) => {
      const v = value(s, i);
      if (v === null) return;
      if (kind === 'node') {
        if (vertical) dxf.text('SW_TABLE', [s.distance + th * 0.4, top - rowH / 2], th * 0.85, v, 90, 1);
        else if (i === stations.length - 1) dxf.text('SW_TABLE', [s.distance - th * 0.4, y], th * 0.85, v, 0, 2);
        else dxf.text('SW_TABLE', [s.distance + th * 0.4, y], th * 0.85, v);
        dxf.line('SW_TABLE', [s.distance, top], [s.distance, top - rowH]);
      } else if (s.next) {
        dxf.text('SW_TABLE', [s.distance + s.next.conduit.length / 2, y], th * 0.85, v, 0, 1);
      }
    });
  });

  // 관경별 터파기 표준 횡단면 (가로·세로 같은 축척, 오른쪽에 나란히)
  const diameters = [...new Set(stations.filter((s) => s.next).map((s) => s.next!.conduit.diameter))].sort((a, b) => a - b);
  const depthFor = (d: number) => {
    const ds = stations.filter((s) => s.next && s.next.conduit.diameter === d).map((s) => ((s.ground - s.next!.upIl) + (stations.find((x) => x.distance === s.distance + s.next!.conduit.length)?.ground ?? s.ground) - s.next!.downIl) / 2);
    return ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : 2;
  };
  let sx = L + 30;
  const sScale = 10; // 횡단면은 10배 확대해 그린다
  dxf.text('SW_SECTION', [sx, Y(top) + th * 4], th * 1.4, '관경별 터파기 표준단면 (확대 ×10, 개략)');
  for (const d of diameters) {
    const B = trenchWidth(d);
    const H = depthFor(d) + BEDDING;
    const base: XY = [sx + (B * sScale) / 2, Y(datum) + th * 3];
    const w = (B * sScale) / 2;
    dxf.poly('SW_SECTION', [[base[0] - w, base[1] + H * sScale], [base[0] - w, base[1]], [base[0] + w, base[1]], [base[0] + w, base[1] + H * sScale]]);
    dxf.line('SW_SECTION', [base[0] - w - 5, base[1] + H * sScale], [base[0] + w + 5, base[1] + H * sScale]);
    dxf.line('SW_SECTION', [base[0] - w, base[1] + BEDDING * sScale], [base[0] + w, base[1] + BEDDING * sScale]);
    dxf.circle('SW_SECTION', [base[0], base[1] + (BEDDING + d / 2) * sScale], (d / 2) * sScale);
    dxf.text('SW_SECTION', [base[0], base[1] - th * 2], th, `D${Math.round(d * 1000)}  B=${fx(B)} m  H≈${fx(H)} m`, 0, 1);
    sx += Math.max(B * sScale, 30) + 20;
  }
  return dxf.toString();
}

/* ------------------------------------------------------------------ 평면도 DXF */

export function planDxf(project: SewerProject, textHeight = 1.5): string {
  const dxf = new Dxf([['SW_CONDUIT', 5], ['SW_MANHOLE', 7], ['SW_OUTFALL', 1], ['SW_CATCHMENT', 3], ['SW_LABEL', 7]]);
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  for (const c of project.catchments) {
    if (!c.polygon) continue;
    dxf.poly('SW_CATCHMENT', c.polygon, true);
    const cx = c.polygon.reduce((s, p) => s + p[0], 0) / c.polygon.length;
    const cy = c.polygon.reduce((s, p) => s + p[1], 0) / c.polygon.length;
    dxf.text('SW_CATCHMENT', [cx, cy], textHeight, `${c.id} A=${c.area.toFixed(3)}ha`, 0, 1);
  }
  for (const c of project.conduits) {
    const u = byId.get(c.upstream);
    const v = byId.get(c.downstream);
    if (!u || !v) continue;
    dxf.line('SW_CONDUIT', [u.x, u.y], [v.x, v.y]);
    const slope = (u.invert + c.inlet_offset - v.invert - c.outlet_offset) / c.length;
    let angle = (Math.atan2(v.y - u.y, v.x - u.x) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;
    dxf.text('SW_LABEL', [(u.x + v.x) / 2, (u.y + v.y) / 2 + textHeight * 0.4], textHeight, `${c.id} D${Math.round(c.diameter * 1000)} L=${fx(c.length, 1)} i=${fx(slope * 1000, 1)}‰`, angle, 1);
  }
  for (const n of project.nodes) {
    dxf.circle(n.kind === 'OUTFALL' ? 'SW_OUTFALL' : 'SW_MANHOLE', [n.x, n.y], n.kind === 'OUTFALL' ? textHeight : textHeight * 0.6);
    dxf.text('SW_LABEL', [n.x + textHeight, n.y + textHeight], textHeight * 0.9, `${n.id} GL${fx(n.ground)} IL${fx(n.invert)}`);
  }
  return dxf.toString();
}

/* ------------------------------------------------------------------ 수량 산출 */

/** 원형 맨홀 규격 (내경, 접속 최대 관경) — 일반적인 예시 구분. */
export const MANHOLE_TYPES: { name: string; inner: number; maxPipe: number }[] = [
  { name: '1호 (Φ900)', inner: 0.9, maxPipe: 0.6 },
  { name: '2호 (Φ1200)', inner: 1.2, maxPipe: 0.8 },
  { name: '3호 (Φ1500)', inner: 1.5, maxPipe: 1.1 },
  { name: '4호 (Φ1800)', inner: 1.8, maxPipe: 1.35 },
  { name: '5호 (Φ2100)', inner: 2.1, maxPipe: 1.65 },
];

const DEPTH_BINS = [2, 3, 4, 5, Infinity];
const binLabel = (i: number) => (i === 0 ? '2.0 m 이하' : DEPTH_BINS[i] === Infinity ? `${DEPTH_BINS[i - 1]}.0 m 초과` : `${DEPTH_BINS[i - 1]}.0~${DEPTH_BINS[i]}.0 m`);

export interface QuantityTable {
  pipes: { diameter: number; count: number; length: number }[];
  manholes: { type: string; bins: number[]; total: number }[];
  depthBins: string[];
  outfalls: number;
  drops: number;
  earth: { excavation: number; pipeVolume: number; bedding: number; backfill: number; surplus: number; pavement: number };
  totalLength: number;
}

/** 관거·맨홀·개략 토공 수량. design 이 있으면 설계한 관경·관저고로 센다. */
export function quantityTakeoff(input: SewerProject, design?: DesignResult | null, dropPipeAt = 0.6): QuantityTable {
  const project = design?.project ?? input;
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const pipeMap = new Map<number, { count: number; length: number }>();
  const earth = { excavation: 0, pipeVolume: 0, bedding: 0, backfill: 0, surplus: 0, pavement: 0 };
  let totalLength = 0;
  for (const c of project.conduits) {
    const u = byId.get(c.upstream);
    const v = byId.get(c.downstream);
    if (!u || !v) continue;
    const p = pipeMap.get(c.diameter) ?? { count: 0, length: 0 };
    p.count++;
    p.length += c.length;
    pipeMap.set(c.diameter, p);
    totalLength += c.length;
    const B = trenchWidth(c.diameter);
    const depthUp = u.ground - (u.invert + c.inlet_offset) + BEDDING;
    const depthDown = v.ground - (v.invert + c.outlet_offset) + BEDDING;
    const H = Math.max(0, (depthUp + depthDown) / 2);
    const outer = c.diameter * 1.2;
    const exc = B * H * c.length;
    const pipeVol = (Math.PI * outer * outer * c.length) / 4;
    const bed = B * BEDDING * c.length;
    earth.excavation += exc;
    earth.pipeVolume += pipeVol;
    earth.bedding += bed;
    earth.backfill += Math.max(0, exc - pipeVol - bed);
    earth.surplus += pipeVol + bed;
    earth.pavement += B * c.length;
  }
  // 맨홀: 접속 관경 최대값으로 규격, 깊이(지반고 − 관저고)로 구간
  const maxD = new Map<string, number>();
  for (const c of project.conduits) {
    maxD.set(c.upstream, Math.max(maxD.get(c.upstream) ?? 0, c.diameter));
    maxD.set(c.downstream, Math.max(maxD.get(c.downstream) ?? 0, c.diameter));
  }
  const manholes = MANHOLE_TYPES.map((t) => ({ type: t.name, bins: DEPTH_BINS.map(() => 0), total: 0 }));
  manholes.push({ type: '특수 (Φ2100 초과)', bins: DEPTH_BINS.map(() => 0), total: 0 });
  let outfalls = 0;
  for (const n of project.nodes) {
    if (n.kind === 'OUTFALL') {
      outfalls++;
      continue;
    }
    const d = maxD.get(n.id) ?? 0;
    let k = MANHOLE_TYPES.findIndex((t) => d <= t.maxPipe + 1e-9);
    if (k < 0) k = manholes.length - 1;
    const depth = n.ground - n.invert;
    const b = DEPTH_BINS.findIndex((x) => depth <= x + 1e-9);
    manholes[k].bins[b]++;
    manholes[k].total++;
  }
  const drops = design ? design.rows.filter((r) => (r.drop ?? 0) >= dropPipeAt).length : 0;
  return {
    pipes: [...pipeMap.entries()].sort((a, b) => a[0] - b[0]).map(([diameter, p]) => ({ diameter, ...p })),
    manholes: manholes.filter((m) => m.total > 0),
    depthBins: DEPTH_BINS.map((_, i) => binLabel(i)),
    outfalls,
    drops,
    earth,
    totalLength,
  };
}

export function quantityCsv(q: QuantityTable, name: string): string {
  const lines: string[] = [`${name} 수량 산출 (개략 — 터파기 폭 = 관경×1.2+0.6 m(최소 0.8 m), 기초 ${BEDDING} m 가정)`, ''];
  lines.push('[관거]', '관경(mm),개소,연장(m)');
  for (const p of q.pipes) lines.push(`D${Math.round(p.diameter * 1000)},${p.count},${p.length.toFixed(2)}`);
  lines.push(`합계,${q.pipes.reduce((s, p) => s + p.count, 0)},${q.totalLength.toFixed(2)}`, '');
  lines.push('[맨홀] 깊이 = 지반고 − 관저고', ['규격', ...q.depthBins, '계'].join(','));
  for (const m of q.manholes) lines.push([m.type, ...m.bins, m.total].join(','));
  lines.push(`방류구,${q.outfalls}`, `부관(낙차) 맨홀,${q.drops}`, '');
  const e = q.earth;
  lines.push('[토공] (m³ · 포장 m²)', '항목,수량');
  lines.push(`터파기,${e.excavation.toFixed(1)}`, `관 점유 체적,${e.pipeVolume.toFixed(1)}`, `모래 기초,${e.bedding.toFixed(1)}`, `되메우기,${e.backfill.toFixed(1)}`, `잔토 처리,${e.surplus.toFixed(1)}`, `포장 깨기·복구(면적),${e.pavement.toFixed(1)}`);
  return lines.join('\r\n');
}
