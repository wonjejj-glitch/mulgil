import { describe, expect, it } from 'vitest';
import sampleInp from '../../../public/samples/sample-district.inp?raw';
import { parseInp } from '../io/inpParser';
import { writeInp } from '../io/inpWriter';
import { runHydraulics } from './epanetRunner';
import { runFireFlow } from './fireFlow';
import { nodeValueAt, toSimulationResults } from './simulationManager';

describe('runFireFlow', () => {
  it('소화 유량을 더하면 그 절점의 수압이 정적 수압보다 낮아지고, 정적 수압은 기간 해석과 같다', async () => {
    const model = parseInp(sampleInp).model;
    const inp = writeInp(model, { forEngine: true });
    const eps = toSimulationResults(await runHydraulics(inp), 0);
    const step = 8; // 08:00
    const tankLevels = { T1: nodeValueAt(eps, 'pressure', step, 'T1')! };
    const result = await runFireFlow({ inp, nodeIds: ['J1', 'J35', 'R1'], fireFlow: 16.7, time: eps.times[step], tankLevels });

    expect(result.failedNodeIds).toEqual([]);
    expect(result.nodes.map((n) => n.nodeId)).toEqual(['J1', 'J35']); // 수원지는 대상이 아니다
    for (const node of result.nodes) {
      expect(node.residualPressure).toBeLessThan(node.staticPressure);
      expect(node.minSystemPressure).toBeLessThanOrEqual(node.residualPressure + 1e-6);
      expect(node.staticPressure).toBeCloseTo(nodeValueAt(eps, 'pressure', step, node.nodeId)!, 1);
    }
    // 소화 유량이 클수록 잔류 수압은 낮다 (유량-손실 단조성)
    const larger = await runFireFlow({ inp, nodeIds: ['J35'], fireFlow: 33.4, time: eps.times[step], tankLevels });
    expect(larger.nodes[0].residualPressure).toBeLessThan(result.nodes.find((n) => n.nodeId === 'J35')!.residualPressure);
  });
});
