/**
 * 하수관 검토 목록 — 기존 하수 설계 프로그램의 '검토 목록' 판정 체계를 따른다.
 *   Overflow(통수능 부족) · 최소 유속 미달 · 최대 유속 초과 · 동수위 오류 · 역경사
 * 판정은 GOOD / NG / -(계산 안 됨). 동수위는 SWMM 해석 결과가 있어야 판정한다.
 * 기본값(0.6·3.0 m/s, GL+0 m)은 그 프로그램의 기본값이며 사업 기준에 맞춰 바꿔 쓴다.
 */
import { fullFlow, type DesignResult } from './design';
import type { SimulationSummary } from './report';
import type { SewerProject } from './types';

export type Verdict = 'GOOD' | 'NG' | '-';
export type ReviewKind = 'overflow' | 'minVelocity' | 'maxVelocity' | 'hgl' | 'adverse';

export const REVIEW_KINDS: { kind: ReviewKind; label: string; rule: string }[] = [
  { kind: 'overflow', label: 'Overflow', rule: '설계 유량 > 만관 유량 (해석 결과가 있으면 만관 초과 수위 포함)' },
  { kind: 'minVelocity', label: '최소 유속 미달', rule: '판정 유속 < 최소 유속' },
  { kind: 'maxVelocity', label: '최대 유속 초과', rule: '판정 유속 > 최대 유속' },
  { kind: 'hgl', label: '동수위 오류', rule: '시점 또는 종점 동수위 > 지반고 + 판정 기준' },
  { kind: 'adverse', label: '역경사', rule: '관로 구배 < 0' },
];

export interface ReviewCriteria {
  minVelocity: number;
  maxVelocity: number;
  /** 동수위 판정 기준: 지반고 + 이 값 (m). GL+0 이면 지반고를 넘으면 오류. */
  hglAboveGround: number;
  /** 'actual' 실유속(부분 충만) / 'full' 만관 유속 */
  velocityBasis: 'actual' | 'full';
}

export const DEFAULT_REVIEW: ReviewCriteria = { minVelocity: 0.6, maxVelocity: 3.0, hglAboveGround: 0, velocityBasis: 'actual' };

export interface ReviewRow {
  id: string;
  upstream: string;
  downstream: string;
  diameter: number;
  length: number;
  /** 하류 끝까지가 아니라 상류 말단에서 이 관 끝까지의 최장 누가 연장 (m). */
  cumLength: number;
  groundUp: number;
  groundDown: number;
  invertUp: number;
  invertDown: number;
  coverUp: number;
  coverDown: number;
  /** ‰ */
  slopePermil: number;
  flow: number;
  fullFlow: number;
  fullVelocity: number;
  velocity: number;
  depthRatio: number;
  /** 사용율 = 설계 유량 / 만관 유량 (%) */
  usage: number;
  hglUp: number | null;
  hglDown: number | null;
  /** 시작관(유입 관 없음) */
  isStart: boolean;
  /** 관말(방류구로 나가는 관) */
  isEnd: boolean;
  verdict: Record<ReviewKind, Verdict>;
  ng: boolean;
}

