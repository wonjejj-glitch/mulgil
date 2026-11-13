import { useMemo } from 'react';
import type { LinkResultVariable, NodeResultVariable, SimulationResults } from '../../core/engine/simulationManager';
import { computeSupplyZones, type SupplyZones } from '../../core/engine/supplyZones';

/** 최대 기여 수원의 비율이 이 값 미만이면 '혼합' 구역으로 칠한다. */
export const ZONE_MIXED_THRESHOLD = 0.8;
import type { NetworkLink, NetworkModel, NetworkNode } from '../../core/model/types';
import { isUsUnits, qualityLabel, qualityUnit, unitLabels } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { useUIStore, type LinkTheme, type NodeTheme } from '../../store/useUIStore';
import {
  chlorineScale,
  classify,
  dataScale,
  traceScale,
  waterAgeScale,
  zoneScale,
  PALETTE,
  pressureScale,
  unitHeadlossScale,
  velocityScale,
  type RGB,
  type ThematicScale,
} from '../../utils/colorScales';

export interface Thematic {
  nodeScale: ThematicScale | null;
  linkScale: ThematicScale | null;
  nodeColor: (node: NetworkNode) => RGB;
  linkColor: (link: NetworkLink) => RGB;
  /** 현재 시간 스텝의 수압 (결과가 없으면 undefined). */
  pressureOf: (node: NetworkNode) => number | undefined;
  /** 현재 시간 스텝의 유량 (부호 = 시점→종점 기준 방향). */
  flowOf: (link: NetworkLink) => number | undefined;
}

export const NODE_THEME_OPTIONS: { value: NodeTheme; label: string; needsResults: boolean }[] = [
  { value: 'pressure', label: '수압', needsResults: true },
  { value: 'head', label: '수두', needsResults: true },
  { value: 'demand', label: '수요량', needsResults: true },
  { value: 'quality', label: '수질', needsResults: true },
  { value: 'zone', label: '급수구역', needsResults: true },
  { value: 'elevation', label: '표고', needsResults: false },
  { value: 'none', label: '단색', needsResults: false },
];

export const LINK_THEME_OPTIONS: { value: LinkTheme; label: string; needsResults: boolean }[] = [
  { value: 'velocity', label: '유속', needsResults: true },
  { value: 'flow', label: '유량', needsResults: true },
  { value: 'unitHeadloss', label: '단위 손실수두', needsResults: true },
  { value: 'quality', label: '수질', needsResults: true },
  { value: 'zone', label: '급수구역', needsResults: true },
  { value: 'diameter', label: '관경', needsResults: false },
  { value: 'none', label: '단색', needsResults: false },
];

const CLOSED_PIPE: RGB = [96, 100, 112];

function defaultLinkColor(link: NetworkLink): RGB {
  if (link.type === 'pump') return PALETTE.pump;
  if (link.type === 'valve') return PALETTE.valve;
  return link.status === 'Closed' ? CLOSED_PIPE : PALETTE.neutralPipe;
}

