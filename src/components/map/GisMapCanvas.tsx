import type { PickingInfo } from '@deck.gl/core';
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, {
  NavigationControl,
  ScaleControl,
  useControl,
  type MapLayerMouseEvent,
  type MapRef,
} from 'react-map-gl/maplibre';
import { INITIAL_VIEW } from '../../config';
import { useProfilePath } from '../../app/useProfilePath';
import { linkPath } from '../../core/model/networkEdit';
import { mergeSets, objectsInPolygon, type ObjectSet } from '../../core/model/selection';
import type { LinkType, LngLat, NetworkNode, NodeType } from '../../core/model/types';
import { formatNumber, isUsUnits, unitLabels } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { useUIStore, type Selection, type Tool } from '../../store/useUIStore';
import { midpointOfPath, wgs84ToEpsg } from '../../utils/geoMath';
import { useDraftStore } from '../../store/useDraftStore';
import { buildMapStyle } from './basemaps';
import { buildDraftLayers } from './draftLayers';
import { ColorRampLegend } from './ColorRampLegend';
import { DrawingOverlay } from './DrawingOverlay';
import { buildNetworkLayers, LINK_LAYER_IDS, NODE_LAYER_IDS, type LinkDatum } from './networkLayers';
import { useThematic } from './thematic';
import { useSwmmStore } from '../../store/useSwmmStore';
import { SwmmLegend } from '../swmm/SwmmPanels';
import { buildSwmmLayers } from '../swmm/swmmLayers';
import { useSwmmThematic } from '../swmm/swmmThematic';

const NODE_TOOLS: ReadonlySet<Tool> = new Set(['junction', 'reservoir', 'tank']);
const LINK_TOOLS: ReadonlySet<Tool> = new Set(['pipe', 'pump', 'valve']);

const TOOL_HINTS: Record<Tool, string> = {
  select: '',
  area: '구역 선택: 지도를 클릭해 다각형 꼭짓점을 찍고 더블클릭(또는 첫 점 클릭)으로 닫습니다 · Shift 를 누른 채 닫으면 기존 선택에 추가 · 우클릭 취소',
  profile: '종단면도: 시점 절점 → (경유 절점) → 종점 절점 순서로 클릭합니다 · Esc 로 지정 종료',
  junction: '지도를 클릭해 절점을 추가합니다. 관로 위를 클릭하면 그 지점에서 관로를 나눕니다.',
  reservoir: '지도를 클릭해 수원지를 추가합니다.',
  tank: '지도를 클릭해 배수지를 추가합니다.',
  pipe: '시작 절점 클릭 → 빈 곳 클릭으로 꺾임점 추가 → 절점 클릭 또는 더블클릭으로 완료 · Esc/우클릭 종료',
  pump: '흡입측 절점 → 토출측 절점 순서로 클릭합니다 · Esc/우클릭 종료',
  valve: '상류측 절점 → 하류측 절점 순서로 클릭합니다 · Esc/우클릭 종료',
};

function selectionAsSet(selection: Selection): ObjectSet | null {
  if (!selection) return null;
  return selection.kind === 'node' ? { nodeIds: [selection.id], linkIds: [] } : { nodeIds: [], linkIds: [selection.id] };
}

function DeckOverlay({ onReady, ...props }: MapboxOverlayProps & { onReady: (overlay: MapboxOverlay | null) => void }) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay({ interleaved: false, ...props }));
  overlay.setProps(props);
  useEffect(() => {
    onReady(overlay);
    return () => onReady(null);
  }, [overlay, onReady]);
  return null;
}

