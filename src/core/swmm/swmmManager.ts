import type { SwmmOutput } from './outReader';
import type { SwmmWorkerRequest, SwmmWorkerResponse } from './swmm.worker';

export interface SwmmRun {
  output: SwmmOutput;
  report: string;
  engineVersion: string;
  elapsedMs: number;
}

export class SwmmFailure extends Error {
  code: number | null;
  report: string;
  constructor(message: string, code: number | null, report: string) {
    super(message);
    this.name = 'SwmmFailure';
    this.code = code;
    this.report = report;
  }
}

export const SWMM_CANCELLED = '해석이 취소되었습니다.';

/** SWMM Worker 래퍼: 새 실행이 오면 이전 실행을 취소한다. */
export class SwmmManager {
  private worker: Worker | null = null;
  private runId = 0;
  private rejectCurrent: ((reason: Error) => void) | null = null;

  run(inp: string): Promise<SwmmRun> {
    this.cancel();
    const runId = ++this.runId;
    const startedAt = performance.now();
    const worker = new Worker(new URL('./swmm.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    return new Promise<SwmmRun>((resolve, reject) => {
      this.rejectCurrent = reject;
      const finish = () => {
        worker.terminate();
        if (this.worker === worker) {
          this.worker = null;
          this.rejectCurrent = null;
        }
      };
      worker.onmessage = (event: MessageEvent<SwmmWorkerResponse>) => {
        const message = event.data;
        if (message.runId !== runId) return;
        finish();
        if (message.type === 'done') {
          resolve({ output: message.output, report: message.report, engineVersion: message.engineVersion, elapsedMs: performance.now() - startedAt });
        } else {
          reject(new SwmmFailure(message.message, message.code, message.report));
        }
      };
      worker.onerror = (event) => {
        finish();
        reject(new SwmmFailure(event.message || 'SWMM 워커를 시작하지 못했습니다.', null, ''));
      };
      const request: SwmmWorkerRequest = { runId, inp };
      worker.postMessage(request);
    });
  }

  cancel(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.rejectCurrent?.(new SwmmFailure(SWMM_CANCELLED, null, ''));
      this.rejectCurrent = null;
    }
  }
}

export const swmmManager = new SwmmManager();
