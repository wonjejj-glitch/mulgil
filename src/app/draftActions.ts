/**
 * 화면 동작: 수용가 CSV → 관망 초안, 용도지역 분담유량, 관망 정리 도구, 자동 백업 복원.
 * 계산은 core(순수 함수)가 맡고 여기서는 파일·네트워크·지형 조회와 상태 반영만 한다.
 */
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { guessMapping, parseCsv, readCustomers, type ColumnMapping, type Customer } from '../core/io/customerCsv';
import { loadShapefiles } from '../core/io/loadShapefiles';
import { addDraftToWaterModel, draftToSewerProject, draftToWaterModel } from '../core/model/draftConvert';
import { linkPath } from '../core/model/networkEdit';
import { plane, RoadGraph } from '../core/model/roadSnap';
import { allocateDemand, allocationCsv, m3dToFlowUnits } from '../core/model/landUse';
import { buildDraft, defaultDraftOptions, nodeRoads, prepareRoads } from '../core/model/networkDraft';
import { mergeNearbyNodes, mergeSeriesPipes, renumber, type RenumberOptions } from '../core/model/networkTools';
import type { LngLat, SourceCrs } from '../core/model/types';
import { parcelsOf, useDraftStore } from '../store/useDraftStore';
import { useNetworkStore } from '../store/useNetworkStore';
import { nodePositions } from '../core/sewer/mapFrame';
import { fitOutfallInverts } from '../core/sewer/outfall';
import { useSewerStore } from '../store/useSewerStore';
import { useUIStore } from '../store/useUIStore';
import { baseName, downloadText } from '../utils/files';
import { bboxOf, CRS_DEFS, detectCrs, toWgs84, type ImportCrsChoice } from '../utils/geoMath';
import { adoptModel, fitToNetwork } from './actions';
import { readBackup } from './autoBackup';
import { getViewBounds } from './mapView';
import { BUILDING_SOURCE_LABEL, fetchMapBuildings } from './mapBuildings';
import { fetchRoads, lastRoadSource, ROAD_SOURCE_LABEL, setUserRoads } from './osmRoads';
import { applyBusinessRatio, DEFAULT_WATER_DEMAND, estimateBuildings } from '../core/model/buildingEstimate';
import { sampleTerrainTiles } from './terrainFetch';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function resolveCrs(choice: ImportCrsChoice, points: [number, number][]): { crs: SourceCrs; label: string } {
  const code = choice === 'auto' ? detectCrs(points) : choice;
  if (code === 'local') throw new Error('좌표계를 알 수 없습니다. 좌표계를 직접 골라 주세요 (경위도 / EPSG:5186 등).');
  if (code === 'wgs84') return { crs: { kind: 'wgs84' }, label: 'WGS84 경위도' };
  return { crs: { kind: 'epsg', code }, label: CRS_DEFS[code]?.label ?? code };
}

/* ------------------------------------------------------------------ 수용가 CSV → 관망 초안 */

export async function loadCustomerFile(file: File): Promise<void> {
  const store = useDraftStore.getState();
  try {
    const table = parseCsv(new Uint8Array(await file.arrayBuffer()));
    store.set({ table, fileName: file.name, mapping: guessMapping(table.headers), customers: [], result: null, error: null, warnings: [] });
    applyCustomerMapping();
  } catch (e) {
    store.set({ error: errorText(e) });
  }
}

/** 열 지정·좌표계를 바꿀 때마다 수용가 목록을 다시 만든다. */
export function applyCustomerMapping(patch?: { mapping?: ColumnMapping; crs?: ImportCrsChoice }): void {
  const store = useDraftStore.getState();
  if (patch) store.set(patch);
  const { table, mapping, crs } = useDraftStore.getState();
  if (!table || !mapping) return;
  try {
    const { records, skipped } = readCustomers(table, mapping);
    if (records.length === 0) throw new Error('좌표를 읽은 수용가가 없습니다. X·Y 열을 확인하세요.');
    const resolved = resolveCrs(crs, records.map((r) => r.xy));
    const customers: Customer[] = records.map((r) => ({ id: r.id, position: toWgs84(resolved.crs, r.xy), demand: r.demand }));
    const outside = customers.filter((c) => c.position[0] < 124 || c.position[0] > 132 || c.position[1] < 33 || c.position[1] > 39.5).length;
    store.set({
      customers,
      // 새 수용가 파일: 앞서 뺀 목록은 다른 자료의 것이므로 비운다
      removed: [],
      excluded: [],
      skipped,
      crsLabel: resolved.label,
      result: null,
      error: outside > customers.length / 2 ? `수용가 ${outside}곳이 국내 범위 밖입니다. 좌표계나 X·Y 열 순서를 확인하세요.` : null,
    });
    const box = bboxOf(customers.map((c) => c.position));
    if (box) useUIStore.getState().fitBounds(box);
  } catch (e) {
    store.set({ customers: [], error: errorText(e) });
  }
}

