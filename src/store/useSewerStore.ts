import { create } from 'zustand';
import type { SwmmRun } from '../core/swmm/swmmManager';
import type { DesignMode, DesignResult } from '../core/sewer/design';
import type { OptimizeOutcome } from '../core/sewer/optimize';
import type { SimulationSummary } from '../core/sewer/report';
import { demoProject, type SewerProject } from '../core/sewer/types';

const MAX_UNDO = 50;

interface SewerState {
  project: SewerProject;
  /** 편집 전 상태 (실행 취소용 JSON 문자열) */
  past: string[];
  future: string[];
  /** 마지막 자동 설계 (입력은 바꾸지 않는다) */
  design: DesignResult | null;
  /** 마지막 SWMM 해석 (설계한 관망 기준) */
  simulation: SimulationSummary | null;
  run: SwmmRun | null;
  /** 마지막 반복 검토 */
  outcome: OptimizeOutcome | null;
  busy: string | null;
  error: string | null;
  /** 소유량 관로 처리 방식 (core/sewer/design.ts DesignMode) */
  designMode: DesignMode;

  setDesignMode: (mode: DesignMode) => void;
  setProject: (project: SewerProject, options?: { keepResults?: boolean }) => void;
  edit: (recipe: (draft: SewerProject) => void) => void;
  undo: () => void;
  redo: () => void;
  loadDemo: () => void;
  setDesign: (design: DesignResult | null) => void;
  setSimulation: (simulation: SimulationSummary | null, run: SwmmRun | null) => void;
  setOutcome: (outcome: OptimizeOutcome | null) => void;
  setBusy: (busy: string | null) => void;
  setError: (error: string | null) => void;
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export const useSewerStore = create<SewerState>()((set, get) => ({
  project: demoProject(),
  past: [],
  future: [],
  design: null,
  simulation: null,
  run: null,
  outcome: null,
  busy: null,
  error: null,
  designMode: 'practical',

  setDesignMode: (designMode) => set({ designMode, design: null, simulation: null, run: null, outcome: null }),
  // 새 프로젝트를 통째로 넣는다 (열기·설계 결과 반영). 입력이 바뀌면 이전 결과는 무효.
  setProject: (project, options) =>
    set((s) => ({
      project,
      past: [...s.past, JSON.stringify(s.project)].slice(-MAX_UNDO),
      future: [],
      ...(options?.keepResults ? {} : { design: null, simulation: null, run: null, outcome: null }),
      error: null,
    })),

  edit: (recipe) => {
    const next = clone(get().project);
    recipe(next);
    get().setProject(next);
  },

  undo: () => {
    const { past, project, future } = get();
    if (past.length === 0) return;
    set({ project: JSON.parse(past[past.length - 1]) as SewerProject, past: past.slice(0, -1), future: [JSON.stringify(project), ...future], design: null, simulation: null, run: null, outcome: null });
  },
  redo: () => {
    const { past, project, future } = get();
    if (future.length === 0) return;
    set({ project: JSON.parse(future[0]) as SewerProject, past: [...past, JSON.stringify(project)], future: future.slice(1), design: null, simulation: null, run: null, outcome: null });
  },

  loadDemo: () => get().setProject(demoProject()),
  setDesign: (design) => set({ design }),
  setSimulation: (simulation, run) => set({ simulation, run }),
  setOutcome: (outcome) => set({ outcome }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
}));
