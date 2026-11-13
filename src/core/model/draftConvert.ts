/**
 * 관망 초안(networkDraft) → 상수 관망 모델 / 하수 설계 프로젝트.
 * 여기 기본값(첨두계수·설계유속·전환율 등)은 예시값이다. 사업별 기본계획·설계기준 값으로 바꿔 쓴다.
 */
import { wgs84ToEpsg } from '../../utils/geoMath';
import { defaultConstraints, defaultOptions, type SewerProject } from '../sewer/types';
import { m3dToFlowUnits } from './landUse';
import { addLink, nextId } from './networkEdit';
import type { DraftResult } from './networkDraft';
import { defaultRoughness, FEET_PER_METER, isUsUnits } from './units';
import { createEmptyModel, type NetworkModel } from './types';

export interface WaterDraftOptions {
  /** 시간 최대 / 일평균 (관경 결정용). */
  peakFactor: number;
  /** 관경 결정 설계 유속 (m/s). */
  designVelocity: number;
  /** 최소 관경 (mm). */
  minDiameter: number;
  /** Hazen-Williams C */
  roughness: number;
  /** 수원 수위 = 수원 지반고 + 이 값 (m). */
  sourceHeadAboveGround: number;
}

export const DEFAULT_WATER_DRAFT: WaterDraftOptions = { peakFactor: 1.5, designVelocity: 1.0, minDiameter: 80, roughness: 110, sourceHeadAboveGround: 30 };

export const WATER_DIAMETERS_MM = [80, 100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000, 1100, 1200];

/** 유량(m³/s)·유속으로 필요한 관경을 표준 관경으로 올려 고른다. */
export function pickWaterDiameter(flowM3s: number, velocity: number, minMm: number): number {
  const needMm = Math.sqrt((4 * flowM3s) / (Math.PI * velocity)) * 1000;
  return WATER_DIAMETERS_MM.find((d) => d >= Math.max(needMm, minMm)) ?? WATER_DIAMETERS_MM[WATER_DIAMETERS_MM.length - 1];
}

export function draftToWaterModel(draft: DraftResult, o: WaterDraftOptions, title: string): NetworkModel {
  const model = createEmptyModel();
  model.title = [title, '수용가 자료로 만든 관망 초안 — 관경·수원 수위는 예시 기준값으로 정함'];
  model.options.flowUnits = 'LPS';
  const ids = new Map<number, string>();
  let j = 0;
  for (const nd of draft.nodes) {
    const ground = nd.ground ?? 0;
    if (nd.isSource) {
      const id = 'R1';
      ids.set(nd.key, id);
      model.nodes[id] = { id, type: 'reservoir', position: nd.position, elevation: Math.round((ground + o.sourceHeadAboveGround) * 100) / 100, pattern: '' };
    } else {
      const id = `J${++j}`;
      ids.set(nd.key, id);
      // m³/일 → L/s
      model.nodes[id] = { id, type: 'junction', position: nd.position, elevation: Math.round(ground * 100) / 100, demand: Math.round((nd.demand / 86.4) * 10000) / 10000, pattern: '' };
    }
  }
  draft.links.forEach((l, i) => {
    const id = `P${i + 1}`;
    const peak = (l.carried / 86400) * o.peakFactor;
    // 수원 쪽(to)에서 수용가 쪽(from)으로 흐르도록 시점을 수원 쪽에 둔다
    model.links[id] = {
      id,
      type: 'pipe',
      startNodeId: ids.get(l.to)!,
      endNodeId: ids.get(l.from)!,
      vertices: l.path.slice(1, -1).reverse(),
      length: Math.round(l.length * 100) / 100,
      isCustomLength: false,
      diameter: pickWaterDiameter(peak, o.designVelocity, o.minDiameter),
      roughness: o.roughness,
      minorLoss: 0,
      status: 'Open',
    };
  });
  return model;
}

export interface SewerDraftOptions {
  /** 오수 전환율 (급수량 중 하수로 나오는 비율). */
  conversion: number;
  /** 지하수 침입 비율 (오수량 대비). */
  infiltration: number;
  /** 시간 최대 / 일평균. */
  peakFactor: number;
  /** 초기 맨홀 깊이 (지반고 − 관저고, m). 설계에서 다시 정한다. */
  initialDepth: number;
  /** 방류구 깊이 (m). 방류구 관저고는 설계에서 고정값이다. */
  outfallDepth: number;
}

/** 방류구 앞 집수 맨홀 → 방류구 관 길이 (m). */
const OUTFALL_LINK = 10;

export const DEFAULT_SEWER_DRAFT: SewerDraftOptions = { conversion: 0.9, infiltration: 0.15, peakFactor: 1.5, initialDepth: 1.8, outfallDepth: 3 };

/** 일평균 사용량(m³/일) → 맨홀 설계 유입량(m³/s). */
export function sewerFlow(dailyM3: number, o: SewerDraftOptions): number {
  return (dailyM3 * o.conversion * (1 + o.infiltration) * o.peakFactor) / 86400;
}

/**
 * 하수 설계 프로젝트. 좌표는 EPSG:5186(중부원점, m)이라 지도에 바로 겹쳐 보인다.
 * 유역(우수)은 만들지 않는다 — 오수 초안. 우수까지 보려면 설계 화면에서 유역을 넣는다.
 */
