import { useMemo } from 'react';
import { linkValue, nodeValue, rangeOf, subValue, LINK_VAR, NODE_VAR, type SwmmOutput } from '../../core/swmm/outReader';
import type { SwmmLinkDef, SwmmNodeDef, SwmmProject } from '../../core/swmm/inpReader';
import { useSwmmStore, type SwmmLinkTheme, type SwmmNodeTheme } from '../../store/useSwmmStore';
import { classify, dataScale, PALETTE, type RGB, type ThematicScale } from '../../utils/colorScales';

export const SWMM_NODE_THEMES: { value: SwmmNodeTheme; label: string }[] = [
  { value: 'depthRatio', label: '수심 비율 (수심/최대수심)' },
  { value: 'depth', label: '수심' },
  { value: 'inflow', label: '총 유입량' },
  { value: 'flooding', label: '월류량' },
  { value: 'none', label: '단색' },
];

export const SWMM_LINK_THEMES: { value: SwmmLinkTheme; label: string }[] = [
  { value: 'capacity', label: '충만도 (수심/관경)' },
  { value: 'velocity', label: '유속' },
  { value: 'flow', label: '유량' },
  { value: 'none', label: '단색' },
];

const NEUTRAL_NODE: RGB = PALETTE.neutralNode;
const NEUTRAL_LINK: RGB = PALETTE.neutralPipe;
const NO_RESULT: RGB = [120, 128, 142];

export interface SwmmThematic {
  nodeScale: ThematicScale | null;
  linkScale: ThematicScale | null;
  nodeColor: (node: SwmmNodeDef) => RGB;
  linkColor: (link: SwmmLinkDef) => RGB;
  /** 유역 색: 현재 시각의 유출량(없으면 불투명도 낮은 기본색). */
  subcatchAlpha: (id: string) => number;
  /** 링크 현재 유량 (화살표 크기·표시용). */
  flowOf: (linkId: string) => number | undefined;
}

const RATIO_BREAKS = [0.25, 0.5, 0.75, 1.0];
const RATIO_LABELS = ['< 25%', '25 ~ 50%', '50 ~ 75%', '75 ~ 100%', '100% 이상 (만관·월류 위험)'];
const RATIO_COLORS: RGB[] = [PALETTE.blue, PALETTE.cyan, PALETTE.green, PALETTE.yellow, PALETTE.red];

function ratioScale(title: string): ThematicScale {
  return { title, unit: '비율', breaks: RATIO_BREAKS, colors: RATIO_COLORS, labels: RATIO_LABELS };
}

function unitsOf(output: SwmmOutput | null, us: boolean) {
  const flow = output?.flowUnits ?? (us ? 'CFS' : 'CMS');
  return { flow, length: us ? 'ft' : 'm', velocity: us ? 'ft/s' : 'm/s' };
}

