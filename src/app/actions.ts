/**
 * 여러 스토어에 걸친 상위 동작(파일 입출력, 해석 실행, 관망 검증).
 * 컴포넌트는 이 함수들을 호출하고, 각 스토어는 자기 상태만 관리한다.
 */
import { describeEngineError, describeEngineWarning, extractObjectIds, extractReportErrors } from '../core/engine/errorMessages';
import {
  negativePressureNodes,
  SimulationError,
  simulationManager,
  type SimulationResults,
} from '../core/engine/simulationManager';
import { parseInp } from '../core/io/inpParser';
import { networkDxf, networkShapefileZip, type ExportCrs } from '../core/io/gisExport';
import { linkColumns, linkRows, nodeColumns, nodeRows, tableToCsv } from '../core/engine/resultsExport';
import { writeInp } from '../core/io/inpWriter';
import { loadShapefiles } from '../core/io/loadShapefiles';
import { looksLikeSewerGis, openSewerGisFiles } from './sewerGisImport';
import { fetchOsmRoads } from './osmRoads';
import { looksLikeSwmm, readSwmmInp, swmmErrorHint, withRouting } from '../core/swmm/inpReader';
import { nodeValue } from '../core/swmm/outReader';
import { SWMM_CANCELLED, SwmmFailure, swmmManager } from '../core/swmm/swmmManager';
import { useSwmmStore } from '../store/useSwmmStore';
import { exportGeoJson, importGeoJson } from '../core/io/shapefileImporter';
import { deleteLink, deleteNodes, linkPath } from '../core/model/networkEdit';
import { estimateRoadShift, roadFitScore, shiftLngLat } from '../core/model/roadAlign';
import { bfs, buildGraph } from '../core/model/networkGraph';
import { isNodeSource, type LngLat, type NetworkModel, type SourceCrs } from '../core/model/types';
import { formatClock, isUsUnits, qualityLabel, qualityUnit } from '../core/model/units';
import { ISSUE_TYPE_LABELS, type ValidationIssue } from '../core/validation';
import { applyAutoFix, totalFixes, type AutoFixReport, type AutoFixSelection } from '../core/validation/autoFix';
import { runValidationAsync } from '../core/validation/validationRunner';
import { useNetworkStore } from '../store/useNetworkStore';
import { useSimulationStore, type LogEntry } from '../store/useSimulationStore';
import { useUIStore, type Highlight } from '../store/useUIStore';
import { useValidationStore } from '../store/useValidationStore';
import { baseName, decodeText, downloadText } from '../utils/files';
import { bboxOf, CRS_DEFS, distanceMeters, fromWgs84, toWgs84, type ImportCrsChoice } from '../utils/geoMath';

function networkPoints(model: NetworkModel): LngLat[] {
  const points: LngLat[] = [];
  for (const id in model.nodes) points.push(model.nodes[id].position);
  for (const id in model.links) for (const v of model.links[id].vertices) points.push(v);
  return points;
}

export function fitToNetwork(): void {
  const box = bboxOf(networkPoints(useNetworkStore.getState().model));
  if (box) useUIStore.getState().fitBounds(box);
}

/** 지정한 객체들을 강조하고 그 범위로 지도를 이동한다 (토스트의 '문제 위치 보기'). */
export function focusObjects(highlight: Highlight): void {
  const ui = useUIStore.getState();
  const { model } = useNetworkStore.getState();
  ui.setHighlight(highlight);
  const positions: LngLat[] = [];
  for (const id of highlight.nodeIds) {
    const node = model.nodes[id];
    if (node) positions.push(node.position);
  }
  for (const id of highlight.linkIds) {
    const link = model.links[id];
    if (!link) continue;
    const a = model.nodes[link.startNodeId];
    const b = model.nodes[link.endNodeId];
    if (a) positions.push(a.position);
    if (b) positions.push(b.position);
  }
  const box = bboxOf(positions);
  if (box) ui.fitBounds(box);
}

/* ------------------------------------------------------------------ 성과품 내보내기 */

function exportBase(): string {
  const { fileName, model } = useNetworkStore.getState();
  return baseName(fileName ?? model.title[0] ?? 'network') || 'network';
}

/** Shapefile(.zip: nodes·links). 해석 결과가 있으면 지금 시각의 수압·유량·유속을 속성으로 넣는다. */
export function exportShapefile(crs: ExportCrs): void {
  const { model } = useNetworkStore.getState();
  const sim = useSimulationStore.getState();
  if (Object.keys(model.nodes).length === 0) return;
  const zip = networkShapefileZip(model, sim.results, sim.stepIndex, crs);
  downloadText(`${exportBase()}_${crs === 'wgs84' ? 'WGS84' : '5186'}.zip`, zip, 'application/zip');
  useUIStore.getState().pushToast({
    level: 'success',
    title: 'Shapefile 내보내기 완료',
    message: `nodes·links 레이어 · 좌표계 ${crs === 'wgs84' ? 'WGS84 경위도' : 'EPSG:5186 중부원점'}${sim.results ? ` · 해석 결과 ${formatClock(sim.results.times[sim.stepIndex] ?? 0)} 값 포함` : ''}`,
  });
}

