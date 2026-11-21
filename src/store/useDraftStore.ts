import { create } from 'zustand';
import type { ColumnMapping, CsvTable, Customer } from '../core/io/customerCsv';
import { DEFAULT_SEWER_DRAFT, DEFAULT_WATER_DRAFT, type SewerDraftOptions, type WaterDraftOptions } from '../core/model/draftConvert';
import type { AllocationResult, LandParcel } from '../core/model/landUse';
import type { DraftMode, DraftResult } from '../core/model/networkDraft';
import type { LngLat } from '../core/model/types';
import type { GroundPoint, ReservoirSuggestion } from '../core/model/siteSuggest';
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
  /** 신규(수원부터 새로) / 보완(지금 열린 상수 관망에 비어 있는 곳만 잇기) */
  build: 'new' | 'fill';
  /** 보완: 기존 관로에서 이 거리(m) 안의 수용가는 이미 공급 중으로 본다 */
  servedDistance: number;
  /** 보완: 이미 공급 중이라 건너뛴 수용가 수 */
  alreadyServed: number;
  /** 직접 넣은 도로 중심선 파일 (없으면 OpenStreetMap) */
  roadFile: string;
  source: LngLat | null;
  /** source 를 자동으로 정했는지 (종류를 바꾸면 다시 정해야 한다: 상수=가장 높은 곳, 하수=가장 낮은 곳). */
  sourceAuto: boolean;
  maxServiceDistance: number;
  maxPipeLength: number;
  /** 지도 건물로 수용가를 만들 때 영업·업무용수 = 가정용수 × 이 비율(%) */
  businessRatio: number;
  /** 지도 건물을 읽을 범위 [서, 남, 동, 북] (없으면 지금 지도 화면) */
  area: [number, number, number, number] | null;
  /** 지도 도구: 'area' 끌어서 범위 그리기 / 'erase' 수용가 빼기 (도구를 쓰는 동안 대화상자는 닫힌다) */
  mapTool: 'area' | 'erase' | null;
  /** 뺀 수용가 묶음 (되돌리기용, 마지막이 가장 최근) */
  removed: Customer[][];
  /** 직접 뺀 수용가 ID — 지도 건물을 다시 읽어도 넣지 않는다 */
  excluded: string[];
  /** 배수지(상수)·방류구(하수) 후보 */
  sites: { kind: 'reservoir'; result: ReservoirSuggestion } | { kind: 'outfall'; list: (GroundPoint & { kind: 'edge' | 'customer' })[] } | null;
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
  build: 'new',
  servedDistance: 30,
  alreadyServed: 0,
  roadFile: '',
  source: null,
  sourceAuto: false,
  maxServiceDistance: 80,
  maxPipeLength: 300,
  businessRatio: 30,
  area: null,
  mapTool: null,
  removed: [],
  excluded: [],
  sites: null,
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
