/**
 * 설계기준 프리셋. 값과 근거 쪽수는 기준 문서를 그대로 옮긴 것이고, 문서에 없는 항목은 바꾸지 않는다.
 *
 * 부산광역시 「2026 하수관로 신설(확충)공사 설계기준」(공공하수인프라과, 2026.03) — 분류식 오수관로 기준.
 * 우수·합류식(합리식, 유출계수, 강우강도) 값은 이 문서에 없다.
 */
import type { PracticalRules } from './design';
import type { SewerConstraints } from './types';

export interface DesignStandard {
  id: string;
  name: string;
  /** 바꾸는 설계 제약 (없는 키는 그대로 둔다) */
  constraints: Partial<SewerConstraints>;
  rules: PracticalRules;
  /** 화면에 보여 줄 근거 (항목: 값 — 쪽) */
  notes: string[];
  /** 문서에 규정이 없어 바꾸지 않은 항목 */
  notDefined: string[];
}

export const BUSAN_2026_SEWAGE: DesignStandard = {
  id: 'busan-2026-sewage',
  name: '부산 2026 하수관로 신설(확충) 설계기준 (오수관로)',
  constraints: {
    min_cover: 1.0,
    min_velocity: 0.6,
    max_velocity: 3.0,
    // 여유율: D200~600 약 100% (용량 ≥ 2Q) ≈ 원형관 수심비 0.5. D700 이상은 50~100% 라 0.5 는 안전 쪽.
    max_depth_ratio: 0.5,
    diameters: [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.35, 1.5],
  },
  rules: { minFlow: 0.001, dropPipeAt: 0.6, maxDrop: 1.5 },
  notes: [
    '유속 0.6~3.0 m/s, 계획시간최대오수량 기준 — p.13·16·27',
    '최소토피 1.0 m (불가피 시 0.6 m + 보호공) — p.17·28',
    '여유율 D200~600 약 100% → 수심비 0.5 로 적용 (D700~1500 은 50~100%) — p.17·27',
    '최소관경 D200 (초기관 국지적 D150 가능) — p.16~17·28',
    '조도계수 n: 철근콘크리트관·도관 0.013, PVC·GRP 등 0.011 — p.27',
    '관 유량 0.001 m³/s 미만은 0.001 로 절상 — p.15~16',
    '단차 0.6 m 이상이면 부관, 1개소 단차 1.5 m 이내 — p.18·29',
    '시간최대오수량 = 일최대오수량 × 1.5 — p.16',
    '맨홀 최대간격: D600 이하 75 m, D1000 이하 100 m, D1500 이하 150 m — p.30',
    '0.6 m/s 미만 구간은 도면에 ‘중점유지관리대상’ 표기 — p.18',
  ],
  notDefined: [
    '최대 굴착깊이 (공법 구분 2 m·4 m 만 있음 — p.41)',
    '최소·최대 경사 (유속으로 판정, 시점부 관 최소 5‰ — p.27)',
    '오수량 원단위·전환율·지하수량 (부산시 하수도정비기본계획 따름 — p.15)',
    '우수·합류식 설계값',
    '표준 관경 목록 (위 목록은 KS 규격 예시)',
  ],
};

export const DESIGN_STANDARDS: DesignStandard[] = [BUSAN_2026_SEWAGE];