/**
 * 수용가 자료가 없을 때: 지금 지도 화면 안의 건물(브이월드, 안 되면 OpenStreetMap)로 수용가를 만든다 (세대수 개략 추정 × 세대당 인원 × 1인 1일 급수량).
 * 정확도가 낮아 참고용이다.
 */
export async function loadCustomersFromMap(): Promise<void> {
  const store = useDraftStore.getState();
  if (store.busy) return;
  const view = store.area ?? getViewBounds();
  if (!view) {
    store.set({ error: '지도 화면 범위를 알 수 없습니다. 지도를 한 번 움직인 뒤 다시 누르세요.' });
    return;
  }
  store.set({ busy: '지도 건물 읽는 중…', error: null });
  try {
    const [w, s, e, n] = view;
    const { buildings, partsUsed, source, note } = await fetchMapBuildings([[w, s], [e, n]], 0, (done, total, unit) => {
      useDraftStore.getState().set({ busy: `지도 건물 읽는 중… (${unit} ${done}/${total})` });
    });
    const est = estimateBuildings(buildings);
    if (est.items.length === 0) throw new Error(`지금 지도 화면 안에 ${BUILDING_SOURCE_LABEL[source]}이 없습니다. 관망을 만들 지역으로 지도를 옮기고 다시 누르세요.`);
    const o = DEFAULT_WATER_DEMAND;
    const priced = applyBusinessRatio(
      est.items.map((b) => ({ id: b.id, position: b.position, households: b.households, business: b.category === '비주거' })),
      { ...o, businessRatio: store.businessRatio },
    );
    const excluded = new Set(store.excluded);
    const all: Customer[] = priced.map((b) => ({ id: b.id, position: b.position, demand: b.demand ?? 0 }));
    const customers = all.filter((c) => !excluded.has(c.id));
    const dropped = all.length - customers.length;
    const c = est.byCategory;
    useDraftStore.getState().set({
      table: null,
      mapping: null,
      fileName: '',
      customers,
      removed: [],
      skipped: [],
      crsLabel: 'WGS84 경위도 (지도)',
      result: null,
      warnings: [
        `${BUILDING_SOURCE_LABEL[source]} ${est.items.length.toLocaleString()}동으로 만든 개략 수용가입니다 — 공동주택 ${c.공동주택.count}동, 단독 ${c.단독주택.count}동, 용도 미상 ${c['용도 미상'].count}동, 비주거 ${c.비주거.count}동. ` +
          `층수 자료 있는 건물 ${est.floorsKnown}동(${Math.round((est.floorsKnown / est.items.length) * 100)}%${partsUsed ? `, 건물 부분에서 ${partsUsed}동` : ''}). 가정용 = 세대수 × ${o.personsPerHousehold}인 × ${o.litersPerCapita} L, 영업·업무용 = 가정용 × ${store.businessRatio}% 를 상가·업무 건물에 연면적 비율로 (예시 원단위).`,
        ...(note ? [note] : []),
        ...(dropped > 0 ? [`직접 뺀 수용가 ${dropped.toLocaleString()}곳은 넣지 않았습니다 (‘뺀 수용가 되살리기’로 되돌릴 수 있음).`] : []),
      ],
    });
  } catch (e) {
    useDraftStore.getState().set({ error: errorText(e) });
  } finally {
    useDraftStore.getState().set({ busy: null });
  }
}

/** 지도에서 누른 채 끌어 네모 범위를 그린다 (components/map/DraftMapTool). */
export function startDraftAreaTool(): void {
  useDraftStore.getState().set({ mapTool: 'area', error: null });
  useUIStore.getState().openModal(null);
}

/** 지도에서 수용가를 클릭·네모로 뺀다. */
export function startEraseTool(): void {
  if (useDraftStore.getState().customers.length === 0) return;
  useDraftStore.getState().set({ mapTool: 'erase', error: null });
  useUIStore.getState().openModal(null);
}

