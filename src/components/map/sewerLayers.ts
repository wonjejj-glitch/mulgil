/** 하수 모드 지도 레이어: 맨홀(원)·방류구(심벌)·관거(관경에 따른 굵기, 설계 판정 색)·흐름 방향 화살표·선택 강조. */
import type { Color, Layer } from '@deck.gl/core';
import { IconLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { DesignResult } from '../../core/sewer/design';
import { nodePositions } from '../../core/sewer/mapFrame';
import type { SimulationSummary } from '../../core/sewer/report';
import type { SewerConduit, SewerNode, SewerProject } from '../../core/sewer/types';
import type { LngLat } from '../../core/model/types';
import type { SewerSelection } from '../../store/useSewerStore';
import { PALETTE, type RGB } from '../../utils/colorScales';
import { midpointOfPath } from '../../utils/geoMath';
import { getIconAtlas, ICON_MAPPING } from './iconAtlas';

export const SEWER_NODE_LAYER = 'sewer-nodes';
export const SEWER_CONDUIT_LAYER = 'sewer-conduits';

export interface SewerNodeDatum {
  node: SewerNode;
  position: LngLat;
}

export interface SewerConduitDatum {
  conduit: SewerConduit;
  path: LngLat[];
  mid: { position: LngLat; angle: number };
}

export interface SewerMapData {
  nodes: SewerNodeDatum[];
  conduits: SewerConduitDatum[];
}

/** 색 범례와 같은 값을 쓴다 (GisMapCanvas 의 SewerLegend). */
export const SEWER_COLORS: Record<'neutral' | 'ok' | 'violation' | 'surcharged' | 'manhole', RGB> = {
  neutral: [72, 118, 214],
  ok: PALETTE.green,
  violation: PALETTE.red,
  surcharged: PALETTE.orange,
  manhole: PALETTE.neutralNode,
};

const OUTLINE: Color = [15, 19, 24, 255];

export function sewerMapData(project: SewerProject): SewerMapData {
  const positions = nodePositions(project);
  const nodes: SewerNodeDatum[] = project.nodes.map((node) => ({ node, position: positions.get(node.id)! }));
  const conduits: SewerConduitDatum[] = [];
  for (const conduit of project.conduits) {
    const a = positions.get(conduit.upstream);
    const b = positions.get(conduit.downstream);
    if (!a || !b) continue;
    const path = [a, b];
    conduits.push({ conduit, path, mid: midpointOfPath(path) });
  }
  return { nodes, conduits };
}

function widthOf(diameter: number): number {
  return diameter >= 1 ? 7 : diameter >= 0.6 ? 5.5 : diameter >= 0.4 ? 4.5 : diameter >= 0.3 ? 3.5 : 2.5;
}

export interface SewerLayerInput {
  data: SewerMapData;
  design: DesignResult | null;
  simulation: SimulationSummary | null;
  selection: SewerSelection;
  /** 관거 작도에서 먼저 고른 상류 절점 */
  drawStart: string | null;
  /** 관거 작도 중 커서 위치 (고무줄 선) */
  cursor: LngLat | null;
  zoom: number;
  /** 색·굵기 접근자가 의존하는 상태의 키 (updateTriggers) */
  styleKey: string;
}

export function buildSewerLayers(input: SewerLayerInput): Layer[] {
  const { data, design, simulation, selection, drawStart, cursor, zoom, styleKey } = input;
  const layers: Layer[] = [];
  const rows = new Map(design?.rows.map((r) => [r.id, r]) ?? []);
  const conduitColor = (d: SewerConduitDatum): Color => {
    const row = rows.get(d.conduit.id);
    const rgb = !row ? SEWER_COLORS.neutral : row.status.startsWith('적합') ? SEWER_COLORS.ok : SEWER_COLORS.violation;
    return [...rgb, 240];
  };
  const nodeColor = (d: SewerNodeDatum): Color => {
    const s = simulation?.node_summary[d.node.id];
    const rgb = !s ? SEWER_COLORS.manhole : s.flood_hours > 0 ? SEWER_COLORS.violation : s.surcharged ? SEWER_COLORS.surcharged : SEWER_COLORS.ok;
    return [...rgb, 255];
  };

  if (selection?.kind === 'conduit') {
    const datum = data.conduits.find((d) => d.conduit.id === selection.id);
    if (datum) {
      layers.push(
        new PathLayer<SewerConduitDatum>({
          id: 'sewer-conduit-selected',
          data: [datum],
          getPath: (d) => d.path,
          getColor: [...PALETTE.selection, 235],
          getWidth: 11,
          widthUnits: 'pixels',
          capRounded: true,
        }),
      );
    }
  }

  layers.push(
    new PathLayer<SewerConduitDatum>({
      id: SEWER_CONDUIT_LAYER,
      data: data.conduits,
      getPath: (d) => d.path,
      getColor: conduitColor,
      getWidth: (d) => widthOf(rows.get(d.conduit.id)?.diameter ?? d.conduit.diameter),
      widthUnits: 'pixels',
      widthMinPixels: 2,
      capRounded: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 110],
      updateTriggers: { getColor: styleKey, getWidth: styleKey },
    }),
  );

  // 흐름 방향: 상류 → 하류 (중력식이므로 작도 방향이 곧 흐름 방향)
  if (zoom >= 13 || data.conduits.length <= 600) {
    layers.push(
      new IconLayer<SewerConduitDatum>({
        id: 'sewer-arrows',
        data: data.conduits,
        iconAtlas: getIconAtlas(),
        iconMapping: ICON_MAPPING,
        getIcon: () => 'arrow',
        getPosition: (d) => d.mid.position,
        getAngle: (d) => d.mid.angle,
        getSize: 13,
        getColor: [245, 247, 250, 255],
        sizeUnits: 'pixels',
        billboard: false,
      }),
    );
  }

  if (drawStart && cursor) {
    const start = data.nodes.find((d) => d.node.id === drawStart);
    if (start) {
      layers.push(
        new PathLayer<{ path: LngLat[] }>({
          id: 'sewer-rubber-band',
          data: [{ path: [start.position, cursor] }],
          getPath: (d) => d.path,
          getColor: [...PALETTE.highlight, 220],
          getWidth: 2,
          widthUnits: 'pixels',
        }),
      );
    }
  }

  const ringIds = new Set<string>();
  if (selection?.kind === 'node') ringIds.add(selection.id);
  if (drawStart) ringIds.add(drawStart);
  if (ringIds.size > 0) {
    layers.push(
      new ScatterplotLayer<SewerNodeDatum>({
        id: 'sewer-node-selected',
        data: data.nodes.filter((d) => ringIds.has(d.node.id)),
        getPosition: (d) => d.position,
        getRadius: 13,
        radiusUnits: 'pixels',
        filled: false,
        stroked: true,
        getLineColor: (d) => (d.node.id === drawStart ? [...PALETTE.highlight, 255] : [...PALETTE.selection, 255]),
        getLineWidth: 2.5,
        lineWidthUnits: 'pixels',
        updateTriggers: { getLineColor: drawStart },
      }),
    );
  }

  // 픽킹은 맨홀·방류구 모두 이 레이어 하나로 한다 (방류구 심벌은 위에 덧그린다).
  layers.push(
    new ScatterplotLayer<SewerNodeDatum>({
      id: SEWER_NODE_LAYER,
      data: data.nodes,
      getPosition: (d) => d.position,
      getRadius: (d) => (d.node.kind === 'OUTFALL' ? 9 : 6),
      radiusUnits: 'meters',
      radiusMinPixels: 4.5,
      radiusMaxPixels: 9,
      getFillColor: nodeColor,
      stroked: true,
      getLineColor: OUTLINE,
      getLineWidth: 1.25,
      lineWidthUnits: 'pixels',
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 110],
      updateTriggers: { getFillColor: styleKey, getRadius: styleKey },
    }),
  );
  const outfalls = data.nodes.filter((d) => d.node.kind === 'OUTFALL');
  if (outfalls.length > 0) {
    layers.push(
      new IconLayer<SewerNodeDatum>({
        id: 'sewer-outfalls',
        data: outfalls,
        iconAtlas: getIconAtlas(),
        iconMapping: ICON_MAPPING,
        getIcon: () => 'outfall',
        getPosition: (d) => d.position,
        getSize: 24,
        sizeUnits: 'pixels',
      }),
    );
  }

  if (zoom >= 16 || data.nodes.length <= 60) {
    layers.push(
      new TextLayer<SewerNodeDatum>({
        id: 'sewer-node-labels',
        data: data.nodes,
        getPosition: (d) => d.position,
        getText: (d) => d.node.id,
        getSize: 11,
        getColor: [240, 239, 236, 255],
        getPixelOffset: [0, -17],
        background: true,
        getBackgroundColor: [15, 19, 24, 200],
        backgroundPadding: [3, 1],
        fontFamily: 'system-ui, "Segoe UI", sans-serif',
        characterSet: 'auto',
      }),
    );
  }
  return layers;
}
