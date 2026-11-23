import { describe, expect, it } from 'vitest';
import sample from '../../../public/samples/sample-district.inp?raw';
import { runHydraulics } from '../engine/epanetRunner';
import { linkSeries, nodeSeries, toSimulationResults } from '../engine/simulationManager';
import { parseInp } from '../io/inpParser';
import { writeInp } from '../io/inpWriter';
import { insertDeviceOnPipe, renameLink, renameNode, splitPipe } from './networkEdit';

const TEXT = [
  '[JUNCTIONS]', ' A 10 1', ' B 10 1',
  '[TANKS]', ' T1 60 3 0 5 10 0',
  '[RESERVOIRS]', ' R 50',
  '[PIPES]', ' P1 R A 100 150 110 0 Open', ' P2 A B 100 150 110 0 Open', ' P3 B T1 100 150 110 0 Open',
  '[DEMANDS]', ' A 1 PAT1', ' A 2 PAT2',
  '[CONTROLS]', ' LINK P2 CLOSED IF NODE T1 ABOVE 4.5', ' LINK P3 OPEN AT TIME 6',
  '[RULES]', ' RULE 1', ' IF TANK T1 LEVEL BELOW 1', ' THEN PIPE P2 STATUS IS OPEN',
  '[REACTIONS]', ' Bulk P2 -0.7',
  '[OPTIONS]', ' Quality Trace T1',
  '[COORDINATES]', ' A 127.0 37.0', ' B 127.001 37.0', ' R 126.999 37.0', ' T1 127.002 37.0',
  '[END]',
].join('\n');

describe('renameNode / renameLink', () => {
  it('제어 규칙·원문 섹션·추적 절점의 ID 참조도 함께 바꾼다', () => {
    const { model } = parseInp(TEXT);
    expect(renameNode(model, 'T1', 'TANK_N')).toBe(true);
    expect(renameNode(model, 'A', 'J_A')).toBe(true);
    expect(renameLink(model, 'P2', 'MAIN2')).toBe(true);

    expect(model.extraSections.CONTROLS).toEqual(['LINK MAIN2 CLOSED IF NODE TANK_N ABOVE 4.5', 'LINK P3 OPEN AT TIME 6']);
    expect(model.extraSections.RULES).toEqual(['RULE 1', 'IF TANK TANK_N LEVEL BELOW 1', 'THEN PIPE MAIN2 STATUS IS OPEN']);
    expect(model.extraSections.DEMANDS).toEqual(['J_A 1 PAT1', 'J_A 2 PAT2']);
    expect(model.extraSections.REACTIONS).toEqual(['Bulk MAIN2 -0.7']);
    expect(model.options.quality.traceNode).toBe('TANK_N');
    expect(model.links.P3.endNodeId).toBe('TANK_N');
  });

  it('이미 있는 ID 나 공백이 든 ID 로는 바꾸지 않는다', () => {
    const { model } = parseInp(TEXT);
    expect(renameNode(model, 'A', 'B')).toBe(false);
    expect(renameLink(model, 'P1', 'P 1')).toBe(false);
  });
});

describe('splitPipe', () => {
  it('관로를 둘로 나누고 총 연장을 보존한다', () => {
    const { model } = parseInp(TEXT);
    const pipe = model.links.P2;
    const total = pipe.type === 'pipe' ? pipe.length : 0;
    const result = splitPipe(model, 'P2', [127.0005, 37.0]);
    expect(result).not.toBeNull();
    const left = model.links.P2;
    const right = model.links[result!.newPipeId];
    expect(left.endNodeId).toBe(result!.nodeId);
    expect(right.startNodeId).toBe(result!.nodeId);
    if (left.type === 'pipe' && right.type === 'pipe') {
      expect(left.length + right.length).toBeCloseTo(total, 1);
    }
  });
});

describe('insertDeviceOnPipe (관로 가운데에 펌프·밸브)', () => {
  it('감압밸브는 하류 압력을 설정값으로 낮추고, 펌프는 한 점 곡선 양정만큼 수두를 올린다', async () => {
    const base = parseInp(sample).model;
    const solve = async (m: typeof base) => toSimulationResults(await runHydraulics(writeInp(m, { forEngine: true })), 0);
    const before = await solve(base);
    // 수원지에서 나가는 관 = 관망 전체가 이 관으로 물을 받는다
    const main = Object.values(base.links).find((l) => l.type === 'pipe' && (base.nodes[l.startNodeId].type === 'reservoir' || base.nodes[l.endNodeId].type === 'reservoir'))!;
    const flowSign = Math.sign(linkSeries(before, 'flow', main.id).reduce((a, q) => a + q, 0)) || 1;
    const a = base.nodes[main.startNodeId].position;
    const b = base.nodes[main.endNodeId].position;
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    const prvModel = structuredClone(base);
    const prv = insertDeviceOnPipe(prvModel, 'valve', main.id, mid, { flowSign })!;
    expect(prvModel.links[prv.linkId]).toMatchObject({ type: 'valve', valveType: 'PRV', diameter: main.type === 'pipe' ? main.diameter : 0 });
    const linksBefore = Object.keys(base.links).length;
    expect(Object.keys(prvModel.links)).toHaveLength(linksBefore + 2); // 관이 둘로 + 밸브
    const upPressure = Math.min(...nodeSeries(before, 'pressure', flowSign > 0 ? main.endNodeId : main.startNodeId));
    const setting = Math.max(5, Math.round(upPressure - 15));
    const valve = prvModel.links[prv.linkId];
    if (valve.type === 'valve') valve.setting = String(setting);
    const r1 = await solve(prvModel);
    // 밸브로 물이 흐르는 시각에는 하류 압력 = 설정값 (배수지가 하류를 채우는 시각엔 밸브가 닫힌다)
    const q = linkSeries(r1, 'flow', prv.linkId);
    const down = nodeSeries(r1, 'pressure', prv.downstreamNodeId);
    const active = q.map((v, t) => (v > 0.01 ? down[t] : NaN)).filter(Number.isFinite);
    expect(active.length).toBeGreaterThan(0);
    for (const p of active) expect(p).toBeCloseTo(setting, 0);

    const pumpModel = structuredClone(base);
    const peak = Math.round(Math.max(...linkSeries(before, 'flow', main.id).map(Math.abs)) * 1000) / 1000;
    const pump = insertDeviceOnPipe(pumpModel, 'pump', main.id, mid, { flowSign, pumpFlow: peak, pumpHead: 20 })!;
    expect(pumpModel.curves[pump.curveId!]).toEqual([[peak, 20]]);
    const r2 = await solve(pumpModel);
    const lift = nodeSeries(r2, 'head', pump.downstreamNodeId)[0] - nodeSeries(r2, 'head', pump.upstreamNodeId)[0];
    expect(lift).toBeGreaterThan(5);
  });
});