/** 지도 도구를 끝내고 대화상자로 돌아간다. */
export function finishDraftTool(): void {
  useDraftStore.getState().set({ mapTool: null });
  useUIStore.getState().openModal('draft');
}

/** 끌어서 그린 범위 [서, 남, 동, 북] 를 정하고, 그 안의 건물로 수용가를 만든다. */
export function applyDraftArea(area: [number, number, number, number]): void {
  if (area[2] - area[0] < 1e-5 || area[3] - area[1] < 1e-5) return;
  useDraftStore.getState().set({ area, result: null, error: null, mapTool: null });
  useUIStore.getState().openModal('draft');
  void loadCustomersFromMap();
}

/** 수용가를 뺀다 (한 번에 뺀 묶음은 되돌리기 한 번으로 돌아온다). 초안은 다시 만들어야 한다. */
export function eraseCustomers(ids: string[]): void {
  const s = useDraftStore.getState();
  const drop = new Set(ids);
  const batch = s.customers.filter((c) => drop.has(c.id));
  if (batch.length === 0) return;
  s.set({
    customers: s.customers.filter((c) => !drop.has(c.id)),
    removed: [...s.removed, batch],
    excluded: [...new Set([...s.excluded, ...batch.map((c) => c.id)])],
    result: null,
  });
}

/** 마지막으로 뺀 묶음을 되살린다. */
export function undoErase(): void {
  const s = useDraftStore.getState();
  const batch = s.removed[s.removed.length - 1];
  if (!batch) return;
  const back = new Set(batch.map((c) => c.id));
  s.set({
    customers: [...s.customers, ...batch],
    removed: s.removed.slice(0, -1),
    excluded: s.excluded.filter((id) => !back.has(id)),
    result: null,
  });
}

/** 직접 뺀 수용가를 모두 되살린다. */
export function restoreErased(): void {
  const s = useDraftStore.getState();
  const present = new Set(s.customers.map((c) => c.id));
  const back = s.removed.flat().filter((c) => !present.has(c.id));
  s.set({ customers: [...s.customers, ...back], removed: [], excluded: [], result: null });
}

/** 네모 범위를 지우고 다시 지도 화면 전체를 쓴다. */
export function clearDraftArea(): void {
  useDraftStore.getState().set({ area: null });
}

export function pickDraftSource(): void {
  useUIStore.getState().setPointPick({
    label: useDraftStore.getState().mode === 'water' ? '수원(배수지·급수 접속점) 위치' : '방류구(처리장·간선 접속점) 위치',
    returnTo: 'draft',
    onPick: (p) => useDraftStore.getState().set({ source: p, sourceAuto: false, result: null }),
  });
}

