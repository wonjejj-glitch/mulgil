/**
 * 시간최대계수(수요 배율) 검토: EPANET [OPTIONS] 'Demand Multiplier' 로 모든 기본 수요량에 같은 배율을 곱해 해석한다.
 * 절점 수요량이 '일평균'으로 들어 있으면 1.5 처럼 시간최대계수를 넣고, 이미 시간최대 값이면 1.0 으로 둔다.
 * 여러 계수를 차례로 해석해 최저 수압·최대 유속·기준 위반 개수를 한 표로 비교한다.
 */
import type { NetworkModel } from '../model/types';
import { checkCriteria, type WaterCriteria } from './criteria';
import type { SimulationResults } from './simulationManager';

const LINE = /^\s*demand\s+multiplier\s+([-+0-9.eE]+)/i;

/** [OPTIONS] 원문 줄에서 수요 배율을 읽는다 (없으면 1). */
export function demandMultiplier(extra: readonly string[]): number {
  for (const line of extra) {
    const m = LINE.exec(line);
    if (m) {
      const v = Number(m[1]);
      return Number.isFinite(v) && v > 0 ? v : 1;
    }
  }
  return 1;
}

/** 수요 배율 줄을 바꾸거나 넣는다. 1 이면 줄을 없앤다 (EPANET 기본값). */
export function withDemandMultiplier(extra: readonly string[], factor: number): string[] {
  const kept = extra.filter((line) => !LINE.test(line));
  if (Math.abs(factor - 1) < 1e-9) return kept;
  return [...kept, `Demand Multiplier ${+factor.toFixed(4)}`];
}

/** 모델을 복사해 수요 배율만 바꾼다 (원본은 그대로). */
export function modelWithFactor(model: NetworkModel, factor: number): NetworkModel {
  return { ...model, options: { ...model.options, extra: withDemandMultiplier(model.options.extra, factor) } };
}

export interface FactorScenario {
  factor: number;
  /** 수요 절점 수요량 합의 전 시간 최대 (유량 단위) — 계수가 실제로 곱해졌는지 보는 값 */
  totalDemand: number;
  /** 배수지·수원지 제외 절점의 전 시간 최저 수압 */
  minPressure: number;
  minPressureNode: string;
  maxPressure: number;
  /** 관로 전 시간 최대 유속 */
  maxVelocity: number;
  maxVelocityLink: string;
  lowPressure: number;
  highPressure: number;
  highVelocity: number;
  lowVelocity: number;
  /** 음압 절점 수 */
  negative: number;
}

export function summarizeScenario(model: Pick<NetworkModel, 'nodes' | 'links'>, r: SimulationResults, c: WaterCriteria, factor: number): FactorScenario {
  const N = r.nodeIds.length;
  const L = r.linkIds.length;
  let minPressure = Infinity, minPressureNode = '', maxPressure = -Infinity, negative = 0;
  const demandSum = new Float64Array(r.stepCount);
  for (let i = 0; i < N; i++) {
    const id = r.nodeIds[i];
    if (model.nodes[id]?.type !== 'junction') continue;
    for (let t = 0; t < r.stepCount; t++) demandSum[t] += Math.max(0, r.node.demand[t * N + i]);
    let lo = Infinity;
    for (let t = 0; t < r.stepCount; t++) {
      const p = r.node.pressure[t * N + i];
      if (p < lo) lo = p;
      if (p > maxPressure) maxPressure = p;
    }
    if (lo < minPressure) [minPressure, minPressureNode] = [lo, id];
    if (lo < 0) negative++;
  }
  let maxVelocity = 0, maxVelocityLink = '';
  for (let j = 0; j < L; j++) {
    const id = r.linkIds[j];
    if (model.links[id]?.type !== 'pipe') continue;
    for (let t = 0; t < r.stepCount; t++) {
      const v = Math.abs(r.link.velocity[t * L + j]);
      if (v > maxVelocity) [maxVelocity, maxVelocityLink] = [v, id];
    }
  }
  const hits = checkCriteria(model, r, c);
  const count = (k: string) => hits.filter((h) => h.kind === k).length;
  return {
    factor,
    totalDemand: demandSum.length > 0 ? Math.max(...demandSum) : 0,
    minPressure: Number.isFinite(minPressure) ? minPressure : 0,
    minPressureNode,
    maxPressure: Number.isFinite(maxPressure) ? maxPressure : 0,
    maxVelocity,
    maxVelocityLink,
    lowPressure: count('lowPressure'),
    highPressure: count('highPressure'),
    lowVelocity: count('lowVelocity'),
    highVelocity: count('highVelocity'),
    negative,
  };
}

/**
 * 계수를 바꿔도 수압이 거의 그대로인지 (최저 수압 차이 0.1 m 미만).
 * 수요가 관 크기에 비해 아주 작으면 관로 손실이 없어 수압이 표고·수원 수위로만 정해진다 — 계산이 틀린 것이 아니다.
 */
export function pressureInsensitive(rows: readonly FactorScenario[]): boolean {
  if (rows.length < 2) return false;
  const lo = rows.map((r) => r.minPressure);
  return Math.max(...lo) - Math.min(...lo) < 0.1;
}

/** '1, 1.3, 1.5' 같은 입력을 계수 목록으로 (양수만, 중복 제거, 오름차순, 최대 8개). */
export function parseFactors(text: string): number[] {
  const values = text
    .split(/[\s,;/]+/)
    .map(Number)
    .filter((v) => Number.isFinite(v) && v > 0 && v <= 10);
  return [...new Set(values.map((v) => +v.toFixed(4)))].sort((a, b) => a - b).slice(0, 8);
}

export function scenariosCsv(rows: FactorScenario[], pressureUnit: string, velocityUnit: string): string {
  const head = ['시간최대계수', '총수요', `최저수압(${pressureUnit})`, '최저수압절점', `최고수압(${pressureUnit})`, `최대유속(${velocityUnit})`, '최대유속관로', '저수압', '고수압', '저유속', '고유속', '음압'];
  const body = rows.map((r) =>
    [r.factor, r.totalDemand.toFixed(2), r.minPressure.toFixed(2), r.minPressureNode, r.maxPressure.toFixed(2), r.maxVelocity.toFixed(3), r.maxVelocityLink, r.lowPressure, r.highPressure, r.lowVelocity, r.highVelocity, r.negative].join(','),
  );
  return [head.join(','), ...body].join('\r\n');
}
