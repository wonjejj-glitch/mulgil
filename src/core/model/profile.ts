/**
 * 종단면도(Profile Plot): 두 절점 사이 최단 경로(관로 연장 기준)를 찾고,
 * 경로를 따라 누적 거리·지반고·수두를 늘어놓는다.
 */
import { buildGraph } from './networkGraph';
import { computeLinkLength } from './networkEdit';
import type { NetworkModel } from './types';

export interface ProfilePath {
  nodeIds: string[];
  /** nodeIds[i] → nodeIds[i+1] 를 잇는 링크. 길이 = nodeIds.length - 1. */
  linkIds: string[];
  /** 시점부터 각 절점까지의 누적 거리 (모델 길이 단위). */
  distances: number[];
}

/** 링크의 경로 탐색용 길이. 펌프·밸브는 형상 길이를 쓴다. */
function linkWeight(model: NetworkModel, linkId: string): number {
  const link = model.links[linkId];
  if (link.type === 'pipe') return Math.max(link.length, 0);
  return Math.max(computeLinkLength(model, link), 0);
}

/** 최소 힙 (거리, 절점). */
class MinHeap {
  private items: [number, string][] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: [number, string]): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent][0] <= a[i][0]) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop(): [number, string] | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Dijkstra 최단 경로. 닫힌 관로도 지나간다(종단면은 물리적 배관 경로를 보는 것이므로).
 * 경로가 없으면 null.
 */
export function shortestPath(model: NetworkModel, fromId: string, toId: string): ProfilePath | null {
  if (!(fromId in model.nodes) || !(toId in model.nodes)) return null;
  if (fromId === toId) return { nodeIds: [fromId], linkIds: [], distances: [0] };
  const graph = buildGraph(model);
  const dist = new Map<string, number>([[fromId, 0]]);
  const prev = new Map<string, { nodeId: string; linkId: string }>();
  const done = new Set<string>();
  const heap = new MinHeap();
  heap.push([0, fromId]);
  while (heap.size > 0) {
    const [d, nodeId] = heap.pop()!;
    if (done.has(nodeId)) continue;
    done.add(nodeId);
    if (nodeId === toId) break;
    for (const edge of graph.adjacency.get(nodeId) ?? []) {
      if (done.has(edge.nodeId)) continue;
      const next = d + linkWeight(model, edge.linkId);
      if (next < (dist.get(edge.nodeId) ?? Infinity)) {
        dist.set(edge.nodeId, next);
        prev.set(edge.nodeId, { nodeId, linkId: edge.linkId });
        heap.push([next, edge.nodeId]);
      }
    }
  }
  if (!done.has(toId)) return null;
  const nodeIds: string[] = [toId];
  const linkIds: string[] = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const step = prev.get(cursor)!;
    linkIds.push(step.linkId);
    nodeIds.push(step.nodeId);
    cursor = step.nodeId;
  }
  nodeIds.reverse();
  linkIds.reverse();
  const distances = [0];
  for (let i = 0; i < linkIds.length; i++) distances.push(distances[i] + linkWeight(model, linkIds[i]));
  return { nodeIds, linkIds, distances };
}

/** 여러 경유 절점을 차례로 잇는 경로. 한 구간이라도 끊기면 null. */
export function pathThrough(model: NetworkModel, waypoints: string[]): ProfilePath | null {
  if (waypoints.length < 2) return null;
  let result: ProfilePath | null = null;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const leg = shortestPath(model, waypoints[i], waypoints[i + 1]);
    if (!leg) return null;
    if (!result) {
      result = leg;
      continue;
    }
    const offset: number = result.distances[result.distances.length - 1];
    result = {
      nodeIds: [...result.nodeIds, ...leg.nodeIds.slice(1)],
      linkIds: [...result.linkIds, ...leg.linkIds],
      distances: [...result.distances, ...leg.distances.slice(1).map((d) => d + offset)],
    };
  }
  return result;
}