/** 도로·지형을 받아 초안을 만든다. 수원을 안 고르면 상수는 가장 높은 수용가, 하수는 가장 낮은 수용가 근처로 정한다. */
export async function generateDraft(): Promise<void> {
  const store = useDraftStore.getState();
  const { mode, maxServiceDistance, maxPipeLength } = store;
  let { customers } = store;
  if (customers.length === 0 || store.busy) return;
  const warnings: string[] = [];
  store.set({ busy: '준비 중…', error: null, result: null, alreadyServed: 0 });
  try {
    // 보완 모드: 지금 열린 상수 관망에 비어 있는 곳만 잇는다
    let seeds: { id: string; position: LngLat }[] | undefined;
    const reach: LngLat[] = [];
    if (store.build === 'fill') {
      if (mode !== 'water') throw new Error('보완 모드는 지금 상수관망에만 쓸 수 있습니다. 하수는 신규로 만든 뒤 하수 설계에서 다루세요.');
      const model = useNetworkStore.getState().model;
      const nodes = Object.values(model.nodes);
      if (nodes.length === 0) throw new Error('보완하려면 먼저 기존 관망(.inp 등)을 여세요.');
      // 기존 관로에서 servedDistance 안의 수용가는 이미 공급 중으로 보고 뺀다
      const P = plane(nodes[0].position);
      const pipes = new RoadGraph(Math.max(store.servedDistance, 20));
      for (const l of Object.values(model.links)) {
        let prev = -1;
        for (const p of linkPath(model, l)) {
          const v = pipes.vertex(P.to(p));
          if (prev >= 0) pipes.addSegment(prev, v);
          prev = v;
        }
      }
      const before = customers.length;
      customers = customers.filter((c) => !pipes.nearest(P.to(c.position), store.servedDistance));
      store.set({ alreadyServed: before - customers.length });
      warnings.push(`기존 관로 ${store.servedDistance} m 안의 수용가 ${before - customers.length}곳은 이미 공급 중으로 보고 뺐습니다.`);
      if (customers.length === 0) throw new Error(`모든 수용가가 기존 관로 ${store.servedDistance} m 안에 있습니다. 보완할 곳이 없습니다.`);
      seeds = nodes.map((n) => ({ id: n.id, position: n.position }));
      // 도로 자료 영역에 가장 가까운 기존 관로 지점도 넣는다 (기존 관망이 수용가에서 멀리 있어도 이을 수 있게)
      for (const c of customers) {
        const near = pipes.nearest(P.to(c.position), 2000);
        if (near) reach.push(P.from(near.q));
      }
    }
    // 자동으로 정한 위치는 매번 다시 정한다 (상수↔하수를 바꾸면 기준이 반대)
    let source = store.sourceAuto ? null : store.source;
    if (seeds) source = customers[0].position; // 보완은 수원 대신 기존 관망에서 키운다 (도로 영역 기준점으로만 씀)
    if (!source) {
      store.set({ busy: '수원 위치를 정하려고 수용가 지반고를 읽는 중…' });
      const z = await sampleTerrainTiles(customers.map((c) => c.position));
      let k = 0;
      for (let i = 1; i < z.length; i++) if (mode === 'water' ? z[i] > z[k] : z[i] < z[k]) k = i;
      source = customers[k].position;
      warnings.push(`${mode === 'water' ? '수원' : '방류구'} 위치를 지정하지 않아 ${mode === 'water' ? '가장 높은' : '가장 낮은'} 수용가(${customers[k].id}, 지반고 ${z[k].toFixed(1)} m) 근처로 정했습니다.`);
      useDraftStore.getState().set({ source, sourceAuto: true });
    }
    const box = bboxOf([...customers.map((c) => c.position), source, ...reach])!;
    const padLat = 400 / 110540;
    const padLng = 400 / (111320 * Math.cos((box[1] * Math.PI) / 180));
    store.set({ busy: '도로 자료 받는 중…' });
    const roads = await fetchRoads(box[1] - padLat, box[0] - padLng, box[3] + padLat, box[2] + padLng);
    if (roads.length === 0) throw new Error('이 영역의 도로 자료가 없습니다.');
    const roadSource = lastRoadSource();
    if (roadSource) warnings.push(`도로 자료: ${ROAD_SOURCE_LABEL[roadSource]}${roadSource === 'osm' ? ' (브이월드에 연결하지 못했거나 인증키가 없음 — 빠진 골목이 있을 수 있습니다)' : ''}.`);
    const options = { ...defaultDraftOptions(mode, source), maxServiceDistance, maxPipeLength, seeds };
    const prepared = prepareRoads(roads, source, options.spacing);
    let ground: number[] | undefined;
    try {
      store.set({ busy: `지반고 읽는 중 (도로 점 ${prepared.vertices.length.toLocaleString()}개)…` });
      ground = await sampleTerrainTiles(prepared.vertices, (d, t) => useDraftStore.getState().set({ busy: `지형 타일 ${d}/${t}…` }));
    } catch {
      warnings.push('지형 자료를 받지 못해 지반고 없이 만들었습니다(표고 0). 나중에 ‘도로 따라 관로 맞추기 · 표고 보정’으로 표고를 넣으세요.');
    }
    store.set({ busy: '관망 경로 계산 중…' });
    await new Promise((r) => setTimeout(r, 0));
    const result = buildDraft(prepared, customers, options, ground);
    if (result.unserved.length > 0) warnings.push(`연결하지 못한 수용가 ${result.unserved.length}곳 (지도의 빨간 점): ${result.unserved.slice(0, 5).map((u) => `${u.id} ${u.reason}`).join(', ')}${result.unserved.length > 5 ? ' …' : ''}`);
    useDraftStore.getState().set({ result, warnings, overlay: true });
  } catch (e) {
    useDraftStore.getState().set({ error: errorText(e), warnings });
  } finally {
    useDraftStore.getState().set({ busy: null });
  }
}

