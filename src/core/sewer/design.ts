/**
 * 하수관 초기 설계 (SewerStudio design.py 호환 구현, SPEC §4).
 * 탐욕적 휴리스틱이다: 상류부터 지반 경사 예산·유속을 만족하는 가장 작은 표준 관경을 고르고,
 * 맨홀마다 공통 관정을 맞춘다. 비용 최적화·GVF 수면곡선 해석이 아니다.
 */
import { manning, normalRatio, requiredSlope, section } from './hydraulics';
import { accumulatedFlows, buildNetwork } from './topology';
import type { SewerProject } from './types';
import { revalidate } from './validate';

export interface DesignRow {
  id: string;
  diameter: number;
  flow: number;
  slope: number;
  velocity: number;
  depth_ratio: number;
  cover: number;
  status: string;
  /** 실무 모드에서 하류 맨홀 안 낙차(부관) 높이 (m). 원본 호환 모드에는 없다. */
  drop?: number;
}

export interface DesignResult {
  project: SewerProject;
  rows: DesignRow[];
  issues: string[];
  feasible: boolean;
  /**
   * 참고 사항 (위반으로 세지 않음). 지금은 '최소유속 미달' — 유량이 적은 오수관은 최소 관경·최소 경사로도
   * 최소 유속을 못 채우는 것이 보통이라, 위반이 아니라 퇴적 점검 참고로만 알린다.
   */
  notes?: string[];
  /** 현황 해석(survey.ts asBuiltDesign) 결과면 true — 관경·관저고를 새로 정하지 않았다. */
  asBuilt?: boolean;
}

/** 상태 문구에 붙는 참고 표시 — 관은 '적합' 색으로 남는다. */
export const LOW_VELOCITY_NOTE = '최소유속 미달(참고)';

export class SewerDesignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SewerDesignError';
  }
}

const fixed2 = (x: number) => x.toFixed(2);

/**
 * 'compat'   : SewerStudio 와 같은 동작 (정답 벡터 기준). 조건을 만족하는 후보가 없으면 가장 큰 관경.
 * 'practical': 같은 탐색을 먼저 하고, 후보가 없을 때 최소 유속 조건만 빼고 다시 찾는다.
 *              상류 말단처럼 유량이 아주 작아 어떤 경사로도 최소 유속을 못 내는 관에 큰 관을 넣지 않고,
 *              작은 관·최소 경사로 두고 저유속은 위반이 아닌 참고(notes)로 남긴다 (실무 관행).
 */
export type DesignMode = 'compat' | 'practical';

/** 실무 모드 세부 규칙 (설계기준 프리셋에서 채운다). 없으면 해당 규칙을 쓰지 않는다. */
export interface PracticalRules {
  /** 관 설계 유량 하한 (m³/s). 0 보다 크고 이 값보다 작으면 이 값으로 올린다 (예: 0.001). */
  minFlow?: number;
  /** 맨홀 안 단차가 이 값(m) 이상이면 '부관', 미만이면 '단차'로 표기. */
  dropPipeAt?: number;
  /** 맨홀 1곳 단차 상한 (m). 넘으면 위반. */
  maxDrop?: number;
}

