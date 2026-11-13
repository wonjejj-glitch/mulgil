import type { NetworkModel } from '../model/types';
import { runValidation, type ValidationIssue, type ValidationOptions } from './index';
import type { ValidationRequest, ValidationResponse } from './validation.worker';

let requestCounter = 0;

/**
 * Worker 에서 관망 검증을 실행한다. Worker 를 만들 수 없는 환경에서는 메인 스레드에서 실행한다.
 */
export function runValidationAsync(model: NetworkModel, options: ValidationOptions): Promise<ValidationIssue[]> {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./validation.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return Promise.resolve(runValidation(model, options));
  }
  const requestId = ++requestCounter;
  return new Promise<ValidationIssue[]>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<ValidationResponse>) => {
      if (event.data.requestId !== requestId) return;
      worker.terminate();
      if (event.data.ok) resolve(event.data.issues);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || '검증 워커 오류'));
    };
    const request: ValidationRequest = { requestId, model, options };
    worker.postMessage(request);
  });
}