export function adoptWaterDraft(): void {
  const s = useDraftStore.getState();
  if (!s.result) return;
  const existing = Object.keys(useNetworkStore.getState().model.nodes).length;
  if (existing > 0 && !window.confirm(`지금 열린 관망(절점 ${existing}개)을 닫고 초안을 엽니다. 저장하지 않은 작업은 자동 백업에만 남습니다. 계속할까요?`)) return;
  const name = baseName(s.fileName || '수용가') + '_관망초안';
  const model = draftToWaterModel(s.result, s.water, name);
  s.set({ overlay: false });
  adoptModel(model, `${name}.inp`, 'WGS84 (초안)', s.warnings);
  useUIStore.getState().openModal(null);
}

/** 보완 모드 결과를 지금 관망에 더한다 (실행 취소 가능). */
export function addFillToNetwork(): void {
  const s = useDraftStore.getState();
  if (!s.result) return;
  let report: ReturnType<typeof addDraftToWaterModel> | null = null;
  useNetworkStore.getState().commit((draft) => {
    report = addDraftToWaterModel(draft, s.result!, s.water);
  });
  s.set({ overlay: false, result: null });
  useUIStore.getState().openModal(null);
  const r = report as ReturnType<typeof addDraftToWaterModel> | null;
  useUIStore.getState().pushToast({
    level: 'success',
    title: `관망 보완 — 절점 ${r?.junctions ?? 0}개 · 관 ${r?.pipes ?? 0}개 추가`,
    message: `기존 절점 ${r?.connectedTo.length ?? 0}곳에 이었습니다${r && r.demandAddedTo.length > 0 ? `, 접속 절점 ${r.demandAddedTo.length}곳에 수요를 더했습니다` : ''}. Ctrl+Z 로 되돌릴 수 있습니다. 관경·연결은 검토하세요.`,
  });
}

export function sendSewerDraft(): void {
  const s = useDraftStore.getState();
  if (!s.result) return;
  const draft = draftToSewerProject(s.result, s.sewer, `${baseName(s.fileName || '수용가')} 하수 초안`.slice(0, 60));
  // 방류구 깊이를 설계에 맞춘다 (얕게 고정하면 마지막 관이 역경사·만관이 된다)
  const { project } = fitOutfallInverts(draft, useSewerStore.getState().designMode, useSewerStore.getState().designRules);
  useSewerStore.getState().setProject(project);
  useSewerStore.getState().select(null);
  s.set({ overlay: false });
  const ui = useUIStore.getState();
  if (ui.domain === 'sewer') {
    // 하수 모드: 대화상자 대신 지도에 편집 가능한 관망으로 올린다
    ui.openModal(null);
    ui.setTool('select');
    const box = bboxOf(nodePositions(project).values());
    if (box) ui.fitBounds(box);
    ui.pushToast({
      level: 'success',
      title: '하수 관망 초안을 지도에 올렸습니다',
      message: `맨홀 ${project.nodes.length - 1}개 · 관로 ${project.conduits.length}개. 지도에서 고치고 ‘설계·해석 실행’(F5)을 누르세요. Ctrl+Z 로 이전 관망으로 되돌릴 수 있습니다.`,
    });
    return;
  }
  ui.openModal('sewer');
  ui.pushToast({
    level: 'success',
    title: '하수 설계로 보냈습니다',
    message: `맨홀 ${project.nodes.length - 1}개 · 관로 ${project.conduits.length}개. ‘설계 결과’ 탭에서 ① 자동 설계를 누르세요.`,
  });
}

/* ------------------------------------------------------------------ 용도지역 분담유량 */

