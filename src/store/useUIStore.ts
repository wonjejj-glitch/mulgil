import { create } from 'zustand';
import type { LinkType, LngLat } from '../core/model/types';
import type { BBox, ImportCrsChoice } from '../utils/geoMath';

export type Tool = 'select' | 'area' | 'profile' | 'junction' | 'reservoir' | 'tank' | 'pipe' | 'pump' | 'valve';
export type Selection = { kind: 'node' | 'link'; id: string } | null;

/** 다중 선택(구역 선택·Ctrl+클릭). 단일 선택(selection)과 별개로 관리한다. */
export interface MultiSelection {
  nodeIds: string[];
  linkIds: string[];
}
export type BasemapId = 'osm' | 'satellite' | 'vworld-base' | 'vworld-satellite' | 'vworld-hybrid' | 'none';
export type NodeTheme = 'none' | 'pressure' | 'head' | 'demand' | 'quality' | 'zone' | 'elevation';
export type LinkTheme = 'none' | 'velocity' | 'flow' | 'unitHeadloss' | 'quality' | 'zone' | 'diameter';
export type BottomTab = 'timeline' | 'profile' | 'table' | 'validation' | 'log';
export type ModalId = 'validation' | 'simulation' | 'curves' | 'controls' | 'fireflow' | 'correction' | 'sewer' | 'draft' | 'allocate' | 'tools' | null;

/** 지도에서 한 점 고르기 (대화상자를 잠시 닫고 클릭을 기다린다). */
export interface PointPick {
  label: string;
  onPick: (position: LngLat) => void;
  /** 고른 뒤(또는 취소 뒤) 다시 열 대화상자 */
  returnTo: ModalId;
}

export interface LayerVisibility {
  junctions: boolean;
  sources: boolean;
  pipes: boolean;
  pumpsValves: boolean;
  labels: boolean;
  arrows: boolean;
  columns3d: boolean;
}

export interface Highlight {
  nodeIds: string[];
  linkIds: string[];
}

export interface DrawingState {
  linkType: LinkType;
  startNodeId: string;
  vertices: LngLat[];
}

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  level: ToastLevel;
  title: string;
  message?: string;
  details?: string[];
  /** '문제 위치 보기' 버튼으로 지도에 표시할 객체. */
  highlight?: Highlight;
}

export type CameraRequest =
  | { nonce: number; kind: 'fit'; bbox: BBox }
  | { nonce: number; kind: 'fly'; center: LngLat; zoom?: number };

const STORAGE_KEY = 'mulgil.ui';
/** 이름 변경 전 저장 키 — 배경지도 선택·브이월드 키를 잃지 않도록 한 번 읽어 온다. */
const LEGACY_STORAGE_KEY = 'opengispipe.ui';

interface PersistedUI {
  basemap: BasemapId;
  vworldKey: string;
}

function loadPersisted(): PersistedUI {
  const fallback: PersistedUI = { basemap: 'osm', vworldKey: '' };
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedUI>;
    return {
      basemap: parsed.basemap ?? fallback.basemap,
      vworldKey: typeof parsed.vworldKey === 'string' ? parsed.vworldKey : '',
    };
  } catch {
    return fallback;
  }
}

function persist(value: PersistedUI): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 조용히 건너뛴다.
  }
}

interface UIState {
  tool: Tool;
  selection: Selection;
  highlight: Highlight | null;
  basemap: BasemapId;
  vworldKey: string;
  layers: LayerVisibility;
  nodeTheme: NodeTheme;
  linkTheme: LinkTheme;
  drawing: DrawingState | null;
  cursor: LngLat | null;
  snapNodeId: string | null;
  bottomTab: BottomTab;
  bottomCollapsed: boolean;
  modal: ModalId;
  toasts: Toast[];
  camera: CameraRequest | null;
  importCrs: ImportCrsChoice;
  multiSelection: MultiSelection | null;
  /** 구역 선택 도구로 그리는 중인 다각형 꼭짓점. */
  areaDraft: LngLat[];
  /** 종단면도 경유 절점 (시점 → … → 종점). */
  profileWaypoints: string[];
  pointPick: PointPick | null;

