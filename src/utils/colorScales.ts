/** 수치 범위별 색상 분류·보간. 지도 주제도와 범례가 같은 스케일을 공유한다. */

export type RGB = [number, number, number];

export interface ThematicScale {
  title: string;
  unit: string;
  /** 오름차순 경계값. 구간 수는 breaks.length + 1. */
  breaks: number[];
  colors: RGB[];
  labels: string[];
  /** 범주형 스케일(급수구역 등): 범례를 정의 순서대로 보인다. */
  categorical?: boolean;
}

export const PALETTE = {
  blue: [57, 135, 229] as RGB,
  cyan: [34, 184, 207] as RGB,
  green: [46, 184, 76] as RGB,
  yellow: [250, 178, 25] as RGB,
  orange: [236, 131, 90] as RGB,
  red: [227, 73, 72] as RGB,
  magenta: [200, 80, 230] as RGB,
  slate: [120, 138, 165] as RGB,
  neutralNode: [214, 222, 235] as RGB,
  neutralPipe: [110, 160, 215] as RGB,
  pump: [250, 178, 25] as RGB,
  valve: [176, 148, 240] as RGB,
  reservoir: [57, 135, 229] as RGB,
  tank: [34, 184, 207] as RGB,
  selection: [255, 255, 255] as RGB,
  highlight: [255, 221, 51] as RGB,
};

/** 낮음 → 높음 5단계 (파랑~초록~빨강). */
export const RAMP_5: RGB[] = [PALETTE.blue, PALETTE.cyan, PALETTE.green, PALETTE.yellow, PALETTE.red];

export function interpolateRgb(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

/** 여러 색상 정지점 사이를 선형 보간한다. t 는 0~1. */
export function rampColor(stops: RGB[], t: number): RGB {
  if (stops.length === 1) return stops[0];
  const k = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(k));
  return interpolateRgb(stops[index], stops[index + 1], k - index);
}

/** 값이 속한 구간의 인덱스 (경계값은 위 구간에 속한다). */
export function classIndex(breaks: number[], value: number): number {
  let index = 0;
  while (index < breaks.length && value >= breaks[index]) index++;
  return index;
}

export function classify(scale: ThematicScale, value: number): RGB {
  return scale.colors[classIndex(scale.breaks, value)];
}

function trimNumber(value: number): string {
  return String(Number(value.toPrecision(4)));
}

function rangeLabels(breaks: number[]): string[] {
  const labels: string[] = [`${trimNumber(breaks[0])} 미만`];
  for (let i = 0; i < breaks.length - 1; i++) labels.push(`${trimNumber(breaks[i])} ~ ${trimNumber(breaks[i + 1])}`);
  labels.push(`${trimNumber(breaks[breaks.length - 1])} 이상`);
  return labels;
}

/** 수압: 음압·저수압·적정·높음·고수압의 상태 구분. */
export function pressureScale(us: boolean): ThematicScale {
  const breaks = us ? [0, 21, 57, 100] : [0, 15, 40, 70];
  const [, low, ok, high] = breaks;
  return {
    title: '수압',
    unit: us ? 'psi' : 'm',
    breaks,
    colors: [PALETTE.magenta, PALETTE.red, PALETTE.green, PALETTE.blue, PALETTE.yellow],
    labels: [
      '음압 (0 미만)',
      `저수압 (0 ~ ${low})`,
      `적정 (${low} ~ ${ok})`,
      `높음 (${ok} ~ ${high})`,
      `고수압 (${high} 이상)`,
    ],
  };
}

export function velocityScale(us: boolean): ThematicScale {
  const breaks = us ? [0.3, 1, 3, 6.5, 10] : [0.1, 0.3, 1, 2, 3];
  const labels = rangeLabels(breaks);
  labels[0] = `정체 (${breaks[0]} 미만)`;
  labels[labels.length - 1] = `과대 (${breaks[breaks.length - 1]} 이상)`;
  return {
    title: '유속',
    unit: us ? 'ft/s' : 'm/s',
    breaks,
    colors: [PALETTE.slate, PALETTE.blue, PALETTE.green, PALETTE.yellow, PALETTE.orange, PALETTE.red],
    labels,
  };
}

export function unitHeadlossScale(us: boolean): ThematicScale {
  const breaks = [1, 3, 5, 10];
  return {
    title: '단위 손실수두',
    unit: us ? 'ft/kft' : 'm/km',
    breaks,
    colors: RAMP_5,
    labels: rangeLabels(breaks),
  };
}