function ringsOf(g: Geometry | null): number[][][][] {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

export async function loadParcelFiles(files: File[]): Promise<void> {
  const store = useDraftStore.getState();
  try {
    let collection: FeatureCollection;
    let declared: string | null = null;
    const geo = files.find((f) => /\.(geo)?json$/i.test(f.name));
    if (geo) collection = JSON.parse(await geo.text()) as FeatureCollection;
    else {
      const set = await loadShapefiles(await Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))));
      collection = set.collection;
      declared = set.crs;
    }
    const polys: { id: string; props: Record<string, unknown>; raw: number[][][] }[] = [];
    collection.features.forEach((f: Feature, i) => {
      ringsOf(f.geometry).forEach((rings, k) => polys.push({ id: String(f.id ?? f.properties?.id ?? i + 1) + (k > 0 ? `-${k + 1}` : ''), props: f.properties ?? {}, raw: rings }));
    });
    if (polys.length === 0) throw new Error('면(폴리곤) 도형이 없습니다. 용도지역·토지이용계획 면 레이어를 넣어 주세요.');
    const sample = polys.flatMap((p) => p.raw[0].slice(0, 3).map((c) => [c[0], c[1]] as [number, number]));
    const code = declared && (declared === 'wgs84' || declared in CRS_DEFS) ? declared : detectCrs(sample);
    if (code === 'local') throw new Error('좌표계를 알 수 없습니다. .prj 파일을 함께 넣어 주세요.');
    const crs: SourceCrs = code === 'wgs84' ? { kind: 'wgs84' } : { kind: 'epsg', code };
    const parcelsRaw = polys.map((p) => ({ id: p.id, props: p.props, rings: p.raw.map((r) => r.map((c) => toWgs84(crs, [c[0], c[1]]) as LngLat)) }));
    const keys = [...new Set(polys.flatMap((p) => Object.keys(p.props)))];
    const guess = keys.find((k) => /용도|uname|use|zone|landuse|토지|지목|dgm_nm|prpos/i.test(k)) ?? keys[0] ?? '';
    store.set({ parcelsRaw, parcelFile: files.map((f) => f.name).join(', '), parcelKeys: keys, allocation: null, error: null });
    setUseKey(guess);
  } catch (e) {
    store.set({ error: errorText(e) });
  }
}

/** 용도 열을 고르면 용도 목록으로 원단위 표를 만든다 (이미 넣은 값은 유지). */
export function setUseKey(useKey: string): void {
  const store = useDraftStore.getState();
  store.set({ useKey, allocation: null });
  const uses = [...new Set(parcelsOf(useDraftStore.getState()).map((p) => p.use))].sort((a, b) => a.localeCompare(b, 'ko'));
  const rates: Record<string, number> = {};
  for (const u of uses) rates[u] = store.rates[u] ?? 0;
  store.set({ rates });
}

export function previewAllocation(): void {
  const s = useDraftStore.getState();
  const ui = useUIStore.getState();
  const model = useNetworkStore.getState().model;
  const scope = ui.multiSelection?.nodeIds.length ? ui.multiSelection.nodeIds : undefined;
  try {
    const allocation = allocateDemand(model, parcelsOf(s), s.rates, { maxConnectDistance: s.maxConnectDistance, nodeIds: scope });
    s.set({ allocation, error: null });
  } catch (e) {
    s.set({ error: errorText(e) });
  }
}

/** 분담유량을 절점 기본 수요량에 넣는다 (replace: 대상 절점 수요를 덮어씀 / add: 더함). 실행 취소 가능. */
export function applyAllocation(mode: 'replace' | 'add'): void {
  const s = useDraftStore.getState();
  if (!s.allocation) return;
  const units = useNetworkStore.getState().model.options.flowUnits;
  const per = s.allocation.perNode;
  useNetworkStore.getState().commit((draft) => {
    for (const [id, m3d] of Object.entries(per)) {
      const node = draft.nodes[id];
      if (node?.type !== 'junction') continue;
      const v = Math.round(m3dToFlowUnits(m3d, units) * 10000) / 10000;
      node.demand = mode === 'add' ? node.demand + v : v;
    }
  });
  useUIStore.getState().pushToast({
    level: 'success',
    title: `분담유량 반영 — 절점 ${Object.keys(per).length}개`,
    message: `합계 ${s.allocation.totalFlow.toFixed(1)} m³/일 (${m3dToFlowUnits(s.allocation.totalFlow, units).toFixed(2)} ${units}). Ctrl+Z 로 되돌릴 수 있습니다.`,
  });
}

export function exportAllocationCsv(): void {
  const s = useDraftStore.getState();
  if (!s.allocation) return;
  downloadText(`${baseName(useNetworkStore.getState().fileName ?? '관망')}_분담유량산출표.csv`, allocationCsv(s.allocation, useNetworkStore.getState().model.options.flowUnits), 'text/csv;charset=utf-8');
}

/* ------------------------------------------------------------------ 관망 정리 도구 */

function scopeIds(kind: 'node' | 'link'): string[] | undefined {
  const multi = useUIStore.getState().multiSelection;
  if (!multi) return undefined;
  const ids = kind === 'node' ? multi.nodeIds : multi.linkIds;
  return ids.length > 0 ? ids : undefined;
}

