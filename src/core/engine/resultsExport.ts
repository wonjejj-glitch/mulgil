/**
 * 해석 결과 표·CSV 만들기. 엑셀에서 한글이 깨지지 않도록 CSV 는 UTF-8 BOM 을 붙여 내보낸다.
 */
import type { NetworkModel } from '../model/types';
import { formatClock, qualityLabel, qualityUnit, unitLabels } from '../model/units';
import type { SimulationResults } from './simulationManager';

export interface ResultColumn<T> {
  key: string;
  label: string;
  unit: string;
  value: (row: T) => number | string;
  numeric: boolean;
}

export interface NodeRow {
  id: string;
  type: string;
  index: number;
}

export interface LinkRow {
  id: string;
  type: string;
  index: number;
}

const NODE_TYPE = { junction: '절점', reservoir: '수원지', tank: '배수지' } as const;
const LINK_TYPE = { pipe: '관로', pump: '펌프', valve: '밸브' } as const;

export function nodeRows(model: NetworkModel, results: SimulationResults): NodeRow[] {
  return results.nodeIds.map((id, index) => ({ id, index, type: NODE_TYPE[model.nodes[id]?.type ?? 'junction'] }));
}

export function linkRows(model: NetworkModel, results: SimulationResults): LinkRow[] {
  return results.linkIds.map((id, index) => ({ id, index, type: LINK_TYPE[model.links[id]?.type ?? 'pipe'] }));
}

export function nodeColumns(model: NetworkModel, results: SimulationResults, step: number): ResultColumn<NodeRow>[] {
  const labels = unitLabels(model.options.flowUnits);
  const n = results.nodeIds.length;
  const at = (variable: 'pressure' | 'head' | 'demand' | 'quality') => (row: NodeRow) => results.node[variable][step * n + row.index];
  const columns: ResultColumn<NodeRow>[] = [
    { key: 'id', label: 'ID', unit: '', value: (r) => r.id, numeric: false },
    { key: 'type', label: '종류', unit: '', value: (r) => r.type, numeric: false },
    { key: 'elevation', label: '표고', unit: labels.elevation, value: (r) => model.nodes[r.id]?.elevation ?? NaN, numeric: true },
    { key: 'demand', label: '수요량', unit: labels.flow, value: at('demand'), numeric: true },
    { key: 'head', label: '수두', unit: labels.elevation, value: at('head'), numeric: true },
    { key: 'pressure', label: '수압', unit: labels.pressure, value: at('pressure'), numeric: true },
  ];
  if (results.quality) {
    columns.push({ key: 'quality', label: qualityLabel(results.quality), unit: qualityUnit(results.quality), value: at('quality'), numeric: true });
  }
  return columns;
}

export function linkColumns(model: NetworkModel, results: SimulationResults, step: number): ResultColumn<LinkRow>[] {
  const labels = unitLabels(model.options.flowUnits);
  const n = results.linkIds.length;
  const at = (variable: 'flow' | 'velocity' | 'headloss' | 'unitHeadloss' | 'quality') => (row: LinkRow) =>
    results.link[variable][step * n + row.index];
  const columns: ResultColumn<LinkRow>[] = [
    { key: 'id', label: 'ID', unit: '', value: (r) => r.id, numeric: false },
    { key: 'type', label: '종류', unit: '', value: (r) => r.type, numeric: false },
    {
      key: 'diameter',
      label: '관경',
      unit: labels.diameter,
      value: (r) => {
        const link = model.links[r.id];
        return link && link.type !== 'pump' ? link.diameter : NaN;
      },
      numeric: true,
    },
    {
      key: 'length',
      label: '연장',
      unit: labels.length,
      value: (r) => {
        const link = model.links[r.id];
        return link?.type === 'pipe' ? link.length : NaN;
      },
      numeric: true,
    },
    { key: 'flow', label: '유량', unit: labels.flow, value: at('flow'), numeric: true },
    { key: 'velocity', label: '유속', unit: labels.velocity, value: at('velocity'), numeric: true },
    { key: 'headloss', label: '손실수두', unit: labels.headloss, value: at('headloss'), numeric: true },
    { key: 'unitHeadloss', label: '단위 손실수두', unit: labels.unitHeadloss, value: at('unitHeadloss'), numeric: true },
  ];
  if (results.quality) {
    columns.push({ key: 'quality', label: qualityLabel(results.quality), unit: qualityUnit(results.quality), value: at('quality'), numeric: true });
  }
  return columns;
}

function csvCell(value: number | string): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(Number(value.toFixed(6))) : '';
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function header<T>(columns: ResultColumn<T>[]): string {
  return columns.map((c) => csvCell(c.unit ? `${c.label} (${c.unit})` : c.label)).join(',');
}

export const CSV_BOM = '﻿';

/** 한 시각의 표 → CSV. */
export function tableToCsv<T>(rows: T[], columns: ResultColumn<T>[]): string {
  const lines = [header(columns)];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(','));
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** 전체 시간대 결과 → 긴 형식 CSV (시각, ID, 변수…). */
export function timeSeriesCsv(model: NetworkModel, results: SimulationResults, kind: 'node' | 'link'): string {
  const lines: string[] = [];
  for (let step = 0; step < results.stepCount; step++) {
    const time = formatClock(results.times[step]);
    if (kind === 'node') {
      const columns = nodeColumns(model, results, step).filter((c) => c.key !== 'elevation' && c.key !== 'type');
      if (step === 0) lines.push(`${csvCell('시각')},${header(columns)}`);
      for (const row of nodeRows(model, results)) lines.push(`${time},${columns.map((c) => csvCell(c.value(row))).join(',')}`);
    } else {
      const columns = linkColumns(model, results, step).filter((c) => c.key !== 'diameter' && c.key !== 'length' && c.key !== 'type');
      if (step === 0) lines.push(`${csvCell('시각')},${header(columns)}`);
      for (const row of linkRows(model, results)) lines.push(`${time},${columns.map((c) => csvCell(c.value(row))).join(',')}`);
    }
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