export function exportDxf(): void {
  const { model } = useNetworkStore.getState();
  if (Object.keys(model.nodes).length === 0) return;
  downloadText(`${exportBase()}_5186.dxf`, networkDxf(model), 'application/dxf');
}

/** 결과 표(지금 시각, 절점·링크) CSV 두 개. */
export function exportResultTables(): void {
  const { model } = useNetworkStore.getState();
  const { results, stepIndex } = useSimulationStore.getState();
  if (!results) {
    useUIStore.getState().pushToast({ level: 'info', title: '먼저 해석을 실행하세요' });
    return;
  }
  const t = formatClock(results.times[stepIndex] ?? 0).replace(':', '');
  downloadText(`${exportBase()}_절점_${t}.csv`, tableToCsv(nodeRows(model, results), nodeColumns(model, results, stepIndex)), 'text/csv;charset=utf-8');
  downloadText(`${exportBase()}_링크_${t}.csv`, tableToCsv(linkRows(model, results), linkColumns(model, results, stepIndex)), 'text/csv;charset=utf-8');
}

/* ------------------------------------------------------------------ SWMM (우수·하수) */

/** SWMM .inp 를 열어 우수·하수 보기 모드로 들어간다. 상수관망 작업은 그대로 보존된다. */
export function openSwmmText(text: string, fileName: string): void {
  const project = readSwmmInp(text);
  if (project.nodes.length === 0) throw new Error('좌표가 있는 절점이 없습니다. SWMM [COORDINATES] 섹션을 확인하세요.');
  const ui = useUIStore.getState();
  ui.setTool('select');
  ui.select(null);
  ui.setMultiSelection(null);
  ui.clearToasts();
  useSwmmStore.getState().open(project, fileName);
  const box = bboxOf([...project.nodes.map((n) => n.position), ...project.subcatchments.flatMap((s) => s.polygon)]);
  if (box) ui.fitBounds(box);
  ui.pushToast({
    level: project.warnings.length > 0 ? 'warning' : 'success',
    title: `${fileName} 불러오기 완료 (SWMM)`,
    message: `절점 ${project.nodes.length}개, 링크 ${project.links.length}개, 유역 ${project.subcatchments.length}개 · 좌표계: ${project.crsLabel}`,
    details: project.warnings,
  });
}

export function closeSwmm(): void {
  swmmManager.cancel();
  useSwmmStore.getState().close();
}

export async function runSwmmAnalysis(): Promise<void> {
  const store = useSwmmStore.getState();
  const project = store.project;
  const ui = useUIStore.getState();
  if (!project || store.status === 'running') return;
  store.setRunning();
  try {
    const run = await swmmManager.run(withRouting(project.text, store.routing));
    useSwmmStore.getState().setResult(run);
    const o = run.output;
    // 보고서의 연속방정식 오차(%)와 월류 여부로 결과 신뢰도를 알린다.
    const errors = [...run.report.matchAll(/Continuity Error \(%\)\s*\.+\s*(-?[\d.]+)/g)].map((m) => Math.abs(Number(m[1])));
    const worst = errors.length > 0 ? Math.max(...errors) : 0;
    const flooded = o.nodeIds.filter((_, i) => {
      for (let t = 0; t < o.periods; t++) if (nodeValue(o, 'flooding', t, i) > 0) return true;
      return false;
    });
    if (flooded.length > 0) {
      ui.pushToast({ level: 'warning', title: `월류 발생 — 절점 ${flooded.length}개`, message: flooded.slice(0, 12).join(', ') + (flooded.length > 12 ? ' …' : '') });
    } else if (worst > 5) {
      ui.pushToast({ level: 'warning', title: `연속방정식 오차 ${worst.toFixed(1)}%`, message: '5% 를 넘으면 계산 간격을 줄이거나 입력을 확인하세요. 해석 보고서 탭을 보세요.' });
    } else {
      ui.pushToast({ level: 'success', title: `SWMM ${run.engineVersion} 해석 완료`, message: `${o.periods}개 시간 스텝 · ${Math.round(run.elapsedMs)} ms · 연속방정식 오차 ${worst.toFixed(2)}%` });
    }
  } catch (error) {
    if (error instanceof SwmmFailure && error.message === SWMM_CANCELLED) return;
    const message = error instanceof Error ? error.message : String(error);
    const report = error instanceof SwmmFailure ? error.report : '';
    useSwmmStore.getState().setError({ message, report });
    useSwmmStore.getState().setBottomTab('report');
    const hint = swmmErrorHint(error instanceof SwmmFailure ? error.code : null);
    ui.pushToast({ level: 'error', title: 'SWMM 해석에 실패했습니다', message, details: hint ? [hint] : [] });
  }
}

function resetWorkspaceState(): void {
  closeSwmm();
  simulationManager.cancel();
  useSimulationStore.getState().clear();
  useValidationStore.getState().clear();
  const ui = useUIStore.getState();
  ui.setTool('select');
  ui.select(null);
  ui.setHighlight(null);
  ui.setMultiSelection(null);
  ui.setProfileWaypoints([]);
  // 이전 관망에 대한 오류·경고 알림이 새 관망 위에 남지 않게 한다.
  ui.clearToasts();
}

