/**
 * 수지상 중력 관망 그래프: 검증, networkx 와 같은 위상 순서, 설계 유량 누적 (SPEC §3).
 */
import type { SewerConduit, SewerNode, SewerProject } from './types';

export class SewerTopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SewerTopologyError';
  }
}

export interface SewerGraph {
  nodes: Map<string, SewerNode>;
  /** 노드 → [하류 절점, 관로] (간선 삽입 순서) */
  out: Map<string, { to: string; conduit: SewerConduit }[]>;
  inn: Map<string, { from: string; conduit: SewerConduit }[]>;
  /** networkx 3.x topological_sort 와 같은 세대별(Kahn) 순서 */
  order: string[];
}

/** 병렬 → 순환 → 절점 차수 순으로 검사한다 (SPEC §3). */
export function buildNetwork(project: SewerProject): SewerGraph {
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  const out = new Map<string, { to: string; conduit: SewerConduit }[]>();
  const inn = new Map<string, { from: string; conduit: SewerConduit }[]>();
  for (const n of project.nodes) {
    out.set(n.id, []);
    inn.set(n.id, []);
  }
  for (const c of project.conduits) {
    if (out.get(c.upstream)!.some((e) => e.to === c.downstream)) {
      throw new SewerTopologyError('첫 버전은 동일 절점 사이 병렬 관로를 지원하지 않습니다.');
    }
    out.get(c.upstream)!.push({ to: c.downstream, conduit: c });
    inn.get(c.downstream)!.push({ from: c.upstream, conduit: c });
  }

  // Kahn 세대별 순회: 진입차수 0 절점을 삽입순으로 모으고, 그 세대를 순서대로 처리하며 다음 세대를 만든다.
  const indegree = new Map(project.nodes.map((n) => [n.id, inn.get(n.id)!.length]));
  let generation = project.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (generation.length > 0) {
    const next: string[] = [];
    for (const id of generation) {
      order.push(id);
      for (const e of out.get(id)!) {
        const d = indegree.get(e.to)! - 1;
        indegree.set(e.to, d);
        if (d === 0) next.push(e.to);
      }
    }
    generation = next;
  }
  if (order.length < project.nodes.length) throw new SewerTopologyError('순환 관망입니다. 첫 버전은 중력식 수지상 관망을 지원합니다.');

  for (const n of project.nodes) {
    const outDeg = out.get(n.id)!.length;
    const inDeg = inn.get(n.id)!.length;
    if (n.kind === 'OUTFALL') {
      if (!(outDeg === 0 && inDeg > 0)) throw new SewerTopologyError(`${n.id}: 방류구 연결 방향 또는 연결 여부를 확인하세요.`);
    } else if (outDeg !== 1) {
      throw new SewerTopologyError(`${n.id}: 맨홀은 하류 관로가 정확히 1개여야 합니다 (분류/고립 미지원).`);
    }
  }
  return { nodes, out, inn, order };
}

/** 관로별 설계 유량 (m³/s): 상시 유입 + 유역의 합리식 Q = C·I·A/360, 상류에서 하류로 누적. */
export function accumulatedFlows(project: SewerProject, graph: SewerGraph = buildNetwork(project)): Record<string, number> {
  const q = new Map(project.nodes.map((n) => [n.id, n.base_flow]));
  const intensity = project.options.design_intensity;
  for (const s of project.catchments) {
    q.set(s.outlet, q.get(s.outlet)! + (s.runoff_coefficient * intensity * s.area) / 360);
  }
  const result: Record<string, number> = {};
  for (const u of graph.order) {
    for (const e of graph.out.get(u)!) {
      result[e.conduit.id] = q.get(u)!;
      q.set(e.to, q.get(e.to)! + q.get(u)!);
    }
  }
  return result;
}
