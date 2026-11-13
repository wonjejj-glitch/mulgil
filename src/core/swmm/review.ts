/**
 * SWMM 해석 결과 검토 — 아무 SWMM .inp 에나 쓸 수 있는 하수·우수 관거 판정.
 *   월류(절점 flooding > 0), 지표 도달(절점 수심 ≥ 최대 수심 = 수위가 맨홀 뚜껑까지),
 *   만관(관거 수심/관경 ≥ 1, 용량 부족), 최대 유속 초과, 최소 유속 미달(전 시간 최대 유속 기준).
 * 유속 기준 기본값은 오수관로 0.6~3.0 m/s (부산 2026 설계기준 p.13·27, 하수도시설기준과 같음).
 */
import type { SwmmProject } from './inpReader';
import { LINK_VAR, NODE_VAR, type SwmmOutput } from './outReader';

export type SwmmReviewKind = 'flooding' | 'surface' | 'fullPipe' | 'highVelocity' | 'lowVelocity';

export const SWMM_REVIEW_LABELS: Record<SwmmReviewKind, string> = {
  flooding: '월류',
  surface: '수위 지표 도달',
  fullPipe: '만관(용량 부족)',
  highVelocity: '최대 유속 초과',
  lowVelocity: '최소 유속 미달',
};

export interface SwmmReviewCriteria {
  /** m/s (US 모델은 ft/s 로 바꿔 비교) */
  minVelocity: number;
  maxVelocity: number;
  /** 관거 수심/관경 이 값 이상이면 만관 */
  fullRatio: number;
}

export const DEFAULT_SWMM_REVIEW: SwmmReviewCriteria = { minVelocity: 0.6, maxVelocity: 3.0, fullRatio: 1.0 };

export interface SwmmReviewHit {
  kind: SwmmReviewKind;
  /** 'node' | 'link' */
  target: 'node' | 'link';
  id: string;
  /** 판정 값 (월류: 최대 월류량, 지표: 최대 수심, 만관: 최대 수심비, 유속: 최대 유속) */
  value: number;
  /** 기준을 넘은 시간 (시간) */
  hours: number;
  /** 최대값이 나온 기간 */
  period: number;
}

const FT = 3.280839895;

export function reviewSwmm(project: SwmmProject, out: SwmmOutput, c: SwmmReviewCriteria = DEFAULT_SWMM_REVIEW): SwmmReviewHit[] {
  const hits: SwmmReviewHit[] = [];
  const stepHours = out.reportStepSec / 3600;
  const vScale = project.us ? FT : 1;
  const N = out.nodeIds.length;
  const L = out.linkIds.length;
  const nv = out.nodeVars;
  const lv = out.linkVars;
  for (let i = 0; i < N; i++) {
    let maxFlood = 0, floodPeriod = 0, floodSteps = 0;
    let maxDepth = 0, depthPeriod = 0, fullSteps = 0;
    const rim = out.nodeMaxDepth[i];
    for (let t = 0; t < out.periods; t++) {
      const base = (t * N + i) * nv;
      const flood = out.node[base + NODE_VAR.flooding];
      const depth = out.node[base + NODE_VAR.depth];
      if (flood > 1e-6) floodSteps++;
      if (flood > maxFlood) [maxFlood, floodPeriod] = [flood, t];
      if (depth > maxDepth) [maxDepth, depthPeriod] = [depth, t];
      if (rim > 0 && depth >= rim - 1e-3) fullSteps++;
    }
    const isOutfall = out.nodeTypes[i] === 1;
    if (maxFlood > 1e-6) hits.push({ kind: 'flooding', target: 'node', id: out.nodeIds[i], value: maxFlood, hours: floodSteps * stepHours, period: floodPeriod });
    else if (!isOutfall && fullSteps > 0) hits.push({ kind: 'surface', target: 'node', id: out.nodeIds[i], value: maxDepth, hours: fullSteps * stepHours, period: depthPeriod });
  }
  for (let j = 0; j < L; j++) {
    if (out.linkTypes[j] !== 0) continue; // 관거만
    let maxRatio = 0, ratioPeriod = 0, fullSteps = 0;
    let maxV = 0, vPeriod = 0, fastSteps = 0;
    let maxQ = 0;
    for (let t = 0; t < out.periods; t++) {
      const base = (t * L + j) * lv;
      const ratio = out.link[base + LINK_VAR.capacity];
      const v = Math.abs(out.link[base + LINK_VAR.velocity]);
      maxQ = Math.max(maxQ, Math.abs(out.link[base + LINK_VAR.flow]));
      if (ratio > maxRatio) [maxRatio, ratioPeriod] = [ratio, t];
      if (ratio >= c.fullRatio - 1e-6) fullSteps++;
      if (v > maxV) [maxV, vPeriod] = [v, t];
      if (v > c.maxVelocity * vScale) fastSteps++;
    }
    const id = out.linkIds[j];
    if (fullSteps > 0) hits.push({ kind: 'fullPipe', target: 'link', id, value: maxRatio, hours: fullSteps * stepHours, period: ratioPeriod });
    if (maxV > c.maxVelocity * vScale) hits.push({ kind: 'highVelocity', target: 'link', id, value: maxV, hours: fastSteps * stepHours, period: vPeriod });
    // 흐름이 아예 없는 관(건기 우수관 등)은 유속 판정에서 뺀다
    if (maxQ > 1e-6 && maxV < c.minVelocity * vScale) hits.push({ kind: 'lowVelocity', target: 'link', id, value: maxV, hours: 0, period: vPeriod });
  }
  return hits;
}
