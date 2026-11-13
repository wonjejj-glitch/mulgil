import type { Color, Layer } from '@deck.gl/core';
import { IconLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { SwmmLinkDef, SwmmNodeDef, SwmmProject, SwmmSubcatchDef } from '../../core/swmm/inpReader';
import type { LngLat } from '../../core/model/types';
import type { SwmmSelection } from '../../store/useSwmmStore';
import { PALETTE } from '../../utils/colorScales';
import { midpointOfPath } from '../../utils/geoMath';
import { getIconAtlas, ICON_MAPPING } from '../map/iconAtlas';
import type { SwmmThematic } from './swmmThematic';

export const SWMM_PICK_LAYERS = ['swmm-nodes', 'swmm-links', 'swmm-subs'];

interface LinkDatum {
  link: SwmmLinkDef;
  path: LngLat[];
  mid: { position: LngLat; angle: number };
}

export interface SwmmLayerInput {
  project: SwmmProject;
  thematic: SwmmThematic;
  styleKey: string;
  selection: SwmmSelection;
  zoom: number;
  hasResults: boolean;
}

const OUTLINE: Color = [15, 19, 24, 255];

function linkDatum(project: SwmmProject): LinkDatum[] {
  const pos = new Map(project.nodes.map((n) => [n.id, n.position]));
  const out: LinkDatum[] = [];
  for (const link of project.links) {
    const a = pos.get(link.from);
    const b = pos.get(link.to);
    if (!a || !b) continue;
    const path = [a, ...link.vertices, b];
    out.push({ link, path, mid: midpointOfPath(path) });
  }
  return out;
}

function linkWidth(link: SwmmLinkDef, us: boolean): number {
  if (link.kind !== 'conduit') return 3;
  const m = us ? link.geom1 * 0.3048 : link.geom1;
  return m >= 1.5 ? 6 : m >= 0.9 ? 5 : m >= 0.5 ? 4 : 3;
}

export function buildSwmmLayers(input: SwmmLayerInput): Layer[] {
  const { project, thematic, styleKey, selection, zoom, hasResults } = input;
  const layers: Layer[] = [];
  const links = linkDatum(project);
  const nodeById = new Map(project.nodes.map((n) => [n.id, n]));

  const subs = project.subcatchments.filter((s) => s.polygon.length >= 3);
  if (subs.length > 0) {
    layers.push(
      new PolygonLayer<SwmmSubcatchDef>({
        id: 'swmm-subs',
        data: subs,
        getPolygon: (d) => d.polygon,
        getFillColor: (d) => [...PALETTE.cyan, thematic.subcatchAlpha(d.id)] as Color,
        getLineColor: [...PALETTE.cyan, 200],
        getLineWidth: 1.5,
        lineWidthUnits: 'pixels',
        pickable: true,
        updateTriggers: { getFillColor: styleKey },
      }),
    );
    // 유역 → 유출 절점 연결선
    layers.push(
      new PathLayer<{ path: LngLat[] }>({
        id: 'swmm-sub-outlets',
        data: subs.flatMap((s) => {
          const target = nodeById.get(s.outlet);
          if (!target) return [];
          const cx = s.polygon.reduce((a, p) => a + p[0], 0) / s.polygon.length;
          const cy = s.polygon.reduce((a, p) => a + p[1], 0) / s.polygon.length;
          return [{ path: [[cx, cy] as LngLat, target.position] }];
        }),
        getPath: (d) => d.path,
        getColor: [...PALETTE.cyan, 150],
        getWidth: 1.25,
        widthUnits: 'pixels',
      }),
    );
  }

  if (selection?.kind === 'link') {
    const datum = links.find((d) => d.link.id === selection.id);
    if (datum) {
      layers.push(
        new PathLayer<LinkDatum>({
          id: 'swmm-link-selected',
          data: [datum],
          getPath: (d) => d.path,
          getColor: [...PALETTE.selection, 235],
          getWidth: 10,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
        }),
      );
    }
  }

  layers.push(
    new PathLayer<LinkDatum>({
      id: 'swmm-links',
      data: links,
      getPath: (d) => d.path,
      getColor: (d) => thematic.linkColor(d.link),
      getWidth: (d) => linkWidth(d.link, project.us),
      widthUnits: 'pixels',
      widthMinPixels: 2,
      capRounded: true,
      jointRounded: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 110],
      updateTriggers: { getColor: styleKey },
    }),
  );

  if (hasResults && (zoom >= 14 || links.length <= 400)) {
    layers.push(
      new IconLayer<LinkDatum>({
        id: 'swmm-arrows',
        data: links,
        iconAtlas: getIconAtlas(),
        iconMapping: ICON_MAPPING,
        getIcon: () => 'arrow',
        getPosition: (d) => d.mid.position,
        // SWMM 유량은 시점→종점 방향이 양수이고 역류는 음수다.
        getAngle: (d) => d.mid.angle + ((thematic.flowOf(d.link.id) ?? 0) < 0 ? 180 : 0),
        getSize: (d) => (Math.abs(thematic.flowOf(d.link.id) ?? 0) > 1e-6 ? 14 : 0),
        getColor: [245, 247, 250, 255],
        sizeUnits: 'pixels',
        billboard: false,
        updateTriggers: { getAngle: styleKey, getSize: styleKey },
      }),
    );
  }

  if (selection?.kind === 'node') {
    const node = nodeById.get(selection.id);
    if (node) {
      layers.push(
        new ScatterplotLayer<SwmmNodeDef>({
          id: 'swmm-node-selected',
          data: [node],
          getPosition: (d) => d.position,
          getRadius: 12,
          radiusUnits: 'pixels',
          filled: false,
          stroked: true,
          getLineColor: [...PALETTE.selection, 255],
          getLineWidth: 2.5,
          lineWidthUnits: 'pixels',
        }),
      );
    }
  }

  layers.push(
    new ScatterplotLayer<SwmmNodeDef>({
      id: 'swmm-nodes',
      data: project.nodes,
      getPosition: (d) => d.position,
      getRadius: (d) => (d.kind === 'junction' ? 7 : 10),
      radiusUnits: 'meters',
      radiusMinPixels: 4,
      radiusMaxPixels: 9,
      getFillColor: (d) => thematic.nodeColor(d),
      stroked: true,
      getLineColor: OUTLINE,
      getLineWidth: 1,
      lineWidthUnits: 'pixels',
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 110],
      updateTriggers: { getFillColor: styleKey },
    }),
  );

  if (project.gages.length > 0) {
    layers.push(
      new TextLayer<{ id: string; position: LngLat }>({
        id: 'swmm-gages',
        data: project.gages,
        getPosition: (d) => d.position,
        getText: (d) => `☂ ${d.id}`,
        getSize: 12,
        getColor: [200, 225, 255, 255],
        background: true,
        getBackgroundColor: [15, 19, 24, 200],
        backgroundPadding: [4, 2],
        fontFamily: 'system-ui, "Segoe UI", sans-serif',
        characterSet: 'auto',
      }),
    );
  }

  if (zoom >= 15) {
    layers.push(
      new TextLayer<SwmmNodeDef>({
        id: 'swmm-node-labels',
        data: project.nodes,
        getPosition: (d) => d.position,
        getText: (d) => d.id,
        getSize: 11,
        getColor: [240, 239, 236, 255],
        getPixelOffset: [0, -15],
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
