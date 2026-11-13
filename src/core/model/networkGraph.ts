import type { NetworkModel } from './types';

export interface GraphEdge {
  linkId: string;
  /** 반대편 절점 ID. */
  nodeId: string;
}

/** 인접 리스트 기반 무방향 위상 그래프. */
export interface NetworkGraph {
  adjacency: Map<string, GraphEdge[]>;
}

export function buildGraph(model: Pick<NetworkModel, 'nodes' | 'links'>): NetworkGraph {
  const adjacency = new Map<string, GraphEdge[]>();
  for (const id in model.nodes) adjacency.set(id, []);
  for (const linkId in model.links) {
    const link = model.links[linkId];
    const a = adjacency.get(link.startNodeId);
    const b = adjacency.get(link.endNodeId);
    if (!a || !b) continue; // 끊어진 참조는 그래프에서 제외
    a.push({ linkId, nodeId: link.endNodeId });
    if (link.startNodeId !== link.endNodeId) b.push({ linkId, nodeId: link.startNodeId });
  }
  return { adjacency };
}

export function degreeOf(graph: NetworkGraph, nodeId: string): number {
  return graph.adjacency.get(nodeId)?.length ?? 0;
}

export function linksAtNode(graph: NetworkGraph, nodeId: string): string[] {
  return (graph.adjacency.get(nodeId) ?? []).map((e) => e.linkId);
}

/** 여러 시작 절점에서 동시에 출발하는 BFS. 도달한 절점 집합을 돌려준다. */
export function bfs(
  graph: NetworkGraph,
  startIds: Iterable<string>,
  canTraverse?: (linkId: string) => boolean,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const id of startIds) {
    if (graph.adjacency.has(id) && !visited.has(id)) {
      visited.add(id);
      queue.push(id);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const edges = graph.adjacency.get(queue[head]);
    if (!edges) continue;
    for (const edge of edges) {
      if (visited.has(edge.nodeId)) continue;
      if (canTraverse && !canTraverse(edge.linkId)) continue;
      visited.add(edge.nodeId);
      queue.push(edge.nodeId);
    }
  }
  return visited;
}

/** 주어진 절점 집합을 연결 요소(블록)별로 나눈다. */
export function connectedComponents(graph: NetworkGraph, nodeIds: Iterable<string>): string[][] {
  const pool = new Set(nodeIds);
  const components: string[][] = [];
  for (const id of pool) {
    const reached = bfs(graph, [id]);
    const component: string[] = [];
    for (const r of reached) {
      if (pool.delete(r)) component.push(r);
    }
    if (component.length > 0) components.push(component);
  }
  return components;
}
