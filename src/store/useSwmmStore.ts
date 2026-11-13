import { create } from 'zustand';
import type { RoutingChoice, SwmmProject } from '../core/swmm/inpReader';
import type { SwmmRun } from '../core/swmm/swmmManager';

export type SwmmNodeTheme = 'none' | 'depthRatio' | 'depth' | 'flooding' | 'inflow';
export type SwmmLinkTheme = 'none' | 'capacity' | 'velocity' | 'flow';
export type SwmmSelection = { kind: 'node' | 'link' | 'subcatch'; id: string } | null;
export type SwmmBottomTab = 'chart' | 'table' | 'review' | 'report';

interface SwmmState {
  project: SwmmProject | null;
  fileName: string | null;
  status: 'idle' | 'running' | 'done' | 'error';
  run: SwmmRun | null;
  error: { message: string; report: string } | null;
  period: number;
  playing: boolean;
  selection: SwmmSelection;
  nodeTheme: SwmmNodeTheme;
  linkTheme: SwmmLinkTheme;
  bottomTab: SwmmBottomTab;
  /** 해석 직전에 FLOW_ROUTING 을 바꿔 실행할지 (원문은 그대로 둔다). */
  routing: RoutingChoice;
  setRouting: (routing: RoutingChoice) => void;

  open: (project: SwmmProject, fileName: string) => void;
  close: () => void;
  setRunning: () => void;
  setResult: (run: SwmmRun) => void;
  setError: (error: { message: string; report: string }) => void;
  setPeriod: (period: number) => void;
  setPlaying: (playing: boolean) => void;
  select: (selection: SwmmSelection) => void;
  setNodeTheme: (theme: SwmmNodeTheme) => void;
  setLinkTheme: (theme: SwmmLinkTheme) => void;
  setBottomTab: (tab: SwmmBottomTab) => void;
}

export const useSwmmStore = create<SwmmState>()((set, get) => ({
  project: null,
  fileName: null,
  status: 'idle',
  run: null,
  error: null,
  period: 0,
  playing: false,
  selection: null,
  nodeTheme: 'depthRatio',
  linkTheme: 'capacity',
  bottomTab: 'chart',
  routing: 'original',
  setRouting: (routing) => set({ routing }),

  open: (project, fileName) =>
    set({ project, fileName, status: 'idle', run: null, error: null, period: 0, playing: false, selection: null, bottomTab: 'chart', routing: 'original' }),
  close: () => set({ project: null, fileName: null, status: 'idle', run: null, error: null, period: 0, playing: false, selection: null }),
  setRunning: () => set({ status: 'running', error: null, playing: false }),
  setResult: (run) => set({ status: 'done', run, error: null, period: Math.min(get().period, Math.max(0, run.output.periods - 1)) }),
  setError: (error) => set({ status: 'error', run: null, error, playing: false }),
  setPeriod: (period) => {
    const count = get().run?.output.periods ?? 0;
    if (count > 0) set({ period: Math.max(0, Math.min(count - 1, period)) });
  },
  setPlaying: (playing) => set({ playing }),
  select: (selection) => set({ selection }),
  setNodeTheme: (nodeTheme) => set({ nodeTheme }),
  setLinkTheme: (linkTheme) => set({ linkTheme }),
  setBottomTab: (bottomTab) => set({ bottomTab }),
}));
