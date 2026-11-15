import { create } from 'zustand';
import type { GisNetwork, XY } from '../core/sewer/fromGis';

export interface GisArea {
  /** 레이어 이름 (예: 처리분구) */
  layer: string;
  name: string;
  /** 하수 프로젝트 좌표(EPSG:5186) 고리들 */
  rings: XY[][];
}

export interface SewerGisData {
  net: GisNetwork;
  areas: GisArea[];
  crsLabel: string;
  layers: string[];
  warnings: string[];
  label: string;
}

interface SewerGisState {
  data: SewerGisData | null;
  busy: string | null;
  error: string | null;
  setData: (data: SewerGisData) => void;
  setBusy: (busy: string | null) => void;
  setError: (error: string | null) => void;
  clear: () => void;
}

/** 하수도 GIS 가져오기 대화상자의 읽어 둔 자료 (관망으로 만들기 전 단계). */
export const useSewerGisStore = create<SewerGisState>()((set) => ({
  data: null,
  busy: null,
  error: null,
  setData: (data) => set({ data, error: null }),
  setBusy: (busy) => set(busy ? { busy, error: null } : { busy }),
  setError: (error) => set({ error }),
  clear: () => set({ data: null, busy: null, error: null }),
}));