function CursorReadout({ zoom }: { zoom: number }) {
  const cursor = useUIStore((s) => s.cursor);
  const nodeCount = useNetworkStore((s) => Object.keys(s.model.nodes).length);
  const linkCount = useNetworkStore((s) => Object.keys(s.model.links).length);
  let tm = '';
  if (cursor && cursor[0] > 122 && cursor[0] < 134 && cursor[1] > 31 && cursor[1] < 45) {
    const [x, y] = wgs84ToEpsg('EPSG:5186', cursor);
    tm = `X ${x.toFixed(1)}  Y ${y.toFixed(1)}`;
  }
  return (
    <div className="absolute inset-x-0 bottom-0 z-10 flex h-7 items-center gap-4 border-t border-line bg-panel/95 px-3 text-[11px] tabular-nums text-ink-soft">
      <span>
        <span className="text-ink-muted">경도</span> {cursor ? cursor[0].toFixed(6) : '—'}
      </span>
      <span>
        <span className="text-ink-muted">위도</span> {cursor ? cursor[1].toFixed(6) : '—'}
      </span>
      {tm && (
        <span>
          <span className="text-ink-muted">EPSG:5186</span> {tm}
        </span>
      )}
      <span className="ml-auto">
        <span className="text-ink-muted">절점</span> {nodeCount.toLocaleString()} · <span className="text-ink-muted">링크</span>{' '}
        {linkCount.toLocaleString()}
      </span>
      <span>
        <span className="text-ink-muted">줌</span> {zoom.toFixed(1)}
      </span>
    </div>
  );
}

