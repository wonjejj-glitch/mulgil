/**
 * 방류구 관저고 자동 맞춤.
 * 설계에서 방류구 관저고는 고정값이라, 너무 얕게 주면 마지막 관이 역경사·만관이 된다(평지에서 상류가 깊어질 때 흔함).
 * 이 설계 알고리즘에서 방류구 바로 위 맨홀의 관정은 방류구 표고와 무관하게 정해지므로(SPEC: 공통 관정은 방류구를 건드리지 않음)
 *   1) 방류구를 일단 충분히 깊게 두고 설계해 위 맨홀 관정과 마지막 관 관경·유량을 얻고
 *   2) 마지막 관이 필요한 경사(최소 경사·d/D·유속)를 갖도록 방류구 관저고 = 위 관정 − 경사×연장 − 관경 으로 정한다.
 * 결과 깊이가 최대 굴착깊이를 넘으면 설계 검토에 그대로 나온다(중계펌프장 검토 대상).
 */
import { designSewer, type DesignMode, type PracticalRules } from './design';
import { requiredSlope } from './hydraulics';
import type { SewerProject } from './types';

export interface OutfallChange {
  id: string;
  from: number;
  to: number;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function fitOutfallInverts(input: SewerProject, mode: DesignMode = 'practical', rules: PracticalRules = {}): { project: SewerProject; changes: OutfallChange[] } {
  const p: SewerProject = JSON.parse(JSON.stringify(input));
  const k = p.constraints;
  const targets = p.nodes.filter((n) => n.kind === 'OUTFALL' && p.conduits.filter((c) => c.downstream === n.id).length === 1);
  if (targets.length === 0) return { project: p, changes: [] };
  const original = new Map(targets.map((n) => [n.id, n.invert]));
  // 1) 방류구가 상류 설계를 제약하지 않도록 아주 깊게 (지반고보다는 낮게 유지)
  for (const n of targets) n.invert = Math.min(n.invert, n.ground - Math.max(k.max_depth, 1) * 3);
  const first = designSewer(p, {}, mode, rules);
  const nodeOf = new Map(first.project.nodes.map((n) => [n.id, n]));
  const changes: OutfallChange[] = [];
  for (const n of targets) {
    const c = first.project.conduits.find((x) => x.downstream === n.id)!;
    const u = nodeOf.get(c.upstream)!;
    const crownU = u.invert + c.inlet_offset + c.diameter;
    const q = first.rows.find((r) => r.id === c.id)?.flow ?? 0;
    let s = Math.max(k.min_slope, requiredSlope(q, c.diameter, c.roughness, k.max_depth_ratio, k.min_velocity));
    // 최소 유속을 어떤 경사로도 못 내면(소유량) d/D 조건만으로
    if (s > k.max_slope) s = Math.max(k.min_slope, requiredSlope(q, c.diameter, c.roughness, k.max_depth_ratio, 0));
    s = Math.min(s, k.max_slope);
    const invert = round3(crownU - s * c.length - c.diameter);
    const target = p.nodes.find((x) => x.id === n.id)!;
    target.invert = invert;
    if (target.boundary === 'FIXED' && target.stage !== null && target.stage < invert) target.stage = invert;
    changes.push({ id: n.id, from: original.get(n.id)!, to: invert });
  }
  return { project: p, changes };
}
