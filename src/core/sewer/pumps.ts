/**
 * 중계펌프장 설계값: 자동(null)으로 둔 용량·양정·습정 면적을 지금 관망 값으로 정하고, SWMM 펌프 곡선을 만든다.
 * 모두 개략 계획용이다. 실제 펌프 선정은 제조사 성능곡선·압송관 손실 계산으로 다시 한다.
 */
import { buildNetwork, nodeInflows, type SewerGraph } from './topology';
import type { SewerProject, SewerPump } from './types';

/** 자동 양정에 더하는 손실 여유 (m): 압송관 마찰·밸브·토출 손실 개략 */
export const PUMP_HEAD_MARGIN = 2;
/** 자동 습정 면적: 펌프 용량으로 이 시간(분) 퍼낼 물을 가동~정지 수심 사이에 담는다 */
export const WET_WELL_MINUTES = 10;
/** 최소 습정 바닥 면적 (m²) */
const MIN_AREA = 2;

export interface PumpDuty {
  id: string;
  /** 습정으로 들어오는 설계 유량 (m³/s) */
  inflow: number;
  capacity: number;
  head: number;
  /** 실양정 = 토출 맨홀 관저 − 습정 바닥 (m) */
  staticLift: number;
  area: number;
  /** 각 값이 자동인지 */
  auto: { capacity: boolean; head: boolean; area: boolean };
}

export function pumpsOf(p: SewerProject): SewerPump[] {
  return p.pumps ?? [];
}

export function pumpDuties(p: SewerProject, graph?: SewerGraph): PumpDuty[] {
  const list = pumpsOf(p);
  if (list.length === 0) return [];
  const g = graph ?? buildNetwork(p);
  const inflow = nodeInflows(p, g);
  const node = new Map(p.nodes.map((n) => [n.id, n]));
  return list.map((pu) => {
    const w = node.get(pu.wet_well)!;
    const d = node.get(pu.discharge)!;
    const q = inflow[pu.wet_well] ?? 0;
    const capacity = pu.capacity ?? Math.max(q, 0.001);
    const staticLift = d.invert - w.invert;
    const head = pu.head ?? Math.round((Math.max(0.5, staticLift) + PUMP_HEAD_MARGIN) * 100) / 100;
    const span = Math.max(0.2, pu.on_depth - pu.off_depth);
    const area = pu.area ?? Math.max(MIN_AREA, Math.round(((capacity * WET_WELL_MINUTES * 60) / span) * 10) / 10);
    return { id: pu.id, inflow: q, capacity, head, staticLift, area, auto: { capacity: pu.capacity === null, head: pu.head === null, area: pu.area === null } };
  });
}

/**
 * SWMM TYPE3 펌프 곡선 (양정 → 유량) 점들. 원심 펌프 근사 H = H0·(1 − (Q/Qmax)²),
 * 체절 양정 H0 = 1.33 × 설계 양정이 되게 잡아 설계점(용량·양정)을 지나게 한다.
 */
export function pumpCurve(capacity: number, head: number): [number, number][] {
  const h0 = 1.33 * head;
  const qmax = capacity / Math.sqrt(1 - head / h0);
  return [0, 0.5, 1, 1.2, 1.33].map((k) => {
    const h = Math.min(k * head, h0);
    return [h, Math.max(0, qmax * Math.sqrt(Math.max(0, 1 - h / h0)))] as [number, number];
  });
}
