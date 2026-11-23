import { describe, expect, it } from 'vitest';
import sampleInp from '../../../public/samples/sample-district.inp?raw';
import { runHydraulics } from '../../core/engine/epanetRunner';
import { nodeValueAt, toSimulationResults } from '../../core/engine/simulationManager';
import { parseInp } from '../../core/io/inpParser';
import { writeInp } from '../../core/io/inpWriter';
import { formatLabelNumber, makeLabelers } from './mapLabels';

describe('지도 라벨 글자', () => {
  it('숫자는 크기에 맞춰 소수 자리를 줄인다', () => {
    expect(formatLabelNumber(0.0123)).toBe('0.012');
    expect(formatLabelNumber(1.234)).toBe('1.23');
    expect(formatLabelNumber(45.67)).toBe('45.7');
    expect(formatLabelNumber(1234.5)).toBe('1235');
    expect(formatLabelNumber(-0.0001)).toBe('0.000');
  });

  it('해석 전에는 ID·표고·기본 수요량, 해석 뒤에는 그 시각 수압·유속을 쓴다', async () => {
    const model = parseInp(sampleInp).model;
    const j1 = model.nodes.J1;
    const pipe = Object.values(model.links).find((l) => l.type === 'pipe')!;

    const before = makeLabelers(null, 0, 'pressure', 'velocity');
    expect(before.node(j1)).toBe('J1'); // 해석 전 수압은 ID 로
    expect(before.link(pipe)).toBe('');
    expect(makeLabelers(null, 0, 'demand', 'diameter').node(j1)).toBe(formatLabelNumber(j1.type === 'junction' ? j1.demand : 0));
    expect(makeLabelers(null, 0, 'elevation', 'id').link(pipe)).toBe(pipe.id);

    const results = toSimulationResults(await runHydraulics(writeInp(model, { forEngine: true })), 0);
    const at5 = makeLabelers(results, 5, 'pressure', 'velocity');
    expect(at5.node(j1)).toBe(formatLabelNumber(nodeValueAt(results, 'pressure', 5, 'J1')!));
    expect(Number(at5.link(pipe))).toBeGreaterThanOrEqual(0);
    // 시간 스텝마다 수요량이 달라진다 (패턴)
    const d = (step: number) => makeLabelers(results, step, 'demand', 'none').node(j1);
    expect(new Set([0, 3, 6, 9, 12, 15, 18, 21].map(d)).size).toBeGreaterThan(1);
    expect(makeLabelers(results, 5, 'demand', 'none').link(pipe)).toBe('');
  });
});