/**
 * 잔류염소(mg/L): 수도법 기준 — 수도꼭지 0.1 mg/L 이상(결합 0.4), 먹는물 수질기준 4.0 mg/L 이하.
 * 0.2 미만은 말단 관리 목표 미달로 본다.
 */
export function chlorineScale(): ThematicScale {
  return {
    title: '잔류염소',
    unit: 'mg/L',
    breaks: [0.1, 0.2, 1, 4],
    colors: [PALETTE.red, PALETTE.orange, PALETTE.green, PALETTE.blue, PALETTE.magenta],
    labels: ['부족 (0.1 미만)', '낮음 (0.1 ~ 0.2)', '적정 (0.2 ~ 1.0)', '높음 (1.0 ~ 4.0)', '기준 초과 (4.0 이상)'],
  };
}

/** 수령(시간): 체류시간이 길수록 수질 저하 위험. */
export function waterAgeScale(): ThematicScale {
  const breaks = [6, 12, 24, 48];
  const labels = rangeLabels(breaks);
  labels[labels.length - 1] = '장기 체류 (48 이상)';
  return { title: '수령', unit: '시간', breaks, colors: [PALETTE.blue, PALETTE.cyan, PALETTE.green, PALETTE.yellow, PALETTE.red], labels };
}

export function traceScale(name: string): ThematicScale {
  const breaks = [10, 30, 50, 70, 90];
  return {
    title: name,
    unit: '%',
    breaks,
    colors: [PALETTE.slate, PALETTE.blue, PALETTE.cyan, PALETTE.green, PALETTE.yellow, PALETTE.red],
    labels: rangeLabels(breaks),
  };
}

/** 범주형(수원별) 색: 이웃 색끼리 구분이 잘 되도록 고른 10색. */
export const CATEGORY_COLORS: RGB[] = [
  [57, 135, 229],
  [236, 131, 90],
  [46, 184, 76],
  [200, 80, 230],
  [250, 178, 25],
  [34, 184, 207],
  [227, 73, 72],
  [150, 200, 60],
  [240, 120, 180],
  [140, 150, 255],
];
const MIXED_ZONE: RGB = [170, 176, 190];
const NO_SUPPLY: RGB = [80, 84, 96];

/**
 * 급수구역 범주 스케일. 값 = 수원 인덱스(0..n-1), n = 혼합, n+1 = 공급 없음.
 * 수원이 10개를 넘으면 색을 돌려 쓴다.
 */
export function zoneScale(sourceIds: string[], mixedThreshold: number): ThematicScale {
  const n = sourceIds.length;
  const breaks = Array.from({ length: n + 1 }, (_, i) => i + 0.5);
  const colors = [...sourceIds.map((_, i) => CATEGORY_COLORS[i % CATEGORY_COLORS.length]), MIXED_ZONE, NO_SUPPLY];
  const labels = [...sourceIds, `혼합 (최대 기여 ${Math.round(mixedThreshold * 100)}% 미만)`, '공급 없음 (흐름 없음)'];
  return { title: '급수구역', unit: '주 공급 수원', breaks, colors, labels, categorical: true };
}

function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / magnitude;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * magnitude;
}

/** 데이터 범위에 맞춘 5단계 등간격 스케일. */
export function dataScale(title: string, unit: string, min: number, max: number): ThematicScale {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-9) {
    const value = Number.isFinite(min) ? min : 0;
    return { title, unit, breaks: [], colors: [PALETTE.green], labels: [trimNumber(value)] };
  }
  const step = niceStep((max - min) / 5);
  const breaks: number[] = [];
  let value = Math.floor(min / step) * step + step;
  while (value < max - step * 1e-6 && breaks.length < 4) {
    if (value > min) breaks.push(Number(value.toPrecision(10)));
    value += step;
  }
  if (breaks.length === 0) return { title, unit, breaks: [], colors: [PALETTE.green], labels: [`${trimNumber(min)} ~ ${trimNumber(max)}`] };
  const colors = Array.from({ length: breaks.length + 1 }, (_, i) => rampColor(RAMP_5, i / breaks.length));
  return { title, unit, breaks, colors, labels: rangeLabels(breaks) };
}

export function toCss(color: RGB, alpha = 1): string {
  return alpha >= 1 ? `rgb(${color[0]}, ${color[1]}, ${color[2]})` : `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
}
