import type { LngLat } from '../model/types';

export type ValidationIssueType =
  | 'noSource'
  | 'orphanNode'
  | 'selfLoop'
  | 'duplicatePipe'
  | 'microPipe'
  | 'disconnected'
  | 'crossing'
  | 'overpass'
  | 'overlap'
  | 'tee';

export interface ValidationIssue {
  id: string;
  type: ValidationIssueType;
  /** info = 참고(오류일 가능성이 낮음, 일괄 보정 기본 제외). */
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** 관련 절점 ID. 유형별 의미는 각 검출 함수 주석 참고. */
  nodeIds: string[];
  linkIds: string[];
  /** 지도 이동(flyTo) 대상 위치. */
  position: LngLat | null;
  /** 자동 보정 가능 여부. */
  fixable: boolean;
}

export interface ValidationOptions {
  /** 이 길이(m) 미만의 관로를 미소 관로로 본다. */
  microPipeLength: number;
  /** T자 미분할 판정 허용오차(m). */
  teeTolerance: number;
  /** 교차하는 두 관의 관경 비가 이 값 이상이면 입체교차(본관-지관)로 추정한다. */
  overpassDiameterRatio: number;
}

export const DEFAULT_VALIDATION_OPTIONS: ValidationOptions = {
  microPipeLength: 1.0,
  teeTolerance: 0.1,
  overpassDiameterRatio: 2.5,
};

export const ISSUE_TYPE_LABELS: Record<ValidationIssueType, string> = {
  noSource: '수원 없음',
  orphanNode: '고립 절점',
  selfLoop: '자기 연결 관로',
  duplicatePipe: '중복 관로',
  microPipe: '미소 관로',
  disconnected: '단절 관망',
  crossing: '교차 미분할',
  overpass: '입체교차 추정',
  overlap: '겹쳐 지나는 관',
  tee: 'T자 미연결',
};

export const ISSUE_TYPE_ORDER: ValidationIssueType[] = [
  'noSource',
  'disconnected',
  'orphanNode',
  'selfLoop',
  'duplicatePipe',
  'microPipe',
  'crossing',
  'tee',
  'overpass',
  'overlap',
];
