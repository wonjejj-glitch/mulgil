import { bfs, connectedComponents, degreeOf, type NetworkGraph } from '../model/networkGraph';
import { isNodeSource, type NetworkModel } from '../model/types';
import type { ValidationIssue } from './types';

/**
 * 수원(수원지/배수지)에서 BFS 로 도달할 수 없는 단절 구역을 블록 단위로 찾는다.
 * nodeIds = 블록에 속한 절점, linkIds = 블록 내부 링크.
 * 고립 절점(연결 링크 0개)은 별도 항목으로 보고하므로 여기서는 제외한다.
 */
export function findDisconnected(model: NetworkModel, graph: NetworkGraph): ValidationIssue[] {
  const sources: string[] = [];
  let nodeCount = 0;
  for (const id in model.nodes) {
    nodeCount++;
    if (isNodeSource(model.nodes[id])) sources.push(id);
  }
  if (nodeCount === 0) return [];
  if (sources.length === 0) {
    return [
      {
        id: 'noSource',
        type: 'noSource',
        severity: 'error',
        message: '수원지 또는 배수지가 없습니다. 물을 공급할 수원이 최소 1개 필요합니다.',
        nodeIds: [],
        linkIds: [],
        position: null,
        fixable: false,
      },
    ];
  }

  const reached = bfs(graph, sources);
  const unreached: string[] = [];
  for (const id in model.nodes) {
    if (!reached.has(id) && degreeOf(graph, id) > 0) unreached.push(id);
  }
  if (unreached.length === 0) return [];

  const issues: ValidationIssue[] = [];
  for (const component of connectedComponents(graph, unreached)) {
    const members = new Set(component);
    const linkIds = new Set<string>();
    for (const nodeId of component) {
      for (const edge of graph.adjacency.get(nodeId) ?? []) {
        if (members.has(edge.nodeId)) linkIds.add(edge.linkId);
      }
    }
    const first = model.nodes[component[0]];
    issues.push({
      id: `disconnected:${component[0]}`,
      type: 'disconnected',
      severity: 'error',
      message: `수원과 연결되지 않은 단절 구역 — 절점 ${component.length}개, 링크 ${linkIds.size}개 (대표 절점 ${component[0]}).`,
      nodeIds: component,
      linkIds: [...linkIds],
      position: first?.position ?? null,
      fixable: false,
    });
  }
  return issues;
}