/** 새 관망 모델을 작업 화면에 연다 (이전 결과·선택·알림 정리 후). */
export function adoptModel(model: NetworkModel, fileName: string, crsLabel: string, warnings: string[]): void {
  resetWorkspaceState();
  useNetworkStore.getState().loadModel(model, fileName);
  fitToNetwork();
  const nodeCount = Object.keys(model.nodes).length;
  const linkCount = Object.keys(model.links).length;
  const ui = useUIStore.getState();
  ui.pushToast({
    level: warnings.length > 0 ? 'warning' : 'success',
    title: `${fileName} 불러오기 완료`,
    message: `절점 ${nodeCount.toLocaleString()}개, 링크 ${linkCount.toLocaleString()}개 · 좌표계: ${crsLabel}`,
    details: warnings,
  });
}

/**
 * 지금 열려 있는 관망의 원본 좌표계를 바꿔 위치를 다시 계산한다 (파일을 다시 열 필요 없음, Undo 가능).
 * 자동 감지가 틀렸을 때 쓴다. 예: 구 중부원점(EPSG:5174)과 5186 은 좌표 범위가 같아 남북으로 약 100 km 어긋난다.
 */
export function reprojectModel(choice: string): boolean {
  const { model } = useNetworkStore.getState();
  const next: SourceCrs = choice === 'wgs84' ? { kind: 'wgs84' } : { kind: 'epsg', code: choice };
  if (model.crs.kind === 'local') {
    useUIStore.getState().pushToast({ level: 'warning', title: '좌표계를 바꿀 수 없습니다', message: '임의 평면 좌표로 배치된 관망은 원본 좌표를 알 수 없어 파일을 다시 열어야 합니다.' });
    return false;
  }
  const old = model.crs;
  const move = (p: LngLat): LngLat => toWgs84(next, fromWgs84(old, p));
  useNetworkStore.getState().commit((draft) => {
    for (const id in draft.nodes) draft.nodes[id].position = move(draft.nodes[id].position);
    for (const id in draft.links) draft.links[id].vertices = draft.links[id].vertices.map(move);
    draft.crs = next;
  });
  fitToNetwork();
  return true;
}

/* ------------------------------------------------------------------ 도로 기준 위치 보정 */

/** 지금 화면 위치(경위도)를 좌표계 code 로 다시 해석한 위치. 같은 파일 좌표를 다른 좌표계로 읽은 결과다. */
function reinterpret(model: NetworkModel, code: string): (p: LngLat) => LngLat {
  const base: SourceCrs = { ...model.crs };
  const target: SourceCrs = { kind: 'epsg', code };
  return (p) => toWgs84(target, fromWgs84(base, p));
}

let aligning = false;

/**
 * 관로는 도로 밑에 있다고 보고 관망 위치를 도로에 맞춘다.
 * 1) 좌표 범위가 같아 헷갈리는 좌표계들(예: 5174·5181·2097 — 서로 수백 m 차이)로 다시 읽어 보고 도로와 가장 잘 맞는 좌표계를 고른다.
 * 2) 그래도 남는 평행 밀림이 있으면 이동량을 찾아 crs.shift 로 저장한다 (.inp 로 내보내면 원본 좌표가 그대로 나간다).
 * 한 번의 Undo(Ctrl+Z)로 되돌릴 수 있다.
 */
