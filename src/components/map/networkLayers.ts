import type { Color, Layer } from '@deck.gl/core';
import { ColumnLayer, IconLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { LngLat, NetworkLink, NetworkNode } from '../../core/model/types';
import { PSI_PER_METER } from '../../core/model/units';
import type { Highlight, LayerVisibility, MultiSelection, Selection } from '../../store/useUIStore';
import { PALETTE } from '../../utils/colorScales';
import { getIconAtlas, ICON_MAPPING } from './iconAtlas';
import type { Labelers } from './mapLabels';
import type { Thematic } from './thematic';

export interface LinkDatum {
  link: NetworkLink;
  path: LngLat[];
  mid: { position: LngLat; angle: number };
}

export interface LayerInput {
  junctions: NetworkNode[];
  sources: NetworkNode[];
  links: LinkDatum[];
  nodesById: Record<string, NetworkNode>;
  thematic: Thematic;
  hasResults: boolean;
  /** 모델·결과·시간 스텝·주제도 설정이 바뀔 때마다 달라지는 값 (updateTriggers 용). */
  styleKey: string;
  layers: LayerVisibility;
  selection: Selection;
  highlight: Highlight | null;
  multiSelection: MultiSelection | null;
  /** 종단면도 경로 (링크) 와 경유 절점. */
  profile: { linkIds: string[]; waypointIds: string[] } | null;
  zoom: number;
  usUnits: boolean;
  /** 라벨 글자 (절점: ID·수압·수요량 등, 관로: 관경·유속 등) */
  labelers: Labelers;
  /** 라벨 종류·시간 스텝이 바뀔 때 달라지는 값 (updateTriggers 용) */
  labelKey: string;
}

const PROFILE_COLOR: [number, number, number] = [236, 131, 90];

export const NODE_LAYER_IDS = ['sources', 'junctions'];
export const LINK_LAYER_IDS = ['links'];

const DARK_OUTLINE: Color = [15, 19, 24, 255];
const HOVER: number[] = [255, 255, 255, 110];

function pipeWidth(link: NetworkLink, us: boolean): number {
  if (link.type !== 'pipe') return 3;
  const mm = us ? link.diameter * 25.4 : link.diameter;
  if (mm >= 400) return 5;
  if (mm >= 250) return 4;
  if (mm >= 150) return 3;
  return 2;
}

export function buildNetworkLayers(input: LayerInput): Layer[] {
  const { junctions, sources, links, nodesById, thematic, styleKey, layers, selection, highlight, multiSelection, profile, zoom, usUnits, labelers, labelKey } =
    input;
  const result: Layer[] = [];
  const atlas = getIconAtlas();

  const visibleLinks = links.filter((d) => (d.link.type === 'pipe' ? layers.pipes : layers.pumpsValves));
  const linkById = new Map(links.map((d) => [d.link.id, d]));
  const linkData = (ids: string[]) => ids.map((id) => linkById.get(id)).filter((d): d is LinkDatum => d !== undefined);

  if (profile && profile.linkIds.length > 0) {
    result.push(
      new PathLayer<LinkDatum>({
        id: 'profile-path',
        data: linkData(profile.linkIds),
        getPath: (d) => d.path,
        getColor: [...PROFILE_COLOR, 200],
        getWidth: 10,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
      }),
    );
  }
  if (multiSelection && multiSelection.linkIds.length > 0) {
    result.push(
      new PathLayer<LinkDatum>({
        id: 'link-multi',
        data: linkData(multiSelection.linkIds),
        getPath: (d) => d.path,
        getColor: [...PALETTE.selection, 170],
        getWidth: 8,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
      }),
    );
  }

  // 강조(검증 오류·해석 경고)·선택 표시는 본 레이어 아래에 후광으로 깐다.
  if (highlight && highlight.linkIds.length > 0) {
    const data = highlight.linkIds.map((id) => linkById.get(id)).filter((d): d is LinkDatum => d !== undefined);
    result.push(
      new PathLayer<LinkDatum>({
        id: 'link-highlight',
        data,
        getPath: (d) => d.path,
        getColor: [...PALETTE.highlight, 220],
        getWidth: 11,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
      }),
    );
  }
  if (selection?.kind === 'link') {
    const datum = linkById.get(selection.id);
    if (datum) {
      result.push(
        new PathLayer<LinkDatum>({
          id: 'link-selected',
          data: [datum],
          getPath: (d) => d.path,
          getColor: [...PALETTE.selection, 235],
          getWidth: 9,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
        }),
      );
    }
  }

  result.push(
    new PathLayer<LinkDatum>({
      id: 'links',
      data: visibleLinks,
      getPath: (d) => d.path,
      getColor: (d) => thematic.linkColor(d.link),
      getWidth: (d) => pipeWidth(d.link, usUnits),
      widthUnits: 'pixels',
      widthMinPixels: 1.5,
      capRounded: true,
      jointRounded: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: HOVER,
      updateTriggers: { getColor: styleKey, getWidth: usUnits },
    }),
  );

  // 유향 화살표: 지도 평면에 눕혀 관로 방향을 따라가게 한다.
  if (layers.arrows && input.hasResults && (zoom >= 13.5 || visibleLinks.length <= 400)) {
    result.push(
      new IconLayer<LinkDatum>({
        id: 'flow-arrows',
        data: visibleLinks,
        iconAtlas: atlas,
        iconMapping: ICON_MAPPING,
        getIcon: () => 'arrow',
        getPosition: (d) => d.mid.position,
        getAngle: (d) => d.mid.angle + ((thematic.flowOf(d.link) ?? 0) < 0 ? 180 : 0),
        getSize: (d) => (Math.abs(thematic.flowOf(d.link) ?? 0) > 1e-6 ? 15 : 0),
        getColor: [245, 247, 250, 255],
        sizeUnits: 'pixels',
        billboard: false,
        updateTriggers: { getAngle: styleKey, getSize: styleKey },
      }),
    );
  }

  if (layers.pumpsValves) {
    const devices = links.filter((d) => d.link.type !== 'pipe');
    if (devices.length > 0) {
      result.push(
        new IconLayer<LinkDatum>({
          id: 'device-icons',
          data: devices,
          iconAtlas: atlas,
          iconMapping: ICON_MAPPING,
          getIcon: (d) => (d.link.type === 'pump' ? 'pump' : 'valve'),
          getPosition: (d) => d.mid.position,
          getSize: 22,
          sizeUnits: 'pixels',
        }),
      );
    }
  }

  // 3D 수압 기둥
  if (layers.columns3d && input.hasResults && layers.junctions) {
    const toMeters = usUnits ? 1 / PSI_PER_METER : 1;
    result.push(
      new ColumnLayer<NetworkNode>({
        id: 'pressure-columns',
        data: junctions,
        getPosition: (d) => d.position,
        getElevation: (d) => Math.max(0, (thematic.pressureOf(d) ?? 0) * toMeters),
        getFillColor: (d) => [...thematic.nodeColor(d), 225] as Color,
        elevationScale: 4,
        radius: 5,
        radiusUnits: 'pixels',
        diskResolution: 10,
        extruded: true,
        updateTriggers: { getElevation: styleKey, getFillColor: styleKey },
      }),
    );
  }

  const ringNodes = (ids: string[]) => ids.map((id) => nodesById[id]).filter((n): n is NetworkNode => n !== undefined);
  if (highlight && highlight.nodeIds.length > 0) {
    result.push(
      new ScatterplotLayer<NetworkNode>({
        id: 'node-highlight',
        data: ringNodes(highlight.nodeIds),
        getPosition: (d) => d.position,
        getRadius: 12,
        radiusUnits: 'pixels',
        filled: true,
        getFillColor: [...PALETTE.highlight, 70],
        stroked: true,
        getLineColor: [...PALETTE.highlight, 255],
        getLineWidth: 2.5,
        lineWidthUnits: 'pixels',
      }),
    );
  }
  if (multiSelection && multiSelection.nodeIds.length > 0) {
    result.push(
      new ScatterplotLayer<NetworkNode>({
        id: 'node-multi',
        data: ringNodes(multiSelection.nodeIds),
        getPosition: (d) => d.position,
        getRadius: (d) => (d.type === 'junction' ? 9 : 16),
        radiusUnits: 'pixels',
        filled: true,
        getFillColor: [...PALETTE.selection, 50],
        stroked: true,
        getLineColor: [...PALETTE.selection, 230],
        getLineWidth: 1.5,
        lineWidthUnits: 'pixels',
      }),
    );
  }
  if (profile && profile.waypointIds.length > 0) {
    const waypointNodes = ringNodes(profile.waypointIds);
    result.push(
      new ScatterplotLayer<NetworkNode>({
        id: 'profile-waypoints',
        data: waypointNodes,
        getPosition: (d) => d.position,
        getRadius: 10,
        radiusUnits: 'pixels',
        filled: true,
        getFillColor: [...PROFILE_COLOR, 90],
        stroked: true,
        getLineColor: [...PROFILE_COLOR, 255],
        getLineWidth: 2.5,
        lineWidthUnits: 'pixels',
      }),
      new TextLayer<NetworkNode>({
        id: 'profile-waypoint-labels',
        data: waypointNodes,
        getPosition: (d) => d.position,
        getText: (d) => {
          const index = profile.waypointIds.indexOf(d.id);
          return index === 0 ? '시점' : index === profile.waypointIds.length - 1 ? '종점' : `경유 ${index}`;
        },
        getSize: 11,
        getColor: [255, 255, 255, 255],
        getPixelOffset: [0, -20],
        background: true,
        getBackgroundColor: [...PROFILE_COLOR, 230],
        backgroundPadding: [4, 2],
        fontFamily: 'system-ui, "Segoe UI", sans-serif',
        characterSet: 'auto',
        updateTriggers: { getText: profile.waypointIds.join('|') },
      }),
    );
  }
  if (selection?.kind === 'node' && nodesById[selection.id]) {
    result.push(
      new ScatterplotLayer<NetworkNode>({
        id: 'node-selected',
        data: [nodesById[selection.id]],
        getPosition: (d) => d.position,
        getRadius: (d) => (d.type === 'junction' ? 11 : 18),
        radiusUnits: 'pixels',
        filled: false,
        stroked: true,
        getLineColor: [...PALETTE.selection, 255],
        getLineWidth: 2.5,
        lineWidthUnits: 'pixels',
      }),
    );
  }

  if (layers.junctions) {
    result.push(
      new ScatterplotLayer<NetworkNode>({
        id: 'junctions',
        data: junctions,
        getPosition: (d) => d.position,
        getRadius: 7,
        radiusUnits: 'meters',
        radiusMinPixels: 3,
        radiusMaxPixels: 7,
        getFillColor: (d) => thematic.nodeColor(d),
        stroked: true,
        getLineColor: DARK_OUTLINE,
        getLineWidth: 1,
        lineWidthUnits: 'pixels',
        pickable: true,
        autoHighlight: true,
        highlightColor: HOVER,
        updateTriggers: { getFillColor: styleKey },
      }),
    );
  }

  if (layers.sources && sources.length > 0) {
    result.push(
      new IconLayer<NetworkNode>({
        id: 'sources',
        data: sources,
        iconAtlas: atlas,
        iconMapping: ICON_MAPPING,
        getIcon: (d) => (d.type === 'reservoir' ? 'reservoir' : 'tank'),
        getPosition: (d) => d.position,
        getSize: 28,
        sizeUnits: 'pixels',
        pickable: true,
        autoHighlight: true,
        highlightColor: HOVER,
      }),
    );
  }

  // 관로 라벨: 관 가운데, 절점 라벨보다 한 단계 더 확대했을 때 (관이 절점보다 많아 겹치기 쉽다)
  if (layers.labels && zoom >= 15.5) {
    const data = visibleLinks.map((d) => ({ d, text: labelers.link(d.link) })).filter((x) => x.text !== '');
    if (data.length > 0) {
      result.push(
        new TextLayer<{ d: LinkDatum; text: string }>({
          id: 'link-labels',
          data,
          getPosition: (x) => x.d.mid.position,
          getText: (x) => x.text,
          getSize: 10,
          getColor: [190, 214, 240, 255],
          background: true,
          getBackgroundColor: [15, 19, 24, 170],
          backgroundPadding: [2, 1],
          fontFamily: 'system-ui, "Segoe UI", sans-serif',
          characterSet: 'auto',
        }),
      );
    }
  }

  if (layers.labels && zoom >= 14.5) {
    result.push(
      new TextLayer<NetworkNode>({
        id: 'node-labels',
        data: [...(layers.junctions ? junctions : []), ...(layers.sources ? sources : [])],
        getPosition: (d) => d.position,
        getText: (d) => labelers.node(d),
        updateTriggers: { getText: labelKey },
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

  return result;
}
