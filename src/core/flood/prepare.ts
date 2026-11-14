/**
 * 침수 해석 준비 (순수 함수): 격자 범위, 맨홀 월류 시계열 → 유입원, 격자 ↔ 좌표 변환, 결과 내보내기(ESRI ASCII Grid).
 * 좌표는 하수 프로젝트 좌표(x, y m — EPSG:5186 또는 도면 좌표)를 그대로 쓴다.
 */
import type { SewerProject } from '../sewer/types';
import { NODE_VAR, type SwmmOutput } from '../swmm/outReader';
import type { FloodSource } from './solver';

export interface GridFrame {
  /** 왼쪽 위 모서리 (프로젝트 좌표, m) */
  xmin: number;
  ymax: number;
  cell: number;
  nx: number;
  ny: number;
}

/** 관망 범위 + 여유(margin m)를 덮는 격자. 셀 수가 maxCells 를 넘으면 셀을 키운다. */
export function gridFrame(project: Pick<SewerProject, 'nodes' | 'catchments'>, cell: number, margin: number, maxCells = 300_000): GridFrame {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const n of project.nodes) {
    xs.push(n.x);
    ys.push(n.y);
  }
  for (const c of project.catchments) for (const [x, y] of c.polygon ?? []) {
    xs.push(x);
    ys.push(y);
  }
  if (xs.length === 0) throw new Error('관망이 비어 있습니다.');
  const x0 = Math.min(...xs) - margin, x1 = Math.max(...xs) + margin;
  const y0 = Math.min(...ys) - margin, y1 = Math.max(...ys) + margin;
  let size = cell;
  while (Math.ceil((x1 - x0) / size) * Math.ceil((y1 - y0) / size) > maxCells) size *= 1.25;
  size = Math.round(size * 100) / 100;
  return { xmin: x0, ymax: y1, cell: size, nx: Math.ceil((x1 - x0) / size), ny: Math.ceil((y1 - y0) / size) };
}

export function cellCenter(f: GridFrame, index: number): [number, number] {
  const i = index % f.nx;
  const j = Math.floor(index / f.nx);
  return [f.xmin + (i + 0.5) * f.cell, f.ymax - (j + 0.5) * f.cell];
}

export function cellOf(f: GridFrame, x: number, y: number): number {
  const i = Math.floor((x - f.xmin) / f.cell);
  const j = Math.floor((f.ymax - y) / f.cell);
  if (i < 0 || j < 0 || i >= f.nx || j >= f.ny) return -1;
  return j * f.nx + i;
}

/** SWMM 유량 단위 → m³/s */
const TO_CMS: Record<string, number> = { CMS: 1, LPS: 0.001, MLD: 1000 / 86400, CFS: 0.0283168, GPM: 0.0000630902, MGD: 0.0438126 };

export interface OverflowNode {
  id: string;
  /** 월류 총량 (m³) */
  volume: number;
  /** 최대 월류 유량 (m³/s) */
  peak: number;
  index: number;
}

/**
 * SWMM 결과의 절점 Flooding(지표로 넘친 유량)을 유입원으로 바꾼다. 시각은 보고 기간 끝(s).
 * 격자 밖이거나 월류가 없는 절점은 빠진다.
 */
export function overflowSources(project: SewerProject, out: SwmmOutput, f: GridFrame): { sources: FloodSource[]; nodes: OverflowNode[] } {
  const k = TO_CMS[out.flowUnits] ?? 1;
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const sources: FloodSource[] = [];
  const nodes: OverflowNode[] = [];
  const nN = out.nodeIds.length;
  const times = Array.from({ length: out.periods }, (_, p) => (p + 1) * out.reportStepSec);
  out.nodeIds.forEach((id, ni) => {
    const node = byId.get(id);
    if (!node) return;
    const flows = new Array<number>(out.periods);
    let volume = 0, peak = 0;
    for (let p = 0; p < out.periods; p++) {
      const q = Math.max(0, out.node[(p * nN + ni) * out.nodeVars + NODE_VAR.flooding] * k);
      flows[p] = q;
      volume += q * out.reportStepSec;
      if (q > peak) peak = q;
    }
    if (peak <= 0) return;
    const index = cellOf(f, node.x, node.y);
    if (index < 0) return;
    // 앞에 0 을 붙여 첫 기간 동안 늘어나게 한다
    sources.push({ index, times: [0, ...times], flows: [0, ...flows] });
    nodes.push({ id, volume, peak, index });
  });
  return { sources, nodes: nodes.sort((a, b) => b.volume - a.volume) };
}

/** ESRI ASCII Grid (.asc) — GIS 에서 바로 열린다. 값이 nodata 미만이면 -9999. */
export function asciiGrid(f: GridFrame, values: ArrayLike<number>, min = 0.01): string {
  const lines = [
    `ncols ${f.nx}`,
    `nrows ${f.ny}`,
    `xllcorner ${f.xmin.toFixed(3)}`,
    `yllcorner ${(f.ymax - f.ny * f.cell).toFixed(3)}`,
    `cellsize ${f.cell}`,
    'NODATA_value -9999',
  ];
  for (let j = 0; j < f.ny; j++) {
    const row: string[] = [];
    for (let i = 0; i < f.nx; i++) {
      const v = values[j * f.nx + i];
      row.push(v >= min ? v.toFixed(3) : '-9999');
    }
    lines.push(row.join(' '));
  }
  return lines.join('\n') + '\n';
}

/** 지반고를 맨홀 지반고에 맞추는 보정량: 맨홀 지반고 − 격자 지반고의 중앙값. */
export function demOffset(project: SewerProject, f: GridFrame, z: ArrayLike<number>): { offset: number; samples: number; spread: number } {
  const diffs: number[] = [];
  for (const n of project.nodes) {
    const c = cellOf(f, n.x, n.y);
    if (c >= 0 && Number.isFinite(z[c])) diffs.push(n.ground - z[c]);
  }
  if (diffs.length === 0) return { offset: 0, samples: 0, spread: 0 };
  diffs.sort((a, b) => a - b);
  const offset = diffs[Math.floor(diffs.length / 2)];
  const spread = diffs.reduce((s, d) => s + Math.abs(d - offset), 0) / diffs.length;
  return { offset, samples: diffs.length, spread };
}