export function buildSwmmThematic(
  project: SwmmProject,
  output: SwmmOutput | null,
  period: number,
  nodeTheme: SwmmNodeTheme,
  linkTheme: SwmmLinkTheme,
): SwmmThematic {
  const units = unitsOf(output, project.us);
  const t = output ? Math.max(0, Math.min(period, output.periods - 1)) : 0;
  const nodeIdx = new Map(output?.nodeIds.map((id, i) => [id, i]) ?? []);
  const linkIdx = new Map(output?.linkIds.map((id, i) => [id, i]) ?? []);
  const subIdx = new Map(output?.subcatchIds.map((id, i) => [id, i]) ?? []);

  let nodeScale: ThematicScale | null = null;
  let nodeVal: (n: SwmmNodeDef) => number | undefined = () => undefined;
  if (output && nodeTheme !== 'none') {
    const nodeAt = (variable: keyof typeof NODE_VAR) => (n: SwmmNodeDef) => {
      const i = nodeIdx.get(n.id);
      return i === undefined ? undefined : nodeValue(output, variable, t, i);
    };
    if (nodeTheme === 'depthRatio') {
      nodeScale = ratioScale('수심 비율');
      nodeVal = (n) => {
        const i = nodeIdx.get(n.id);
        if (i === undefined) return undefined;
        const max = output.nodeMaxDepth[i];
        if (!(max > 0)) return undefined; // 방류구 등
        const depth = nodeValue(output, 'depth', t, i);
        return nodeValue(output, 'flooding', t, i) > 0 ? 1.01 : depth / max;
      };
    } else if (nodeTheme === 'depth') {
      const [lo, hi] = rangeOf(output.node, output.nodeVars, NODE_VAR.depth);
      nodeScale = dataScale('수심', units.length, lo, hi);
      nodeVal = nodeAt('depth');
    } else if (nodeTheme === 'inflow') {
      const [lo, hi] = rangeOf(output.node, output.nodeVars, NODE_VAR.totalInflow);
      nodeScale = dataScale('총 유입량', units.flow, lo, hi);
      nodeVal = nodeAt('totalInflow');
    } else {
      const [, hi] = rangeOf(output.node, output.nodeVars, NODE_VAR.flooding);
      nodeScale = dataScale('월류량', units.flow, 0, Math.max(hi, 1e-9));
      nodeVal = nodeAt('flooding');
    }
  }

  let linkScale: ThematicScale | null = null;
  let linkVal: (l: SwmmLinkDef) => number | undefined = () => undefined;
  const linkAt = (variable: keyof typeof LINK_VAR) => (l: SwmmLinkDef) => {
    const i = linkIdx.get(l.id);
    return i === undefined || !output ? undefined : linkValue(output, variable, t, i);
  };
  if (output && linkTheme !== 'none') {
    if (linkTheme === 'capacity') {
      linkScale = ratioScale('충만도');
      linkVal = linkAt('capacity');
    } else if (linkTheme === 'velocity') {
      const [lo, hi] = rangeOf(output.link, output.linkVars, LINK_VAR.velocity);
      linkScale = dataScale('유속', units.velocity, Math.max(0, lo), hi);
      linkVal = linkAt('velocity');
    } else {
      const [lo, hi] = rangeOf(output.link, output.linkVars, LINK_VAR.flow);
      linkScale = dataScale('유량', units.flow, Math.max(0, lo), hi);
      linkVal = linkAt('flow');
    }
  }

  const [, runoffMax] = output ? rangeOf(output.sub, output.subVars, 4) : [0, 0];
  const nScale = nodeScale;
  const lScale = linkScale;
  return {
    nodeScale,
    linkScale,
    nodeColor: (n) => {
      if (!nScale) return n.kind === 'outfall' ? PALETTE.reservoir : NEUTRAL_NODE;
      const v = nodeVal(n);
      return v === undefined ? (n.kind === 'outfall' ? PALETTE.reservoir : NO_RESULT) : classify(nScale, v);
    },
    linkColor: (l) => {
      if (!lScale) return NEUTRAL_LINK;
      const v = linkVal(l);
      return v === undefined ? NO_RESULT : classify(lScale, v);
    },
    subcatchAlpha: (id) => {
      const i = subIdx.get(id);
      if (!output || i === undefined || !(runoffMax > 0)) return 40;
      return 40 + Math.round(120 * Math.min(1, subValue(output, 'runoff', t, i) / runoffMax));
    },
    flowOf: (id) => {
      const i = linkIdx.get(id);
      return i === undefined || !output ? undefined : linkValue(output, 'flow', t, i);
    },
  };
}

export function useSwmmThematic(): SwmmThematic | null {
  const project = useSwmmStore((s) => s.project);
  const run = useSwmmStore((s) => s.run);
  const period = useSwmmStore((s) => s.period);
  const nodeTheme = useSwmmStore((s) => s.nodeTheme);
  const linkTheme = useSwmmStore((s) => s.linkTheme);
  const output = run?.output ?? null;
  return useMemo(
    () => (project ? buildSwmmThematic(project, output, period, nodeTheme, linkTheme) : null),
    [project, output, period, nodeTheme, linkTheme],
  );
}
