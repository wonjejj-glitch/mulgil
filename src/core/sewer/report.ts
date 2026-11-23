/**
 * SWMM 보고서(.rpt) 요약표 읽기와 해석 요약(simulate 경계) — SPEC §7, §5 끝.
 * 실제 SI·영어 SWMM RPT 만 가정한다 (US 단위·다른 언어·잘린 숫자는 범용 지원하지 않음).
 */
import type { SewerProject } from './types';

export interface ReportNode {
  max_depth?: number;
  max_hgl?: number;
  flood_hours?: number;
  max_flood?: number;
  flood_volume_m3?: number;
}
export interface ReportLink {
  max_flow: number;
  max_velocity: number;
  max_depth_ratio: number;
}
/** SWMM 'Pumping Summary' 한 줄 */
export interface ReportPump {
  /** 가동 시간 비율 (%) */
  utilized: number;
  startups: number;
  avg_flow: number;
  max_flow: number;
  /** 펌프 곡선 범위를 벗어난 시간 (%, 낮은 쪽·높은 쪽) */
  off_curve_low: number;
  off_curve_high: number;
}

export interface ParsedReport {
  nodes: Record<string, ReportNode>;
  links: Record<string, ReportLink>;
  /** 펌프가 있을 때만 */
  pumps?: Record<string, ReportPump>;
  continuity: Record<string, number>;
  warnings: string[];
}

export class SewerReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SewerReportError';
  }
}

const SECTION = /^([A-Za-z][A-Za-z /-]*? (?:Summary|Continuity))(?=\s|$)/;

export function parseReport(text: string, project: SewerProject): ParsedReport {
  const nodeIds = new Set(project.nodes.map((n) => n.id));
  const linkIds = new Set(project.conduits.map((c) => c.id));
  const pumpIds = new Set((project.pumps ?? []).map((x) => x.id));
  const pumps: Record<string, ReportPump> = {};
  const nodes: Record<string, ReportNode> = {};
  const links: Record<string, ReportLink> = {};
  const continuity: Record<string, number> = {};
  const warnings: string[] = [];
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const title = SECTION.exec(line);
    if (title) section = title[1];
    if (line.includes('WARNING')) warnings.push(line);
    if (line.includes('Continuity Error (%)')) {
      const last = line.split(/\s+/).pop() as string;
      continuity[section] = Number(last);
      continue;
    }
    const parts = line.split(/\s+/);
    if (section === 'Node Depth Summary' && nodeIds.has(parts[0]) && parts.length >= 8) {
      nodes[parts[0]] = { ...nodes[parts[0]], max_depth: Number(parts[3]), max_hgl: Number(parts[4]) };
    } else if (section === 'Node Flooding Summary' && nodeIds.has(parts[0]) && parts.length >= 7) {
      // 체적 열은 10^6 litre = 1000 m³
      nodes[parts[0]] = { ...nodes[parts[0]], flood_hours: Number(parts[1]), max_flood: Number(parts[2]), flood_volume_m3: Number(parts[5]) * 1000 };
    } else if (section === 'Pumping Summary' && pumpIds.has(parts[0]) && parts.length >= 10) {
      pumps[parts[0]] = {
        utilized: Number(parts[1]),
        startups: Number(parts[2]),
        avg_flow: Number(parts[4]),
        max_flow: Number(parts[5]),
        off_curve_low: Number(parts[parts.length - 2]),
        off_curve_high: Number(parts[parts.length - 1]),
      };
    } else if (section === 'Link Flow Summary' && linkIds.has(parts[0]) && parts.length >= 8) {
      // '>50.00' 같은 하한 표기는 50 으로 축소된다 (원본과 같은 동작, QUESTIONS 11)
      links[parts[0]] = { max_flow: Number(parts[2]), max_velocity: Number(parts[5].replace(/>/g, '')), max_depth_ratio: Number(parts[7]) };
    }
  }
  const sameKeys = (a: Record<string, unknown>, b: Set<string>) => Object.keys(a).length === b.size && Object.keys(a).every((k) => b.has(k));
  if (!sameKeys(nodes, nodeIds) || !sameKeys(links, linkIds)) throw new SewerReportError('SWMM 요약표에서 일부 객체 결과를 찾을 수 없습니다.');
  if (!('Flow Routing Continuity' in continuity)) throw new SewerReportError('SWMM 유량 연속성 오차를 찾을 수 없습니다.');
  return { nodes, links, continuity, warnings, ...(pumpIds.size > 0 ? { pumps } : {}) };
}

export interface NodeSummary {
  max_depth: number;
  max_hgl: number;
  flood_hours: number;
  /** 월류가 있던 절점에만 있다 (원본과 같음) */
  max_flood?: number;
  flood_volume_m3: number;
  surcharged: boolean;
}

export interface SimulationSummary {
  continuity: Record<string, number>;
  warnings: string[];
  node_summary: Record<string, NodeSummary>;
  link_summary: Record<string, ReportLink>;
  /** 펌프장 결과 (펌프가 있을 때만) */
  pump_summary?: Record<string, ReportPump>;
  quality_ok: boolean;
}

/**
 * 파싱한 보고서에 원본 simulate() 의 후처리를 더한 반복 검토용 요약.
 * - 누락된 월류 값은 0
 * - surcharged: 최대 HGL 이 접속 관로 관정 최대보다 0.01 m 넘게 높음 (방류구 제외)
 * - quality_ok: 연속성 오차 절댓값이 모두 허용치 이하이고 경고가 없음
 */
export function summarizeSimulation(project: SewerProject, report: ParsedReport): SimulationSummary {
  const crownMax = new Map<string, number>();
  const nodeById = new Map(project.nodes.map((n) => [n.id, n]));
  for (const c of project.conduits) {
    const up = nodeById.get(c.upstream)!;
    const down = nodeById.get(c.downstream)!;
    const upCrown = up.invert + c.inlet_offset + c.diameter;
    const downCrown = down.invert + c.outlet_offset + c.diameter;
    crownMax.set(up.id, Math.max(crownMax.get(up.id) ?? -Infinity, upCrown));
    crownMax.set(down.id, Math.max(crownMax.get(down.id) ?? -Infinity, downCrown));
  }
  const node_summary: Record<string, NodeSummary> = {};
  for (const n of project.nodes) {
    const r = report.nodes[n.id];
    const maxHgl = r.max_hgl ?? 0;
    node_summary[n.id] = {
      max_depth: r.max_depth ?? 0,
      max_hgl: maxHgl,
      flood_hours: r.flood_hours ?? 0,
      ...(r.max_flood !== undefined ? { max_flood: r.max_flood } : {}),
      flood_volume_m3: r.flood_volume_m3 ?? 0,
      surcharged: n.kind !== 'OUTFALL' && maxHgl > (crownMax.get(n.id) ?? Infinity) + 0.01,
    };
  }
  const tolerance = project.constraints.continuity_tolerance;
  const quality_ok = Object.values(report.continuity).every((v) => Math.abs(v) <= tolerance) && report.warnings.length === 0;
  return {
    continuity: report.continuity,
    warnings: report.warnings,
    node_summary,
    link_summary: report.links,
    ...(report.pumps ? { pump_summary: report.pumps } : {}),
    quality_ok,
  };
}
