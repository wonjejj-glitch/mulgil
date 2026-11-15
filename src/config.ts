/** 앱 표시 이름 — 배포 시 상표 문제가 없도록 이 한 줄만 바꾸면 된다. */
export const APP_NAME = '물길';
export const APP_SUBTITLE = '상수·우수·하수 관망해석 워크스페이스';

export const MAX_UNDO_STEPS = 100;

/** 새 프로젝트의 초기 지도 위치 (서울시청 부근). */
export const INITIAL_VIEW = { longitude: 128.8665, latitude: 35.2385, zoom: 13 };

export const SAMPLES = [
  { file: 'sample-district.inp', label: '가상 배수구역 (정상)' },
  { file: 'sample-errors.inp', label: '검증 오류 포함 관망' },
  { file: 'sample-sewer.inp', label: '우수관망 (SWMM)' },
] as const;
