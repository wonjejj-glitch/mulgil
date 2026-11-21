/**
 * 감압·가압 후보 제안 (해석 결과 기반, 순수 함수).
 *
 * 답을 정하는 것이 아니라 엔지니어가 판단할 '후보와 근거'를 낸다.
 *  1. 수요 절점마다 전 시간 최고·최저 수압을 구한다.
 *  2. 최고 수압이 기준을 넘는 절점들을 열린 관로로 이어진 덩어리(구역)로 묶는다 → 감압 구역.
 *     최저 수압이 기준에 못 미치는 절점들도 같은 방식으로 묶는다 → 가압 구역.
 *  3. 구역 경계 관로 중 물이 들어오는 관(유입관)을 찾는다. 가장 많이 들어오는 관에 감압밸브(PRV) 또는
 *     가압펌프를 두고, 나머지 유입관은 경계 제수밸브(닫힘) 후보로 둔다 — 구역을 하나의 블록으로 만든다.
 *  4. 감압밸브 설정압: 구역에서 가장 낮은 절점의 수압이 (최대 기준 − 여유)가 되게 하는 수두를 밸브 아래 절점 수압으로 바꾼 값.
 *     가압펌프: 양정 = 구역 최저 수압을 최소 기준 + 여유로 올리는 데 모자란 수두, 유량 = 유입관 최대 유입량.
 *  5. 적용(applyPressureFixes)하면 유입관의 구역 쪽 끝에 새 절점을 두고 그 사이에 밸브·펌프를 넣는다. 다시 해석해 확인한다.
 *
 * 한계: 구역 경계·밸브 위치·설정의 최종 결정은 운영 여건(계량기, 단수 영향, 기존 밸브)을 아는 엔지니어가 한다.
 * 구역 안 표고 차가 크면 감압 한 단계로는 높은 곳이 모자랄 수 있어 '구역 나누기 검토'로 표시한다.
 */
import { isUsUnits, PSI_PER_METER } from '../model/units';
import type { LngLat, NetworkModel } from '../model/types';
import type { SimulationResults } from './simulationManager';

export interface PressureFixOptions {
  /** 최소 수압 (모델 수압 단위) */
  minPressure: number;
  /** 최대 수압 (모델 수압 단위) */
  maxPressure: number;
  /** 감압 목표 = 최대 기준 − 이 값 (m) */
  prvMarginM: number;
  /** 가압 목표 = 최소 기준 + 이 값 (m) */
  boostMarginM: number;
  /** 이보다 작은 구역은 후보로 내지 않는다 (개별 확인) */
  minZoneNodes: number;
  /** 펌프 효율 (동력 계산용) */
  pumpEfficiency: number;
}

export const DEFAULT_PRESSURE_FIX: Omit<PressureFixOptions, 'minPressure' | 'maxPressure'> = {
  prvMarginM: 5,
  boostMarginM: 3,
  minZoneNodes: 3,
  pumpEfficiency: 0.7,
};

export interface FixCandidate {
  id: string;
  kind: 'prv' | 'booster';
  zoneNodeIds: string[];
  /** 밸브·펌프를 둘 유입관 */
  entryPipeId: string;
  /** 유입관의 구역 쪽 절점 / 바깥 쪽 절점 */
  zoneNodeId: string;
  outsideNodeId: string;
  /** 닫을 다른 유입관 (경계 제수밸브 후보) */
  closePipeIds: string[];
  /** 감압밸브 설정 (밸브 아래 절점 수압, 모델 수압 단위) */
  prvSetting?: number;
  /** 가압 양정 (모델 표고 단위: m 또는 ft) */
  pumpHead?: number;
  /** 설계 유량 (모델 유량 단위) — 유입관 최대 유입량 */
  designFlow: number;
  /** 가압펌프 동력 (kW, 개략) */
  pumpPowerKw?: number;
  /** 구역의 현재 최고(감압)·최저(가압) 수압 */
  worstPressure: number;
  /** 적용 후 기대값: 감압이면 구역 최고 수압, 가압이면 구역 최저 수압 (개략) */
  expectedPressure: number;
  minElevation: number;
  maxElevation: number;
  /** 지도 이동용 위치 (밸브 자리) */
  position: LngLat;
  /** 구역 안 수요 합 (첨두, 모델 유량 단위) */
  zoneDemandPeak: number;
  /** 바로 적용해도 무리가 적은 후보인지 (아니면 화면에서 기본으로 고르지 않는다) */
  recommended: boolean;
  notes: string[];
}

