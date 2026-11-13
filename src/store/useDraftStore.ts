import { create } from 'zustand';
import type { ColumnMapping, CsvTable, Customer } from '../core/io/customerCsv';
import { DEFAULT_SEWER_DRAFT, DEFAULT_WATER_DRAFT, type SewerDraftOptions, type WaterDraftOptions } from '../core/model/draftConvert';
import type { AllocationResult, LandParcel } from '../core/model/landUse';
import type { DraftMode, DraftResult } from '../core/model/networkDraft';
import type { LngLat } from '../core/model/types';
import type { ImportCrsChoice } from '../utils/geoMath';

/** 수용가 CSV → 관망 초안 / 용도지역 분담유량 화면의 상태 (대화상자를 닫았다 열어도 유지). */
interface DraftState {
  // 수용가 초안
  table: CsvTable | null;
  fileName: string;
  mapping: ColumnMapping | null;
  crs: ImportCrsChoice;
  customers: Customer[];
  skipped: number[];
  crsLabel: string;
  mode: DraftMode;
  source: LngLat | null;
  maxServiceDistance: number;
  maxPipeLength: number;
  water: WaterDraftOptions;
  sewer: SewerDraftOptions;
  result: DraftResult | null;
  warnings: string[];
  busy: string | null;
  error: string | null;
  /** 지도에 수용가·초안을 겹쳐 보일지 */
  overlay: boolean;

  // 용도지역 분담유량
  parcelsRaw: { id: string; props: Record<string, unknown>; rings: LngLat[][] }[];
  parcelFile: string;
  parcelKeys: string[];
  useKey: string;
  rates: Record<string, number>;
  maxConnectDistance: number;
  allocation: AllocationResult | null;

  set: (patch: Partial<DraftState>) => void;
}

export const useDraftStore = create<DraftState>()((set) => ({
  table: null,
  fileName: '',
  mapping: null,
  crs: 'auto',
  customers: [],
  skipped: [],
  crsLabel: '',
  mode: 'water',
  source: null,
  maxServiceDistance: 80,
  maxPipeLength: 300,
  water: { ...DEFAULT_WATER_DRAFT },
  sewer: { ...DEFAULT_SEWER_DRAFT },
  result: null,
  warnings: [],
  busy: null,
  error: null,
  overlay: true,

  parcelsRaw: [],
  parcelFile: '',
  parcelKeys: [],
  useKey: '',
  rates: {},
  maxConnectDistance: 150,
  allocation: null,

  set: (patch) => set(patch),
}));

/** 선택한 용도 열로 구역 목록을 만든다. */
export function parcelsOf(state: Pick<DraftState, 'parcelsRaw' | 'useKey'>): LandParcel[] {
  return state.parcelsRaw.map((p) => ({ id: p.id, use: String(p.props[state.useKey] ?? '(없음)').trim() || '(없음)', rings: p.rings }));
}