export function buildThematic(
  model: Pick<NetworkModel, 'nodes' | 'links' | 'options'>,
  results: SimulationResults | null,
  stepIndex: number,
  nodeTheme: NodeTheme,
  linkTheme: LinkTheme,
): Thematic {
  const us = isUsUnits(model.options.flowUnits);
  const labels = unitLabels(model.options.flowUnits);
  const step = results ? Math.max(0, Math.min(stepIndex, results.stepCount - 1)) : 0;
  const nodeCount = results?.nodeIds.length ?? 0;
  const linkCount = results?.linkIds.length ?? 0;

  const nodeResult = (variable: NodeResultVariable) => (node: NetworkNode) => {
    if (!results) return undefined;
    const index = results.nodeIndex.get(node.id);
    return index === undefined ? undefined : results.node[variable][step * nodeCount + index];
  };
  const linkResult = (variable: LinkResultVariable) => (link: NetworkLink) => {
    if (!results) return undefined;
    const index = results.linkIndex.get(link.id);
    return index === undefined ? undefined : results.link[variable][step * linkCount + index];
  };
  // 급수구역: 노드·링크 주제도가 함께 쓰므로 한 번만 계산한다.
  let zones: SupplyZones | null = null;
  const getZones = () => (zones ??= results ? computeSupplyZones(model, results, step) : null);
  const zoneValue = (nodeIndex: number | undefined): number | undefined => {
    const z = getZones();
    if (!z || nodeIndex === undefined) return undefined;
    const d = z.dominant[nodeIndex];
    if (d < 0) return z.sources.length + 1;
    return z.share[nodeIndex] >= ZONE_MIXED_THRESHOLD ? d : z.sources.length;
  };

  const quality = results?.quality ?? null;
  const qualityScale = (): ThematicScale | null => {
    if (!results || !quality) return null;
    if (quality.mode === 'AGE') return waterAgeScale();
    if (quality.mode === 'TRACE') return traceScale(qualityLabel(quality));
    if (quality.name.toLowerCase() === 'chlorine' && qualityUnit(quality) === 'mg/L') return chlorineScale();
    return dataScale(qualityLabel(quality), qualityUnit(quality), results.ranges.quality[0], results.ranges.quality[1]);
  };

  let nodeScale: ThematicScale | null = null;
  let nodeValue: (node: NetworkNode) => number | undefined = () => undefined;
  if (nodeTheme === 'elevation') {
    let min = Infinity;
    let max = -Infinity;
    for (const id in model.nodes) {
      const node = model.nodes[id];
      if (node.type !== 'junction') continue;
      if (node.elevation < min) min = node.elevation;
      if (node.elevation > max) max = node.elevation;
    }
    if (Number.isFinite(min)) {
      nodeScale = dataScale('표고', labels.elevation, min, max);
      nodeValue = (node) => node.elevation;
    }
  } else if (results && nodeTheme === 'pressure') {
    nodeScale = pressureScale(us);
    nodeValue = nodeResult('pressure');
  } else if (results && nodeTheme === 'head') {
    nodeScale = dataScale('수두', labels.elevation, results.ranges.head[0], results.ranges.head[1]);
    nodeValue = nodeResult('head');
  } else if (results && nodeTheme === 'demand') {
    nodeScale = dataScale('수요량', labels.flow, results.ranges.demand[0], results.ranges.demand[1]);
    nodeValue = nodeResult('demand');
  } else if (nodeTheme === 'quality' && quality) {
    nodeScale = qualityScale();
    nodeValue = nodeResult('quality');
  } else if (results && nodeTheme === 'zone') {
    const z = getZones();
    if (z && z.sources.length > 0) {
      nodeScale = zoneScale(z.sources, ZONE_MIXED_THRESHOLD);
      nodeValue = (node) => zoneValue(results.nodeIndex.get(node.id));
    }
  }

  let linkScale: ThematicScale | null = null;
  let linkValue: (link: NetworkLink) => number | undefined = () => undefined;
  if (linkTheme === 'diameter') {
    let min = Infinity;
    let max = -Infinity;
    for (const id in model.links) {
      const link = model.links[id];
      if (link.type !== 'pipe') continue;
      if (link.diameter < min) min = link.diameter;
      if (link.diameter > max) max = link.diameter;
    }
    if (Number.isFinite(min)) {
      linkScale = dataScale('관경', labels.diameter, min, max);
      linkValue = (link) => (link.type === 'pipe' ? link.diameter : undefined);
    }
  } else if (results && linkTheme === 'velocity') {
    linkScale = velocityScale(us);
    linkValue = linkResult('velocity');
  } else if (results && linkTheme === 'flow') {
    linkScale = dataScale('유량 (절댓값)', labels.flow, 0, results.ranges.flow[1]);
    const flow = linkResult('flow');
    linkValue = (link) => {
      const value = flow(link);
      return value === undefined ? undefined : Math.abs(value);
    };
  } else if (results && linkTheme === 'unitHeadloss') {
    linkScale = unitHeadlossScale(us);
    linkValue = (link) => (link.type === 'pipe' ? linkResult('unitHeadloss')(link) : undefined);
  } else if (linkTheme === 'quality' && quality) {
    linkScale = qualityScale();
    linkValue = linkResult('quality');
  } else if (results && linkTheme === 'zone') {
    const z = getZones();
    if (z && z.sources.length > 0) {
      linkScale = zoneScale(z.sources, ZONE_MIXED_THRESHOLD);
      const flow = linkResult('flow');
      // 링크는 상류 쪽 절점의 구역을 따른다. 흐름이 없으면 '공급 없음'.
      linkValue = (link) => {
        const q = flow(link) ?? 0;
        if (Math.abs(q) < 1e-6) return z.sources.length + 1;
        return zoneValue(results.nodeIndex.get(q > 0 ? link.startNodeId : link.endNodeId));
      };
    }
  }

  const activeNodeScale = nodeScale;
  const activeLinkScale = linkScale;
  return {
    nodeScale,
    linkScale,
    nodeColor: (node) => {
      if (!activeNodeScale || (node.type !== 'junction' && nodeTheme !== 'zone')) return PALETTE.neutralNode;
      const value = nodeValue(node);
      return value === undefined ? PALETTE.neutralNode : classify(activeNodeScale, value);
    },
    linkColor: (link) => {
      if (!activeLinkScale) return defaultLinkColor(link);
      if (link.type === 'pipe' && link.status === 'Closed') return CLOSED_PIPE;
      const value = linkValue(link);
      return value === undefined ? defaultLinkColor(link) : classify(activeLinkScale, value);
    },
    pressureOf: nodeResult('pressure'),
    flowOf: linkResult('flow'),
  };
}

/** 현재 스토어 상태로부터 주제도 스케일·색상 함수를 만든다. */
export function useThematic(): Thematic {
  const nodes = useNetworkStore((s) => s.model.nodes);
  const links = useNetworkStore((s) => s.model.links);
  const options = useNetworkStore((s) => s.model.options);
  const results = useSimulationStore((s) => s.results);
  const stepIndex = useSimulationStore((s) => s.stepIndex);
  const nodeTheme = useUIStore((s) => s.nodeTheme);
  const linkTheme = useUIStore((s) => s.linkTheme);
  return useMemo(
    () => buildThematic({ nodes, links, options }, results, stepIndex, nodeTheme, linkTheme),
    [nodes, links, options, results, stepIndex, nodeTheme, linkTheme],
  );
}
