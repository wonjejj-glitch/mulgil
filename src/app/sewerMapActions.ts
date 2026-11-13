/**
 * 하수 모드(지도 편집) 동작: 영역 전환, 지도 맞춤, 삭제, 설계·해석 실행, SWMM 가져오기, 지반고 보정.
 * 편집 연산 자체는 core/sewer/edit.ts(순수 함수), 설계·해석은 app/sewerActions.ts 를 쓴다.
 */
import { applyGroundLevels, deleteSewerConduit, deleteSewerNode, emptySewerProject } from '../core/sewer/edit';
import { sewerProjectFromSwmm } from '../core/sewer/fromSwmmInp';
import { isGeoreferenced, nodePositions } from '../core/sewer/mapFrame';
import type { LngLat } from '../core/model/types';
import { looksLikeSwmm } from '../core/swmm/inpReader';
import { useSewerStore, type SewerSelection } from '../store/useSewerStore';
import { useSwmmStore } from '../store/useSwmmStore';
import { useUIStore, type Domain } from '../store/useUIStore';
import { bboxOf } from '../utils/geoMath';
import { decodeText } from '../utils/files';
import { closeSwmm } from './actions';
import { runSewerSimulation } from './sewerActions';
import { sampleTerrainTiles } from './terrainFetch';

/** 하수 관망 전체가 보이게 지도를 맞춘다. */
export function fitToSewer(): void {
  const box = bboxOf(nodePositions(useSewerStore.getState().project).values());
  if (box) useUIStore.getState().fitBounds(box);
}

/** 상수 ↔ 하수 전환. 읽기 전용 SWMM 보기가 열려 있으면 닫는다. */
export function switchDomain(domain: Domain): void {
  if (useSwmmStore.getState().project) closeSwmm();
  const ui = useUIStore.getState();
  if (ui.domain === domain) return;
  ui.setDomain(domain);
  useSewerStore.getState().select(null);
  if (domain === 'sewer') fitToSewer();
}

/** 지도·목록에서 하수 객체를 고르고 그 위치로 간다. */
export function focusSewerObject(selection: NonNullable<SewerSelection>): void {
  const { project, select } = useSewerStore.getState();
  select(selection);
  const positions = nodePositions(project);
  let points: LngLat[] = [];
  if (selection.kind === 'node') {
    const p = positions.get(selection.id);
    if (p) points = [p];
  } else {
    const c = project.conduits.find((x) => x.id === selection.id);
    if (c) points = [positions.get(c.upstream), positions.get(c.downstream)].filter((p): p is LngLat => p !== undefined);
  }
  const box = bboxOf(points);
  if (box) useUIStore.getState().fitBounds(box);
}

export function deleteSewerSelection(): void {
  const store = useSewerStore.getState();
  const selection = store.selection;
  if (!selection) return;
  store.edit((d) => void (selection.kind === 'node' ? deleteSewerNode(d, selection.id) : deleteSewerConduit(d, selection.id)));
  store.select(null);
}

export function newSewerProject(): void {
  const store = useSewerStore.getState();
  store.setProject(emptySewerProject());
  store.select(null);
  useUIStore.getState().pushToast({ level: 'info', title: '빈 하수 관망', message: '맨홀(M)·방류구(O)를 찍고 관거(C)로 상류 → 하류 순서로 이으세요. Ctrl+Z 로 이전 관망을 되돌릴 수 있습니다.' });
}

export function loadSewerDemo(): void {
  useSewerStore.getState().loadDemo();
  useSewerStore.getState().select(null);
  fitToSewer();
}

/** 하수 모드의 '해석 실행': 자동 설계(없으면) → SWMM 해석. 결과·오류를 토스트로 알린다. */
export async function runSewerFromMap(): Promise<void> {
  const ui = useUIStore.getState();
  if (useSewerStore.getState().busy) return;
  const { project } = useSewerStore.getState();
  if (project.nodes.length < 2 || project.conduits.length === 0) {
    ui.pushToast({ level: 'warning', title: '해석할 관망이 없습니다', message: '맨홀과 방류구를 찍고 관거로 이은 뒤 실행하세요.' });
    return;
  }
  await runSewerSimulation();
  const { error, simulation, design } = useSewerStore.getState();
  if (error) {
    ui.pushToast({ level: 'error', title: '하수 설계·해석을 하지 못했습니다', message: error });
    return;
  }
  if (!simulation || !design) return;
  const nodes = Object.values(simulation.node_summary);
  const flooded = nodes.filter((n) => n.flood_hours > 0).length;
  const surcharged = nodes.filter((n) => n.surcharged).length;
  const ok = flooded === 0 && surcharged === 0 && simulation.quality_ok;
  ui.pushToast({
    level: ok ? 'success' : 'warning',
    title: ok ? 'SWMM 해석 완료 — 월류·만관 초과 없음' : `SWMM 해석 완료 — 월류 ${flooded}곳 · 만관 초과 ${surcharged}곳`,
    message: `연속성 오차 ${Object.entries(simulation.continuity).map(([k, v]) => `${k.replace(' Continuity', '')} ${v}%`).join(', ')} · 아래 ‘검토 목록’에서 관로별 판정을 확인하세요.`,
  });
  ui.setSewerBottomTab(design.feasible && ok ? 'simulation' : 'review');
}

