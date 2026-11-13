/**
 * 관망 검증 전용 Web Worker — 대규모 관망의 그래프 탐색·공간 교차 검사를 메인 스레드 밖에서 수행한다.
 */
import type { NetworkModel } from '../model/types';
import { runValidation, type ValidationIssue, type ValidationOptions } from './index';

export interface ValidationRequest {
  requestId: number;
  model: NetworkModel;
  options: ValidationOptions;
}

export type ValidationResponse =
  | { requestId: number; ok: true; issues: ValidationIssue[]; elapsedMs: number }
  | { requestId: number; ok: false; message: string };

self.onmessage = (event: MessageEvent<ValidationRequest>) => {
  const { requestId, model, options } = event.data;
  const startedAt = performance.now();
  let response: ValidationResponse;
  try {
    const issues = runValidation(model, options);
    response = { requestId, ok: true, issues, elapsedMs: performance.now() - startedAt };
  } catch (error) {
    response = { requestId, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(response);
};
