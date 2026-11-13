import { create } from 'zustand';
import type { FireFlowResult } from '../core/engine/fireFlow';
import type { SimulationResults } from '../core/engine/simulationManager';

/** 마지막 소화용수 분석 결과와 조건. */
export interface FireFlowRun {
  result: FireFlowResult;
  fireFlow: number;
  time: number;
  minPressure: number;
  /** 분석 당시 관망 revision. */
  revision: number;
}

export type SimulationStatus = 'idle' | 'running' | 'done' | 'error';

export interface SimulationErrorInfo {
  code: number | null;
  title: string;
  hint: string;
  details: string[];
}

export interface LogEntry {
  level: 'info' | 'warning' | 'error';
  text: string;
}

interface SimulationState {
  status: SimulationStatus;
  /** 0~1 진행률. */
  progress: number;
  results: SimulationResults | null;
  /** 결과를 만든 시점의 관망 revision. 현재 revision 과 다르면 결과가 최신이 아니다. */
  resultsRevision: number;
  stepIndex: number;
  playing: boolean;
  error: SimulationErrorInfo | null;
  log: LogEntry[];
  fireFlow: FireFlowRun | null;

  setFireFlow: (run: FireFlowRun | null) => void;
  setRunning: () => void;
  setProgress: (progress: number) => void;
  setResults: (results: SimulationResults, revision: number, log: LogEntry[]) => void;
  setError: (error: SimulationErrorInfo, log: LogEntry[]) => void;
  setStep: (stepIndex: number) => void;
  setPlaying: (playing: boolean) => void;
  clear: () => void;
}

export const useSimulationStore = create<SimulationState>()((set, get) => ({
  status: 'idle',
  progress: 0,
  results: null,
  resultsRevision: -1,
  stepIndex: 0,
  playing: false,
  error: null,
  log: [],
  fireFlow: null,

  setFireFlow: (fireFlow) => set({ fireFlow }),
  setRunning: () => set({ status: 'running', progress: 0, error: null, playing: false }),
  setProgress: (progress) => set({ progress }),
  setResults: (results, revision, log) =>
    set((s) => ({
      status: 'done',
      progress: 1,
      results,
      resultsRevision: revision,
      stepIndex: Math.min(s.stepIndex, Math.max(0, results.stepCount - 1)),
      error: null,
      log,
    })),
  setError: (error, log) => set({ status: 'error', progress: 0, results: null, error, log, playing: false }),
  setStep: (stepIndex) => {
    const count = get().results?.stepCount ?? 0;
    if (count === 0) return;
    set({ stepIndex: Math.max(0, Math.min(count - 1, stepIndex)) });
  },
  setPlaying: (playing) => set({ playing }),
  clear: () =>
    set({ status: 'idle', progress: 0, results: null, resultsRevision: -1, stepIndex: 0, playing: false, error: null, log: [], fireFlow: null }),
}));