function report(title: string, n: number, none: string): void {
  useUIStore.getState().pushToast({ level: n > 0 ? 'success' : 'info', title: n > 0 ? `${title} ${n}건` : none, message: n > 0 ? 'Ctrl+Z 로 되돌릴 수 있습니다.' : undefined });
}

export function runMergeNearby(tol: number): void {
  let n = 0;
  useNetworkStore.getState().commit((draft) => {
    n = mergeNearbyNodes(draft, tol, scopeIds('node'));
  });
  report('가까운 절점 병합', n, `${tol} m 안에 겹친 절점이 없습니다`);
}

export function runMergeSeries(): void {
  let n = 0;
  useNetworkStore.getState().commit((draft) => {
    n = mergeSeriesPipes(draft, scopeIds('node'));
  });
  report('직렬 관로 병합', n, '합칠 수 있는 관로가 없습니다 (수요 0 절점에 같은 제원 관 2개)');
}

export function runRenumber(kind: 'node' | 'link', o: RenumberOptions, typeFilter: string): void {
  const model = useNetworkStore.getState().model;
  const pool = kind === 'node' ? model.nodes : model.links;
  const ids = (scopeIds(kind) ?? Object.keys(pool)).filter((id) => typeFilter === 'all' || pool[id]?.type === typeFilter);
  let n = 0;
  useNetworkStore.getState().commit((draft) => {
    n = renumber(draft, kind, ids, o);
  });
  if (n < 0) useUIStore.getState().pushToast({ level: 'error', title: 'ID 를 바꾸지 못했습니다', message: '새 이름이 대상이 아닌 다른 객체와 겹치거나 형식이 맞지 않습니다. 접두어·시작 번호를 바꿔 보세요.' });
  else report('ID 재부여', n, '대상 객체가 없습니다');
  useUIStore.getState().select(null);
}

/* ------------------------------------------------------------------ 자동 백업 */

export async function restoreBackup(): Promise<void> {
  const b = await readBackup();
  if (!b) {
    useUIStore.getState().pushToast({ level: 'info', title: '복원할 백업이 없습니다' });
    return;
  }
  adoptModel(b.model, b.fileName ?? '복원된 관망', '백업', []);
  fitToNetwork();
}

/* ------------------------------------------------------------------ 도로 중심선 직접 넣기 */

/** 도로 중심선 파일(.shp/.zip/.geojson)을 읽어 공개 도로 서버 대신 쓴다. */
export async function loadRoadFiles(files: File[]): Promise<void> {
  const store = useDraftStore.getState();
  try {
    let collection: FeatureCollection;
    let declared: string | null = null;
    const geo = files.find((f) => /\.(geo)?json$/i.test(f.name));
    if (geo) collection = JSON.parse(await geo.text()) as FeatureCollection;
    else {
      const set = await loadShapefiles(await Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))));
      collection = set.collection;
      declared = set.crs;
    }
    const lines: number[][][] = [];
    for (const f of collection.features) {
      const g = f.geometry;
      if (g?.type === 'LineString') lines.push(g.coordinates);
      else if (g?.type === 'MultiLineString') lines.push(...g.coordinates);
    }
    if (lines.length === 0) throw new Error('선(도로 중심선) 도형이 없습니다.');
    const sample = lines.slice(0, 50).flatMap((l) => l.slice(0, 2).map((c) => [c[0], c[1]] as [number, number]));
    const code = declared && (declared === 'wgs84' || declared in CRS_DEFS) ? declared : detectCrs(sample);
    if (code === 'local') throw new Error('도로 자료의 좌표계를 알 수 없습니다. .prj 파일을 함께 넣어 주세요.');
    const crs: SourceCrs = code === 'wgs84' ? { kind: 'wgs84' } : { kind: 'epsg', code };
    // 교차점에 공통 점이 없는 자료가 많아 교차점·T자 접속점을 넣어 도로망을 잇는다
    const roads = nodeRoads(lines.map((l) => l.map((c) => toWgs84(crs, [c[0], c[1]]) as LngLat)));
    const name = files.map((f) => f.name).join(', ');
    setUserRoads(roads, name);
    store.set({ roadFile: `${name} · 선 ${roads.length.toLocaleString()}개`, error: null, result: null });
  } catch (e) {
    store.set({ error: errorText(e) });
  }
}

export function clearRoadFiles(): void {
  setUserRoads(null);
  useDraftStore.getState().set({ roadFile: '', result: null });
}
