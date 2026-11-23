/**
 * 지도 라벨 글자: 절점은 ID·수압·수두·수요량·표고, 관로는 ID·관경·연장·유량·유속 중에서 고른다.
 * 해석 값은 지금 보고 있는 시간 스텝의 값이다. 숫자만 쓰고 단위는 왼쪽 패널 선택 칸에 적는다(라벨이 짧아야 겹치지 않는다).
 */
import type { SimulationResults } from '../../core/engine/simulationManager';
import type { NetworkLink, NetworkNode } from '../../core/model/types';

export type NodeLabelKind = 'id' | 'pressure' | 'head' | 'demand' | 'elevation';
export type LinkLabelKind = 'none' | 'id' | 'diameter' | 'length' | 'flow' | 'velocity';

export const NODE_LABEL_OPTIONS: { value: NodeLabelKind; label: string; unit: 'pressure' | 'elevation' | 'flow' | null; needsResults: boolean }[] = [
  { value: 'id', label: 'ID', unit: null, needsResults: false },
  { value: 'pressure', label: '수압', unit: 'pressure', needsResults: true },
  { value: 'head', label: '수두', unit: 'elevation', needsResults: true },
  { value: 'demand', label: '수요량', unit: 'flow', needsResults: false },
  { value: 'elevation', label: '표고', unit: 'elevation', needsResults: false },
];

export const LINK_LABEL_OPTIONS: { value: LinkLabelKind; label: string; unit: 'diameter' | 'length' | 'flow' | 'velocity' | null; needsResults: boolean }[] = [
  { value: 'none', label: '표시 안 함', unit: null, needsResults: false },
  { value: 'id', label: 'ID', unit: null, needsResults: false },
  { value: 'diameter', label: '관경', unit: 'diameter', needsResults: false },
  { value: 'length', label: '연장', unit: 'length', needsResults: false },
  { value: 'flow', label: '유량', unit: 'flow', needsResults: true },
  { value: 'velocity', label: '유속', unit: 'velocity', needsResults: true },
];

export interface Labelers {
  node: (node: NetworkNode) => string;
  /** 빈 글자면 그리지 않는다 */
  link: (link: NetworkLink) => string;
}

/** 크기에 맞춰 소수 자리를 줄인다 (0.012 → 0.012, 1.234 → 1.23, 45.67 → 45.7, 1234.5 → 1235). */
export function formatLabelNumber(value: number): string {
  const a = Math.abs(value);
  const digits = a >= 1000 ? 0 : a >= 10 ? 1 : a >= 0.1 || a === 0 ? 2 : 3;
  const text = value.toFixed(digits);
  return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
}

export function makeLabelers(results: SimulationResults | null, stepIndex: number, nodeKind: NodeLabelKind, linkKind: LinkLabelKind): Labelers {
  const step = results ? Math.max(0, Math.min(stepIndex, results.stepCount - 1)) : 0;
  const N = results?.nodeIds.length ?? 0;
  const L = results?.linkIds.length ?? 0;
  const nodeAt = (variable: 'pressure' | 'head' | 'demand', id: string): number | undefined => {
    const i = results?.nodeIndex.get(id);
    return results && i !== undefined ? results.node[variable][step * N + i] : undefined;
  };
  const linkAt = (variable: 'flow' | 'velocity', id: string): number | undefined => {
    const j = results?.linkIndex.get(id);
    return results && j !== undefined ? results.link[variable][step * L + j] : undefined;
  };
  const num = (v: number | undefined, fallback: string) => (v === undefined || !Number.isFinite(v) ? fallback : formatLabelNumber(v));

  const node = (n: NetworkNode): string => {
    switch (nodeKind) {
      case 'id':
        return n.id;
      case 'elevation':
        return formatLabelNumber(n.elevation);
      case 'head':
        return num(nodeAt('head', n.id), n.id);
      case 'pressure':
        // 수원지는 수압이 늘 0 이라 ID 를 보인다 (배수지는 수위)
        return n.type === 'reservoir' ? n.id : num(nodeAt('pressure', n.id), n.id);
      case 'demand':
        if (n.type !== 'junction') return n.id;
        // 해석 전에는 기본 수요량, 해석 뒤에는 그 시각 수요량(패턴·배율 반영)
        return num(results ? nodeAt('demand', n.id) : n.demand, n.id);
    }
  };

  const link = (l: NetworkLink): string => {
    switch (linkKind) {
      case 'none':
        return '';
      case 'id':
        return l.id;
      case 'diameter':
        return l.type === 'pump' ? l.id : formatLabelNumber(l.diameter);
      case 'length':
        return l.type === 'pipe' ? formatLabelNumber(l.length) : '';
      case 'flow': {
        const v = linkAt('flow', l.id);
        return v === undefined ? '' : formatLabelNumber(Math.abs(v));
      }
      case 'velocity': {
        if (l.type === 'pump') return '';
        const v = linkAt('velocity', l.id);
        return v === undefined ? '' : formatLabelNumber(Math.abs(v));
      }
    }
  };
  return { node, link };
}
