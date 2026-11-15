import { PlatformBar } from './components/platform/PlatformBar';
import { FolderOpen, History, Spline, Upload, Users } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { deleteSelection, exportInp, fitToNetwork, importFiles, loadSample, runSimulation, selectAll } from './app/actions';
import { readBackup, startAutoBackup, startSewerBackup, type Backup } from './app/autoBackup';
import { restoreBackup } from './app/draftActions';
import { saveSewerProject } from './app/sewerActions';
import { deleteSewerSelection, fitToSewer, runSewerFromMap } from './app/sewerMapActions';
import { SewerDock } from './components/sewer/SewerDock';
import { SewerPropertyPanel } from './components/sewer/SewerPropertyPanel';
import { useSewerStore } from './store/useSewerStore';
import { useDraftStore } from './store/useDraftStore';
import { BottomTimelineDock } from './components/layout/BottomTimelineDock';
import { LeftLayerPanel } from './components/layout/LeftLayerPanel';
import { RightPropertyPanel } from './components/layout/RightPropertyPanel';
import { TopToolbar } from './components/layout/TopToolbar';
import { GisMapCanvas } from './components/map/GisMapCanvas';
import { Button } from './components/ui/fields';
import { Toaster } from './components/ui/Toaster';
import { SAMPLES } from './config';
import { useNetworkStore } from './store/useNetworkStore';
import { SwmmDock, SwmmRightPanel } from './components/swmm/SwmmPanels';
import { useSimulationStore } from './store/useSimulationStore';
import { useSwmmStore } from './store/useSwmmStore';
import { useUIStore, type Tool } from './store/useUIStore';

// 대화상자는 처음 열 때 불러온다 (첫 화면 로딩을 가볍게).
const ValidationModal = lazy(() => import('./components/modals/ValidationModal').then((m) => ({ default: m.ValidationModal })));
const SimulationOptions = lazy(() => import('./components/modals/SimulationOptions').then((m) => ({ default: m.SimulationOptions })));
const DataEditorModal = lazy(() => import('./components/modals/DataEditorModal').then((m) => ({ default: m.DataEditorModal })));
const FireFlowModal = lazy(() => import('./components/modals/FireFlowModal').then((m) => ({ default: m.FireFlowModal })));
const CorrectionModal = lazy(() => import('./components/modals/CorrectionModal').then((m) => ({ default: m.CorrectionModal })));
const SewerDesignModal = lazy(() => import('./components/modals/SewerDesignModal').then((m) => ({ default: m.SewerDesignModal })));
const CustomerDraftModal = lazy(() => import('./components/modals/NetworkBuildModals').then((m) => ({ default: m.CustomerDraftModal })));
const AllocationModal = lazy(() => import('./components/modals/NetworkBuildModals').then((m) => ({ default: m.AllocationModal })));
const NetworkToolsModal = lazy(() => import('./components/modals/NetworkBuildModals').then((m) => ({ default: m.NetworkToolsModal })));
const SewerGisModal = lazy(() => import('./components/modals/SewerGisModal').then((m) => ({ default: m.SewerGisModal })));

function ModalHost() {
  const modal = useUIStore((s) => s.modal);
  if (!modal) return null;
  return (
    <Suspense fallback={null}>
      {modal === 'validation' && <ValidationModal />}
      {modal === 'simulation' && <SimulationOptions />}
      {(modal === 'curves' || modal === 'controls') && <DataEditorModal />}
      {modal === 'fireflow' && <FireFlowModal />}
      {modal === 'correction' && <CorrectionModal />}
      {modal === 'sewer' && <SewerDesignModal />}
      {modal === 'draft' && <CustomerDraftModal />}
      {modal === 'allocate' && <AllocationModal />}
      {modal === 'tools' && <NetworkToolsModal />}
      {modal === 'sewerGis' && <SewerGisModal />}
    </Suspense>
  );
}

/** 한글 입력 상태에서도 동작하도록 물리 키(event.code) 기준으로 도구를 고른다. */
const TOOL_KEYS: Record<string, Tool> = {
  KeyV: 'select',
  KeyA: 'area',
  KeyG: 'profile',
  KeyJ: 'junction',
  KeyR: 'reservoir',
  KeyT: 'tank',
  KeyP: 'pipe',
  KeyU: 'pump',
  KeyL: 'valve',
};

