/**
 * EPANET Worker 통신 래퍼. 실행 요청을 직렬화하고, 받은 결과를 시간대별로 조회하기
 * 좋은 형태(SimulationResults)로 정리해 보관한다.
 */
import type { EngineWarning, QualityResultInfo, RawSimulationResult } from './epanetRunner';
import type { FireFlowWorkerRequest, RunRequest, WorkerResponse } from './epanet.worker';
import type { FireFlowRequest, FireFlowResult } from './fireFlow';

export type NodeResultVariable = 'pressure' | 'head' | 'demand' | 'quality';
export type LinkResultVariable = 'flow' | 'velocity' | 'headloss' | 'unitHeadloss' | 'quality';

export interface SimulationResults {
  times: number[];
  stepCount: number;
  nodeIds: string[];
  linkIds: string[];
  nodeIndex: Map<string, number>;
  linkIndex: Map<string, number>;
  node: Record<NodeResultVariable, Float32Array>;
  link: Record<LinkResultVariable, Float32Array>;
  /** 전체 시간대에 걸친 변수별 [최소, 최대]. 유량은 절댓값 기준. */
  ranges: Record<NodeResultVariable | LinkResultVariable, [number, number]>;
  /** 수질 해석 정보. null 이면 quality 변수는 의미가 없다(빈 배열). */
  quality: QualityResultInfo | null;
  warnings: EngineWarning[];
  engineVersion: string;
  elapsedMs: number;
}

export class SimulationError extends Error {
  code: number | null;
  report: string;

  constructor(message: string, code: number | null, report: string) {
    super(message);
    this.name = 'SimulationError';
    this.code = code;
    this.report = report;
  }
}

function extent(values: Float32Array, absolute = false): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = absolute ? Math.abs(values[i]) : values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? [min, max] : [0, 0];
}

export function toSimulationResults(raw: RawSimulationResult, elapsedMs: number): SimulationResults {
  const nodeIndex = new Map<string, number>();
  const linkIndex = new Map<string, number>();
  raw.nodeIds.forEach((id, i) => nodeIndex.set(id, i));
  raw.linkIds.forEach((id, i) => linkIndex.set(id, i));
  return {
    times: raw.times,
    stepCount: raw.times.length,
    nodeIds: raw.nodeIds,
    linkIds: raw.linkIds,
    nodeIndex,
    linkIndex,
    node: { pressure: raw.pressure, head: raw.head, demand: raw.demand, quality: raw.nodeQuality },
    link: { flow: raw.flow, velocity: raw.velocity, headloss: raw.headloss, unitHeadloss: raw.unitHeadloss, quality: raw.linkQuality },
    ranges: {
      pressure: extent(raw.pressure),
      head: extent(raw.head),
      demand: extent(raw.demand),
      flow: extent(raw.flow, true),
      velocity: extent(raw.velocity),
      headloss: extent(raw.headloss, true),
      unitHeadloss: extent(raw.unitHeadloss),
      quality: extent(raw.nodeQuality),
    },
    quality: raw.quality,
    warnings: raw.warnings,
    engineVersion: raw.engineVersion,
    elapsedMs,
  };
}

export function nodeValueAt(
  results: SimulationResults,
  variable: NodeResultVariable,
  step: number,
  nodeId: string,
): number | undefined {
  const index = results.nodeIndex.get(nodeId);
  if (index === undefined || step < 0 || step >= results.stepCount) return undefined;
  return results.node[variable][step * results.nodeIds.length + index];
}

export function linkValueAt(
  results: SimulationResults,
  variable: LinkResultVariable,
  step: number,
  linkId: string,
): number | undefined {
  const index = results.linkIndex.get(linkId);
  if (index === undefined || step < 0 || step >= results.stepCount) return undefined;
  return results.link[variable][step * results.linkIds.length + index];
}

export function nodeSeries(results: SimulationResults, variable: NodeResultVariable, nodeId: string): number[] {
  const index = results.nodeIndex.get(nodeId);
  if (index === undefined) return [];
  const count = results.nodeIds.length;
  const data = results.node[variable];
  return results.times.map((_, step) => data[step * count + index]);
}

