/**
 * 수리해석 결과의 설계기준 적합성 판정과 수원별 물수지.
 * 기본값: 최소 동수압 150 kPa(≈15.3 m), 최대 수압 700 kPa(≈71.4 m), 유속 0.3~3.0 m/s.
 * 사업·지자체 기준에 따라 화면에서 바꿔 쓴다. 최대 정수압은 무수요 상태 해석이 필요하므로 여기서는 '전 시간 최대 수압'으로 본다.
 */
import { isUsUnits, PSI_PER_METER } from '../model/units';
import type { NetworkModel } from '../model/types';
import type { SimulationResults } from './simulationManager';
import { computeSupplyZones } from './supplyZones';

export interface WaterCriteria {
  /** 모델 수압 단위 (SI m, US psi) */
  minPressure: number;
  maxPressure: number;
  /** 모델 유속 단위 (SI m/s, US ft/s) */
  minVelocity: number;
  maxVelocity: number;
}

const FT = 3.280839895;

export function defaultCriteria(model: Pick<NetworkModel, 'options'>): WaterCriteria {
  const us = isUsUnits(model.options.flowUnits);
  return us
    ? { minPressure: 15.3 * PSI_PER_METER, maxPressure: 71.4 * PSI_PER_METER, minVelocity: 0.3 * FT, maxVelocity: 3.0 * FT }
    : { minPressure: 15.3, maxPressure: 71.4, minVelocity: 0.3, maxVelocity: 3.0 };
}

export type CriteriaKind = 'lowPressure' | 'highPressure' | 'lowVelocity' | 'highVelocity';

export interface CriteriaHit {
  kind: CriteriaKind;
  id: string;
  /** 판정에 쓴 값 (최저 수압 / 최고 수압 / 최대 유속) */
  value: number;
  /** 그 값이 나온 시간 스텝 */
  step: number;
}

export const CRITERIA_LABELS: Record<CriteriaKind, string> = {
  lowPressure: '최소 수압 미달',
  highPressure: '최대 수압 초과',
  lowVelocity: '최소 유속 미달',
  highVelocity: '최대 유속 초과',
};

/**
 * 감압·가압 후보를 적용할 때 밸브·펌프 자리에 만든 절점(PRV_·BP_ 로 시작, 수요 0).
 * 수용가가 없는 장치 연결점이라 수압 기준 검토에서 뺀다 (가압펌프 흡입 쪽은 원래 수압이 낮다).
 */
export function isDeviceNode(id: string, demand: number): boolean {
  return /^(PRV|BP)_/.test(id) && !(demand > 0);
}

/** 절점은 수요 절점(junction)만, 유속은 관로만 본다. 저유속은 '전 시간 최대 유속'이 기준 미만인 관(정체 의심). */
export function checkCriteria(model: Pick<NetworkModel, 'nodes' | 'links'>, r: SimulationResults, c: WaterCriteria): CriteriaHit[] {
  const hits: CriteriaHit[] = [];
  const N = r.nodeIds.length;
  const L = r.linkIds.length;
  for (let i = 0; i < N; i++) {
    const id = r.nodeIds[i];
    const node = model.nodes[id];
    if (node?.type !== 'junction' || isDeviceNode(id, node.demand)) continue;
    let lo = Infinity, loStep = 0, hi = -Infinity, hiStep = 0;
    for (let t = 0; t < r.stepCount; t++) {
      const p = r.node.pressure[t * N + i];
      if (p < lo) [lo, loStep] = [p, t];
      if (p > hi) [hi, hiStep] = [p, t];
    }
    if (lo < c.minPressure) hits.push({ kind: 'lowPressure', id, value: lo, step: loStep });
    if (hi > c.maxPressure) hits.push({ kind: 'highPressure', id, value: hi, step: hiStep });
  }
  for (let j = 0; j < L; j++) {
    const id = r.linkIds[j];
    if (model.links[id]?.type !== 'pipe') continue;
    let hi = 0, hiStep = 0;
    for (let t = 0; t < r.stepCount; t++) {
      const v = Math.abs(r.link.velocity[t * L + j]);
      if (v > hi) [hi, hiStep] = [v, t];
    }
    if (hi < c.minVelocity) hits.push({ kind: 'lowVelocity', id, value: hi, step: hiStep });
    if (hi > c.maxVelocity) hits.push({ kind: 'highVelocity', id, value: hi, step: hiStep });
  }
  return hits;
}

export interface SourceBalance {
  id: string;
  type: 'reservoir' | 'tank';
  /** 평균 유출량 (유량 단위, + = 관망으로 내보냄, − = 배수지로 들어옴) */
  avgOutflow: number;
  maxOutflow: number;
  /** 이 수원이 가장 많이 공급하는 절점 수 (최대 수요 시각 기준) */
  zoneNodes: number;
  /** 그 절점들의 평균 수요 합 */
  zoneDemand: number;
}

export interface WaterBalance {
  sources: SourceBalance[];
  /** 전체 평균 수요 (junction) */
  totalDemand: number;
  /** 전체 평균 공급 (수원 유출 합) */
  totalSupply: number;
  /** 수원에 닿지 않는 수요 절점 수 */
  unsuppliedNodes: number;
  peakStep: number;
}

export function waterBalance(model: Pick<NetworkModel, 'nodes' | 'links'>, r: SimulationResults): WaterBalance {
  const N = r.nodeIds.length;
  const T = Math.max(1, r.stepCount);
  // 최대 수요 시각
  let peakStep = 0;
  let peak = -Infinity;
  for (let t = 0; t < r.stepCount; t++) {
    let s = 0;
    for (let i = 0; i < N; i++) if (model.nodes[r.nodeIds[i]]?.type === 'junction') s += r.node.demand[t * N + i];
    if (s > peak) [peak, peakStep] = [s, t];
  }
  const avgDemand = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let t = 0; t < r.stepCount; t++) s += r.node.demand[t * N + i];
    avgDemand[i] = s / T;
  }
  const zones = computeSupplyZones(model, r, peakStep);
  const sources: SourceBalance[] = zones.sources.map((id) => {
    const i = r.nodeIndex.get(id)!;
    let max = -Infinity;
    for (let t = 0; t < r.stepCount; t++) max = Math.max(max, -r.node.demand[t * N + i]);
    return { id, type: model.nodes[id].type as 'reservoir' | 'tank', avgOutflow: -avgDemand[i], maxOutflow: max, zoneNodes: 0, zoneDemand: 0 };
  });
  let totalDemand = 0;
  let unsupplied = 0;
  for (let i = 0; i < N; i++) {
    if (model.nodes[r.nodeIds[i]]?.type !== 'junction') continue;
    totalDemand += avgDemand[i];
    const d = zones.dominant[i];
    if (d < 0) {
      if (avgDemand[i] > 0) unsupplied++;
      continue;
    }
    sources[d].zoneNodes++;
    sources[d].zoneDemand += avgDemand[i];
  }
  return { sources, totalDemand, totalSupply: sources.reduce((s, x) => s + x.avgOutflow, 0), unsuppliedNodes: unsupplied, peakStep };
}
