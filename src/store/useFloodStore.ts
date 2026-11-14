import { create } from 'zustand';
import type { GridFrame, OverflowNode } from '../core/flood/prepare';
import type { FloodResult } from '../core/flood/solver';

export interface FloodSettings {
  /** 셀 크기 (m) */
  cell: number;
  /** 관망 바깥 여유 (m) */
  margin: number;
  /** 지표 Manning n */
  manning: number;
  /** SWMM 해석이 끝난 뒤 더 퍼지게 둘 시간 (분) */
  extraMinutes: number;
  /** 지반고 자료 */
  dem: 'tiles' | 'files';
  /** 격자 지반고를 맨홀 지반고에 맞춰 평행 이동 */
  fitDem: boolean;
}

export interface FloodInfo {
  demLabel: string;
  offset: number;
  offsetSpread: number;
  duration: number;
  elapsedMs: number;
}

interface FloodState {
  settings: FloodSettings;
  frame: GridFrame | null;
  z: Float32Array | null;
  result: FloodResult | null;
  overflow: OverflowNode[];
  info: FloodInfo | null;
  /** -1 = 최대 수심, 0.. = 스냅샷 */
  frameIndex: number;
  show: boolean;
  busy: string | null;
  error: string | null;
  setSettings: (patch: Partial<FloodSettings>) => void;
  setResult: (r: Pick<FloodState, 'frame' | 'z' | 'result' | 'overflow' | 'info'>) => void;
  clear: () => void;
  setFrameIndex: (i: number) => void;
  setShow: (show: boolean) => void;
  setBusy: (busy: string | null) => void;
  setError: (error: string | null) => void;
}

export const useFloodStore = create<FloodState>()((set) => ({
  settings: { cell: 5, margin: 150, manning: 0.035, extraMinutes: 60, dem: 'tiles', fitDem: true },
  frame: null,
  z: null,
  result: null,
  overflow: [],
  info: null,
  frameIndex: -1,
  show: true,
  busy: null,
  error: null,
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  setResult: (r) => set({ ...r, frameIndex: -1, show: true, error: null }),
  clear: () => set({ frame: null, z: null, result: null, overflow: [], info: null, frameIndex: -1 }),
  setFrameIndex: (frameIndex) => set({ frameIndex }),
  setShow: (show) => set({ show }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
}));
