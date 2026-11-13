import { linkPath } from '../model/networkEdit';
import type { LngLat, NetworkLink, NetworkModel } from '../model/types';
import { modelLengthToMeters } from '../model/units';
import type { ValidationIssue } from './types';

function midpoint(model: NetworkModel, link: NetworkLink): LngLat | null {
  const path = linkPath(model, link);
  if (path.length === 0) return null;
  if (path.length === 1) return path[0];
  const a = path[Math.floor((path.length - 1) / 2)];
  const b = path[Math.ceil((path.length - 1) / 2)];
  return a === b ? a : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** 시점과 종점이 같은 링크. linkIds = [해당 링크]. */
export function findSelfLoops(model: NetworkModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const id in model.links) {
    const link = model.links[id];
    if (link.startNodeId !== link.endNodeId) continue;
    issues.push({
      id: `selfLoop:${id}`,
      type: 'selfLoop',
      severity: 'error',
      message: `링크 ${id} — 시점과 종점이 같은 절점(${link.startNodeId})입니다.`,
      nodeIds: [link.startNodeId],
      linkIds: [id],
      position: model.nodes[link.startNodeId]?.position ?? null,
      fixable: true,
    });
  }
  return issues;
}

/**
 * 동일한 두 절점을 잇는 중복 관로.
 * linkIds = [중복 관로(삭제 대상), 먼저 정의된 원본 관로].
 */
export function findDuplicatePipes(model: NetworkModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const firstByPair = new Map<string, string>();
  for (const id in model.links) {
    const link = model.links[id];
    if (link.type !== 'pipe' || link.startNodeId === link.endNodeId) continue;
    const key =
      link.startNodeId < link.endNodeId
        ? `${link.startNodeId}\u0000${link.endNodeId}`
        : `${link.endNodeId}\u0000${link.startNodeId}`;
    const original = firstByPair.get(key);
    if (original === undefined) {
      firstByPair.set(key, id);
      continue;
    }
    issues.push({
      id: `duplicatePipe:${id}`,
      type: 'duplicatePipe',
      severity: 'warning',
      message: `관로 ${id} — 관로 ${original} 과(와) 같은 두 절점(${link.startNodeId}, ${link.endNodeId})을 잇습니다.`,
      nodeIds: [link.startNodeId, link.endNodeId],
      linkIds: [id, original],
      position: midpoint(model, link),
      fixable: true,
    });
  }
  return issues;
}

/** 연장이 기준 미만인 미소 관로. linkIds = [해당 관로], nodeIds = [시점, 종점]. */
export function findMicroPipes(model: NetworkModel, minLengthMeters: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const id in model.links) {
    const link = model.links[id];
    if (link.type !== 'pipe' || link.startNodeId === link.endNodeId) continue;
    const meters = modelLengthToMeters(link.length, model.options.flowUnits);
    if (meters >= minLengthMeters) continue;
    const a = model.nodes[link.startNodeId];
    const b = model.nodes[link.endNodeId];
    // 양 끝이 모두 수원지/배수지이면 절점 병합으로 고칠 수 없다.
    const fixable = a?.type === 'junction' || b?.type === 'junction';
    issues.push({
      id: `microPipe:${id}`,
      type: 'microPipe',
      severity: 'warning',
      message: `관로 ${id} — 연장 ${meters.toFixed(2)} m (기준 ${minLengthMeters} m 미만).`,
      nodeIds: [link.startNodeId, link.endNodeId],
      linkIds: [id],
      position: midpoint(model, link),
      fixable,
    });
  }
  return issues;
}