export async function alignNetworkToRoads(): Promise<void> {
  const ui = useUIStore.getState();
  const { model } = useNetworkStore.getState();
  if (aligning) return;
  const paths: LngLat[][] = [];
  for (const id in model.links) {
    const path = linkPath(model, model.links[id]);
    if (path.length >= 2) paths.push(path);
  }
  if (paths.length < 3) {
    ui.pushToast({ level: 'warning', title: '보정할 관망이 없습니다', message: '관로가 3개 이상 있어야 도로와 맞춰 볼 수 있습니다.' });
    return;
  }

  // 좌표계 후보: 지금 위치에서 3 km 이내로 옮겨지는 좌표계만 (멀리 가는 좌표계는 이미 틀린 것으로 본다)
  const centroid = paths.flat().reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]).map((v) => v / paths.flat().length) as LngLat;
  const candidates: { code: string | null; paths: LngLat[][] }[] = [{ code: null, paths }];
  if (model.crs.kind === 'epsg') {
    for (const code of Object.keys(CRS_DEFS)) {
      if (code === model.crs.code) continue;
      const move = reinterpret(model, code);
      if (distanceMeters(move(centroid), centroid) > 3000) continue;
      candidates.push({ code, paths: paths.map((p) => p.map(move)) });
    }
  }
  const box = bboxOf(candidates.flatMap((c) => c.paths.flat()));
  if (!box) return;
  const [w, s, e, n] = box;
  const pad = 0.004; // 약 400 m — 남은 밀림만큼의 도로도 들어오게

  aligning = true;
  const pending = ui.pushToast({ level: 'info', title: '도로 데이터를 가져오는 중…', message: 'OpenStreetMap 도로 중심선과 관로 위치를 비교합니다 (수 초~수십 초).' });
  try {
    const roads = await fetchOsmRoads(s - pad, w - pad, n + pad, e + pad);
    if (roads.length < 5) throw new Error('이 지역의 도로 데이터가 너무 적어 비교할 수 없습니다.');

    // 1) 좌표계 후보 비교 (이동 없이 일치도만)
    const scored = candidates
      .map((c) => ({ ...c, fit: roadFitScore(c.paths, roads) }))
      .filter((c): c is typeof c & { fit: { mean: number; matched: number } } => c.fit !== null)
      .sort((a, b) => a.fit.mean - b.fit.mean);
    if (scored.length === 0) throw new Error('비교할 표본을 만들지 못했습니다.');
    const original = scored.find((c) => c.code === null)!;
    // 좌표계를 바꾸려면 확실히(평균 거리 30% 이상) 나아야 한다
    const best = scored[0].code !== null && scored[0].fit.mean < original.fit.mean * 0.7 ? scored[0] : original;

    // 2) 남은 평행 밀림
    const residual = estimateRoadShift(best.paths, roads);
    useUIStore.getState().dismissToast(pending);
    const shiftUseful = residual !== null && Math.hypot(residual.dx, residual.dy) >= 2 && residual.after < residual.before * 0.8;
    const finalMean = shiftUseful ? residual.after : best.fit.mean;
    const finalMatched = shiftUseful ? residual.matchedAfter : best.fit.matched;

    if (best.code === null && !shiftUseful) {
      ui.pushToast({
        level: 'info',
        title: '이미 도로와 잘 맞습니다',
        message: `도로까지 평균 거리 ${original.fit.mean.toFixed(1)} m, 도로 15 m 이내 관로 ${Math.round(original.fit.matched * 100)}%. 관망 전체를 옮길 필요는 없습니다.`,
        details: ['절점·관로를 하나하나 도로 위로 붙이려면 ‘② 도로 따라 관로 맞추기’를 쓰세요.'],
      });
      return;
    }

    const crsCode = best.code;
    useNetworkStore.getState().commit((draft) => {
      if (crsCode) {
        const move = reinterpret(draft as NetworkModel, crsCode);
        for (const id in draft.nodes) draft.nodes[id].position = move(draft.nodes[id].position);
        for (const id in draft.links) draft.links[id].vertices = draft.links[id].vertices.map(move);
        draft.crs = { kind: 'epsg', code: crsCode };
      }
      if (shiftUseful) {
        for (const id in draft.nodes) draft.nodes[id].position = shiftLngLat(draft.nodes[id].position, residual.dx, residual.dy);
        for (const id in draft.links) draft.links[id].vertices = draft.links[id].vertices.map((p) => shiftLngLat(p, residual.dx, residual.dy));
        const prev = draft.crs.shift ?? [0, 0];
        draft.crs.shift = [Math.round((prev[0] + residual.dx) * 10) / 10, Math.round((prev[1] + residual.dy) * 10) / 10];
      }
    });
    if (crsCode) useUIStore.getState().setImportCrs(crsCode as ImportCrsChoice);

    const parts: string[] = [];
    if (crsCode) parts.push(`좌표계를 ${CRS_DEFS[crsCode]?.label ?? crsCode} 로 바꿈`);
    if (shiftUseful) parts.push(`${residual.dx >= 0 ? '동' : '서'} ${Math.abs(residual.dx).toFixed(0)} m, ${residual.dy >= 0 ? '북' : '남'} ${Math.abs(residual.dy).toFixed(0)} m 이동`);
    ui.pushToast({
      level: 'success',
      title: '도로에 맞춰 관망 위치를 보정했습니다',
      message: `${parts.join(' · ')}. 도로까지 평균 거리 ${original.fit.mean.toFixed(1)} m → ${finalMean.toFixed(1)} m, 도로 15 m 이내 관로 ${Math.round(original.fit.matched * 100)}% → ${Math.round(finalMatched * 100)}%`,
      details: [
        ...(crsCode ? ['같은 파일을 열 때 좌측 ‘가져오기 좌표계’를 이 좌표계로 두면 처음부터 맞게 열립니다 (지금 그렇게 바꿔 두었습니다).'] : []),
        '평행 이동·좌표계 선택만 합니다(회전·축척 보정 없음). .inp 로 내보내면 원본 좌표가 그대로 저장됩니다. 되돌리려면 Ctrl+Z.',
      ],
    });
  } catch (error) {
    useUIStore.getState().dismissToast(pending);
    ui.pushToast({ level: 'error', title: '도로 기준 보정에 실패했습니다', message: error instanceof Error ? error.message : String(error) });
  } finally {
    aligning = false;
  }
}

export function newProject(): void {
  resetWorkspaceState();
  useNetworkStore.getState().newProject();
}

const SHAPEFILE_PARTS = /\.(shp|dbf|prj|cpg|shx|zip)$/i;

