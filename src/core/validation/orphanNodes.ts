import { degreeOf, type NetworkGraph } from '../model/networkGraph';
import type { NetworkModel } from '../model/types';
import type { ValidationIssue } from './types';

const TYPE_LABEL = { junction: '절점', reservoir: '수원지', tank: '배수지' } as const;

/** 어떤 링크와도 연결되지 않은 고립 절점. nodeIds = [고립 절점]. */
export function findOrphanNodes(model: NetworkModel, graph: NetworkGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const id in model.nodes) {
    if (degreeOf(graph, id) > 0) continue;
    const node = model.nodes[id];
    issues.push({
      id: `orphanNode:${id}`,
      type: 'orphanNode',
      severity: 'error',
      message: `${TYPE_LABEL[node.type]} ${id} — 연결된 관로가 없습니다.`,
      nodeIds: [id],
      linkIds: [],
      position: node.position,
      fixable: true,
    });
  }
  return issues;
}