export function linkSeries(results: SimulationResults, variable: LinkResultVariable, linkId: string): number[] {
  const index = results.linkIndex.get(linkId);
  if (index === undefined) return [];
  const count = results.linkIds.length;
  const data = results.link[variable];
  return results.times.map((_, step) => data[step * count + index]);
}

/** 한 번이라도 음압이 발생한 절점 ID 목록. */
export function negativePressureNodes(results: SimulationResults, excludeIds: ReadonlySet<string>): string[] {
  const count = results.nodeIds.length;
  const flagged: string[] = [];
  for (let i = 0; i < count; i++) {
    if (excludeIds.has(results.nodeIds[i])) continue;
    for (let step = 0; step < results.stepCount; step++) {
      if (results.node.pressure[step * count + i] < 0) {
        flagged.push(results.nodeIds[i]);
        break;
      }
    }
  }
  return flagged;
}

export class SimulationManager {
  private worker: Worker | null = null;
  private runId = 0;
  private rejectCurrent: ((reason: Error) => void) | null = null;

  /** 진행 중인 해석이 있으면 중단하고 새 해석을 시작한다. */
  run(inp: string, onProgress?: (fraction: number) => void): Promise<SimulationResults> {
    this.cancel();
    const runId = ++this.runId;
    const startedAt = performance.now();
    const worker = new Worker(new URL('./epanet.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;

    return new Promise<SimulationResults>((resolve, reject) => {
      this.rejectCurrent = reject;
      const finish = () => {
        worker.terminate();
        if (this.worker === worker) {
          this.worker = null;
          this.rejectCurrent = null;
        }
      };
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (message.runId !== runId) return;
        if (message.type === 'progress') {
          onProgress?.(message.duration > 0 ? Math.min(1, message.time / message.duration) : 1);
        } else if (message.type === 'done') {
          finish();
          resolve(toSimulationResults(message.result, performance.now() - startedAt));
        } else if (message.type === 'fireflowDone') {
          finish();
        } else {
          finish();
          reject(new SimulationError(message.message, message.code, message.report));
        }
      };
      worker.onerror = (event) => {
        finish();
        reject(new SimulationError(event.message || '해석 워커를 시작하지 못했습니다.', null, ''));
      };
      const request: RunRequest = { type: 'run', runId, inp };
      worker.postMessage(request);
    });
  }

  cancel(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.rejectCurrent?.(new SimulationError('해석이 취소되었습니다.', null, ''));
      this.rejectCurrent = null;
    }
  }
}

export const simulationManager = new SimulationManager();

/** 소화용수 분석 전용 Worker 실행. 수리해석과 별개의 Worker 를 써서 서로 취소하지 않는다. */
export class FireFlowManager {
  private worker: Worker | null = null;
  private runId = 0;
  private rejectCurrent: ((reason: Error) => void) | null = null;

  run(request: FireFlowRequest, onProgress?: (fraction: number) => void): Promise<FireFlowResult> {
    this.cancel();
    const runId = ++this.runId;
    const worker = new Worker(new URL('./epanet.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    return new Promise<FireFlowResult>((resolve, reject) => {
      this.rejectCurrent = reject;
      const finish = () => {
        worker.terminate();
        if (this.worker === worker) {
          this.worker = null;
          this.rejectCurrent = null;
        }
      };
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (message.runId !== runId) return;
        if (message.type === 'progress') onProgress?.(message.duration > 0 ? message.time / message.duration : 1);
        else if (message.type === 'fireflowDone') {
          finish();
          resolve(message.result);
        } else if (message.type === 'error') {
          finish();
          reject(new SimulationError(message.message, message.code, message.report));
        }
      };
      worker.onerror = (event) => {
        finish();
        reject(new SimulationError(event.message || '분석 워커를 시작하지 못했습니다.', null, ''));
      };
      const message: FireFlowWorkerRequest = { type: 'fireflow', runId, request };
      worker.postMessage(message);
    });
  }

  cancel(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.rejectCurrent?.(new SimulationError('분석이 취소되었습니다.', null, ''));
      this.rejectCurrent = null;
    }
  }
}

export const fireFlowManager = new FireFlowManager();