/**
 * 여러 파일을 한꺼번에 받을 때: Shapefile 구성 파일(.shp/.dbf/.prj/.cpg)이나 .zip 이 있으면 묶어서 한 관망으로,
 * 아니면 첫 파일만 연다.
 */
export async function importFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  if (files.some((f) => /\.(shp|zip)$/i.test(f.name))) {
    await importShapefiles(files.filter((f) => SHAPEFILE_PARTS.test(f.name)));
    return;
  }
  await importFile(files[0]);
}

async function importShapefiles(files: File[]): Promise<void> {
  const ui = useUIStore.getState();
  const label = files.length === 1 ? files[0].name : `${baseName(files.find((f) => /\.(shp|zip)$/i.test(f.name))?.name ?? 'shapefile')} 외 ${files.length - 1}개`;
  try {
    const set = await loadShapefiles(await Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))));
    if (looksLikeSewerGis(set.collection.features)) {
      // 하수도 GIS(관거·맨홀) 자료면 하수 관망 가져오기로 넘긴다
      await openSewerGisFiles(files);
      return;
    }
    const choice = ui.importCrs;
    // 좌측 패널에서 좌표계를 직접 고른 경우(.prj 보다 우선)
    const declared = choice !== 'auto' && choice !== 'local' ? choice : set.crs;
    const result = importGeoJson(set.collection, { declaredCrs: declared, sourceLabel: 'Shapefile', title: `Shapefile 에서 가져온 관망` });
    adoptModel(result.model, label, result.crsLabel, [`레이어: ${set.layers.join(', ')}`, ...set.warnings, ...result.warnings]);
  } catch (error) {
    ui.pushToast({ level: 'error', title: `${label} 을(를) 불러오지 못했습니다`, message: error instanceof Error ? error.message : String(error) });
  }
}

