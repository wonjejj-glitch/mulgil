/**
 * 하수관 자동 설계 동작: 설계 → SWMM 해석 → 반복 검토 → 지도에서 보기.
 * 계산은 core/sewer(순수 함수), 해석 엔진은 core/swmm(Worker)이 맡는다.
 */
import { designSewer, type DesignResult } from '../core/sewer/design';
import { generateInp } from '../core/sewer/inp';
import { optimizeSewer } from '../core/sewer/optimize';
import { fitOutfallInverts } from '../core/sewer/outfall';
import { parseReport, summarizeSimulation, type SimulationSummary } from '../core/sewer/report';
import { parseSewerProject, SewerValidationError } from '../core/sewer/validate';
import type { SewerProject } from '../core/sewer/types';
import { SwmmFailure, swmmManager, type SwmmRun } from '../core/swmm/swmmManager';
import { useSewerStore } from '../store/useSewerStore';
import { useUIStore } from '../store/useUIStore';
import { baseName, downloadText } from '../utils/files';
import { openSwmmText } from './actions';
import { useSwmmStore } from '../store/useSwmmStore';

function message(error: unknown): string {
  if (error instanceof SewerValidationError) return error.details.map((d) => (d.loc.length ? `${d.loc.join('.')}: ` : '') + d.msg).join(' / ');
  if (error instanceof SwmmFailure) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** 입력을 검증해 돌려준다. 실패하면 화면에 오류를 남기고 null. */
export function validatedProject(): SewerProject | null {
  const store = useSewerStore.getState();
  try {
    return parseSewerProject(JSON.parse(JSON.stringify(store.project)));
  } catch (error) {
    store.setError(message(error));
    return null;
  }
}

export function runSewerDesign(): DesignResult | null {
  const store = useSewerStore.getState();
  const project = validatedProject();
  if (!project) return null;
  try {
    const design = designSewer(project, {}, store.designMode);
    store.setDesign(design);
    store.setSimulation(null, null);
    store.setOutcome(null);
    store.setError(null);
    useUIStore.getState().pushToast({
      level: design.feasible ? 'success' : 'warning',
      title: design.feasible ? '자동 설계 완료 — 모든 제약 만족' : `자동 설계 완료 — 제약 위반 ${design.issues.length}건`,
      message: design.feasible ? '관경·맨홀 관저고·관로 옵셋을 새로 정했습니다. 입력에는 아직 반영하지 않았습니다.' : design.issues.slice(0, 3).join(' · '),
    });
    return design;
  } catch (error) {
    store.setError(message(error));
    return null;
  }
}

async function simulateDesign(design: DesignResult): Promise<{ summary: SimulationSummary; run: SwmmRun }> {
  const run = await swmmManager.run(generateInp(design.project));
  const summary = summarizeSimulation(design.project, parseReport(run.report, design.project));
  return { summary, run };
}

/** 설계 결과를 SWMM 으로 해석한다 (설계가 없으면 먼저 설계). */
export async function runSewerSimulation(): Promise<void> {
  const store = useSewerStore.getState();
  if (store.busy) return;
  const design = store.design ?? runSewerDesign();
  if (!design) return;
  store.setBusy('SWMM 해석 중…');
  try {
    const { summary, run } = await simulateDesign(design);
    store.setSimulation(summary, run);
    store.setError(null);
  } catch (error) {
    store.setError(message(error));
  } finally {
    store.setBusy(null);
  }
}

/** 설계 → 해석 → 용량 부족 관로 관경 확대를 조건을 만족할 때까지(최대 반복 횟수) 되풀이한다. */
export async function runSewerOptimize(): Promise<void> {
  const store = useSewerStore.getState();
  if (store.busy) return;
  const project = validatedProject();
  if (!project) return;
  store.setBusy('반복 검토 시작…');
  try {
    let lastRun: SwmmRun | null = null;
    const outcome = await optimizeSewer(
      project,
      async (design) => {
        const { summary, run } = await simulateDesign(design);
        lastRun = run;
        return summary;
      },
      (m) => useSewerStore.getState().setBusy(m),
      store.designMode,
    );
    store.setOutcome(outcome);
    store.setDesign(outcome.design);
    store.setSimulation(outcome.simulation, lastRun);
    store.setError(null);
    useUIStore.getState().pushToast({
      level: outcome.converged ? 'success' : 'warning',
      title: outcome.converged ? `반복 검토 완료 — ${outcome.history.length}회에 수렴` : '반복 검토 종료 — 조건을 모두 만족하지는 못했습니다',
      message: outcome.stop_reason,
    });
  } catch (error) {
    store.setError(message(error));
  } finally {
    store.setBusy(null);
  }
}

/** 방류구 관저고를 설계에 맞춰 다시 정한다 (입력에 반영, 실행 취소 가능). */
export function fitOutfallDepth(): void {
  const store = useSewerStore.getState();
  const project = validatedProject();
  if (!project) return;
  try {
    const { project: fitted, changes } = fitOutfallInverts(project, store.designMode);
    if (changes.length === 0) {
      useUIStore.getState().pushToast({ level: 'info', title: '맞출 방류구가 없습니다', message: '유입 관이 하나인 방류구만 맞춥니다.' });
      return;
    }
    store.setProject(fitted);
    useUIStore.getState().pushToast({
      level: 'success',
      title: '방류구 깊이를 맞췄습니다',
      message: changes.map((c) => `${c.id}: 관저고 ${c.from.toFixed(2)} → ${c.to.toFixed(2)} m`).join(' · ') + ' — ① 자동 설계를 다시 누르세요.',
    });
  } catch (error) {
    store.setError(message(error));
  }
}

/** 설계 결과(관경·관저고·옵셋)를 입력 프로젝트에 반영한다 (실행 취소 가능, 설계·해석 결과는 유지). */
export function applyDesignToProject(): void {
  const store = useSewerStore.getState();
  if (!store.design) return;
  store.setProject(JSON.parse(JSON.stringify(store.design.project)) as SewerProject, { keepResults: true });
}

/** 설계한 관망을 지도의 우수·하수 보기로 연다 (해석 결과가 있으면 함께). */
export function showSewerOnMap(): void {
  const store = useSewerStore.getState();
  const project = store.design?.project ?? validatedProject();
  if (!project) return;
  try {
    openSwmmText(generateInp(project), `${project.name}.inp`);
    if (store.run) useSwmmStore.getState().setResult(store.run);
    useUIStore.getState().openModal(null);
  } catch (error) {
    store.setError(message(error));
  }
}

/* ------------------------------------------------------------------ 파일 */

export async function openSewerFile(file: File): Promise<void> {
  const store = useSewerStore.getState();
  try {
    const project = parseSewerProject(JSON.parse(await file.text()));
    store.setProject(project);
    useUIStore.getState().pushToast({ level: 'success', title: `${file.name} 불러오기 완료`, message: `절점 ${project.nodes.length}개 · 관로 ${project.conduits.length}개 · 유역 ${project.catchments.length}개` });
  } catch (error) {
    store.setError(message(error));
  }
}

export function saveSewerProject(): void {
  const { project } = useSewerStore.getState();
  downloadText(`${baseName(project.name || 'sewer')}.json`, JSON.stringify(project, null, 2), 'application/json');
}

export function exportSewerInp(): void {
  const store = useSewerStore.getState();
  const project = store.design?.project ?? validatedProject();
  if (!project) return;
  try {
    downloadText(`${baseName(project.name || 'sewer')}.inp`, generateInp(project));
  } catch (error) {
    store.setError(message(error));
  }
}

export function exportSewerCsv(): void {
  const { design, project } = useSewerStore.getState();
  if (!design) return;
  const head = 'id,diameter(m),flow(m3/s),slope(m/m),velocity(m/s),depth_ratio,cover(m),status';
  const lines = design.rows.map((r) => [r.id, r.diameter, r.flow, r.slope, r.velocity, r.depth_ratio, r.cover, r.status].join(','));
  downloadText(`${baseName(project.name || 'sewer')}_design.csv`, `${String.fromCharCode(0xfeff)}${[head, ...lines].join('\r\n')}\r\n`, 'text/csv;charset=utf-8');
}