/** MapLibre 배경지도 + Deck.gl 관망 레이어 통합 캔버스와 마우스 편집 처리. */
export function GisMapCanvas() {
  const mapRef = useRef<MapRef | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const [mapReady, setMapReady] = useState(false);
  /** WebGL 연결이 끊겨 관망 오버레이를 새로 만들 때마다 증가 (레이어 인스턴스도 새로 만든다). */
  const [deckEpoch, setDeckEpoch] = useState(0);
  const [zoom, setZoom] = useState(INITIAL_VIEW.zoom);
  const [hovering, setHovering] = useState(false);
  const [dragging, setDragging] = useState(false);

  const nodes = useNetworkStore((s) => s.model.nodes);
  const links = useNetworkStore((s) => s.model.links);
  const flowUnits = useNetworkStore((s) => s.model.options.flowUnits);
  const revision = useNetworkStore((s) => s.revision);
  const results = useSimulationStore((s) => s.results);
  const resultsRevision = useSimulationStore((s) => s.resultsRevision);
  const stepIndex = useSimulationStore((s) => s.stepIndex);
  const tool = useUIStore((s) => s.tool);
  const basemap = useUIStore((s) => s.basemap);
  const vworldKey = useUIStore((s) => s.vworldKey);
  const layerVisibility = useUIStore((s) => s.layers);
  const nodeTheme = useUIStore((s) => s.nodeTheme);
  const linkTheme = useUIStore((s) => s.linkTheme);
  const selection = useUIStore((s) => s.selection);
  const highlight = useUIStore((s) => s.highlight);
  const multiSelection = useUIStore((s) => s.multiSelection);
  const profileWaypoints = useUIStore((s) => s.profileWaypoints);
  const camera = useUIStore((s) => s.camera);
  const pointPick = useUIStore((s) => s.pointPick);
  const draftCustomers = useDraftStore((s) => (s.overlay ? s.customers : null));
  const draftResult = useDraftStore((s) => (s.overlay ? s.result : null));
  const draftSource = useDraftStore((s) => (s.overlay ? s.source : null));
  const thematic = useThematic();
  const profilePath = useProfilePath();
  const profile = useMemo(
    () => (profileWaypoints.length > 0 ? { linkIds: profilePath?.linkIds ?? [], waypointIds: profileWaypoints } : null),
    [profilePath, profileWaypoints],
  );

  const swmmProject = useSwmmStore((s) => s.project);
  const swmmRun = useSwmmStore((s) => s.run);
  const swmmPeriod = useSwmmStore((s) => s.period);
  const swmmSelection = useSwmmStore((s) => s.selection);
  const swmmThematic = useSwmmThematic();
  const swmmActive = swmmProject !== null;

  const mapStyle = useMemo(() => buildMapStyle(basemap, vworldKey), [basemap, vworldKey]);
  const usUnits = isUsUnits(flowUnits);

  const { junctions, sources } = useMemo(() => {
    const junctionList: NetworkNode[] = [];
    const sourceList: NetworkNode[] = [];
    for (const id in nodes) (nodes[id].type === 'junction' ? junctionList : sourceList).push(nodes[id]);
    return { junctions: junctionList, sources: sourceList };
  }, [nodes]);

  const linkData = useMemo<LinkDatum[]>(() => {
    const data: LinkDatum[] = [];
    for (const id in links) {
      const link = links[id];
      const path = linkPath({ nodes }, link);
      if (path.length < 2) continue;
      data.push({ link, path, mid: midpointOfPath(path) });
    }
    return data;
  }, [links, nodes]);

  const styleKey = `${revision}:${resultsRevision}:${stepIndex}:${nodeTheme}:${linkTheme}`;
  const swmmStyleKey = `${swmmRun ? 'r' : 'n'}:${swmmPeriod}:${swmmThematic?.nodeScale?.title}:${swmmThematic?.linkScale?.title}:${swmmProject?.nodes.length}`;
  const draftLayers = useMemo(() => buildDraftLayers(draftCustomers, draftResult, draftSource, deckEpoch), [draftCustomers, draftResult, draftSource, deckEpoch]);
  const baseLayers = useMemo(
    () =>
      // deckEpoch: 끊긴 컨텍스트에 묶인 레이어 상태를 버리고 새 오버레이에서 처음부터 초기화하도록 매번 새 인스턴스를 만든다.
      deckEpoch >= 0 && swmmProject && swmmThematic
        ? buildSwmmLayers({ project: swmmProject, thematic: swmmThematic, styleKey: swmmStyleKey, selection: swmmSelection, zoom, hasResults: swmmRun !== null })
        : buildNetworkLayers({
        junctions,
        sources,
        links: linkData,
        nodesById: nodes,
        thematic,
        hasResults: results !== null,
        styleKey,
        layers: layerVisibility,
        selection,
        highlight,
        multiSelection,
        profile,
        zoom,
        usUnits,
      }),
    [
      junctions, sources, linkData, nodes, thematic, results, styleKey, layerVisibility, selection, highlight, multiSelection, profile, zoom, usUnits,
      swmmProject, swmmThematic, swmmStyleKey, swmmSelection, swmmRun, deckEpoch,
    ],
  );
  const deckLayers = useMemo(() => (draftLayers.length > 0 ? [...baseLayers, ...draftLayers] : baseLayers), [baseLayers, draftLayers]);

  /* ---------------------------------------------------------------- 픽킹 */

  const pick = useCallback((point: { x: number; y: number }, layerIds: string[], radius: number): PickingInfo | null => {
    try {
      return overlayRef.current?.pickObject({ x: point.x, y: point.y, radius, layerIds }) ?? null;
    } catch {
      // 지도 스타일을 불러오기 전(deck 초기화 전)에는 픽킹할 수 없다.
      return null;
    }
  }, []);
  const pickNode = useCallback(
    (point: { x: number; y: number }) => (pick(point, NODE_LAYER_IDS, 10)?.object as NetworkNode | undefined) ?? null,
    [pick],
  );
  const pickLink = useCallback(
    (point: { x: number; y: number }) => (pick(point, LINK_LAYER_IDS, 6)?.object as LinkDatum | undefined)?.link ?? null,
    [pick],
  );
  /**
   * 클릭 시점의 절점 찾기. GPU 픽킹이 놓치는 경우(방금 추가한 객체의 레이어가 아직 그려지기 전 등)에는
   * 화면 거리로 한 번 더 찾아, 같은 자리에 절점이 겹쳐 만들어지는 것을 막는다.
   */
  const pickNodeForClick = useCallback(
    (point: { x: number; y: number }): NetworkNode | null => {
      const picked = pickNode(point);
      if (picked) return picked;
      const map = mapRef.current;
      if (!map) return null;
      const { model } = useNetworkStore.getState();
      const visible = useUIStore.getState().layers;
      let best: NetworkNode | null = null;
      let bestDistance = 9;
      for (const id in model.nodes) {
        const node = model.nodes[id];
        if (node.type === 'junction' ? !visible.junctions : !visible.sources) continue;
        const projected = map.project(node.position);
        const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
        if (distance <= bestDistance) {
          best = node;
          bestDistance = distance;
        }
      }
      return best;
    },
    [pickNode],
  );

  /* ---------------------------------------------------------------- 커서 좌표 (rAF 로 묶어서 갱신) */

  const pendingCursor = useRef<{ lngLat: LngLat; snap: string | null } | null>(null);
  const pendingMove = useRef<{ id: string; lngLat: LngLat } | null>(null);
  const frame = useRef(0);
  const flush = useCallback(() => {
    frame.current = 0;
    const move = pendingMove.current;
    if (move) {
      pendingMove.current = null;
      useNetworkStore.getState().moveNode(move.id, move.lngLat, `drag:${move.id}`);
    }
    const cursor = pendingCursor.current;
    if (cursor) {
      pendingCursor.current = null;
      useUIStore.getState().setCursor(cursor.lngLat, cursor.snap);
    }
  }, []);
  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(flush);
  }, [flush]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  /* ---------------------------------------------------------------- 절점 드래그 이동 */

  const drag = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const endDrag = useCallback(() => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setDragging(false);
    if (current.moved) {
      if (frame.current) {
        cancelAnimationFrame(frame.current);
        flush();
      }
      useNetworkStore.getState().sealHistory();
      suppressClick.current = true;
    }
  }, [flush]);

  useEffect(() => {
    window.addEventListener('mouseup', endDrag);
    return () => window.removeEventListener('mouseup', endDrag);
  }, [endDrag]);

  const onMouseDown = useCallback(
    (event: MapLayerMouseEvent) => {
      suppressClick.current = false;
      const original = event.originalEvent;
      if (useSwmmStore.getState().project) return; // SWMM 보기는 읽기 전용: 절점 끌어 이동 없음
      if (original.button !== 0 || useUIStore.getState().tool !== 'select') return;
      if (original.ctrlKey || original.metaKey || original.shiftKey) return; // 다중 선택 클릭
      const node = pickNodeForClick(event.point);
      if (!node) return;
      event.preventDefault(); // 지도 끌기(dragPan) 대신 절점 이동
      drag.current = { id: node.id, x: event.point.x, y: event.point.y, moved: false };
      setDragging(true);
      useUIStore.getState().select({ kind: 'node', id: node.id });
    },
    [pickNodeForClick],
  );

  const onMouseMove = useCallback(
    (event: MapLayerMouseEvent) => {
      const lngLat: LngLat = [event.lngLat.lng, event.lngLat.lat];
      const current = drag.current;
      if (current) {
        if (!current.moved && Math.hypot(event.point.x - current.x, event.point.y - current.y) < 4) return;
        current.moved = true;
        pendingMove.current = { id: current.id, lngLat };
        pendingCursor.current = { lngLat, snap: null };
        schedule();
        return;
      }
      const activeTool = useUIStore.getState().tool;
      const snap = activeTool !== 'select' && activeTool !== 'area' ? (pickNode(event.point)?.id ?? null) : null;
      pendingCursor.current = { lngLat, snap };
      schedule();
    },
    [pickNode, schedule],
  );

  /* ---------------------------------------------------------------- 클릭: 선택 / 작도 */

  const finishLink = useCallback((endNodeId: string) => {
    const ui = useUIStore.getState();
    const drawing = ui.drawing;
    if (!drawing || drawing.startNodeId === endNodeId) return;
    const id = useNetworkStore.getState().addLink(drawing.linkType, drawing.startNodeId, endNodeId, drawing.vertices);
    // 관로는 이어 그리기: 방금 끝난 절점에서 다음 관로를 시작한다.
    ui.setDrawing(drawing.linkType === 'pipe' ? { linkType: 'pipe', startNodeId: endNodeId, vertices: [] } : null);
    if (id) ui.select({ kind: 'link', id });
  }, []);

  const finishArea = useCallback((polygon: LngLat[], additive: boolean) => {
    const ui = useUIStore.getState();
    ui.setAreaDraft([]);
    if (polygon.length < 3) return;
    const found = objectsInPolygon(useNetworkStore.getState().model, polygon);
    const next = additive ? mergeSets(ui.multiSelection, found, 'union') : found;
    ui.setMultiSelection(next);
    ui.select(null);
    if (found.nodeIds.length + found.linkIds.length === 0) {
      ui.pushToast({ level: 'info', title: '구역 안에 객체가 없습니다' });
    }
  }, []);

  const onClick = useCallback(
    (event: MapLayerMouseEvent) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      const pointPick = useUIStore.getState().pointPick;
      if (pointPick) {
        pointPick.onPick([event.lngLat.lng, event.lngLat.lat]);
        useUIStore.getState().setPointPick(null);
        return;
      }
      if (useSwmmStore.getState().project) {
        // SWMM 보기: 절점 → 관거 → 유역 순으로 우선 선택
        const picked = (ids: string[], radius: number) => overlayRef.current?.pickObject({ x: event.point.x, y: event.point.y, radius, layerIds: ids }) ?? null;
        const swmm = useSwmmStore.getState();
        const n = picked(['swmm-nodes'], 10)?.object as { id: string } | undefined;
        if (n) return swmm.select({ kind: 'node', id: n.id });
        const l = picked(['swmm-links'], 6)?.object as { link: { id: string } } | undefined;
        if (l) return swmm.select({ kind: 'link', id: l.link.id });
        const s = picked(['swmm-subs'], 1)?.object as { id: string } | undefined;
        swmm.select(s ? { kind: 'subcatch', id: s.id } : null);
        return;
      }
      const ui = useUIStore.getState();
      const net = useNetworkStore.getState();
      const lngLat: LngLat = [event.lngLat.lng, event.lngLat.lat];
      const activeTool = ui.tool;

      if (activeTool === 'select') {
        const node = pickNodeForClick(event.point);
        const link = node ? null : pickLink(event.point);
        const original = event.originalEvent;
        if (original.ctrlKey || original.metaKey || original.shiftKey) {
          // Ctrl/Shift+클릭: 다중 선택에 넣고 빼기
          if (!node && !link) return;
          const base = ui.multiSelection ?? selectionAsSet(ui.selection);
          ui.setMultiSelection(mergeSets(base, { nodeIds: node ? [node.id] : [], linkIds: link ? [link.id] : [] }, 'toggle'));
          ui.select(null);
          return;
        }
        ui.setMultiSelection(null);
        if (node) ui.select({ kind: 'node', id: node.id });
        else ui.select(link ? { kind: 'link', id: link.id } : null);
        return;
      }

      if (activeTool === 'profile') {
        const node = pickNodeForClick(event.point);
        if (!node) return;
        const current = ui.profileWaypoints;
        if (current[current.length - 1] !== node.id) ui.setProfileWaypoints([...current, node.id]);
        if (ui.bottomTab !== 'profile' || ui.bottomCollapsed) ui.setBottomTab('profile');
        return;
      }

      if (activeTool === 'area') {
        const draft = ui.areaDraft;
        const map = mapRef.current;
        if (map && draft.length >= 3) {
          const first = map.project(draft[0]);
          if (Math.hypot(first.x - event.point.x, first.y - event.point.y) < 9) {
            finishArea(draft, event.originalEvent.shiftKey);
            return;
          }
        }
        const last = draft[draft.length - 1];
        if (map && last) {
          const p = map.project(last);
          if (Math.hypot(p.x - event.point.x, p.y - event.point.y) < 5) return;
        }
        ui.setAreaDraft([...draft, lngLat]);
        return;
      }

      if (NODE_TOOLS.has(activeTool)) {
        const existing = pickNodeForClick(event.point);
        if (existing) {
          ui.select({ kind: 'node', id: existing.id });
          return;
        }
        const link = activeTool === 'junction' ? pickLink(event.point) : null;
        const id = link?.type === 'pipe' ? net.splitPipeAt(link.id, lngLat) : net.addNode(activeTool as NodeType, lngLat);
        if (id) ui.select({ kind: 'node', id });
        return;
      }

      if (LINK_TOOLS.has(activeTool)) {
        const node = pickNodeForClick(event.point);
        const drawing = ui.drawing;
        if (!drawing) {
          const startNodeId = node?.id ?? net.addNode('junction', lngLat);
          ui.setDrawing({ linkType: activeTool as LinkType, startNodeId, vertices: [] });
          return;
        }
        if (node) {
          finishLink(node.id);
          return;
        }
        // 빈 곳 클릭 = 꺾임점. 더블클릭의 두 번째 클릭이 같은 점을 또 넣지 않게 한다.
        const map = mapRef.current;
        const last = drawing.vertices[drawing.vertices.length - 1];
        if (map && last) {
          const p = map.project(last);
          if (Math.hypot(p.x - event.point.x, p.y - event.point.y) < 5) return;
        }
        ui.setDrawing({ ...drawing, vertices: [...drawing.vertices, lngLat] });
      }
    },
    [pickNodeForClick, pickLink, finishLink, finishArea],
  );

  const onDblClick = useCallback(
    (event: MapLayerMouseEvent) => {
      const ui = useUIStore.getState();
      if (ui.tool === 'area') {
        event.preventDefault();
        const map = mapRef.current;
        // 더블클릭의 두 클릭이 넣은 꼭짓점 중복을 걷어낸다.
        const draft = [...ui.areaDraft];
        while (map && draft.length > 0) {
          const p = map.project(draft[draft.length - 1]);
          if (Math.hypot(p.x - event.point.x, p.y - event.point.y) >= 5) break;
          draft.pop();
        }
        draft.push([event.lngLat.lng, event.lngLat.lat]);
        finishArea(draft, event.originalEvent.shiftKey);
        return;
      }
      if (!LINK_TOOLS.has(ui.tool)) return;
      event.preventDefault(); // 더블클릭 확대 방지
      const drawing = ui.drawing;
      const map = mapRef.current;
      if (!drawing || !map || pickNodeForClick(event.point)) return;
      // 더블클릭의 첫 클릭이 넣은 꺾임점을 걷어내고 그 자리에 절점을 만들어 관로를 끝낸다.
      const vertices = [...drawing.vertices];
      while (vertices.length > 0) {
        const p = map.project(vertices[vertices.length - 1]);
        if (Math.hypot(p.x - event.point.x, p.y - event.point.y) >= 5) break;
        vertices.pop();
      }
      ui.setDrawing({ ...drawing, vertices });
      const endNodeId = useNetworkStore.getState().addNode('junction', [event.lngLat.lng, event.lngLat.lat]);
      finishLink(endNodeId);
    },
    [pickNodeForClick, finishLink, finishArea],
  );

  const onContextMenu = useCallback((event: MapLayerMouseEvent) => {
    const ui = useUIStore.getState();
    if (ui.drawing) {
      event.preventDefault();
      event.originalEvent.preventDefault();
      ui.setDrawing(null);
    } else if (ui.areaDraft.length > 0) {
      event.preventDefault();
      event.originalEvent.preventDefault();
      ui.setAreaDraft([]);
    }
  }, []);

  /* ---------------------------------------------------------------- 카메라 */

  // 개발 서버에서만: E2E 테스트가 좌표 → 화면 위치를 계산할 수 있게 지도를 노출한다.
  useEffect(() => {
    if (import.meta.env.DEV && mapRef.current) Object.assign(window, { __ogpMap: mapRef.current.getMap() });
  });

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !camera) return;
    if (camera.kind === 'fit') {
      const [w, s, e, n] = camera.bbox;
      if (w === e && s === n) map.flyTo({ center: [w, s], zoom: 17, duration: 900 });
      else map.fitBounds([[w, s], [e, n]], { padding: 80, duration: 900, maxZoom: 18 });
    } else {
      map.flyTo({ center: camera.center, zoom: camera.zoom ?? Math.max(map.getZoom(), 16), duration: 900 });
    }
  }, [camera, mapReady]);

  const columns3d = layerVisibility.columns3d;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.easeTo({ pitch: columns3d ? 55 : 0, duration: 700 });
  }, [columns3d, mapReady]);

  /* ---------------------------------------------------------------- 툴팁 */

  const labels = unitLabels(flowUnits);
  const getTooltip = useCallback(
    (info: PickingInfo) => {
      if (!info.object || !info.layer) return null;
      const lines: string[] = [];
      if (info.layer.id.startsWith('swmm-')) {
        const o = info.object as { id?: string; link?: { id: string; kind: string } };
        if (info.layer.id === 'swmm-links' && o.link) lines.push(`${o.link.kind === 'conduit' ? '관거' : '링크'} ${o.link.id}`);
        else if (info.layer.id === 'swmm-subs') lines.push(`유역 ${o.id}`);
        else lines.push(`절점 ${o.id}`);
      } else if (info.layer.id === 'links') {
        const { link } = info.object as LinkDatum;
        const kind = link.type === 'pipe' ? '관로' : link.type === 'pump' ? '펌프' : '밸브';
        lines.push(`${kind} ${link.id}`);
        if (link.type === 'pipe') lines.push(`Ø${formatNumber(link.diameter, 1)} ${labels.diameter} · ${formatNumber(link.length, 1)} ${labels.length}`);
        const flow = thematic.flowOf(link);
        if (flow !== undefined) lines.push(`유량 ${formatNumber(flow, 2)} ${labels.flow}`);
      } else {
        const node = info.object as NetworkNode;
        const kind = node.type === 'junction' ? '절점' : node.type === 'reservoir' ? '수원지' : '배수지';
        lines.push(`${kind} ${node.id}`);
        lines.push(`${node.type === 'reservoir' ? '총수두' : '표고'} ${formatNumber(node.elevation, 2)} ${labels.elevation}`);
        const pressure = thematic.pressureOf(node);
        if (pressure !== undefined && node.type === 'junction') lines.push(`수압 ${formatNumber(pressure, 2)} ${labels.pressure}`);
      }
      return {
        text: lines.join('\n'),
        style: {
          background: 'rgba(22, 26, 32, 0.95)',
          color: '#f0efec',
          border: '1px solid #2a313b',
          borderRadius: '6px',
          padding: '6px 8px',
          fontSize: '12px',
          lineHeight: '1.45',
          fontFamily: 'system-ui, "Segoe UI", sans-serif',
        },
      };
    },
    [thematic, labels.diameter, labels.length, labels.flow, labels.elevation, labels.pressure],
  );

  /**
   * 관망 레이어(deck.gl)는 지도와 별도의 WebGL 캔버스에 그린다. 탭을 오래 열어 두거나 새로고침·핫리로드를 반복하면
   * 브라우저가 WebGL 컨텍스트 수 제한 때문에 오래된 컨텍스트를 끊는데, 그러면 배경지도만 보이고 관망이 사라진다.
   * 끊기면 오버레이를 새로 만들어(key 변경) 다시 그린다.
   */
  const onOverlayReady = useCallback((overlay: MapboxOverlay | null) => {
    overlayRef.current = overlay;
  }, []);
  useEffect(() => {
    const container = mapRef.current?.getMap().getContainer();
    if (!container || !mapReady) return;
    const deckCanvases = [...container.querySelectorAll('canvas')].filter((c) => !c.classList.contains('maplibregl-canvas'));
    const onLost = (event: Event) => {
      event.preventDefault();
      setDeckEpoch((n) => n + 1);
      useUIStore.getState().pushToast({
        level: 'info',
        title: '관망 그래픽을 다시 그렸습니다',
        message: '브라우저가 그래픽(WebGL) 연결을 끊어 관망 레이어를 새로 만들었습니다. 계속 보이지 않으면 페이지를 새로고침하세요.',
      });
    };
    for (const canvas of deckCanvases) canvas.addEventListener('webglcontextlost', onLost);
    return () => {
      for (const canvas of deckCanvases) canvas.removeEventListener('webglcontextlost', onLost);
    };
  }, [mapReady, deckEpoch]);
  const onHover = useCallback((info: PickingInfo) => setHovering(Boolean(info.object)), []);

  const cursorStyle = dragging ? 'grabbing' : tool !== 'select' || pointPick ? 'crosshair' : hovering ? 'pointer' : 'grab';
  const hint = pointPick ? `${pointPick.label} — 지도를 클릭하세요 · Esc 취소` : TOOL_HINTS[tool];

  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas">
      <Map
        ref={mapRef}
        initialViewState={INITIAL_VIEW}
        mapStyle={mapStyle}
        style={{ position: 'absolute', inset: 0 }}
        cursor={cursorStyle}
        maxPitch={70}
        doubleClickZoom={!LINK_TOOLS.has(tool) && tool !== 'area'}
        attributionControl={{ compact: true }}
        onLoad={() => setMapReady(true)}
        onZoom={(event) => setZoom(Math.round(event.viewState.zoom * 2) / 2)}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseOut={() => useUIStore.getState().setCursor(null, null)}
        onClick={onClick}
        onDblClick={onDblClick}
        onContextMenu={onContextMenu}
      >
        <DeckOverlay key={deckEpoch} layers={deckLayers} onReady={onOverlayReady} onHover={onHover} getTooltip={getTooltip} />
        <NavigationControl position="top-right" visualizePitch />
        <ScaleControl position="bottom-right" unit="metric" style={{ marginBottom: 34 }} />
        <DrawingOverlay />
      </Map>
      {hint && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 w-max max-w-[min(34rem,calc(100%-4.5rem))] rounded-md border border-line bg-panel/95 px-3 py-1.5 text-xs leading-relaxed text-ink-soft shadow-lg">
          {hint}
        </div>
      )}
      {swmmActive ? <SwmmLegend /> : <ColorRampLegend />}
      <CursorReadout zoom={zoom} />
    </div>
  );
}
