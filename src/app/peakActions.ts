/** 시간최대계수(수요 배율) 적용·비교 해석. 계산은 core/engine/peakFactor.ts, 해석은 EPANET 워커. */
import type { WaterCriteria } from '../core/engine/criteria';
import { modelWithFactor, summarizeScenario, withDemandMultiplier, type FactorScenario } from '../core/engine/peakFactor';
import { SimulationManager } from '../core/engine/simulationManager';
import { writeInp } from '../core/io/inpWriter';
import { isNodeSource } from '../core/model/types';
import { useNetworkStore } from '../store/useNetworkStore';
import { useUIStore } from '../store/useUIStore';
import { runSimulation } from './actions';

// 비교 해석은 본 해석(simulationManager)을 끊지 않게 따로 돌린다.
const sweepManager = new SimulationManager();

/** 관망의 수요 배율을 바꾸고(실행 취소 가능) 바로 다시 해석한다. */
export async function applyDemandFactor(factor: number): Promise<void> {
  useNetworkStore.getState().commit((d) => {
    d.options.extra = withDemandMultiplier(d.options.extra, factor);
  });
  await runSimulation();
}

/**
 * 계수마다 관망을 복사해 해석하고 요약한다 (관망 자체는 바꾸지 않는다).
 * onRow 로 한 줄씩 돌려줘 진행 상황을 바로 보여 준다.
 */
export async function runFactorSweep(factors: number[], criteria: WaterCriteria, onRow: (row: FactorScenario, done: number) => void): Promise<FactorScenario[]> {
  const { model } = useNetworkStore.getState();
  const ui = useUIStore.getState();
  if (!Object.values(model.nodes).some(isNodeSource)) {
    ui.pushToast({ level: 'error', title: '수원(배수지·수원지)이 없습니다', message: '수원을 하나 이상 넣은 뒤 비교하세요.' });
    return [];
  }
  const rows: FactorScenario[] = [];
  for (const factor of factors) {
    try {
      const results = await sweepManager.run(writeInp(modelWithFactor(model, factor), { forEngine: true }));
      const row = summarizeScenario(model, results, criteria, factor);
      rows.push(row);
      onRow(row, rows.length);
    } catch (error) {
      ui.pushToast({
        level: 'error',
        title: `계수 ${factor} 해석 실패`,
        message: `${error instanceof Error ? error.message : String(error)} · 수요가 너무 커서 수리적으로 풀리지 않을 수 있습니다.`,
      });
      break;
    }
  }
  return rows;
}
