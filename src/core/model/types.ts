/**
 * 관망 도메인 모델.
 * - 내부 좌표는 항상 WGS84 [lng, lat].
 * - 수치 값은 파일의 단위계(EPANET 규약)를 그대로 따른다. SI 단위계(LPS, CMD 등)일 때
 *   연장 m, 관경 mm, 수두·수압 m 이고, US 단위계(GPM 등)일 때 ft, in, psi 이다.
 */

export type LngLat = [number, number];

export type NodeType = 'junction' | 'reservoir' | 'tank';
export type LinkType = 'pipe' | 'pump' | 'valve';
export type ValveType = 'PRV' | 'PSV' | 'PBV' | 'FCV' | 'TCV' | 'GPV';
export type PipeStatus = 'Open' | 'Closed' | 'CV';
export type FlowUnits = 'CFS' | 'GPM' | 'MGD' | 'IMGD' | 'AFD' | 'LPS' | 'LPM' | 'MLD' | 'CMH' | 'CMD';
export type HeadlossFormula = 'H-W' | 'D-W' | 'C-M';
export type QualityMode = 'NONE' | 'CHEMICAL' | 'AGE' | 'TRACE';
export type SourceType = 'CONCEN' | 'MASS' | 'FLOWPACED' | 'SETPOINT';

/** 수질 유입원 ([SOURCES]). */
export interface QualitySource {
  type: SourceType;
  /** 기준 농도(또는 질량 유입률). */
  strength: number;
  pattern: string;
}

interface NodeBase {
  id: string;
  position: LngLat;
  /** 절점·배수지는 지반/바닥 표고, 수원지는 총수두(Total Head). */
  elevation: number;
  /** 초기 수질 ([QUALITY]). 없으면 0. */
  initQuality?: number;
  /** 수질 유입원 ([SOURCES]). */
  source?: QualitySource;
}

export interface Junction extends NodeBase {
  type: 'junction';
  /** 기본 수요량 (유량 단위). */
  demand: number;
  /** 수요 패턴 ID (없으면 빈 문자열). */
  pattern: string;
}

export interface Reservoir extends NodeBase {
  type: 'reservoir';
  /** 수두 패턴 ID (없으면 빈 문자열). */
  pattern: string;
}

export interface Tank extends NodeBase {
  type: 'tank';
  initLevel: number;
  minLevel: number;
  maxLevel: number;
  diameter: number;
  minVolume: number;
  volumeCurve: string;
  overflow: boolean;
}

export type NetworkNode = Junction | Reservoir | Tank;

interface LinkBase {
  id: string;
  startNodeId: string;
  endNodeId: string;
  /** 시점·종점 사이의 중간 꺾임점. */
  vertices: LngLat[];
}

export interface Pipe extends LinkBase {
  type: 'pipe';
  length: number;
  /** true 이면 사용자가 연장을 직접 입력한 것으로 보고 절점 이동 시 재계산하지 않는다. */
  isCustomLength: boolean;
  diameter: number;
  roughness: number;
  minorLoss: number;
  status: PipeStatus;
}

export interface Pump extends LinkBase {
  type: 'pump';
  /** 양정 곡선 ID (HEAD). 없으면 빈 문자열. */
  headCurve: string;
  /** 정동력 (POWER, kW 또는 hp). 0 이면 미사용. */
  power: number;
  speed: number;
  pattern: string;
}

export interface Valve extends LinkBase {
  type: 'valve';
  diameter: number;
  valveType: ValveType;
  /** 설정값 (GPV 는 곡선 ID 이므로 문자열로 보관). */
  setting: string;
  minorLoss: number;
}

export type NetworkLink = Pipe | Pump | Valve;

/** 모든 시간 값은 초 단위. */
export interface NetworkTimes {
  duration: number;
  hydraulicStep: number;
  qualityStep: number;
  ruleStep: number;
  patternStep: number;
  patternStart: number;
  reportStep: number;
  reportStart: number;
  startClockTime: number;
  statistic: string;
}

export interface QualityOptions {
  mode: QualityMode;
  /** CHEMICAL 일 때 물질 이름 (예: Chlorine). */
  chemName: string;
  /** CHEMICAL 일 때 농도 단위 (mg/L 또는 ug/L). */
  chemUnits: string;
  /** TRACE 일 때 추적 대상 절점 ID. */
  traceNode: string;
}

/** [REACTIONS] 의 전역 반응계수. 관로별 계수 등 나머지 줄은 extraSections.REACTIONS 에 보존한다. */
export interface ReactionOptions {
  /** 전역 체적(Bulk) 반응계수 (1/일). 염소 감소는 음수. */
  globalBulk: number;
  /** 전역 관벽(Wall) 반응계수. */
  globalWall: number;
}

export interface NetworkOptions {
  flowUnits: FlowUnits;
  headloss: HeadlossFormula;
  quality: QualityOptions;
  reactions: ReactionOptions;
  /** UNITS / HEADLOSS / QUALITY 외의 [OPTIONS] 원문 줄 (그대로 보존). */
  extra: string[];
}

export const DEFAULT_QUALITY: QualityOptions = { mode: 'NONE', chemName: 'Chlorine', chemUnits: 'mg/L', traceNode: '' };
export const DEFAULT_REACTIONS: ReactionOptions = { globalBulk: 0, globalWall: 0 };

/** 원본 .inp 좌표계 — 내보낼 때 같은 좌표계로 되돌리기 위해 보관한다. */
export type SourceCrs = (
  | { kind: 'wgs84' }
  | { kind: 'epsg'; code: string }
  | {
      /** 임의 평면 좌표(도면 단위). anchor 를 중심으로 접평면에 배치한다. */
      kind: 'local';
      origin: [number, number];
      anchor: LngLat;
      metersPerUnit: number;
    }
) & {
  /**
   * 화면 위치 보정용 평행 이동 (동 +, 북 +, m). 도로 기준 자동 보정 결과다.
   * 지도에는 원본 좌표 + 이동량으로 그리고, .inp 로 내보낼 때는 빼서 원본 좌표를 그대로 쓴다.
   */
  shift?: [number, number];
};

export interface NetworkModel {
  title: string[];
  nodes: Record<string, NetworkNode>;
  links: Record<string, NetworkLink>;
  patterns: Record<string, number[]>;
  curves: Record<string, [number, number][]>;
  options: NetworkOptions;
  times: NetworkTimes;
  /** 구조화하지 않은 섹션([CONTROLS], [RULES], [STATUS] 등)의 원문 줄. */
  extraSections: Record<string, string[]>;
  crs: SourceCrs;
}

export const DEFAULT_TIMES: NetworkTimes = {
  duration: 24 * 3600,
  hydraulicStep: 3600,
  qualityStep: 300,
  ruleStep: 300,
  patternStep: 3600,
  patternStart: 0,
  reportStep: 3600,
  reportStart: 0,
  startClockTime: 0,
  statistic: 'NONE',
};

export function createEmptyModel(): NetworkModel {
  return {
    title: ['새 관망 프로젝트'],
    nodes: {},
    links: {},
    patterns: {},
    curves: {},
    options: {
      flowUnits: 'LPS',
      headloss: 'H-W',
      quality: { ...DEFAULT_QUALITY },
      reactions: { ...DEFAULT_REACTIONS },
      extra: [],
    },
    times: { ...DEFAULT_TIMES },
    extraSections: {},
    crs: { kind: 'wgs84' },
  };
}

export function isNodeSource(node: NetworkNode): boolean {
  return node.type === 'reservoir' || node.type === 'tank';
}