export interface PressureFixResult {
  candidates: FixCandidate[];
  /** 기준을 벗어난 절점 수 (구역에 묶기 전) */
  highNodes: number;
  lowNodes: number;
  /** 너무 작아 후보로 내지 않은 구역 수 */
  smallZones: number;
  /** 물이 들어오는 관을 찾지 못한 구역 (수원 바로 아래·고립 등) */
  noEntryZones: number;
}

interface Edge {
  pipeId: string;
  other: string;
}

/** 해석 결과로 감압·가압 후보를 만든다. */
export function proposePressureFixes(model: NetworkModel, results: SimulationResults, o: PressureFixOptions): PressureFixResult {
  const us = isUsUnits(model.options.flowUnits);
  // 표고 단위(m/ft) → 수압 단위(m/psi)
  const pPerElev = us ? PSI_PER_METER * 0.3048 : 1;
  const mToElev = us ? 1 / 0.3048 : 1;
  const N = results.nodeIds.length;
  const L = results.linkIds.length;
  const steps = results.stepCount;

  const junctions = Object.values(model.nodes).filter((n) => n.type === 'junction');
  const maxP = new Map<string, number>();
  const minP = new Map<string, number>();
  for (const j of junctions) {
    const ix = results.nodeIndex.get(j.id);
    if (ix === undefined) continue;
    let lo = Infinity, hi = -Infinity;
    for (let s = 0; s < steps; s++) {
      const p = results.node.pressure[s * N + ix];
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    maxP.set(j.id, hi);
    minP.set(j.id, lo);
  }

  // 열린 관로로 이어진 이웃 (밸브·펌프는 이미 경계이므로 건너지 않는다)
  const adj = new Map<string, Edge[]>();
  const push = (a: string, e: Edge) => {
    const list = adj.get(a);
    if (list) list.push(e);
    else adj.set(a, [e]);
  };
  for (const l of Object.values(model.links)) {
    if (l.type !== 'pipe' || l.status === 'Closed') continue;
    push(l.startNodeId, { pipeId: l.id, other: l.endNodeId });
    push(l.endNodeId, { pipeId: l.id, other: l.startNodeId });
  }

  /** 관로로 구역 안으로 들어오는 유량 (시간별, 모델 유량 단위). 양수 = 들어옴. */
  const inflowSeries = (pipeId: string, insideNode: string): number[] => {
    const li = results.linkIndex.get(pipeId);
    const link = model.links[pipeId];
    if (li === undefined || !link) return [];
    const sign = link.endNodeId === insideNode ? 1 : -1;
    const out: number[] = [];
    for (let s = 0; s < steps; s++) out.push(sign * results.link.flow[s * L + li]);
    return out;
  };

  const zonesOf = (flagged: Set<string>): string[][] => {
    const seen = new Set<string>();
    const zones: string[][] = [];
    for (const start of flagged) {
      if (seen.has(start)) continue;
      const zone: string[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const a = stack.pop()!;
        zone.push(a);
        for (const e of adj.get(a) ?? []) {
          if (flagged.has(e.other) && !seen.has(e.other)) {
            seen.add(e.other);
            stack.push(e.other);
          }
        }
      }
      zones.push(zone);
    }
    return zones.sort((a, b) => b.length - a.length);
  };

  const high = new Set([...maxP].filter(([, v]) => v > o.maxPressure).map(([k]) => k));
  const low = new Set([...minP].filter(([, v]) => v < o.minPressure).map(([k]) => k));
  const result: PressureFixResult = { candidates: [], highNodes: high.size, lowNodes: low.size, smallZones: 0, noEntryZones: 0 };

  const elevOf = (id: string) => model.nodes[id]?.elevation ?? 0;
  const headAt = (id: string, s: number) => {
    const ix = results.nodeIndex.get(id);
    return ix === undefined ? NaN : results.node.head[s * N + ix];
  };

  const build = (kind: 'prv' | 'booster', zone: string[]): FixCandidate | null => {
    const inZone = new Set(zone);
    const boundary: { pipeId: string; inside: string; outside: string; inflow: number[] }[] = [];
    for (const a of zone) {
      for (const e of adj.get(a) ?? []) {
        if (inZone.has(e.other)) continue;
        boundary.push({ pipeId: e.pipeId, inside: a, outside: e.other, inflow: inflowSeries(e.pipeId, a) });
      }
    }
    const tol = 1e-6;
    const inflows = boundary
      .map((b) => ({ ...b, total: b.inflow.reduce((s, q) => s + Math.max(0, q), 0), peak: Math.max(0, ...b.inflow) }))
      .filter((b) => b.peak > tol);
    if (inflows.length === 0) return null;
    inflows.sort((a, b) => b.total - a.total);
    const entry = inflows[0];
    const elevs = zone.map(elevOf);
    const minElev = Math.min(...elevs);
    const maxElev = Math.max(...elevs);
    const notes: string[] = [];
    const closePipeIds = inflows.slice(1).map((b) => b.pipeId);
    if (closePipeIds.length > 0) notes.push(`다른 유입관 ${closePipeIds.length}개를 닫아 블록으로 만듭니다(경계 제수밸브). 닫은 뒤 이 관으로 물을 받던 곳의 수압을 다시 해석해 확인하세요.`);
    const position = model.nodes[entry.inside]?.position ?? [0, 0];
    const zoneMax = Math.max(...zone.map((z) => maxP.get(z) ?? -Infinity));
    const zoneMin = Math.min(...zone.map((z) => minP.get(z) ?? Infinity));
    // 구역 안 수요 (첨두) — 유입량이 이보다 훨씬 크면 물이 구역을 지나 하류로 가는 주관로 구역이다
    let zoneDemandPeak = 0;
    for (let s = 0; s < steps; s++) {
      let sum = 0;
      for (const z of zone) {
        const ix = results.nodeIndex.get(z);
        if (ix !== undefined) sum += Math.max(0, results.node.demand[s * N + ix]);
      }
      zoneDemandPeak = Math.max(zoneDemandPeak, sum);
    }
    // 수요가 없는 저수압 구역(끝단 빈 절점 등)은 가압할 물이 없다 — 펌프 곡선이 0 유량이 되어 해석이 풀리지 않는다
    if (kind === 'booster' && zoneDemandPeak < 1e-3) return null;
    const throughFlow = entry.peak > 2 * zoneDemandPeak + 1e-3;
    let recommended = true;
    if (throughFlow) {
      recommended = false;
      notes.push(`유입량(${entry.peak.toFixed(1)})이 구역 수요(${zoneDemandPeak.toFixed(1)})보다 훨씬 커서 물이 이 구역을 지나 하류로 갑니다 — 여기에 두면 하류 전체 수압이 함께 바뀝니다. 구역 끝 가지관이나 배수지 수위·관경을 먼저 검토하세요.`);
    }
    const designFlow = kind === 'booster' ? Math.max(zoneDemandPeak, 1e-6) : entry.peak;

    if (kind === 'prv') {
      // 감압 후 구역 최고 수압(가장 낮은 절점, 흐름이 적을 때) = 목표
      const target = o.maxPressure - o.prvMarginM * (us ? PSI_PER_METER : 1);
      let hSet = minElev + target / pPerElev; // 밸브 바로 아래 수두 (표고 단위): 가장 낮은 곳이 목표 수압
      // 첨두 때 구역 안 손실수두(유입 절점 → 각 절점)를 현재 결과로 어림해, 높은 곳이 최소 수압(+2 m)을 받는 데 필요한 수두
      let hNeed = -Infinity;
      for (let s = 0; s < steps; s++) {
        const hIn = headAt(entry.inside, s);
        for (const z of zone) {
          const loss = Math.max(0, hIn - headAt(z, s));
          hNeed = Math.max(hNeed, elevOf(z) + (o.minPressure + 2 * (us ? PSI_PER_METER : 1)) / pPerElev + loss);
        }
      }
      if (hNeed > hSet) {
        // 목표대로 낮추면 높은 곳이 모자란다 → 높은 곳을 지키는 만큼만 낮춘다
        const over = (hNeed - minElev) * pPerElev - o.maxPressure;
        notes.push(`구역 표고 차(${minElev.toFixed(1)}~${maxElev.toFixed(1)})가 커서 높은 곳 최소 수압을 지키는 만큼만 낮춥니다 — 가장 낮은 곳은 여전히 기준보다 ${over.toFixed(1)} 높습니다. 구역을 표고별로 나누는 것을 검토하세요.`);
        hSet = hNeed;
        recommended = false;
      }
      let maxHeadIn = -Infinity;
      for (let s = 0; s < steps; s++) maxHeadIn = Math.max(maxHeadIn, headAt(entry.inside, s));
      if (!(hSet < maxHeadIn - 0.5)) return null; // 감압해도 낮아지지 않는다
      const setting = (hSet - elevOf(entry.inside)) * pPerElev;
      if (!(setting > 0)) return null;
      return {
        id: '',
        kind,
        zoneNodeIds: zone,
        entryPipeId: entry.pipeId,
        zoneNodeId: entry.inside,
        outsideNodeId: entry.outside,
        closePipeIds,
        prvSetting: Math.round(setting * 10) / 10,
        designFlow,
        worstPressure: zoneMax,
        expectedPressure: Math.max(target, (hSet - minElev) * pPerElev),
        minElevation: minElev,
        maxElevation: maxElev,
        position,
        zoneDemandPeak,
        recommended,
        notes,
      };
    }
    // 가압: 구역 최저 수압을 (최소 기준 + 여유)로
    const target = o.minPressure + o.boostMarginM * (us ? PSI_PER_METER : 1);
    const headNeeded = (target - zoneMin) / pPerElev; // 표고 단위
    if (!(headNeeded > 0)) return null;
    if (zoneMin < -50 * (us ? PSI_PER_METER : 1)) notes.push('수압이 크게 음수입니다 — 공급원과 제대로 이어지지 않았거나 표고 입력 오류일 수 있으니 가압 전에 연결·표고를 확인하세요.');
    const flowM3s = toM3s(designFlow, model.options.flowUnits);
    const headM = headNeeded / mToElev;
    const powerKw = (9.81 * flowM3s * headM) / o.pumpEfficiency;
    return {
      id: '',
      kind,
      zoneNodeIds: zone,
      entryPipeId: entry.pipeId,
      zoneNodeId: entry.inside,
      outsideNodeId: entry.outside,
      closePipeIds,
      pumpHead: Math.round(headNeeded * 10) / 10,
      designFlow,
      pumpPowerKw: Math.round(powerKw * 10) / 10,
      worstPressure: zoneMin,
      expectedPressure: target,
      minElevation: minElev,
      maxElevation: maxElev,
      position,
      zoneDemandPeak,
      recommended,
      notes,
    };
  };

  let nPrv = 0, nBp = 0;
  for (const [kind, set] of [['prv', high], ['booster', low]] as const) {
    for (const zone of zonesOf(set)) {
      if (zone.length < o.minZoneNodes) {
        result.smallZones++;
        continue;
      }
      const c = build(kind, zone);
      if (!c) {
        result.noEntryZones++;
        continue;
      }
      c.id = kind === 'prv' ? `감압${++nPrv}` : `가압${++nBp}`;
      result.candidates.push(c);
    }
  }
  return result;
}

const FLOW_TO_M3S: Record<string, number> = {
  CFS: 0.028316846592,
  GPM: 6.30901964e-5,
  MGD: 0.0438126364,
  IMGD: 0.0526167,
  AFD: 0.0142764,
  LPS: 0.001,
  LPM: 1 / 60000,
  MLD: 1000 / 86400,
  CMH: 1 / 3600,
  CMD: 1 / 86400,
  CMS: 1,
};
function toM3s(q: number, units: string): number {
  return q * (FLOW_TO_M3S[units] ?? 0.001);
}

/** 새 ID (기존과 겹치지 않게) */
function freshId(base: string, taken: Record<string, unknown>): string {
  if (!(base in taken)) return base;
  for (let k = 2; ; k++) if (!(`${base}_${k}` in taken)) return `${base}_${k}`;
}

export interface ApplySummary {
  prv: number;
  booster: number;
  closed: number;
  /** 후보 ID → 새로 넣은 밸브·펌프 ID */
  placed: Record<string, string>;
  /** 밸브·펌프 자리에 새로 만든 절점 (기준 검토에서 뺀다) */
  nodes: string[];
  skipped: string[];
}

/**
 * 고른 후보를 관망에 넣는다 (model 을 고친다 — 스토어의 commit 안에서 부른다).
 * 유입관의 구역 쪽 끝 가까이에 새 절점을 두고, 관로는 새 절점에서 끝나게 한 뒤 새 절점 → 구역 절점 사이에 밸브·펌프를 넣는다.
 * 관로 연장은 원래 값을 그대로 둔다.
 */
export function applyPressureFixes(model: NetworkModel, candidates: FixCandidate[]): ApplySummary {
  const summary: ApplySummary = { prv: 0, booster: 0, closed: 0, placed: {}, nodes: [], skipped: [] };
  for (const c of candidates) {
    const pipe = model.links[c.entryPipeId];
    const zoneNode = model.nodes[c.zoneNodeId];
    const outside = model.nodes[c.outsideNodeId];
    if (!pipe || pipe.type !== 'pipe' || !zoneNode || !outside) {
      summary.skipped.push(c.id);
      continue;
    }
    const touches = (pipe.startNodeId === c.zoneNodeId && pipe.endNodeId === c.outsideNodeId) || (pipe.endNodeId === c.zoneNodeId && pipe.startNodeId === c.outsideNodeId);
    if (!touches) {
      summary.skipped.push(c.id);
      continue;
    }
    // 새 절점: 구역 절점에서 관로 쪽으로 아주 조금(관 길이의 5%, 최대 약 3 m) 떨어진 곳
    const toward = pipe.startNodeId === c.zoneNodeId ? pipe.vertices[0] ?? outside.position : pipe.vertices[pipe.vertices.length - 1] ?? outside.position;
    const f = Math.min(0.05, 3 / Math.max(1, pipe.length));
    const pos: LngLat = [zoneNode.position[0] + (toward[0] - zoneNode.position[0]) * f, zoneNode.position[1] + (toward[1] - zoneNode.position[1]) * f];
    const tag = c.kind === 'prv' ? 'PRV' : 'BP';
    const nodeId = freshId(`${tag}_${c.zoneNodeId}`, model.nodes);
    model.nodes[nodeId] = { id: nodeId, type: 'junction', position: pos, elevation: zoneNode.elevation, demand: 0, pattern: '' };
    summary.nodes.push(nodeId);
    const length = pipe.length;
    if (pipe.startNodeId === c.zoneNodeId) pipe.startNodeId = nodeId;
    else pipe.endNodeId = nodeId;
    pipe.length = length;
    pipe.isCustomLength = true;
    const linkId = freshId(`${tag}_${c.entryPipeId}`, model.links);
    if (c.kind === 'prv') {
      model.links[linkId] = {
        id: linkId,
        type: 'valve',
        startNodeId: nodeId,
        endNodeId: c.zoneNodeId,
        vertices: [],
        diameter: pipe.diameter,
        valveType: 'PRV',
        setting: String(c.prvSetting ?? 0),
        minorLoss: 0,
      };
      summary.prv++;
    } else {
      const curveId = freshId(`${linkId}_H`, model.curves);
      model.curves[curveId] = [[Math.round(c.designFlow * 1000) / 1000, c.pumpHead ?? 0]];
      model.links[linkId] = { id: linkId, type: 'pump', startNodeId: nodeId, endNodeId: c.zoneNodeId, vertices: [], headCurve: curveId, power: 0, speed: 1, pattern: '' };
      summary.booster++;
    }
    summary.placed[c.id] = linkId;
    for (const pid of c.closePipeIds) {
      const p = model.links[pid];
      if (p && p.type === 'pipe' && p.status !== 'Closed') {
        p.status = 'Closed';
        summary.closed++;
      }
    }
  }
  return summary;
}
