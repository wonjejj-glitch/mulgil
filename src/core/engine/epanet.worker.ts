/**
 * EPANET 수리해석 전용 Web Worker.
 * 메인 스레드는 .inp 문자열만 넘기고, 결과는 Float32Array 버퍼를 transfer 로 돌려받는다.
 * 'fireflow' 요청은 절점별 소화용수 분석(정상 상태 반복 해석)을 수행한다.
 */
import { EpanetRunError, runHydraulics, type RawSimulationResult } from './epanetRunner';
import { runFireFlow, type FireFlowRequest, type FireFlowResult } from './fireFlow';

export interface RunRequest {
  type: 'run';
  runId: number;
  inp: string;
}

export interface FireFlowWorkerRequest {
  type: 'fireflow';
  runId: number;
  request: FireFlowRequest;
}

export type WorkerResponse =
  | { type: 'progress'; runId: number; time: number; duration: number }
  | { type: 'done'; runId: number; result: RawSimulationResult }
  | { type: 'fireflowDone'; runId: number; result: FireFlowResult }
  | { type: 'error'; runId: number; message: string; code: number | null; report: string };

const post = (message: WorkerResponse, transfer: Transferable[] = []) => {
  self.postMessage(message, { transfer });
};

function postError(runId: number, error: unknown): void {
  if (error instanceof EpanetRunError) {
    post({ type: 'error', runId, message: error.message, code: error.code, report: error.report });
  } else {
    const message = error instanceof Error ? error.message : String(error);
    const match = /EPANET Error (\d+)/.exec(message);
    post({ type: 'error', runId, message, code: match ? Number(match[1]) : null, report: '' });
  }
}

self.onmessage = async (event: MessageEvent<RunRequest | FireFlowWorkerRequest>) => {
  const data = event.data;
  const { runId } = data;
  let lastProgress = 0;
  const throttled = (time: number, duration: number) => {
    const now = performance.now();
    if (now - lastProgress > 50) {
      lastProgress = now;
      post({ type: 'progress', runId, time, duration });
    }
  };

  if (data.type === 'fireflow') {
    try {
      const result = await runFireFlow(data.request, throttled);
      post({ type: 'fireflowDone', runId, result });
    } catch (error) {
      postError(runId, error);
    }
    return;
  }

  try {
    const result = await runHydraulics(data.inp, throttled);
    post({ type: 'done', runId, result }, [
      result.pressure.buffer,
      result.head.buffer,
      result.demand.buffer,
      result.flow.buffer,
      result.velocity.buffer,
      result.headloss.buffer,
      result.unitHeadloss.buffer,
      result.nodeQuality.buffer,
      result.linkQuality.buffer,
    ]);
  } catch (error) {
    postError(runId, error);
  }
};
