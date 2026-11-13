import { describe, expect, it } from 'vitest';
import errorInp from '../../../public/samples/sample-errors.inp?raw';
import sampleInp from '../../../public/samples/sample-district.inp?raw';
import { parseInp } from '../io/inpParser';
import { writeInp } from '../io/inpWriter';
import { EpanetRunError, runHydraulics } from './epanetRunner';
import { nodeColumns, nodeRows, tableToCsv, timeSeriesCsv } from './resultsExport';
import { negativePressureNodes, nodeSeries, nodeValueAt, toSimulationResults } from './simulationManager';

describe('runHydraulics (EPANET WASM)', () => {
  it('샘플 관망을 24시간 해석해 시간대별 결과를 돌려준다', async () => {
    const model = parseInp(sampleInp).model;
    const raw = await runHydraulics(writeInp(model, { forEngine: true }));
    const results = toSimulationResults(raw, 0);

    expect(results.stepCount).toBe(25);
    expect(results.times[0]).toBe(0);
    expect(results.times[24]).toBe(86400);
    expect(results.nodeIds).toHaveLength(Object.keys(model.nodes).length);
    expect(results.linkIds).toHaveLength(Object.keys(model.links).length);
    expect(results.node.pressure.every((v) => Number.isFinite(v))).toBe(true);

    // 수원지 수두는 고정값 78 m
    expect(nodeValueAt(results, 'head', 0, 'R1')).toBeCloseTo(78, 3);
    // 일반 절점 수압은 (수두 - 표고) 와 같다
    const j1 = model.nodes.J1;
    const head = nodeValueAt(results, 'head', 5, 'J1')!;
    expect(nodeValueAt(results, 'pressure', 5, 'J1')).toBeCloseTo(head - j1.elevation, 2);
    // 수요 패턴이 적용되어 시간대별 수요가 달라진다
    const demand = nodeSeries(results, 'demand', 'J1');
    expect(Math.max(...demand)).toBeGreaterThan(Math.min(...demand) * 2);
    // 정상 샘플에는 음압이 없다
    expect(negativePressureNodes(results, new Set(['R1', 'T1']))).toHaveLength(0);
    expect(results.ranges.velocity[1]).toBeGreaterThan(0.05);
  });

  it('잔류염소 수질 해석: 수원 농도에서 출발해 체적 반응으로 감소한다', async () => {
    const model = parseInp(sampleInp).model;
    model.options.quality = { mode: 'CHEMICAL', chemName: 'Chlorine', chemUnits: 'mg/L', traceNode: '' };
    model.options.reactions.globalBulk = -0.5;
    model.nodes.R1.initQuality = 1.0;
    const inp = writeInp(model, { forEngine: true });
    expect(inp).toMatch(/Quality\s+Chlorine\s+mg\/L/);
    expect(inp).toMatch(/Global\s+Bulk\s+-0\.5/);

    const results = toSimulationResults(await runHydraulics(inp), 0);
    expect(results.quality?.mode).toBe('CHEMICAL');
    expect(results.quality?.units.toLowerCase()).toBe('mg/l');
    const last = results.stepCount - 1;
    expect(nodeValueAt(results, 'quality', last, 'R1')).toBeCloseTo(1.0, 3);
    const far = nodeValueAt(results, 'quality', last, 'J35')!;
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(1.0);
  });

  it('수령(Age) 해석은 시간 단위 값을 돌려준다', async () => {
    const model = parseInp(sampleInp).model;
    model.options.quality.mode = 'AGE';
    const results = toSimulationResults(await runHydraulics(writeInp(model, { forEngine: true })), 0);
    expect(results.quality?.mode).toBe('AGE');
    expect(nodeValueAt(results, 'quality', results.stepCount - 1, 'J35')).toBeGreaterThan(0.1);
  });

  it('수질 해석을 끄면 quality 결과가 없다', async () => {
    const model = parseInp(sampleInp).model;
    const results = toSimulationResults(await runHydraulics(writeInp(model, { forEngine: true })), 0);
    expect(results.quality).toBeNull();
  });

  it('결과 표를 CSV 로 만든다 (BOM, 단위 머리글, 시계열 긴 형식)', async () => {
    const model = parseInp(sampleInp).model;
    const results = toSimulationResults(await runHydraulics(writeInp(model, { forEngine: true })), 0);
    const rows = nodeRows(model, results);
    const csv = tableToCsv(rows, nodeColumns(model, results, 3));
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe('ID,종류,표고 (m),수요량 (LPS),수두 (m),수압 (m)');
    expect(lines).toHaveLength(rows.length + 1);
    const j1 = lines.find((l) => l.startsWith('J1,'))!.split(',');
    expect(Number(j1[5])).toBeCloseTo(nodeValueAt(results, 'pressure', 3, 'J1')!, 4);

    const series = timeSeriesCsv(model, results, 'link').trim().split('\r\n');
    expect(series[0]).toContain('시각');
    expect(series).toHaveLength(1 + results.stepCount * results.linkIds.length);
  });

  it('고립 절점이 있는 관망은 오류 코드와 함께 실패한다', async () => {
    const model = parseInp(errorInp).model;
    await expect(runHydraulics(writeInp(model, { forEngine: true }))).rejects.toBeInstanceOf(EpanetRunError);
    await runHydraulics(writeInp(model, { forEngine: true })).catch((error: EpanetRunError) => {
      expect(error.code).not.toBeNull();
    });
  });
});
