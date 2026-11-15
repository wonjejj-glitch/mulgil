import { create } from 'zustand';
import type { GisNetwork, GisNote, XY } from '../core/sewer/fromGis';

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
  /** 원본 좌표계 코드 (수치지형도 원점 판단에 씀) */
  crs: string;
  layers: string[];
  warnings: string[];
  label: string;
}

/** GIS 에서 만든 관망의 자료 점검 목록 (하수 도크 '자료 점검' 탭). */
export interface SewerGisAudit {
  projectName: string;
  notes: GisNote[];
  /** 지형 자료 설명 (없으면 '') */
  terrainLabel: string;
}

interface SewerGisState {
  data: SewerGisData | null;
  audit: SewerGisAudit | null;
  setAudit: (audit: SewerGisAudit | null) => void;
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
  audit: null,
  setAudit: (audit) => set({ audit }),
  busy: null,
  error: null,
  setData: (data) => set({ data, error: null }),
  setBusy: (busy) => set(busy ? { busy, error: null } : { busy }),
  setError: (error) => set({ error }),
  clear: () => set({ data: null, busy: null, error: null }),
}));