/** 하수 모드 도구 단축키 (상수 도구 키와 겹쳐도 모드가 달라 충돌하지 않는다). */
const SEWER_TOOL_KEYS: Record<string, Tool> = {
  KeyV: 'select',
  KeyM: 'manhole',
  KeyO: 'outfall',
  KeyC: 'conduit',
  KeyA: 'catchment',
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

function openFileDialog(): void {
  document.getElementById('file-open-input')?.click();
}

function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const ui = useUIStore.getState();
      const net = useNetworkStore.getState();
      const mod = event.ctrlKey || event.metaKey;
      // 하수 모드(읽기 전용 SWMM 보기가 열려 있지 않을 때): 편집 단축키가 하수 프로젝트에 작용한다.
      const sewer = ui.domain === 'sewer' && !useSwmmStore.getState().project;

      if (mod && event.code === 'KeyO') {
        event.preventDefault();
        openFileDialog();
        return;
      }
      if (mod && event.code === 'KeyS') {
        event.preventDefault();
        if (sewer) saveSewerProject();
        else exportInp();
        return;
      }
      if (event.key === 'F5' && !mod) {
        event.preventDefault();
        if (!ui.modal) void (sewer ? runSewerFromMap() : runSimulation());
        return;
      }
      // 입력란에서는 브라우저 기본 동작(입력 내용 실행 취소 등)을 그대로 둔다.
      if (isTypingTarget(event.target) || ui.modal) return;

      const history = sewer ? useSewerStore.getState() : net;
      if (mod && event.code === 'KeyZ') {
        event.preventDefault();
        if (event.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if (mod && event.code === 'KeyY') {
        event.preventDefault();
        history.redo();
        return;
      }
      if (mod && event.code === 'KeyA') {
        event.preventDefault();
        if (!sewer) selectAll();
        return;
      }
      if (mod || event.altKey) return;

      if (event.key === 'Escape') {
        if (ui.pointPick) ui.setPointPick(null);
        else if (ui.sewerDrawStart) ui.setSewerDrawStart(null);
        else if (ui.drawing) ui.setDrawing(null);
        else if (ui.areaDraft.length > 0) ui.setAreaDraft([]);
        else if (ui.tool !== 'select') ui.setTool('select');
        else if (sewer) useSewerStore.getState().select(null);
        else {
          ui.select(null);
          ui.setHighlight(null);
          ui.setMultiSelection(null);
        }
        return;
      }
      if (event.key === 'Delete') {
        if (sewer) deleteSewerSelection();
        else deleteSelection();
        return;
      }
      if (event.code === 'KeyF') {
        if (sewer) fitToSewer();
        else fitToNetwork();
        return;
      }
      if (event.code === 'Space') {
        // 버튼에 포커스가 있을 때는 Space 가 그 버튼을 누르므로 재생 전환과 겹치지 않게 한다.
        const tag = event.target instanceof HTMLElement ? event.target.tagName : '';
        if (tag === 'BUTTON' || tag === 'A') return;
        const swmm = useSwmmStore.getState();
        if (swmm.project) {
          if (swmm.run && swmm.run.output.periods > 1) {
            event.preventDefault();
            swmm.setPlaying(!swmm.playing);
          }
          return;
        }
        const sim = useSimulationStore.getState();
        if (sim.results && sim.results.stepCount > 1) {
          event.preventDefault();
          sim.setPlaying(!sim.playing);
        }
        return;
      }
      if (ui.domain === 'sewer') {
        const sewerTool = sewer ? SEWER_TOOL_KEYS[event.code] : undefined;
        if (sewerTool) ui.setTool(sewerTool);
        return;
      }
      const tool = TOOL_KEYS[event.code];
      if (tool) ui.setTool(tool);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** 창 어디에든 파일을 끌어다 놓으면 불러온다. 끌고 있는 동안 true 를 돌려준다. */
function useFileDrop(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth++;
      setActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setActive(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void importFiles(files);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
  return active;
}

function isEmptyRecord(record: Record<string, unknown>): boolean {
  for (const key in record) {
    if (Object.hasOwn(record, key)) return false;
  }
  return true;
}

/** 빈 프로젝트일 때 지도 위에 띄우는 시작 안내. 작도 도구를 고르면 사라진다. */
function EmptyState() {
  const empty = useNetworkStore((s) => isEmptyRecord(s.model.nodes));
  const tool = useUIStore((s) => s.tool);
  const swmmOpen = useSwmmStore((s) => s.project !== null);
  const picking = useUIStore((s) => s.pointPick !== null);
  const drafting = useDraftStore((s) => s.overlay && s.customers.length > 0);
  const sewer = useUIStore((s) => s.domain === 'sewer');
  const sewerEmpty = useSewerStore((s) => s.project.nodes.length === 0);
  const [backup, setBackup] = useState<Backup | null>(null);
  useEffect(() => {
    if (empty) void readBackup().then(setBackup);
  }, [empty]);
  if (sewer) {
    if (!sewerEmpty || tool !== 'select' || swmmOpen || picking || drafting) return null;
    return (
      <div className="pointer-events-none absolute inset-x-0 top-16 z-10 flex justify-center p-4">
        <div className="pointer-events-auto w-[400px] max-w-full rounded-lg border border-line bg-panel/95 p-5 shadow-2xl backdrop-blur">
          <h2 className="text-sm font-semibold text-ink">하수 관망이 비어 있습니다</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-soft">
            상단 도구로 맨홀(M)과 방류구(O)를 찍고, 관거(C)는 상류 → 하류 순서로 잇습니다. 수용가 자료로 초안을 만들거나, 파일 메뉴에서 SWMM .inp 를 편집 가능한 하수 관망으로 가져올 수도
            있습니다.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => useUIStore.getState().setTool('manhole')}>
              맨홀 찍기 시작
            </Button>
            <Button onClick={() => useUIStore.getState().openModal('draft')}>
              <Users size={14} />
              수용가 자료로 만들기
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (!empty || tool !== 'select' || swmmOpen || picking || drafting) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
      <div className="pointer-events-auto w-[400px] max-w-full rounded-lg border border-line bg-panel/95 p-5 shadow-2xl backdrop-blur">
        <h2 className="text-sm font-semibold text-ink">관망이 비어 있습니다</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-soft">
          EPANET·SWMM .inp, GeoJSON 또는 Shapefile(.zip) 을 이 창에 끌어다 놓거나 샘플 관망으로 시작하세요. SWMM 파일은 우수·하수 해석 화면으로 열립니다. 상단 도구(절점 J, 수원지 R, 관로 P)로 지도에
          직접 그릴 수도 있습니다.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" onClick={openFileDialog}>
            <FolderOpen size={14} />
            파일 열기
          </Button>
          <Button onClick={() => useUIStore.getState().openModal('draft')}>
            <Users size={14} />
            수용가 자료로 만들기
          </Button>
          {SAMPLES.map((sample) => (
            <Button key={sample.file} onClick={() => void loadSample(sample.file)}>
              <Spline size={14} />
              {sample.label}
            </Button>
          ))}
        </div>
        {backup && (
          <div className="mt-4 flex items-center gap-2 border-t border-line pt-3 text-xs text-ink-soft">
            <History size={14} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate" title={backup.fileName ?? ''}>
              지난 작업: {backup.fileName ?? '이름 없음'} · 절점 {backup.nodes.toLocaleString()}개 · {new Date(backup.savedAt).toLocaleString('ko-KR')}
            </span>
            <Button onClick={() => void restoreBackup()}>복원</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function DropOverlay() {
  return (
    <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-canvas/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-accent px-12 py-10 text-ink">
        <Upload size={28} className="text-accent" />
        <p className="text-sm font-semibold">여기에 놓아 불러오기</p>
        <p className="text-xs text-ink-muted">EPANET·SWMM .inp · GeoJSON · Shapefile(.shp+.dbf+.prj 또는 .zip)</p>
      </div>
    </div>
  );
}

/** 4분할 워크스페이스: 상단 툴바 / 좌측 레이어 / 중앙 지도 + 하단 타임라인 / 우측 속성. */
export function App() {
  useGlobalShortcuts();
  useEffect(startAutoBackup, []);
  useEffect(startSewerBackup, []);
  const dropActive = useFileDrop();
  const swmmActive = useSwmmStore((s) => s.project !== null);
  const sewer = useUIStore((s) => s.domain === 'sewer');
  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      {/* 물마루 공통 상단바(40px) — 아래 작업 화면은 남은 높이(100% − 40px)를 flex 로 나눠 쓴다 */}
      <PlatformBar current="mulgil" />
      <TopToolbar />
      <div className="flex min-h-0 flex-1">
        <LeftLayerPanel />
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <GisMapCanvas />
            <EmptyState />
            <Toaster />
          </div>
          {swmmActive ? <SwmmDock /> : sewer ? <SewerDock /> : <BottomTimelineDock />}
        </main>
        {swmmActive ? <SwmmRightPanel /> : sewer ? <SewerPropertyPanel /> : <RightPropertyPanel />}
      </div>
      <ModalHost />
      {dropActive && <DropOverlay />}
    </div>
  );
}
