/**
 * 관망 오류 일괄 보정(Auto-fix). 전달받은 model 을 직접 변경한다 (immer draft 에서 호출).
 */
import { distanceMeters, projectOntoPath } from '../../utils/geoMath';
import { buildGraph, degreeOf } from '../model/networkGraph';
import { deleteLink, deleteNodes, linkPath, mergeNodes, splitPipe } from '../model/networkEdit';
import type { LngLat, NetworkModel } from '../model/types';
import { modelLengthToMeters } from '../model/units';
import type { ValidationIssue, ValidationIssueType, ValidationOptions } from './types';

export type AutoFixSelection = Partial<Record<ValidationIssueType, boolean>>;

export interface AutoFixReport {
  removedSelfLoops: number;
  removedDuplicates: number;
  mergedMicroPipes: number;
  connectedTees: number;
  splitCrossings: number;
  removedOrphans: number;
}

export function totalFixes(report: AutoFixReport): number {
  return (
    report.removedSelfLoops +
    report.removedDuplicates +
    report.mergedMicroPipes +
    report.connectedTees +
    report.splitCrossings +
    report.removedOrphans
  );
}

const NEAR_METERS = 0.05;

/** 분할로 여러 조각이 된 관로 중에서 point 에 가장 가까운 조각을 찾는다. */
function closestPiece(model: NetworkModel, pieceIds: string[], point: LngLat): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const id of pieceIds) {
    const link = model.links[id];
    if (!link || link.type !== 'pipe') continue;
    const path = linkPath(model, link);
    if (path.length < 2) continue;
    const d = projectOntoPath(path, point).distance;
    if (d < bestDistance) {
      best = id;
      bestDistance = d;
    }
  }
  return best;
}

export function applyAutoFix(
  model: NetworkModel,
  issues: ValidationIssue[],
  selection: AutoFixSelection,
  options: ValidationOptions,
): AutoFixReport {
  const report: AutoFixReport = {
    removedSelfLoops: 0,
    removedDuplicates: 0,
    mergedMicroPipes: 0,
    connectedTees: 0,
    splitCrossings: 0,
    removedOrphans: 0,
  };
  const of = (type: ValidationIssueType) => (selection[type] ? issues.filter((i) => i.type === type && i.fixable) : []);

  // 분할된 관로 추적: 원래 ID → 현재 조각 ID 목록
  const pieces = new Map<string, string[]>();
  const piecesOf = (id: string) => pieces.get(id) ?? [id];
  const addPiece = (originalId: string, pieceId: string, newId: string) => {
    const list = pieces.get(originalId) ?? [originalId];
    if (!list.includes(pieceId)) list.push(pieceId);
    list.push(newId);
    pieces.set(originalId, list);
  };

  /**
   * 관로(또는 그 조각) 위의 point 에 절점이 있도록 만든다.
   * 이미 끝 절점이 그 위치에 있으면 그 절점을 쓰고, 아니면 관로를 분할한다.
   */
  const ensureNodeOnPipe = (originalId: string, point: LngLat, useNodeId?: string): string | null => {
    const pieceId = closestPiece(model, piecesOf(originalId), point);
    if (!pieceId) return null;
    const piece = model.links[pieceId];
    for (const endId of [piece.startNodeId, piece.endNodeId]) {
      const end = model.nodes[endId];
      if (end && distanceMeters(end.position, point) < NEAR_METERS) {
        if (useNodeId && useNodeId !== endId) {
          mergeNodes(model, useNodeId, endId);
          return useNodeId;
        }
        return endId;
      }
    }
    const result = splitPipe(model, pieceId, point, useNodeId);
    if (!result) return null;
    addPiece(originalId, pieceId, result.newPipeId);
    return result.nodeId;
  };

  for (const issue of of('selfLoop')) {
    const link = model.links[issue.linkIds[0]];
    if (link && link.startNodeId === link.endNodeId) {
      deleteLink(model, link.id);
      report.removedSelfLoops++;
    }
  }

  for (const issue of of('duplicatePipe')) {
    const [duplicateId, originalId] = issue.linkIds;
    const duplicate = model.links[duplicateId];
    const original = model.links[originalId];
    if (!duplicate || !original) continue;
    const samePair =
      (duplicate.startNodeId === original.startNodeId && duplicate.endNodeId === original.endNodeId) ||
      (duplicate.startNodeId === original.endNodeId && duplicate.endNodeId === original.startNodeId);
    if (samePair) {
      deleteLink(model, duplicateId);
      report.removedDuplicates++;
    }
  }

  for (const issue of of('microPipe')) {
    const pipe = model.links[issue.linkIds[0]];
    if (!pipe || pipe.type !== 'pipe') continue;
    if (modelLengthToMeters(pipe.length, model.options.flowUnits) >= options.microPipeLength) continue;
    const a = model.nodes[pipe.startNodeId];
    const b = model.nodes[pipe.endNodeId];
    if (!a || !b || a.id === b.id) continue;
    // 수원지/배수지는 남기고 일반 절점 쪽을 합친다.
    let keep = a;
    let remove = b;
    if (a.type === 'junction' && b.type !== 'junction') {
      keep = b;
      remove = a;
    } else if (a.type !== 'junction' && b.type !== 'junction') {
      continue;
    }
    if (keep.type === 'junction' && remove.type === 'junction') keep.demand += remove.demand;
    mergeNodes(model, keep.id, remove.id);
    report.mergedMicroPipes++;
  }

  for (const issue of of('tee')) {
    const node = model.nodes[issue.nodeIds[0]];
    if (!node) continue;
    const pieceId = closestPiece(model, piecesOf(issue.linkIds[0]), node.position);
    if (!pieceId) continue;
    const piece = model.links[pieceId];
    if (piece.startNodeId === node.id || piece.endNodeId === node.id) continue;
    const result = splitPipe(model, pieceId, node.position, node.id);
    if (result) {
      addPiece(issue.linkIds[0], pieceId, result.newPipeId);
      report.connectedTees++;
    }
  }

  for (const issue of of('crossing')) {
    if (!issue.position) continue;
    const [aId, bId] = issue.linkIds;
    const nodeId = ensureNodeOnPipe(aId, issue.position);
    if (!nodeId) continue;
    const connected = ensureNodeOnPipe(bId, issue.position, nodeId);
    if (connected) report.splitCrossings++;
  }

  const orphanIssues = of('orphanNode');
  if (orphanIssues.length > 0) {
    const graph = buildGraph(model);
    const doomed = orphanIssues
      .map((i) => i.nodeIds[0])
      .filter((id) => model.nodes[id] && degreeOf(graph, id) === 0);
    deleteNodes(model, doomed);
    report.removedOrphans = doomed.length;
  }

  return report;
}
