/** 관로 가운데에 펌프·밸브 끼워 넣기 (펌프·밸브 도구로 관로를 눌렀을 때). */
import { linkSeries } from '../core/engine/simulationManager';
import { m3dToFlowUnits } from '../core/model/landUse';
import { insertDeviceOnPipe, type InsertDeviceResult } from '../core/model/networkEdit';
import type { LngLat } from '../core/model/types';
import { useNetworkStore } from '../store/useNetworkStore';
import { useSimulationStore } from '../store/useSimulationStore';
import { useUIStore } from '../store/useUIStore';

export function insertDeviceAt(type: 'pump' | 'valve', pipeId: string, point: LngLat): string | null {
  const net = useNetworkStore.getState();
  const results = useSimulationStore.getState().results;
  // 해석 결과가 있으면 그 관의 흐름 방향·최대 유량을 쓴다
  const flows = results && results.linkIndex.has(pipeId) ? linkSeries(results, 'flow', pipeId) : [];
  const sum = flows.reduce((a, q) => a + q, 0);
  const peak = flows.reduce((a, q) => Math.max(a, Math.abs(q)), 0);
  const units = net.model.options.flowUnits;
  let done: InsertDeviceResult | null = null;
  net.commit((d) => {
    done = insertDeviceOnPipe(d, type, pipeId, point, {
      flowSign: sum < 0 ? -1 : 1,
      pumpFlow: peak > 0 ? peak : m3dToFlowUnits(864, units),
    });
  });
  const r = done as InsertDeviceResult | null;
  const ui = useUIStore.getState();
  if (!r) {
    ui.pushToast({ level: 'warning', title: '관로에 넣지 못했습니다', message: '관로 끝(절점) 바로 위가 아닌 관 가운데를 누르세요.' });
    return null;
  }
  ui.select({ kind: 'link', id: r.linkId });
  const dir = flows.length > 0 ? '해석 결과의 흐름 방향' : '관로 방향(시점→종점)';
  ui.pushToast({
    level: 'success',
    title: `${type === 'pump' ? '펌프' : '감압밸브'} ${r.linkId} 를 관로 ${pipeId} 가운데에 넣었습니다`,
    message:
      `${r.upstreamNodeId} → ${r.downstreamNodeId}, ${dir}으로 놓았습니다. ` +
      (type === 'pump' ? '오른쪽 패널에서 설계 유량·양정을 정하세요.' : '오른쪽 패널에서 감압 설정 압력을 정하세요.') +
      ' 방향이 반대면 ⇄ 로 뒤집습니다. Ctrl+Z 로 되돌림.',
  });
  return r.linkId;
}
