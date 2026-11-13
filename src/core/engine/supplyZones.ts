/**
 * 급수구역 분석: 해석 결과의 유량 방향을 따라 각 수원(수원지·배수지)의 물이 어느 절점까지,
 * 몇 % 의 비율로 도달하는지 계산한다 (완전 혼합 가정, 특정 시각의 정상 상태).
 *
 * 유량 방향 그래프는 수두가 높은 곳에서 낮은 곳으로 흐르므로(펌프 제외) 보통 순환이 없다.
 * Kahn 위상 정렬로 상류부터 하류로 기여율을 섞어 내려간다.
 */
import type { NetworkModel } from '../model/types';
import type { SimulationResults } from './simulationManager';

export interface SupplyZones {
  /** 수원 ID (결과 순서). */
  sources: string[];
  /** 절점별 [수원 수] 기여율 (results.nodeIds 순서, 행 우선). 공급이 없으면 모두 0. */
  fractions: Float32Array;
  /** 절점별 최대 기여 수원 인덱스 (-1 = 공급 없음). */
  dominant: Int16Array;
  /** 절점별 최대 기여율 (0~1). */
  share: Float32Array;
  /** 순환 흐름 때문에 위상 정렬이 끝나지 않은 절점 수 (펌프 순환 등). */
  unresolved: number;
}

/** 이 값보다 작은 유량은 흐름이 없는 것으로 본다 (유량 단위). */
const FLOW_EPS = 1e-6;

export function computeSupplyZones(model: Pick<NetworkModel, 'nodes' | 'links'>, results: SimulationResults, step: number): SupplyZones {
  const nodeCount = results.nodeIds.length;
  const linkCount = results.linkIds.length;
  const sources: string[] = [];
  const sourceIndex = new Int16Array(nodeCount).fill(-1);
  results.nodeIds.forEach((id, i) => {
    const type = model.nodes[id]?.type;
    if (type === 'reservoir' || type === 'tank') {
      sourceIndex[i] = sources.length;
      sources.push(id);
    }
  });
  const S = sources.length;

  // 흐름 방향 간선 (상류 → 하류). 수원으로 들어가는 흐름(배수지 충수)은 섞지 않는다.
  const outStart = new Int32Array(nodeCount + 1);
  const edgesFrom: number[] = [];
  const edgesTo: number[] = [];
  const edgesQ: number[] = [];
  const flow = results.link.flow;
  for (let l = 0; l < linkCount; l++) {
    const link = model.links[results.linkIds[l]];
    if (!link) continue;
    const a = results.nodeIndex.get(link.startNodeId);
    const b = results.nodeIndex.get(link.endNodeId);
    if (a === undefined || b === undefined) continue;
    const q = flow[step * linkCount + l];
    if (q > FLOW_EPS) {
      edgesFrom.push(a);
      edgesTo.push(b);
      edgesQ.push(q);
    } else if (q < -FLOW_EPS) {
      edgesFrom.push(b);
      edgesTo.push(a);
      edgesQ.push(-q);
    }
  }
  const E = edgesFrom.length;
  for (let e = 0; e < E; e++) outStart[edgesFrom[e] + 1]++;
  for (let i = 0; i < nodeCount; i++) outStart[i + 1] += outStart[i];
  const outEdges = new Int32Array(E);
  const fill = outStart.slice(0, nodeCount);
  for (let e = 0; e < E; e++) outEdges[fill[edgesFrom[e]]++] = e;

  const indegree = new Int32Array(nodeCount);
  for (let e = 0; e < E; e++) if (sourceIndex[edgesTo[e]] < 0) indegree[edgesTo[e]]++;

  const fractions = new Float32Array(nodeCount * S);
  const accum = new Float64Array(nodeCount * S);
  const inflow = new Float64Array(nodeCount);
  const done = new Uint8Array(nodeCount);
  const queue: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    if (sourceIndex[i] >= 0) {
      fractions[i * S + sourceIndex[i]] = 1;
      queue.push(i);
    } else if (indegree[i] === 0) {
      queue.push(i); // 유입이 없는 절점 (공급 없음)
    }
  }

  const finalize = (v: number) => {
    if (inflow[v] > 0) for (let k = 0; k < S; k++) fractions[v * S + k] = accum[v * S + k] / inflow[v];
  };
  const propagate = (u: number) => {
    done[u] = 1;
    for (let p = outStart[u]; p < outStart[u + 1]; p++) {
      const e = outEdges[p];
      const v = edgesTo[e];
      if (sourceIndex[v] >= 0 || done[v]) continue;
      const q = edgesQ[e];
      inflow[v] += q;
      for (let k = 0; k < S; k++) accum[v * S + k] += q * fractions[u * S + k];
      if (--indegree[v] === 0) {
        finalize(v);
        queue.push(v);
      }
    }
  };
  for (let head = 0; head < queue.length; head++) propagate(queue[head]);

  // 순환 흐름에 걸린 절점: 지금까지 들어온 몫으로 근사하고 반복해서 풀어 준다.
  let unresolved = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (done[i]) continue;
    unresolved++;
    finalize(i);
    const start = queue.length;
    queue.push(i);
    for (let head = start; head < queue.length; head++) if (!done[queue[head]]) propagate(queue[head]);
  }

  const dominant = new Int16Array(nodeCount).fill(-1);
  const share = new Float32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    let best = -1;
    let bestValue = 0;
    for (let k = 0; k < S; k++) {
      const value = fractions[i * S + k];
      if (value > bestValue + 1e-9) {
        best = k;
        bestValue = value;
      }
    }
    dominant[i] = best;
    share[i] = bestValue;
  }
  return { sources, fractions, dominant, share, unresolved };
}

/** 한 절점에 대한 수원별 기여율 (기여 0 인 수원은 뺀다, 큰 순). */
export function nodeContributions(zones: SupplyZones, nodeIndex: number): { sourceId: string; fraction: number }[] {
  const S = zones.sources.length;
  const list: { sourceId: string; fraction: number }[] = [];
  for (let k = 0; k < S; k++) {
    const fraction = zones.fractions[nodeIndex * S + k];
    if (fraction > 1e-4) list.push({ sourceId: zones.sources[k], fraction });
  }
  return list.sort((a, b) => b.fraction - a.fraction);
}
