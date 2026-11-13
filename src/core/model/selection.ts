/** 구역(다각형) 선택과 다중 선택 집합 연산. */
import type { LngLat, NetworkModel } from './types';

export interface ObjectSet {
  nodeIds: string[];
  linkIds: string[];
}

/** 짝수-홀수 규칙(ray casting) 점-다각형 포함 판정. 경위도 평면에서 충분히 정확하다(구역 크기 수 km 이내). */
export function pointInPolygon(point: LngLat, polygon: LngLat[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 다각형 안의 절점과, 양 끝 절점이 모두 안에 있는 링크를 고른다.
 * 꼭짓점이 3개 미만이면 빈 집합.
 */
export function objectsInPolygon(model: Pick<NetworkModel, 'nodes' | 'links'>, polygon: LngLat[]): ObjectSet {
  if (polygon.length < 3) return { nodeIds: [], linkIds: [] };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of polygon) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const inside = new Set<string>();
  for (const id in model.nodes) {
    const [x, y] = model.nodes[id].position;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    if (pointInPolygon([x, y], polygon)) inside.add(id);
  }
  const linkIds: string[] = [];
  for (const id in model.links) {
    const link = model.links[id];
    if (inside.has(link.startNodeId) && inside.has(link.endNodeId)) linkIds.push(id);
  }
  return { nodeIds: [...inside], linkIds };
}

/** 합집합 / 대칭차(토글). */
export function mergeSets(base: ObjectSet | null, add: ObjectSet, mode: 'union' | 'toggle'): ObjectSet {
  const nodes = new Set(base?.nodeIds ?? []);
  const links = new Set(base?.linkIds ?? []);
  for (const id of add.nodeIds) {
    if (mode === 'toggle' && nodes.has(id)) nodes.delete(id);
    else nodes.add(id);
  }
  for (const id of add.linkIds) {
    if (mode === 'toggle' && links.has(id)) links.delete(id);
    else links.add(id);
  }
  return { nodeIds: [...nodes], linkIds: [...links] };
}

/** 삭제된 객체를 걸러낸 다중 선택. */
export function pruneSet(model: Pick<NetworkModel, 'nodes' | 'links'>, set: ObjectSet): ObjectSet {
  return {
    nodeIds: set.nodeIds.filter((id) => id in model.nodes),
    linkIds: set.linkIds.filter((id) => id in model.links),
  };
}