export function draftToSewerProject(draft: DraftResult, o: SewerDraftOptions, name: string): SewerProject {
  const ids = new Map<number, string>();
  let m = 0;
  const pad = (k: number) => String(k).padStart(3, '0');
  const nodes = draft.nodes.map((nd) => {
    const [x, y] = wgs84ToEpsg('EPSG:5186', nd.position);
    const ground = Math.round((nd.ground ?? 100) * 1000) / 1000;
    const outfall = nd.isSource;
    const id = outfall ? 'OF1' : `MH${pad(++m)}`;
    ids.set(nd.key, id);
    return {
      id,
      x: Math.round(x * 1000) / 1000,
      y: Math.round(y * 1000) / 1000,
      ground,
      invert: Math.round((ground - (outfall ? o.outfallDepth : o.initialDepth)) * 1000) / 1000,
      kind: outfall ? ('OUTFALL' as const) : ('JUNCTION' as const),
      base_flow: outfall ? 0 : Math.round(sewerFlow(nd.demand, o) * 1e7) / 1e7,
      boundary: 'FREE' as const,
      stage: null,
    };
  });
  const conduits = draft.links.map((l, i) => ({
    id: `P${pad(i + 1)}`,
    upstream: ids.get(l.from)!,
    downstream: ids.get(l.to)!,
    length: Math.max(1, Math.round(l.length * 100) / 100),
    diameter: defaultConstraints().diameters[0],
    roughness: 0.013,
    inlet_offset: 0,
    outlet_offset: 0,
  }));
  // SWMM 방류구는 유입 관이 하나뿐이어야 한다(ERROR 141). 여러 가지가 모이면 그 자리를 집수 맨홀로 바꾸고
  // 방류 관 하나(OUTFALL_LINK m)로 방류구에 잇는다.
  const outfall = nodes.find((n) => n.kind === 'OUTFALL');
  if (outfall && conduits.filter((c) => c.downstream === outfall.id).length > 1) {
    const collector = { ...outfall, id: `MH${pad(++m)}`, kind: 'JUNCTION' as const, invert: Math.round((outfall.ground - o.initialDepth) * 1000) / 1000 };
    nodes.splice(nodes.indexOf(outfall), 0, collector);
    for (const c of conduits) if (c.downstream === outfall.id) c.downstream = collector.id;
    outfall.x = Math.round((outfall.x + OUTFALL_LINK) * 1000) / 1000;
    conduits.push({ ...conduits[0], id: `P${pad(conduits.length + 1)}`, upstream: collector.id, downstream: outfall.id, length: OUTFALL_LINK });
  }
  return { schema_version: 1, name, nodes, conduits, catchments: [], options: defaultOptions(), constraints: defaultConstraints() };
}

export interface GapFillReport {
  junctions: number;
  pipes: number;
  /** 기존 절점 중 새 관이 이어진 곳 */
  connectedTo: string[];
  /** 접속점에 바로 붙은 수용가 수요를 더한 기존 절점 */
  demandAddedTo: string[];
}

/**
 * 보완 모드 결과를 지금 관망(model)에 더한다 (immer draft 에서 호출). 기존 절점·관은 바꾸지 않고
 * 새 절점·관만 추가하며, 새 관은 기존 절점에서 시작한다. 관경은 수원 쪽 흐름 방향 기준 유속으로 고른다.
 */
export function addDraftToWaterModel(model: NetworkModel, draft: DraftResult, o: WaterDraftOptions): GapFillReport {
  const us = isUsUnits(model.options.flowUnits);
  const ids = new Map<number, string>();
  const report: GapFillReport = { junctions: 0, pipes: 0, connectedTo: [], demandAddedTo: [] };
  for (const nd of draft.nodes) {
    if (nd.existingId) {
      ids.set(nd.key, nd.existingId);
      const existing = model.nodes[nd.existingId];
      if (nd.demand > 0 && existing?.type === 'junction') {
        existing.demand = Math.round((existing.demand + m3dToFlowUnits(nd.demand, model.options.flowUnits)) * 10000) / 10000;
        report.demandAddedTo.push(existing.id);
      }
      continue;
    }
    const id = nextId('J', model.nodes);
    ids.set(nd.key, id);
    const ground = nd.ground ?? 0;
    model.nodes[id] = {
      id,
      type: 'junction',
      position: nd.position,
      elevation: Math.round((us ? ground * FEET_PER_METER : ground) * 100) / 100,
      demand: Math.round(m3dToFlowUnits(nd.demand, model.options.flowUnits) * 10000) / 10000,
      pattern: '',
    };
    report.junctions++;
  }
  const roughness = model.options.headloss === 'H-W' ? o.roughness : defaultRoughness(model.options.headloss);
  for (const l of draft.links) {
    const start = ids.get(l.to);
    const end = ids.get(l.from);
    if (!start || !end) continue;
    // 기존 절점 쪽 끝은 도로 접속점을 꺾임점으로 남겨 관이 도로를 따라 기존 절점에 닿게 한다
    const reversed = [...l.path].reverse();
    const startPos = model.nodes[start].position;
    const inner = reversed.slice(1, -1);
    const head = reversed[0];
    const vertices = draft.nodes[l.to].existingId && Math.hypot(head[0] - startPos[0], head[1] - startPos[1]) > 1e-6 ? [head, ...inner] : inner;
    const link = addLink(model, 'pipe', start, end, vertices);
    if (!link || link.type !== 'pipe') continue;
    const mm = pickWaterDiameter((l.carried / 86400) * o.peakFactor, o.designVelocity, o.minDiameter);
    link.diameter = us ? Math.round((mm / 25.4) * 10) / 10 : mm;
    link.roughness = roughness;
    report.pipes++;
    if (draft.nodes[l.to].existingId && !report.connectedTo.includes(start)) report.connectedTo.push(start);
  }
  return report;
}
