/**
 * 용도지역 분담유량 — 기존 상수관망 프로그램의 '분담유량'을 옮긴 것.
 *   절점 기본 수요량 = Σ (그 절점에 연결된 용도 구역 면적 × 그 용도의 원단위)
 * 원래 프로그램은 용도 폴리곤과 절점을 '연결관'으로 하나씩 손으로 이었다. 여기서는 자동으로 연결한다:
 *   1) 구역 안에 절점이 있으면 그 절점들이 면적 유량을 똑같이 나눠 받는다.
 *   2) 구역 안에 절점이 없으면 구역 중심에서 가장 가까운 절점(최대 거리 안)이 받는다 (= 연결관).
 * 원단위는 m³/일/ha 로 받는다. 값은 사업 기본계획의 용도별 원단위를 넣는다.
 */
import { makeLocalProjector } from '../../utils/geoMath';
import type { FlowUnits, LngLat, NetworkModel } from './types';

export interface LandParcel {
  id: string;
  use: string;
  /** 바깥 고리 + 구멍 고리들. */
  rings: LngLat[][];
}

export interface AllocationOptions {
  /** 구역 안에 절점이 없을 때 연결할 최대 거리 (m). */
  maxConnectDistance: number;
  /** 대상 절점 (없으면 전체 절점). */
  nodeIds?: string[];
}

export interface AllocationRow {
  parcel: string;
  use: string;
  /** ha */
  area: number;
  /** m³/일/ha */
  rate: number;
  /** 구역 유량 (m³/일) */
  flow: number;
  node: string;
  /** 이 절점이 받은 몫 (m³/일) */
  share: number;
  method: '구역 내 절점' | '연결관(최근접)';
}

export interface AllocationResult {
  rows: AllocationRow[];
  /** 절점별 분담유량 합 (m³/일) */
  perNode: Record<string, number>;
  /** 원단위가 없거나 연결할 절점이 없는 구역 */
  skipped: { parcel: string; reason: string }[];
  totalArea: number;
  totalFlow: number;
}

type XY = [number, number];

function ringArea(r: XY[]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(s) / 2;
}

function inRing(p: XY, r: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (r[i][1] > p[1] !== r[j][1] > p[1] && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
  }
  return inside;
}

export function allocateDemand(
  model: Pick<NetworkModel, 'nodes'>,
  parcels: LandParcel[],
  rates: Record<string, number>,
  options: AllocationOptions,
): AllocationResult {
  const ids = (options.nodeIds ?? Object.keys(model.nodes)).filter((id) => model.nodes[id]?.type === 'junction');
  const firstPoint = parcels[0]?.rings[0]?.[0] ?? model.nodes[ids[0]]?.position ?? [127, 37];
  const proj = makeLocalProjector(firstPoint[1]);
  const xy = (p: LngLat): XY => proj.forward(p);
  const nodeXY = ids.map((id) => ({ id, p: xy(model.nodes[id].position) }));

  const rows: AllocationRow[] = [];
  const perNode: Record<string, number> = {};
  const skipped: AllocationResult['skipped'] = [];
  let totalArea = 0;
  let totalFlow = 0;
  for (const parcel of parcels) {
    const rings = parcel.rings.filter((r) => r.length >= 3).map((r) => r.map(xy));
    if (rings.length === 0) continue;
    const areaHa = Math.max(0, ringArea(rings[0]) - rings.slice(1).reduce((s, r) => s + ringArea(r), 0)) / 10000;
    const rate = rates[parcel.use];
    if (rate === undefined || !Number.isFinite(rate)) {
      skipped.push({ parcel: parcel.id, reason: `용도 '${parcel.use}' 의 원단위가 없음` });
      continue;
    }
    const flow = areaHa * rate;
    totalArea += areaHa;
    const inside = nodeXY.filter((n) => inRing(n.p, rings[0]) && !rings.slice(1).some((h) => inRing(n.p, h)));
    let targets: string[];
    let method: AllocationRow['method'];
    if (inside.length > 0) {
      targets = inside.map((n) => n.id);
      method = '구역 내 절점';
    } else {
      // 구역 중심(바깥 고리 꼭짓점 평균)에서 가장 가까운 절점
      const ring = rings[0];
      const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
      const outer = closed ? ring.slice(0, -1) : ring;
      const c: XY = [outer.reduce((s, p) => s + p[0], 0) / outer.length, outer.reduce((s, p) => s + p[1], 0) / outer.length];
      let best: string | null = null;
      let bestD = options.maxConnectDistance;
      for (const n of nodeXY) {
        const d = Math.hypot(n.p[0] - c[0], n.p[1] - c[1]);
        if (d <= bestD) {
          bestD = d;
          best = n.id;
        }
      }
      if (!best) {
        skipped.push({ parcel: parcel.id, reason: `구역 안과 ${options.maxConnectDistance} m 안에 절점이 없음` });
        continue;
      }
      targets = [best];
      method = '연결관(최근접)';
    }
    totalFlow += flow;
    const share = flow / targets.length;
    for (const node of targets) {
      perNode[node] = (perNode[node] ?? 0) + share;
      rows.push({ parcel: parcel.id, use: parcel.use, area: areaHa, rate, flow, node, share, method });
    }
  }
  return { rows, perNode, skipped, totalArea, totalFlow };
}

/** m³/일 → 모델 유량 단위. */
export function m3dToFlowUnits(m3d: number, units: FlowUnits): number {
  const perM3s: Record<FlowUnits, number> = {
    CFS: 35.3146667,
    GPM: 15850.3231,
    MGD: 22.8244653,
    IMGD: 19.0053184,
    AFD: 70.0457,
    LPS: 1000,
    LPM: 60000,
    MLD: 86.4,
    CMH: 3600,
    CMD: 86400,
  };
  return (m3d / 86400) * perM3s[units];
}

/** 분담유량 산출표 CSV (구역별 행 + 절점별 합계). */
export function allocationCsv(result: AllocationResult, units: FlowUnits): string {
  const lines = ['구역,용도,면적(ha),원단위(m3/일/ha),구역유량(m3/일),연결 방법,절점,분담유량(m3/일)'];
  for (const r of result.rows) lines.push([r.parcel, r.use, r.area.toFixed(4), r.rate, r.flow.toFixed(3), r.method, r.node, r.share.toFixed(3)].join(','));
  lines.push('', `절점,분담유량(m3/일),기본 수요량(${units})`);
  for (const [node, v] of Object.entries(result.perNode).sort(([a], [b]) => a.localeCompare(b, 'ko', { numeric: true }))) {
    lines.push([node, v.toFixed(3), m3dToFlowUnits(v, units).toFixed(4)].join(','));
  }
  lines.push('', `합계,${result.totalFlow.toFixed(3)},${m3dToFlowUnits(result.totalFlow, units).toFixed(4)}`);
  if (result.skipped.length > 0) {
    lines.push('', '제외된 구역,사유');
    for (const s of result.skipped) lines.push(`${s.parcel},${s.reason}`);
  }
  return `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`;
}