export function reviewSewer(design: DesignResult, simulation: SimulationSummary | null, criteria: ReviewCriteria = DEFAULT_REVIEW): ReviewRow[] {
  const p: SewerProject = design.project;
  const nodes = new Map(p.nodes.map((n) => [n.id, n]));
  const inflow = new Map<string, number>();
  for (const c of p.conduits) inflow.set(c.downstream, (inflow.get(c.downstream) ?? 0) + 1);
  const rowById = new Map(design.rows.map((r) => [r.id, r]));

  // 누가 연장: 상류부터 (방류구 방향 위상 순서로) 최장 거리
  const reach = new Map<string, number>();
  const pendingIn = new Map(p.nodes.map((n) => [n.id, inflow.get(n.id) ?? 0]));
  const queue = p.nodes.filter((n) => (inflow.get(n.id) ?? 0) === 0).map((n) => n.id);
  const outOf = new Map<string, typeof p.conduits>();
  for (const c of p.conduits) outOf.set(c.upstream, [...(outOf.get(c.upstream) ?? []), c]);
  const cum = new Map<string, number>();
  while (queue.length > 0) {
    const u = queue.shift()!;
    for (const c of outOf.get(u) ?? []) {
      const total = (reach.get(u) ?? 0) + c.length;
      cum.set(c.id, total);
      reach.set(c.downstream, Math.max(reach.get(c.downstream) ?? 0, total));
      const left = pendingIn.get(c.downstream)! - 1;
      pendingIn.set(c.downstream, left);
      if (left === 0) queue.push(c.downstream);
    }
  }

  return p.conduits.map((c) => {
    const u = nodes.get(c.upstream)!;
    const v = nodes.get(c.downstream)!;
    const r = rowById.get(c.id);
    const invertUp = u.invert + c.inlet_offset;
    const invertDown = v.invert + c.outlet_offset;
    const slope = (invertUp - invertDown) / c.length;
    const qFull = slope > 0 ? fullFlow(c.diameter, slope, c.roughness) : 0;
    const area = (Math.PI * c.diameter ** 2) / 4;
    const vFull = qFull / area;
    const flow = r?.flow ?? 0;
    const velocity = r?.velocity ?? 0;
    const judgedV = criteria.velocityBasis === 'full' ? vFull : velocity;
    const hglUp = simulation?.node_summary[u.id]?.max_hgl ?? null;
    const hglDown = simulation?.node_summary[v.id]?.max_hgl ?? null;
    const simRatio = simulation?.link_summary[c.id]?.max_depth_ratio;

    const overflow: Verdict = flow > qFull + 1e-12 || (simRatio !== undefined && simRatio >= 0.999) || simulation?.node_summary[u.id]?.surcharged ? 'NG' : 'GOOD';
    const hasFlow = flow > 0;
    const minV: Verdict = !hasFlow ? '-' : judgedV < criteria.minVelocity - 1e-9 ? 'NG' : 'GOOD';
    const maxV: Verdict = !hasFlow ? '-' : judgedV > criteria.maxVelocity + 1e-9 ? 'NG' : 'GOOD';
    const above = (h: number | null, ground: number) => h !== null && h > ground + criteria.hglAboveGround + 1e-9;
    const hgl: Verdict =
      hglUp === null && hglDown === null
        ? '-'
        : above(hglUp, u.ground) || (v.kind !== 'OUTFALL' && above(hglDown, v.ground))
          ? 'NG'
          : 'GOOD';
    const adverse: Verdict = slope < 0 ? 'NG' : 'GOOD';
    const verdict = { overflow, minVelocity: minV, maxVelocity: maxV, hgl, adverse };
    return {
      id: c.id,
      upstream: u.id,
      downstream: v.id,
      diameter: c.diameter,
      length: c.length,
      cumLength: cum.get(c.id) ?? c.length,
      groundUp: u.ground,
      groundDown: v.ground,
      invertUp,
      invertDown,
      coverUp: u.ground - invertUp - c.diameter,
      coverDown: v.ground - invertDown - c.diameter,
      slopePermil: slope * 1000,
      flow,
      fullFlow: qFull,
      fullVelocity: vFull,
      velocity,
      depthRatio: r?.depth_ratio ?? 0,
      usage: qFull > 0 ? (flow / qFull) * 100 : Infinity,
      hglUp,
      hglDown,
      isStart: (inflow.get(u.id) ?? 0) === 0,
      isEnd: v.kind === 'OUTFALL',
      verdict,
      ng: Object.values(verdict).includes('NG'),
    };
  });
}

/** 검토 목록 CSV (엑셀에서 바로 열리도록 BOM 포함). */
export function reviewCsv(rows: ReviewRow[]): string {
  const head = [
    '관로번호', '시점맨홀', '종점맨홀', '관경(m)', '연장(m)', '누가연장(m)', '시점지반고', '종점지반고', '시점관저고', '종점관저고', '시점토피', '종점토피',
    '구배(‰)', '설계유량(m3/s)', '만관유량(m3/s)', '만관유속(m/s)', '실유속(m/s)', '수심비(d/D)', '사용율(%)', '시점동수위', '종점동수위',
    ...REVIEW_KINDS.map((k) => `판정(${k.label})`),
  ];
  const f = (x: number | null, d: number) => (x === null || !Number.isFinite(x) ? '' : x.toFixed(d));
  const lines = rows.map((r) =>
    [
      r.id, r.upstream, r.downstream, f(r.diameter, 3), f(r.length, 2), f(r.cumLength, 2), f(r.groundUp, 3), f(r.groundDown, 3), f(r.invertUp, 3), f(r.invertDown, 3),
      f(r.coverUp, 3), f(r.coverDown, 3), f(r.slopePermil, 2), f(r.flow, 5), f(r.fullFlow, 5), f(r.fullVelocity, 3), f(r.velocity, 3), f(r.depthRatio, 3),
      f(r.usage, 1), f(r.hglUp, 3), f(r.hglDown, 3), ...REVIEW_KINDS.map((k) => r.verdict[k.kind]),
    ].join(','),
  );
  return `${String.fromCharCode(0xfeff)}${[head.join(','), ...lines].join('\r\n')}\r\n`;
}
