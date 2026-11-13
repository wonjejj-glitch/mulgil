import { buildGraph } from '../model/networkGraph';
import type { NetworkModel } from '../model/types';
import { findDisconnected } from './connectivityCheck';
import { findCrossings } from './crossingPipes';
import { findDuplicatePipes, findMicroPipes, findSelfLoops } from './duplicateLinks';
import { findOrphanNodes } from './orphanNodes';
import { DEFAULT_VALIDATION_OPTIONS, type ValidationIssue, type ValidationIssueType, type ValidationOptions } from './types';

export * from './types';

/** 모든 관망 검증을 순서대로 실행한다. 순수 함수이므로 Worker·테스트에서 그대로 쓴다. */
export function runValidation(
  model: NetworkModel,
  options: ValidationOptions = DEFAULT_VALIDATION_OPTIONS,
): ValidationIssue[] {
  const graph = buildGraph(model);
  return [
    ...findDisconnected(model, graph),
    ...findOrphanNodes(model, graph),
    ...findSelfLoops(model),
    ...findDuplicatePipes(model),
    ...findMicroPipes(model, options.microPipeLength),
    ...findCrossings(model, options.teeTolerance, options.overpassDiameterRatio ?? 2.5),
  ];
}

export function countByType(issues: ValidationIssue[]): Record<ValidationIssueType, number> {
  const counts: Record<ValidationIssueType, number> = {
    noSource: 0,
    orphanNode: 0,
    selfLoop: 0,
    duplicatePipe: 0,
    microPipe: 0,
    disconnected: 0,
    crossing: 0,
    tee: 0,
    overpass: 0,
    overlap: 0,
  };
  for (const issue of issues) counts[issue.type]++;
  return counts;
}