export async function importFile(file: File): Promise<void> {
  const ui = useUIStore.getState();
  const lower = file.name.toLowerCase();
  try {
    if (lower.endsWith('.inp')) {
      const text = decodeText(await file.arrayBuffer());
      if (looksLikeSwmm(text)) {
        openSwmmText(text, file.name);
        return;
      }
      const result = parseInp(text, { crs: ui.importCrs });
      if (Object.keys(result.model.nodes).length === 0) throw new Error('절점이 하나도 없습니다. EPANET .inp 형식인지 확인하세요.');
      const warnings = [...result.warnings];
      if (ui.importCrs === 'auto' && result.model.crs.kind === 'epsg') {
        warnings.push('좌표계는 좌표 범위로 추정한 값입니다. 지도 위치가 어긋나면(예: 구 중부원점 EPSG:5174 는 5186 과 남북 약 100 km 차이) 좌측 패널 ‘가져오기 좌표계’에서 지정한 뒤 ‘열린 관망에 지금 적용’을 누르세요.');
      }
      adoptModel(result.model, file.name, result.crsLabel, warnings);
    } else if (lower.endsWith('.geojson') || lower.endsWith('.json')) {
      const text = decodeText(await file.arrayBuffer());
      const result = importGeoJson(text);
      adoptModel(result.model, file.name, result.crsLabel, result.warnings);
    } else if (SHAPEFILE_PARTS.test(lower)) {
      if (lower.endsWith('.shp') || lower.endsWith('.zip')) await importShapefiles([file]);
      else ui.pushToast({ level: 'warning', title: '.shp 파일을 함께 선택하세요', message: '.shp · .dbf · .prj 를 함께 고르거나 .zip 으로 묶어 불러옵니다.' });
    } else {
      ui.pushToast({ level: 'error', title: '지원하지 않는 파일 형식입니다', message: '.inp, .geojson, .shp(.dbf/.prj) 또는 .zip 파일을 선택하세요.' });
    }
  } catch (error) {
    ui.pushToast({
      level: 'error',
      title: `${file.name} 을(를) 불러오지 못했습니다`,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function loadSample(file: string): Promise<void> {
  const ui = useUIStore.getState();
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}samples/${file}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = decodeText(await response.arrayBuffer());
    if (looksLikeSwmm(text)) {
      openSwmmText(text, file);
      return;
    }
    const result = parseInp(text);
    adoptModel(result.model, file, result.crsLabel, result.warnings);
  } catch (error) {
    ui.pushToast({ level: 'error', title: '샘플을 불러오지 못했습니다', message: error instanceof Error ? error.message : String(error) });
  }
}

export function exportInp(): void {
  const { model, fileName } = useNetworkStore.getState();
  downloadText(`${baseName(fileName ?? 'network')}.inp`, writeInp(model));
}

export function exportGeoJsonFile(): void {
  const { model, fileName } = useNetworkStore.getState();
  downloadText(`${baseName(fileName ?? 'network')}.geojson`, JSON.stringify(exportGeoJson(model)), 'application/geo+json');
}

/** 다중 선택한 절점(연결 링크 포함)과 링크를 한 번에 삭제한다 (Undo 한 단계). */
export function deleteMultiSelection(): void {
  const ui = useUIStore.getState();
  const multi = ui.multiSelection;
  if (!multi) return;
  useNetworkStore.getState().commit((draft) => {
    for (const id of multi.linkIds) deleteLink(draft, id);
    deleteNodes(draft, multi.nodeIds);
  });
  ui.setMultiSelection(null);
  ui.select(null);
}

/**
 * 검증 오류 항목의 객체들을 다중 선택한다. 단절 관망은 블록 안의 링크까지 함께 고른다.
 * 선택한 뒤 우측 패널에서 일괄 삭제·편집하거나 지도에서 확인한다.
 */
export function selectIssueObjects(issues: ValidationIssue[]): void {
  const { model } = useNetworkStore.getState();
  const nodes = new Set<string>();
  const links = new Set<string>();
  for (const issue of issues) {
    for (const id of issue.nodeIds) if (id in model.nodes) nodes.add(id);
    for (const id of issue.linkIds) if (id in model.links) links.add(id);
  }
  if (issues.some((i) => i.type === 'disconnected')) {
    for (const id in model.links) {
      const link = model.links[id];
      if (nodes.has(link.startNodeId) && nodes.has(link.endNodeId)) links.add(id);
    }
  }
  const ui = useUIStore.getState();
  ui.select(null);
  ui.setMultiSelection({ nodeIds: [...nodes], linkIds: [...links] });
  focusObjects({ nodeIds: [...nodes], linkIds: [...links] });
}

/** 관망 전체를 다중 선택한다. */
export function selectAll(): void {
  const { model } = useNetworkStore.getState();
  const ui = useUIStore.getState();
  ui.setMultiSelection({ nodeIds: Object.keys(model.nodes), linkIds: Object.keys(model.links) });
  ui.select(null);
}

export function deleteSelection(): void {
  const ui = useUIStore.getState();
  if (ui.multiSelection) {
    deleteMultiSelection();
    return;
  }
  const selection = ui.selection;
  if (!selection) return;
  const net = useNetworkStore.getState();
  if (selection.kind === 'node') net.deleteNode(selection.id);
  else net.deleteLink(selection.id);
  ui.select(null);
}

/* ------------------------------------------------------------------ 수리해석 */

/** 닫힌 관로를 지나지 않고는 수원(수원지·배수지)에 닿을 수 없는 절점 ID 목록. */
function findUnsuppliedNodes(model: NetworkModel): string[] {
  const sources: string[] = [];
  for (const id in model.nodes) if (isNodeSource(model.nodes[id])) sources.push(id);
  const reached = bfs(buildGraph(model), sources, (linkId) => {
    const link = model.links[linkId];
    return !(link.type === 'pipe' && link.status === 'Closed');
  });
  const unsupplied: string[] = [];
  for (const id in model.nodes) if (!reached.has(id)) unsupplied.push(id);
  return unsupplied;
}

/** 마지막 시간 스텝에서 수질 값이 기준 미만인 절점(junction) ID 목록. */
function lowQualityJunctions(results: SimulationResults, model: NetworkModel, threshold: number): string[] {
  const last = results.stepCount - 1;
  const count = results.nodeIds.length;
  const low: string[] = [];
  results.nodeIds.forEach((id, index) => {
    if (model.nodes[id]?.type !== 'junction') return;
    if (results.node.quality[last * count + index] < threshold) low.push(id);
  });
  return low;
}

export async function runSimulation(): Promise<void> {
  // SWMM 보기 모드에서는 같은 '해석 실행' 버튼이 SWMM 엔진을 돌린다.
  if (useSwmmStore.getState().project) {
    await runSwmmAnalysis();
    return;
  }
  const { model, revision } = useNetworkStore.getState();
  const sim = useSimulationStore.getState();
  const ui = useUIStore.getState();
  if (sim.status === 'running') return;

  const nodes = Object.values(model.nodes);
  if (nodes.length < 2 || Object.keys(model.links).length === 0) {
    ui.pushToast({ level: 'warning', title: '해석할 관망이 없습니다', message: '절점 2개 이상과 관로를 작성하거나 .inp 파일을 불러오세요.' });
    return;
  }
  if (!nodes.some(isNodeSource)) {
    const info = describeEngineError(224);
    ui.pushToast({ level: 'error', title: info.title, message: info.hint });
    return;
  }

  const quality = model.options.quality;
  if (quality.mode === 'TRACE' && !(quality.traceNode in model.nodes)) {
    ui.pushToast({
      level: 'warning',
      title: '수원 추적 대상 절점이 없습니다',
      message: '해석 옵션 > 수질 해석에서 추적할 수원지·배수지를 선택하세요.',
    });
    return;
  }

  sim.setRunning();
  ui.setHighlight(null);
  try {
    const results = await simulationManager.run(writeInp(model, { forEngine: true }), (fraction) =>
      useSimulationStore.getState().setProgress(fraction),
    );
    const us = isUsUnits(model.options.flowUnits);
    const log: LogEntry[] = [
      {
        level: 'info',
        text: `EPANET ${results.engineVersion} 해석 완료 — 절점 ${results.nodeIds.length.toLocaleString()}개, 링크 ${results.linkIds.length.toLocaleString()}개, ${results.stepCount}개 시간 스텝, ${Math.round(results.elapsedMs)} ms`,
      },
      {
        level: 'info',
        text: `수압 범위 ${results.ranges.pressure[0].toFixed(2)} ~ ${results.ranges.pressure[1].toFixed(2)} ${us ? 'psi' : 'm'}, 최대 유속 ${results.ranges.velocity[1].toFixed(2)} ${us ? 'ft/s' : 'm/s'}`,
      },
    ];

    const sourceIds = new Set(nodes.filter(isNodeSource).map((n) => n.id));
    const negative = negativePressureNodes(results, sourceIds);
    for (const warning of results.warnings) {
      const info = describeEngineWarning(warning.code);
      log.push({
        level: 'warning',
        text: `[경고 ${warning.code}] ${info.title} — ${formatClock(warning.time)} 부터 ${warning.count}회. ${info.hint}`,
      });
    }
    if (negative.length > 0) {
      log.push({ level: 'warning', text: `음압 발생 절점 ${negative.length}개: ${negative.slice(0, 30).join(', ')}${negative.length > 30 ? ' …' : ''}` });
    }
    let lowChlorine: string[] = [];
    if (results.quality) {
      const q = results.quality;
      log.push({
        level: 'info',
        text: `수질(${qualityLabel(q)}) 범위 ${results.ranges.quality[0].toFixed(3)} ~ ${results.ranges.quality[1].toFixed(3)} ${qualityUnit(q)}`,
      });
      if (q.mode === 'CHEMICAL' && q.name.toLowerCase() === 'chlorine' && qualityUnit(q) === 'mg/L') {
        lowChlorine = lowQualityJunctions(results, model, 0.1);
        if (lowChlorine.length > 0) {
          log.push({
            level: 'warning',
            text: `모의 마지막 시각에 잔류염소 0.1 mg/L 미만 절점 ${lowChlorine.length}개: ${lowChlorine.slice(0, 30).join(', ')}${lowChlorine.length > 30 ? ' …' : ''}`,
          });
        }
      }
    }
    useSimulationStore.getState().setResults(results, revision, log);
    if (lowChlorine.length > 0) {
      ui.pushToast({
        level: 'warning',
        title: `잔류염소 부족 — 절점 ${lowChlorine.length}개`,
        message: '모의 마지막 시각 기준 0.1 mg/L 미만입니다. 재염소 투입(유입원) 또는 체류시간 단축(관로 정비·배수지 운영)을 검토하세요.',
        highlight: { nodeIds: lowChlorine, linkIds: [] },
      });
    }

    if (negative.length > 0) {
      const info = describeEngineWarning(6);
      ui.setHighlight({ nodeIds: negative, linkIds: [] });
      ui.pushToast({
        level: 'warning',
        title: `${info.title} — 절점 ${negative.length}개`,
        message: info.hint,
        highlight: { nodeIds: negative, linkIds: [] },
      });
    }
    for (const warning of results.warnings) {
      if (warning.code === 6) continue;
      const info = describeEngineWarning(warning.code);
      ui.pushToast({ level: 'warning', title: info.title, message: `${formatClock(warning.time)} 부터 발생. ${info.hint}` });
    }
    if (negative.length === 0 && results.warnings.length === 0) {
      ui.pushToast({
        level: 'success',
        title: '수리해석 완료',
        message: `${results.stepCount}개 시간 스텝 · ${Math.round(results.elapsedMs)} ms`,
      });
    }
  } catch (error) {
    if (error instanceof SimulationError && error.message === '해석이 취소되었습니다.') return;
    const code = error instanceof SimulationError ? error.code : null;
    const report = error instanceof SimulationError ? error.report : '';
    const info = describeEngineError(code);
    const details = extractReportErrors(report);
    if (details.length === 0 && error instanceof Error) {
      // epanet-js 메시지는 "EPANET Error 110: Error 110: ..." 처럼 코드가 두 번 들어간다.
      details.push(error.message.replace(/^EPANET Error (\d+): Error \1: /, 'EPANET Error $1: '));
    }
    const current = useNetworkStore.getState().model;
    const ids = extractObjectIds(details);
    const highlight = {
      nodeIds: ids.filter((id) => id in current.nodes),
      linkIds: ids.filter((id) => id in current.links),
    };
    // 엔진이 문제 객체를 알려 주지 않는 오류(방정식 해석 불가 등)는 열린 경로로
    // 수원에 닿지 못하는 절점을 직접 찾아 원인 후보로 강조한다.
    const unreachable = findUnsuppliedNodes(current);
    if (unreachable.length > 0 && (code === 110 || code === 233 || highlight.nodeIds.length + highlight.linkIds.length === 0)) {
      highlight.nodeIds = [...new Set([...highlight.nodeIds, ...unreachable])];
      details.unshift(
        `수원과 열린 관로로 연결되지 않은 절점 ${unreachable.length}개: ${unreachable.slice(0, 12).join(', ')}${unreachable.length > 12 ? ' …' : ''}`,
      );
    }
    const hasHighlight = highlight.nodeIds.length + highlight.linkIds.length > 0;
    useSimulationStore.getState().setError(
      { code, title: info.title, hint: info.hint, details },
      [
        { level: 'error', text: `${info.title}${code !== null ? ` (EPANET 오류 ${code})` : ''}` },
        { level: 'info', text: info.hint },
        ...details.map((text): LogEntry => ({ level: 'error', text })),
      ],
    );
    if (hasHighlight) ui.setHighlight(highlight);
    ui.setBottomTab('log');
    ui.pushToast({
      level: 'error',
      title: info.title,
      message: info.hint,
      details: details.slice(0, 4),
      highlight: hasHighlight ? highlight : undefined,
    });
  }
}

/* ------------------------------------------------------------------ 관망 검증 */

export async function runNetworkValidation(openModal = true): Promise<ValidationIssue[]> {
  const { model, revision } = useNetworkStore.getState();
  const validation = useValidationStore.getState();
  const ui = useUIStore.getState();
  validation.setRunning();
  try {
    const issues = await runValidationAsync(model, validation.options);
    useValidationStore.getState().setIssues(issues, revision);
    ui.setHighlight(null);
    ui.setBottomTab('validation');
    if (issues.length === 0) {
      ui.pushToast({ level: 'success', title: '관망 검증 완료', message: '오류가 발견되지 않았습니다.' });
    } else if (openModal) {
      ui.openModal('validation');
    }
    return issues;
  } catch (error) {
    useValidationStore.getState().setFailed();
    ui.pushToast({ level: 'error', title: '관망 검증에 실패했습니다', message: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

export function focusIssue(issue: ValidationIssue): void {
  const ui = useUIStore.getState();
  const { model } = useNetworkStore.getState();
  useValidationStore.getState().setActiveIssue(issue.id);
  ui.setHighlight({ nodeIds: issue.nodeIds, linkIds: issue.linkIds });

  const positions: LngLat[] = [];
  for (const id of issue.nodeIds) {
    const node = model.nodes[id];
    if (node) positions.push(node.position);
  }
  for (const id of issue.linkIds) {
    const link = model.links[id];
    if (!link) continue;
    const a = model.nodes[link.startNodeId];
    const b = model.nodes[link.endNodeId];
    if (a) positions.push(a.position);
    if (b) positions.push(b.position);
  }
  const box = bboxOf(positions);
  const spread = box ? Math.max(box[2] - box[0], box[3] - box[1]) : 0;
  if (issue.type === 'disconnected' && box && spread > 0.0005) ui.fitBounds(box);
  else if (issue.position) ui.flyTo(issue.position, 18);
  else if (box) ui.fitBounds(box);

  // 대표 객체를 선택해 속성 패널에 표시한다.
  if (issue.linkIds[0] && model.links[issue.linkIds[0]] && issue.type !== 'disconnected' && issue.type !== 'tee') {
    ui.select({ kind: 'link', id: issue.linkIds[0] });
  } else if (issue.nodeIds[0] && model.nodes[issue.nodeIds[0]]) {
    ui.select({ kind: 'node', id: issue.nodeIds[0] });
  }
}

function describeReport(report: AutoFixReport): string {
  const parts: string[] = [];
  if (report.removedOrphans) parts.push(`고립 절점 ${report.removedOrphans}개 삭제`);
  if (report.removedSelfLoops) parts.push(`자기 연결 관로 ${report.removedSelfLoops}개 삭제`);
  if (report.removedDuplicates) parts.push(`중복 관로 ${report.removedDuplicates}개 삭제`);
  if (report.mergedMicroPipes) parts.push(`미소 관로 ${report.mergedMicroPipes}개 병합`);
  if (report.splitCrossings) parts.push(`교차점 ${report.splitCrossings}곳 분할`);
  if (report.connectedTees) parts.push(`T자 ${report.connectedTees}곳 연결`);
  return parts.join(', ');
}

/** 선택한 유형의 오류를 한 번의 Undo 단위로 일괄 보정하고 다시 검증한다. */
export async function applyValidationFixes(selection: AutoFixSelection, only?: ValidationIssue[]): Promise<void> {
  const validation = useValidationStore.getState();
  const ui = useUIStore.getState();
  const issues = only ?? validation.issues;
  let report: AutoFixReport | null = null;
  useNetworkStore.getState().commit((draft) => {
    report = applyAutoFix(draft, issues, selection, validation.options);
  });
  const done = report as AutoFixReport | null;
  ui.select(null);
  ui.setHighlight(null);
  if (!done || totalFixes(done) === 0) {
    ui.pushToast({ level: 'info', title: '보정할 항목이 없습니다' });
    return;
  }
  ui.pushToast({
    level: 'success',
    title: `자동 보정 ${totalFixes(done)}건 완료`,
    message: `${describeReport(done)} · Ctrl+Z 로 되돌릴 수 있습니다.`,
  });
  await runNetworkValidation(false);
}

export function fixSingleIssue(issue: ValidationIssue): Promise<void> {
  return applyValidationFixes({ [issue.type]: true }, [issue]);
}

export { ISSUE_TYPE_LABELS };
