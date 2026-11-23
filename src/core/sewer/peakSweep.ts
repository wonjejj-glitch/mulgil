/**
 * 하수 첨두계수(오수량 배율) 비교: 맨홀 오수 유입(base_flow)에 배율을 곱해 SWMM 으로 차례로 해석하고
 * 만관·월류·유속·펌프장 결과를 한 표로 비교한다. 관경·관저고는 그대로 둔다(설계 결과 또는 현황).
 */
import type { SimulationSummary } from './report';
import type { SewerProject } from './types';

export interface SewerFactorRow {
  factor: number;
  /** 맨홀 오수 유입 합 (m³/s, 배율 적용) */
  sewage: number;
  /** 관거 최대 수심비 d/D 와 그 관거 */
  maxDepthRatio: number;
  maxDepthRatioLink: string;
  /** 설계 d/D 기준을 넘은 관거 수 */
  overRatio: number;
  /** 만관(관정 위로 수위) 맨홀 수 */
  surcharged: number;
  /** 월류 맨홀 수와 총 월류량 (m³) */
  flooded: number;
  floodVolume: number;
  maxVelocity: number;
  /** 펌프장 최대 가동률 (%), 펌프가 없으면 null */
  pumpUtilization: number | null;
  continuity: number;
}

/** 오수 유입에 배율을 곱한 복사본. rain=false 면 유역(강우 유출)을 빼 오수만 본다. */
export function scaledSewerProject(p: SewerProject, factor: number, rain: boolean): SewerProject {
  const q: SewerProject = JSON.parse(JSON.stringify(p));
  for (const n of q.nodes) n.base_flow = n.base_flow * factor;
  if (!rain) q.catchments = [];
  return q;
}

export function summarizeFactor(p: SewerProject, factor: number, sim: SimulationSummary): SewerFactorRow {
  let maxDepthRatio = 0;
  let maxDepthRatioLink = '';
  let overRatio = 0;
  let maxVelocity = 0;
  for (const [id, l] of Object.entries(sim.link_summary)) {
    if (l.max_depth_ratio > maxDepthRatio) [maxDepthRatio, maxDepthRatioLink] = [l.max_depth_ratio, id];
    if (l.max_depth_ratio > p.constraints.max_depth_ratio + 1e-6) overRatio++;
    if (l.max_velocity > maxVelocity) maxVelocity = l.max_velocity;
  }
  const nodes = Object.values(sim.node_summary);
  const pumps = Object.values(sim.pump_summary ?? {});
  return {
    factor,
    sewage: p.nodes.reduce((a, n) => a + n.base_flow, 0),
    maxDepthRatio,
    maxDepthRatioLink,
    overRatio,
    surcharged: nodes.filter((n) => n.surcharged).length,
    flooded: nodes.filter((n) => n.flood_hours > 0).length,
    floodVolume: nodes.reduce((a, n) => a + n.flood_volume_m3, 0),
    maxVelocity,
    pumpUtilization: pumps.length > 0 ? Math.max(...pumps.map((x) => x.utilized)) : null,
    continuity: sim.continuity['Flow Routing Continuity'] ?? 0,
  };
}

export function sewerFactorCsv(rows: SewerFactorRow[]): string {
  const head = ['배율', '오수유입합(L/s)', '최대d/D', '최대d/D관거', 'd/D초과관거', '만관맨홀', '월류맨홀', '월류량(m3)', '최대유속(m/s)', '펌프최대가동률(%)', '연속성오차(%)'];
  const body = rows.map((r) =>
    [r.factor, (r.sewage * 1000).toFixed(2), r.maxDepthRatio.toFixed(2), r.maxDepthRatioLink, r.overRatio, r.surcharged, r.flooded, r.floodVolume.toFixed(1), r.maxVelocity.toFixed(2), r.pumpUtilization?.toFixed(1) ?? '', r.continuity.toFixed(2)].join(','),
  );
  return [head.join(','), ...body].join('\r\n');
}