export function designSewer(
  input: SewerProject,
  diameterFloors: Record<string, number> = {},
  mode: DesignMode = 'compat',
  rules: PracticalRules = {},
): DesignResult {
  const p: SewerProject = JSON.parse(JSON.stringify(input));
  const g = buildNetwork(p);
  const q = accumulatedFlows(p, g);
  if (mode === 'practical' && rules.minFlow) {
    for (const id in q) if (q[id] > 0 && q[id] < rules.minFlow) q[id] = rules.minFlow;
  }
  const cst = p.constraints;
  const slopes: Record<string, number> = {};
  const issues: string[] = [];

  // A. 후보 관경과 목표 경사 (상류 → 하류)
  for (const u of g.order) {
    for (const { to: v, conduit: c } of g.out.get(u)!) {
      const upstreamD = Math.max(0, ...g.inn.get(u)!.map((e) => e.conduit.diameter));
      const floor = Math.max(upstreamD, diameterFloors[c.id] ?? 0);
      const candidates = cst.diameters.filter((d) => d >= floor - 1e-8);
      if (candidates.length === 0) throw new SewerDesignError(`${c.id}: 최소 관경이 표준 관경 상한을 초과합니다.`);
      const gradeBudget = Math.min(cst.max_slope, Math.max(cst.min_slope, (g.nodes.get(u)!.ground - g.nodes.get(v)!.ground) / c.length));
      let chosen: [number, number] | null = null;
      for (const d of candidates) {
        const s = Math.max(cst.min_slope, requiredSlope(q[c.id], d, c.roughness, cst.max_depth_ratio, cst.min_velocity));
        const ratio = normalRatio(q[c.id], d, s, c.roughness);
        const [a] = section(d, ratio);
        const vel = a ? q[c.id] / a : 0;
        if (s <= gradeBudget + 1e-8 && vel <= cst.max_velocity + 1e-8) {
          chosen = [d, s];
          break;
        }
      }
      if (chosen === null && mode === 'practical') {
        for (const d of candidates) {
          const s = Math.max(cst.min_slope, requiredSlope(q[c.id], d, c.roughness, cst.max_depth_ratio, 0));
          const ratio = normalRatio(q[c.id], d, s, c.roughness);
          const [a] = section(d, ratio);
          const vel = a ? q[c.id] / a : 0;
          if (s <= gradeBudget + 1e-8 && vel <= cst.max_velocity + 1e-8) {
            chosen = [d, s];
            break;
          }
        }
      }
      if (chosen === null) {
        const d = candidates[candidates.length - 1];
        const needed = Math.max(cst.min_slope, requiredSlope(q[c.id], d, c.roughness, cst.max_depth_ratio, cst.min_velocity));
        chosen = [d, Math.min(cst.max_slope, needed)];
        if (needed > cst.max_slope) issues.push(`${c.id}: 표준 관경·경사 범위에서 설계 유량을 만족하는 후보가 없습니다.`);
      }
      c.diameter = chosen[0];
      slopes[c.id] = chosen[1];
    }
  }

  // B. 공통 관정 (맨홀마다 연결 관로 중 최대 관경 기준)
  const maxD = new Map<string, number>();
  for (const n of p.nodes) {
    const all = [...g.inn.get(n.id)!.map((e) => e.conduit.diameter), ...g.out.get(n.id)!.map((e) => e.conduit.diameter)];
    maxD.set(n.id, Math.max(...all));
  }
  const crowns = new Map(p.nodes.map((n) => [n.id, n.ground - cst.min_cover]));
  for (const n of p.nodes) if (n.kind === 'OUTFALL') crowns.set(n.id, n.invert + maxD.get(n.id)!);
  for (const u of g.order) {
    for (const { to: v, conduit: c } of g.out.get(u)!) {
      const bound = crowns.get(u)! - slopes[c.id] * c.length;
      if (g.nodes.get(v)!.kind !== 'OUTFALL') crowns.set(v, Math.min(crowns.get(v)!, bound));
    }
  }
  for (const n of p.nodes) {
    if (n.kind !== 'OUTFALL') n.invert = crowns.get(n.id)! - maxD.get(n.id)!;
    if (n.ground - n.invert > cst.max_depth + 1e-7) issues.push(`${n.id}: 굴착깊이 ${fixed2(n.ground - n.invert)} m > ${fixed2(cst.max_depth)} m`);
  }

  // C. 실제 기하 재검토
  const nodeOf = new Map(p.nodes.map((n) => [n.id, n]));
  const rows: DesignRow[] = [];
  const notes: string[] = [];
  for (const c of p.conduits) {
    const u = nodeOf.get(c.upstream)!;
    const v = nodeOf.get(c.downstream)!;
    c.inlet_offset = maxD.get(u.id)! - c.diameter;
    c.outlet_offset = maxD.get(v.id)! - c.diameter;
    let slope = (crowns.get(u.id)! - crowns.get(v.id)!) / c.length;
    // 실무 모드: 얕은 지선이 깊은 간선 맨홀로 들어가며 경사가 최대 경사를 넘으면, 관은 목표 경사로 두고
    // 남는 높이를 하류 맨홀 안 낙차(부관, 유출 옵셋)로 처리한다.
    let drop = 0;
    if (mode === 'practical' && slope > cst.max_slope + 1e-8) {
      const crownU = crowns.get(u.id)!;
      // 하류 끝 관정도 최소 토피 아래에 묻혀야 한다 (급경사 지형에서 관이 땅 위로 나오지 않게)
      const buried = (crownU - (v.ground - cst.min_cover)) / c.length;
      const target = Math.max(Math.min(cst.max_slope, Math.max(cst.min_slope, slopes[c.id])), buried);
      if (target < slope - 1e-9) {
        drop = crownU - target * c.length - crowns.get(v.id)!;
        c.outlet_offset += drop;
        slope = target;
      }
    }
    const ratio = normalRatio(q[c.id], c.diameter, slope, c.roughness);
    const [a] = section(c.diameter, ratio);
    const vel = a ? q[c.id] / a : 0;
    const cover = Math.min(u.ground - crowns.get(u.id)!, v.ground - crowns.get(v.id)!);
    const problems: string[] = [];
    if (slope < cst.min_slope - 1e-8 || slope > cst.max_slope + 1e-8) problems.push('경사 범위');
    if (cover < cst.min_cover - 1e-8) problems.push('최소 토피');
    if (ratio > cst.max_depth_ratio + 1e-7) problems.push('설계 d/D');
    // 원본 호환 모드는 정답 벡터와 같아야 하므로 저유속도 '유속 범위' 위반으로 둔다.
    const slow = q[c.id] > 0 && vel < cst.min_velocity - 1e-7;
    const lowNote = slow && mode === 'practical';
    if (vel > cst.max_velocity + 1e-7 || (slow && !lowNote)) problems.push(lowNote ? '최대유속 초과' : '유속 범위');
    if (lowNote) notes.push(`${c.id}: 유속 ${vel.toFixed(2)} m/s — 최소 ${cst.min_velocity} m/s 미달`);
    if (Math.max(u.ground - u.invert, v.ground - v.invert) > cst.max_depth + 1e-7) problems.push('굴착깊이');
    if (rules.maxDrop !== undefined && drop > rules.maxDrop + 1e-7) problems.push(`단차 ${rules.maxDrop} m 초과`);
    if (problems.length > 0) issues.push(`${c.id}: ${problems.join(', ')} 제약 위반`);
    rows.push({
      id: c.id,
      diameter: c.diameter,
      flow: q[c.id],
      slope,
      velocity: vel,
      depth_ratio: ratio,
      cover,
      status:
        (problems.length > 0 ? problems.join(' / ') : '적합') +
        (lowNote ? ` · ${LOW_VELOCITY_NOTE}` : '') +
        (drop > 0 ? ` · ${rules.dropPipeAt === undefined || drop >= rules.dropPipeAt ? '부관 낙차' : '단차'} ${drop.toFixed(2)} m` : ''),
      ...(drop > 0 ? { drop } : {}),
    });
  }
  // 변경된 표고·관경 전체를 다시 검증한다 (ground ≤ invert 가 되면 예외).
  return { project: revalidate(p), rows, issues, feasible: issues.length === 0, ...(notes.length > 0 ? { notes } : {}) };
}

/** 만관 유량 (m³/s) — 화면 표시용 보조 */
export function fullFlow(diameter: number, slope: number, roughness: number): number {
  return manning(diameter, slope, roughness, 1);
}