/* ------------------------------------------------------------------ SWMM .inp → 편집 가능한 하수 관망 */

export function importSwmmTextAsSewer(text: string, fileName: string): boolean {
  const ui = useUIStore.getState();
  try {
    const { project, warnings, crsLabel } = sewerProjectFromSwmm(text, fileName.replace(/\.inp$/i, ''));
    if (project.nodes.length === 0) throw new Error('좌표가 있는 절점이 없습니다. SWMM [COORDINATES] 섹션을 확인하세요.');
    if (useSwmmStore.getState().project) closeSwmm();
    const store = useSewerStore.getState();
    store.setProject(project);
    store.select(null);
    ui.setDomain('sewer');
    ui.setTool('select');
    fitToSewer();
    ui.pushToast({
      // 옮기지 못한 항목을 읽을 시간이 있게 경고 수준(오래 남음)으로 띄운다
      level: warnings.length > 0 ? 'warning' : 'success',
      title: `${fileName} → 편집 가능한 하수 관망`,
      message: `맨홀·방류구 ${project.nodes.length}개 · 관거 ${project.conduits.length}개 · 유역 ${project.catchments.length}개 · 좌표계: ${crsLabel}. 옮기지 못한 항목은 아래를 확인하세요.`,
      details: warnings,
    });
    return true;
  } catch (error) {
    ui.pushToast({ level: 'error', title: `${fileName} 을(를) 하수 관망으로 가져오지 못했습니다`, message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export async function importSwmmFileAsSewer(file: File): Promise<void> {
  const text = decodeText(await file.arrayBuffer());
  if (!looksLikeSwmm(text)) {
    useUIStore.getState().pushToast({ level: 'error', title: 'SWMM .inp 파일이 아닙니다', message: '[CONDUITS]·[OUTFALLS] 등 SWMM 섹션이 있는 파일을 고르세요.' });
    return;
  }
  importSwmmTextAsSewer(text, file.name);
}

/** 지금 열려 있는 읽기 전용 SWMM 보기를 편집 가능한 하수 관망으로 바꾼다. */
export function convertOpenSwmmToSewer(): void {
  const swmm = useSwmmStore.getState();
  if (swmm.project) importSwmmTextAsSewer(swmm.project.text, swmm.fileName ?? 'swmm.inp');
}

/* ------------------------------------------------------------------ 지반고 보정 */

/**
 * 온라인 지형 타일(SRTM 30 m 급, 수 m 오차)에서 모든 절점의 지반고를 읽어 넣는다 (실행 취소 한 단계).
 * keepDepth: 관저고도 같은 만큼 옮겨 매설 깊이를 유지 / false 면 지반고만 바꾼다.
 */
export async function correctSewerGround(keepDepth: boolean): Promise<void> {
  const ui = useUIStore.getState();
  const store = useSewerStore.getState();
  const before = store.project;
  if (store.busy) return;
  if (before.nodes.length === 0) {
    ui.pushToast({ level: 'info', title: '지반고를 넣을 절점이 없습니다' });
    return;
  }
  if (!isGeoreferenced(before)) {
    ui.pushToast({
      level: 'warning',
      title: '실제 위치가 없는 관망입니다',
      message: '도면 좌표(임의 평면)라서 기준 위치에 놓여 있습니다. 지형과 맞지 않으므로 지반고를 바꾸지 않았습니다. EPSG:5186 좌표로 된 관망에서 쓰세요.',
    });
    return;
  }
  store.setBusy('지형 타일에서 지반고 읽는 중…');
  try {
    const positions = nodePositions(before);
    const values = await sampleTerrainTiles(before.nodes.map((n) => positions.get(n.id)!));
    // 받는 동안 관망이 바뀌었으면 ID 로 다시 맞춘다
    const byId = new Map(before.nodes.map((n, i) => [n.id, values[i]]));
    let stats = { changed: 0, invertAdjusted: 0, meanAbs: 0, maxAbs: 0 };
    useSewerStore.getState().edit((d) => {
      stats = applyGroundLevels(d, d.nodes.map((n) => byId.get(n.id) ?? NaN), keepDepth);
    });
    ui.pushToast({
      level: stats.invertAdjusted > 0 ? 'warning' : 'info',
      title: `지반고 보정 — ${stats.changed}/${before.nodes.length}개 변경`,
      message:
        `평균 |차이| ${stats.meanAbs.toFixed(2)} m · 최대 ${stats.maxAbs.toFixed(2)} m · ${keepDepth ? '관저고도 같은 만큼 옮김(깊이 유지)' : '지반고만 변경'}` +
        (stats.invertAdjusted > 0 ? ` · 관저고가 지반 위로 나온 ${stats.invertAdjusted}개는 임시 깊이로 내림` : '') +
        ' · 지형 타일은 수 m 오차가 있습니다. Ctrl+Z 로 되돌릴 수 있습니다.',
    });
  } catch (error) {
    ui.pushToast({ level: 'error', title: '지반고를 읽지 못했습니다', message: error instanceof Error ? error.message : String(error) });
  } finally {
    useSewerStore.getState().setBusy(null);
  }
}
