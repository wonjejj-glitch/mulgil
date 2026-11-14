/** 2차원 침수 해석 전용 Web Worker (UI 가 멈추지 않게). */
import { simulateFlood, type FloodGrid, type FloodParams, type FloodResult, type FloodSource } from './solver';

export interface FloodRequest {
  grid: FloodGrid;
  sources: FloodSource[];
  params: FloodParams;
}

export type FloodResponse = { type: 'progress'; t: number; duration: number } | { type: 'done'; result: FloodResult } | { type: 'error'; message: string };

const post = (message: FloodResponse, transfer: Transferable[] = []) => self.postMessage(message, { transfer });

self.onmessage = (event: MessageEvent<FloodRequest>) => {
  const { grid, sources, params } = event.data;
  try {
    const result = simulateFlood(grid, sources, params, (t) => post({ type: 'progress', t, duration: params.duration }));
    post({ type: 'done', result }, [result.maxDepth.buffer, result.maxTime.buffer, ...result.frames.map((f) => f.buffer)]);
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
