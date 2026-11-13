/**
 * 하수관 설계 모델. SewerStudio(Python/Pydantic)의 Project 와 같은 필드·기본값·검증을 따른다
 * (PORTING/vectors/project.schema.json 및 SPEC.md §8). 단위: m, m³/s, ha, mm/h, %.
 *
 * 기본 제약값은 전부 예제값이며 한국 하수도시설기준으로 검증된 값이 아니다.
 */

export type SewerNodeKind = 'JUNCTION' | 'OUTFALL';
export type SewerBoundary = 'FREE' | 'NORMAL' | 'FIXED';

export interface SewerNode {
  id: string;
  /** 투영 좌표(m) — 도면 좌표. */
  x: number;
  y: number;
  /** 맨홀 뚜껑(지반) 표고. */
  ground: number;
  /** 맨홀 관저고 (설계하면 다시 계산됨. 방류구는 고정). */
  invert: number;
  kind: SewerNodeKind;
  /** 상시 오수 유입 (m³/s). */
  base_flow: number;
  boundary: SewerBoundary;
  /** FIXED 방류 수위 (절대 표고). */
  stage: number | null;
}

export interface SewerConduit {
  id: string;
  upstream: string;
  downstream: string;
  length: number;
  diameter: number;
  roughness: number;
  inlet_offset: number;
  outlet_offset: number;
}

export interface SewerCatchment {
  id: string;
  outlet: string;
  /** ha */
  area: number;
  /** % */
  impervious: number;
  /** m */
  width: number;
  /** % */
  slope: number;
  /** 합리식 유출계수 */
  runoff_coefficient: number;
  /** mm/h */
  horton_max: number;
  horton_min: number;
  horton_decay: number;
}

export interface RainPoint {
  /** 해석 시작 후 분 */
  minute: number;
  /** mm/h — 다음 점까지 일정 */
  intensity: number;
}

export interface SewerOptions {
  duration_minutes: number;
  report_seconds: number;
  routing_seconds: number;
  rain_interval_minutes: number;
  routing: 'DYNWAVE' | 'KINWAVE';
  /** 합리식 설계 강우강도 (mm/h) */
  design_intensity: number;
  rainfall: RainPoint[];
}

export interface SewerConstraints {
  /** 표준 관경 (m), 오름차순·중복 없음 */
  diameters: number[];
  min_cover: number;
  max_depth: number;
  min_slope: number;
  max_slope: number;
  min_velocity: number;
  max_velocity: number;
  max_depth_ratio: number;
  max_iterations: number;
  /** % */
  continuity_tolerance: number;
}

export interface SewerProject {
  schema_version: 1;
  name: string;
  nodes: SewerNode[];
  conduits: SewerConduit[];
  catchments: SewerCatchment[];
  options: SewerOptions;
  constraints: SewerConstraints;
}

export const DEFAULT_RAINFALL: RainPoint[] = [
  { minute: 0, intensity: 0 },
  { minute: 10, intensity: 20 },
  { minute: 20, intensity: 55 },
  { minute: 40, intensity: 25 },
  { minute: 60, intensity: 0 },
];

export function defaultOptions(): SewerOptions {
  return {
    duration_minutes: 180,
    report_seconds: 60,
    routing_seconds: 5,
    rain_interval_minutes: 5,
    routing: 'DYNWAVE',
    design_intensity: 55,
    rainfall: DEFAULT_RAINFALL.map((p) => ({ ...p })),
  };
}

export function defaultConstraints(): SewerConstraints {
  return {
    diameters: [0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.2, 1.5],
    min_cover: 1,
    max_depth: 8,
    min_slope: 0.003,
    max_slope: 0.1,
    min_velocity: 0.6,
    max_velocity: 3,
    max_depth_ratio: 0.8,
    max_iterations: 5,
    continuity_tolerance: 5,
  };
}

/** SewerStudio 의 demo_project() 와 같은 예제 (분기형 우·오수 관망). */
export function demoProject(): SewerProject {
  const rows: [number, number, number, number, number][] = [
    [1, 0, 120, 104, 0.003],
    [2, 125, 120, 103.4, 0.004],
    [3, 0, 0, 104.2, 0.003],
    [4, 125, 0, 103.3, 0.004],
    [5, 250, 65, 102.7, 0.005],
    [6, 365, 65, 102, 0.005],
    [7, 250, 200, 103.2, 0.004],
    [8, 480, 65, 101.4, 0.006],
  ];
  const nodes: SewerNode[] = rows.map(([i, x, y, z, q]) => ({
    id: `MH${i}`, x, y, ground: z, invert: z - 1.8, kind: 'JUNCTION', base_flow: q, boundary: 'FREE', stage: null,
  }));
  nodes.push({ id: 'OF1', x: 610, y: 65, ground: 100.8, invert: 98.2, kind: 'OUTFALL', base_flow: 0, boundary: 'FREE', stage: null });
  const links: [string, string, number][] = [
    ['MH1', 'MH2', 125], ['MH2', 'MH5', 141], ['MH3', 'MH4', 125], ['MH4', 'MH5', 141],
    ['MH5', 'MH6', 115], ['MH7', 'MH6', 177], ['MH6', 'MH8', 115], ['MH8', 'OF1', 130],
  ];
  const conduits: SewerConduit[] = links.map(([u, d, l], i) => ({
    id: `P${String(i + 1).padStart(2, '0')}`, upstream: u, downstream: d, length: l, diameter: 0.25, roughness: 0.013, inlet_offset: 0, outlet_offset: 0,
  }));
  const catchments: SewerCatchment[] = Array.from({ length: 8 }, (_, k) => {
    const i = k + 1;
    return {
      id: `S${i}`, outlet: `MH${i}`, area: 0.6 + 0.1 * (i % 3), impervious: 60, width: 80, slope: 1, runoff_coefficient: 0.65,
      horton_max: 75, horton_min: 5, horton_decay: 4,
    };
  });
  return { schema_version: 1, name: '분기형 우·오수 관망 · 예제', nodes, conduits, catchments, options: defaultOptions(), constraints: defaultConstraints() };
}
