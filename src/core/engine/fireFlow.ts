/**
 * 소화용수(Fire-flow) 분석: 지정한 시각의 정상 상태에서 절점마다 소화 유량을 하나씩 더해
 * 그 절점의 잔류 수압과 관망 최저 수압을 계산한다.
 *
 * - 수요 패턴은 분석 시각(PatternStart) 기준으로 적용하고, 배수지 수위는 기간 해석 결과의 그 시각 수위를 넣는다.
 * - 'AT TIME' 단순 제어 등 시간에 따른 운전 변화는 반영하지 않는 근사다.
 */
import { CountType, NodeProperty, NodeType, Project, TimeParameter, Workspace } from 'epanet-js';

export interface FireFlowRequest {
  inp: string;
  /** 분석 대상 절점 ID. */
  nodeIds: string[];
  /** 소화 유량 (모델 유량 단위). */
  fireFlow: number;
  /** 분석 시각 (초, 패턴 기준). */
  time: number;
  /** 배수지 ID → 분석 시각의 수위. */
  tankLevels: Record<string, number>;
}

export interface FireFlowNodeResult {
  nodeId: string;
  /** 소화 유량 없이 같은 시각의 수압. */
  staticPressure: number;
  /** 소화 유량을 더했을 때 그 절점의 수압. 해석 실패면 NaN. */
  residualPressure: number;
  /** 그때 관망(일반 절점) 최저 수압과 그 절점. */
  minSystemPressure: number;
  minSystemNodeId: string;
}

export interface FireFlowResult {
  nodes: FireFlowNodeResult[];
  /** 해석이 실패한 절점 ID (엔진 오류). */
  failedNodeIds: string[];
}

const FLAT_PATTERN = 'OGP_FIRE_FLAT';
const FIRE_DEMAND = 'OGP_FIRE';

export async function runFireFlow(request: FireFlowRequest, onProgress?: (done: number, total: number) => void): Promise<FireFlowResult> {
  const ws = new Workspace();
  await ws.loadModule();
  const project = new Project(ws);
  ws.writeFile('fire.inp', request.inp);
  const originalWarn = console.warn;
  console.warn = () => {}; // 음압 등 경고는 결과 값으로 판단하므로 콘솔에 쌓지 않는다.
  try {
    project.open('fire.inp', 'fire.rpt', 'fire.bin');
    project.setTimeParameter(TimeParameter.Duration, 0);
    project.setTimeParameter(TimeParameter.PatternStart, Math.max(0, Math.round(request.time)));

    const nodeCount = project.getCount(CountType.NodeCount);
    const junctionIndexes: number[] = [];
    for (let i = 1; i <= nodeCount; i++) if (project.getNodeType(i) === NodeType.Junction) junctionIndexes.push(i);
    for (const [id, level] of Object.entries(request.tankLevels)) {
      try {
        const index = project.getNodeIndex(id);
        if (project.getNodeType(index) === NodeType.Tank) project.setNodeValue(index, NodeProperty.TankLevel, level);
      } catch {
        // 없는 배수지는 무시
      }
    }

    project.addPattern(FLAT_PATTERN);
    const flat = project.getPatternIndex(FLAT_PATTERN);
    project.setPattern(flat, [1]);

    const pressures = () => {
      let min = Infinity;
      let minIndex = 0;
      for (const i of junctionIndexes) {
        const p = project.getNodeValue(i, NodeProperty.Pressure);
        if (p < min) {
          min = p;
          minIndex = i;
        }
      }
      return { min, minIndex };
    };

    project.solveH();
    const staticByIndex = new Map<number, number>();
    for (const i of junctionIndexes) staticByIndex.set(i, project.getNodeValue(i, NodeProperty.Pressure));

    const nodes: FireFlowNodeResult[] = [];
    const failedNodeIds: string[] = [];
    request.nodeIds.forEach((nodeId, n) => {
      let index: number;
      try {
        index = project.getNodeIndex(nodeId);
      } catch {
        failedNodeIds.push(nodeId);
        return;
      }
      if (project.getNodeType(index) !== NodeType.Junction) return;
      project.addDemand(index, request.fireFlow, FLAT_PATTERN, FIRE_DEMAND);
      try {
        project.solveH();
        const system = pressures();
        nodes.push({
          nodeId,
          staticPressure: staticByIndex.get(index) ?? NaN,
          residualPressure: project.getNodeValue(index, NodeProperty.Pressure),
          minSystemPressure: system.min,
          minSystemNodeId: project.getNodeId(system.minIndex),
        });
      } catch {
        failedNodeIds.push(nodeId);
        nodes.push({ nodeId, staticPressure: staticByIndex.get(index) ?? NaN, residualPressure: NaN, minSystemPressure: NaN, minSystemNodeId: '' });
      } finally {
        project.deleteDemand(index, project.getDemandIndex(index, FIRE_DEMAND));
      }
      if (n % 5 === 0) onProgress?.(n + 1, request.nodeIds.length);
    });
    onProgress?.(request.nodeIds.length, request.nodeIds.length);
    project.close();
    return { nodes, failedNodeIds };
  } finally {
    console.warn = originalWarn;
  }
}