  setTool: (tool: Tool) => void;
  /** 지도에서 점 고르기 시작(null 이면 취소 — 원래 대화상자로 돌아간다). */
  setPointPick: (pick: PointPick | null) => void;
  select: (selection: Selection) => void;
  setMultiSelection: (multi: MultiSelection | null) => void;
  setAreaDraft: (points: LngLat[]) => void;
  setProfileWaypoints: (ids: string[]) => void;
  setHighlight: (highlight: Highlight | null) => void;
  setBasemap: (basemap: BasemapId) => void;
  setVworldKey: (key: string) => void;
  toggleLayer: (layer: keyof LayerVisibility) => void;
  setNodeTheme: (theme: NodeTheme) => void;
  setLinkTheme: (theme: LinkTheme) => void;
  setDrawing: (drawing: DrawingState | null) => void;
  setCursor: (cursor: LngLat | null, snapNodeId: string | null) => void;
  setBottomTab: (tab: BottomTab) => void;
  setBottomCollapsed: (collapsed: boolean) => void;
  openModal: (modal: ModalId) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => number;
  dismissToast: (id: number) => void;
  clearToasts: () => void;
  fitBounds: (bbox: BBox) => void;
  flyTo: (center: LngLat, zoom?: number) => void;
  setImportCrs: (crs: ImportCrsChoice) => void;
}

let toastCounter = 0;
let cameraCounter = 0;
const persisted = loadPersisted();

export const useUIStore = create<UIState>()((set, get) => ({
  tool: 'select',
  selection: null,
  highlight: null,
  basemap: persisted.basemap,
  vworldKey: persisted.vworldKey,
  layers: {
    junctions: true,
    sources: true,
    pipes: true,
    pumpsValves: true,
    labels: false,
    arrows: true,
    columns3d: false,
  },
  nodeTheme: 'pressure',
  linkTheme: 'velocity',
  drawing: null,
  cursor: null,
  snapNodeId: null,
  bottomTab: 'timeline',
  bottomCollapsed: false,
  modal: null,
  toasts: [],
  camera: null,
  importCrs: 'auto',
  multiSelection: null,
  areaDraft: [],
  profileWaypoints: [],
  pointPick: null,

  setTool: (tool) => set({ tool, drawing: null, snapNodeId: null, areaDraft: [] }),
  setPointPick: (pointPick) => {
    if (pointPick) set({ pointPick, modal: null, tool: 'select', drawing: null });
    else set((s) => ({ pointPick: null, modal: s.pointPick?.returnTo ?? s.modal }));
  },
  select: (selection) => set({ selection }),
  setMultiSelection: (multiSelection) =>
    set({
      multiSelection: multiSelection && multiSelection.nodeIds.length + multiSelection.linkIds.length > 0 ? multiSelection : null,
    }),
  setAreaDraft: (areaDraft) => set({ areaDraft }),
  setProfileWaypoints: (profileWaypoints) => set({ profileWaypoints }),
  setHighlight: (highlight) => set({ highlight }),
  setBasemap: (basemap) => {
    set({ basemap });
    persist({ basemap, vworldKey: get().vworldKey });
  },
  setVworldKey: (vworldKey) => {
    set({ vworldKey });
    persist({ basemap: get().basemap, vworldKey });
  },
  toggleLayer: (layer) => set((s) => ({ layers: { ...s.layers, [layer]: !s.layers[layer] } })),
  setNodeTheme: (nodeTheme) => set({ nodeTheme }),
  setLinkTheme: (linkTheme) => set({ linkTheme }),
  setDrawing: (drawing) => set({ drawing }),
  setCursor: (cursor, snapNodeId) => set({ cursor, snapNodeId }),
  setBottomTab: (bottomTab) => set({ bottomTab, bottomCollapsed: false }),
  setBottomCollapsed: (bottomCollapsed) => set({ bottomCollapsed }),
  openModal: (modal) => set({ modal }),
  pushToast: (toast) => {
    const id = ++toastCounter;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...toast, id }] }));
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clearToasts: () => set({ toasts: [] }),
  fitBounds: (bbox) => set({ camera: { nonce: ++cameraCounter, kind: 'fit', bbox } }),
  flyTo: (center, zoom) => set({ camera: { nonce: ++cameraCounter, kind: 'fly', center, zoom } }),
  setImportCrs: (importCrs) => set({ importCrs }),
}));
