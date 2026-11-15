import { create } from 'zustand';
import type { TakeoffResult } from '../core/land/takeoff';
import type { CadastralParcel } from '../app/vworldData';

export interface LandSettings {
  /** 편입 폭: 관경으로 자동(터파기 폭) 또는 고정 */
  widthMode: 'auto' | 'fixed';
  /** 고정 편입 폭 (m) */
  width: number;
  /** 개략 보상비 = 편입 면적 × 공시지가 × 이 배율 */
  factor: number;
}

interface LandState {
  settings: LandSettings;
  /** 받은 지적도 필지 (경위도) */
  parcels: CadastralParcel[];
  /** 계산에 쓴 평면 좌표계 */
  plane: string;
  result: TakeoffResult | null;
  /** 결과를 만든 관망 (상수/하수) */
  domain: 'water' | 'sewer' | null;
  show: boolean;
  busy: string | null;
  error: string | null;
  set: (patch: Partial<Omit<LandState, 'set' | 'setSettings'>>) => void;
  setSettings: (patch: Partial<LandSettings>) => void;
}

/** 용지 조서·용지도 (지적도) 상태. */
export const useLandStore = create<LandState>()((set) => ({
  settings: { widthMode: 'auto', width: 1.5, factor: 1 },
  parcels: [],
  plane: 'EPSG:5186',
  result: null,
  domain: null,
  show: true,
  busy: null,
  error: null,
  set: (patch) => set(patch),
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch }, result: null })),
}));
