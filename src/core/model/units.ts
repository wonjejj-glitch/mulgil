import type { FlowUnits, HeadlossFormula } from './types';

const US_FLOW_UNITS: ReadonlySet<FlowUnits> = new Set(['CFS', 'GPM', 'MGD', 'IMGD', 'AFD']);

export const FLOW_UNIT_OPTIONS: { value: FlowUnits; label: string }[] = [
  { value: 'LPS', label: 'LPS (L/s)' },
  { value: 'CMD', label: 'CMD (m³/일)' },
  { value: 'CMH', label: 'CMH (m³/시)' },
  { value: 'LPM', label: 'LPM (L/분)' },
  { value: 'MLD', label: 'MLD (천m³/일)' },
  { value: 'GPM', label: 'GPM (gal/분)' },
  { value: 'CFS', label: 'CFS (ft³/s)' },
  { value: 'MGD', label: 'MGD' },
  { value: 'IMGD', label: 'IMGD' },
  { value: 'AFD', label: 'AFD' },
];

export const HEADLOSS_OPTIONS: { value: HeadlossFormula; label: string }[] = [
  { value: 'H-W', label: 'Hazen-Williams' },
  { value: 'D-W', label: 'Darcy-Weisbach' },
  { value: 'C-M', label: 'Chezy-Manning' },
];

export function isUsUnits(flowUnits: FlowUnits): boolean {
  return US_FLOW_UNITS.has(flowUnits);
}

export interface UnitLabels {
  flow: string;
  length: string;
  diameter: string;
  tankDiameter: string;
  elevation: string;
  pressure: string;
  velocity: string;
  headloss: string;
  unitHeadloss: string;
  power: string;
}

export function unitLabels(flowUnits: FlowUnits): UnitLabels {
  if (isUsUnits(flowUnits)) {
    return {
      flow: flowUnits,
      length: 'ft',
      diameter: 'in',
      tankDiameter: 'ft',
      elevation: 'ft',
      pressure: 'psi',
      velocity: 'ft/s',
      headloss: 'ft',
      unitHeadloss: 'ft/kft',
      power: 'hp',
    };
  }
  return {
    flow: flowUnits,
    length: 'm',
    diameter: 'mm',
    tankDiameter: 'm',
    elevation: 'm',
    pressure: 'm',
    velocity: 'm/s',
    headloss: 'm',
    unitHeadloss: 'm/km',
    power: 'kW',
  };
}

export const FEET_PER_METER = 3.280839895;
/** 수두 1 m 에 해당하는 psi. */
export const PSI_PER_METER = 1.4219702;

/** 미터 값을 모델 단위계의 길이 값으로 변환. */
export function metersToModelLength(meters: number, flowUnits: FlowUnits): number {
  return isUsUnits(flowUnits) ? meters * FEET_PER_METER : meters;
}

/** 모델 단위계의 길이 값을 미터로 변환. */
export function modelLengthToMeters(length: number, flowUnits: FlowUnits): number {
  return isUsUnits(flowUnits) ? length / FEET_PER_METER : length;
}

/** 조도계수 라벨: 손실수두 공식에 따라 의미가 다르다. */
export function roughnessLabel(headloss: HeadlossFormula, flowUnits: FlowUnits): string {
  if (headloss === 'H-W') return '조도계수 C';
  if (headloss === 'C-M') return '조도계수 n';
  return isUsUnits(flowUnits) ? '조도 ε (10⁻³ ft)' : '조도 ε (mm)';
}

export function defaultRoughness(headloss: HeadlossFormula): number {
  if (headloss === 'H-W') return 110;
  if (headloss === 'C-M') return 0.013;
  return 0.26;
}

interface QualityDescriptor {
  mode: 'CHEMICAL' | 'AGE' | 'TRACE';
  name: string;
  units: string;
}

/** 수질 결과 라벨 (예: "Chlorine", "수령", "R1 기여율"). */
export function qualityLabel(info: QualityDescriptor): string {
  if (info.mode === 'AGE') return '수령';
  if (info.mode === 'TRACE') return info.name;
  return info.name.toLowerCase() === 'chlorine' ? '잔류염소' : info.name;
}

export function qualityUnit(info: QualityDescriptor): string {
  if (info.mode === 'AGE') return '시간';
  if (info.mode === 'TRACE') return '%';
  return info.units.toLowerCase() === 'ug/l' ? 'µg/L' : 'mg/L';
}

/** 초 → "H:MM" (초가 있으면 "H:MM:SS"). */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  return s === 0 ? `${h}:${mm}` : `${h}:${mm}:${String(s).padStart(2, '0')}`;
}

export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  if (abs !== 0 && abs < 10 ** -digits) return value.toExponential(1);
  return value.toLocaleString('ko-KR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
