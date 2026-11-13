/** SWMM 해석 전용 Web Worker. 원문 .inp 문자열을 받아 결과(.out 을 읽은 값)와 보고서를 돌려준다. */
import type { SwmmOutput } from './outReader';
import { runSwmm, SwmmRunError } from './swmmRunner';

export interface SwmmWorkerRequest {
  runId: number;
  inp: string;
}

export type SwmmWorkerResponse =
  | { type: 'done'; runId: number; output: SwmmOutput; report: string; engineVersion: string }
  | { type: 'error'; runId: number; message: string; code: number | null; report: string };

self.onmessage = async (event: MessageEvent<SwmmWorkerRequest>) => {
  const { runId, inp } = event.data;
  try {
    const { output, report, engineVersion } = await runSwmm(inp);
    const message: SwmmWorkerResponse = { type: 'done', runId, output, report, engineVersion };
    self.postMessage(message, { transfer: [output.sub.buffer, output.node.buffer, output.link.buffer, output.system.buffer, output.days.buffer] });
  } catch (error) {
    const message: SwmmWorkerResponse =
      error instanceof SwmmRunError
        ? { type: 'error', runId, message: error.message, code: error.code, report: error.report }
        : { type: 'error', runId, message: error instanceof Error ? error.message : String(error), code: null, report: '' };
    self.postMessage(message);
  }
};
