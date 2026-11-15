import {
  Hexagon,
  ArrowDownToLine,
  BookOpen,
  LandPlot,
  CloudRain,
  Disc,
  Droplets,
  FileInput,
  RefreshCw,
  Save,
  SlidersHorizontal,
  TrendingDown,
  LayoutGrid,
  Users,
  Wrench,
  ChartSpline,
  ChevronDown,
  CircleDot,
  Cylinder,
  Download,
  Fan,
  FileBraces,
  FilePlus,
  Flame,
  FolderOpen,
  GitCommitHorizontal,
  LassoSelect,
  LoaderCircle,
  Mountain,
  Maximize,
  MousePointer2,
  Play,
  Redo2,
  Route,
  Settings2,
  ShieldCheck,
  Spline,
  Trash,
  Undo2,
  Waves,
  WavesHorizontal,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  deleteSelection,
  exportDxf,
  exportGeoJsonFile,
  exportInp,
  exportResultTables,
  exportShapefile,
  fitToNetwork,
  importFiles,
  loadSample,
  newProject,
  runNetworkValidation,
  runSimulation,
} from '../../app/actions';
import { openSewerGisFiles } from '../../app/sewerGisImport';
import { applyDesignToProject, exportSewerCsv, exportSewerInp, openSewerFile, saveSewerProject } from '../../app/sewerActions';
import {
  correctSewerGround,
  deleteSewerSelection,
  fitToSewer,
  importSwmmFileAsSewer,
  loadSewerDemo,
  newSewerProject,
  runSewerFromMap,
  switchDomain,
} from '../../app/sewerMapActions';
import { APP_NAME, SAMPLES } from '../../config';
import { useSewerStore } from '../../store/useSewerStore';
import { useSwmmStore } from '../../store/useSwmmStore';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { useUIStore, type Domain, type Tool } from '../../store/useUIStore';
import { useValidationStore } from '../../store/useValidationStore';

const TOOLS: { tool: Tool; label: string; shortcut: string; icon: LucideIcon }[] = [
  { tool: 'select', label: '선택·이동', shortcut: 'V', icon: MousePointer2 },
  { tool: 'area', label: '구역 선택', shortcut: 'A', icon: LassoSelect },
  { tool: 'profile', label: '종단면도', shortcut: 'G', icon: Mountain },
  { tool: 'junction', label: '절점', shortcut: 'J', icon: CircleDot },
  { tool: 'reservoir', label: '수원지', shortcut: 'R', icon: WavesHorizontal },
  { tool: 'tank', label: '배수지', shortcut: 'T', icon: Cylinder },
  { tool: 'pipe', label: '관로', shortcut: 'P', icon: Spline },
  { tool: 'pump', label: '펌프', shortcut: 'U', icon: Fan },
  { tool: 'valve', label: '밸브', shortcut: 'L', icon: GitCommitHorizontal },
];

/** 하수 모드 편집 도구 (단축키는 App.tsx 의 SEWER_TOOL_KEYS 와 맞춘다). */
const SEWER_TOOL_LIST: typeof TOOLS = [
  { tool: 'select', label: '선택·이동', shortcut: 'V', icon: MousePointer2 },
  { tool: 'manhole', label: '맨홀', shortcut: 'M', icon: Disc },
  { tool: 'outfall', label: '방류구', shortcut: 'O', icon: ArrowDownToLine },
  { tool: 'conduit', label: '관거', shortcut: 'C', icon: TrendingDown },
  { tool: 'catchment', label: '유역', shortcut: 'A', icon: Hexagon },
];

const DOMAINS: { id: Domain; label: string; icon: LucideIcon; title: string }[] = [
  { id: 'water', label: '상수', icon: Droplets, title: '상수관망 (EPANET) 작도·해석' },
  { id: 'sewer', label: '하수', icon: Waves, title: '하수관망 작도·자동 설계·SWMM 해석' },
];

/** 작업 영역 전환: 상수 | 하수. 같은 지도·같은 화면에서 도구·메뉴·패널만 바뀐다. */
function DomainToggle() {
  const domain = useUIStore((s) => s.domain);
  return (
    <div className="mr-1 inline-flex h-7 shrink-0 overflow-hidden rounded border border-line" role="radiogroup" aria-label="작업 영역">
      {DOMAINS.map(({ id, label, icon: Icon, title }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={domain === id}
          title={title}
          onClick={() => switchDomain(id)}
          className={`inline-flex items-center gap-1 px-2.5 text-xs font-medium transition-colors ${
            domain === id ? 'bg-accent-strong text-white' : 'bg-raised text-ink-soft hover:text-ink'
          }`}
        >
          <Icon size={13} strokeWidth={2} />
          {label}
        </button>
      ))}
    </div>
  );
}

function ToolbarButton({
  icon: Icon,
  label,
  title,
  onClick,
  active,
  disabled,
  showLabel,
}: {
  icon: LucideIcon;
  label: string;
  title?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  /** 'wide' 는 넓은 화면에서만 라벨을 보인다. */
  showLabel?: boolean | 'wide';
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        active ? 'bg-accent-strong text-white' : 'text-ink-soft hover:bg-raised hover:text-ink'
      }`}
    >
      <Icon size={16} strokeWidth={1.9} />
      {showLabel && <span className={`whitespace-nowrap ${showLabel === 'wide' ? 'hidden 2xl:inline' : 'hidden lg:inline'}`}>{label}</span>}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-line" />;
}

function Menu({ label, icon: Icon, children }: { label: string; icon: LucideIcon; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs text-ink-soft transition-colors hover:bg-raised hover:text-ink"
      >
        <Icon size={16} strokeWidth={1.9} />
        <span className="whitespace-nowrap">{label}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-40 min-w-52 rounded-md border border-line bg-panel py-1 shadow-xl">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, hint, onClick }: { icon: LucideIcon; label: string; hint?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-ink-soft hover:bg-raised hover:text-ink"
    >
      <Icon size={14} className="shrink-0" />
      <span className="flex-1 whitespace-nowrap">{label}</span>
      {hint && <span className="text-[10px] text-ink-muted">{hint}</span>}
    </button>
  );
}

/** 상단 툴바: 파일 입출력, 편집 도구, 실행 취소, 관망 검증, 해석 실행. */
export function TopToolbar() {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const sewerFileInput = useRef<HTMLInputElement | null>(null);
  const swmmImportInput = useRef<HTMLInputElement | null>(null);
  const sewerGisInput = useRef<HTMLInputElement | null>(null);
  const sewer = useUIStore((s) => s.domain === 'sewer');
  const swmmViewer = useSwmmStore((s) => s.project !== null);
  const sewerSelected = useSewerStore((s) => s.selection !== null);
  const sewerCanUndo = useSewerStore((s) => s.past.length > 0);
  const sewerCanRedo = useSewerStore((s) => s.future.length > 0);
  const sewerName = useSewerStore((s) => s.project.name);
  const sewerBusy = useSewerStore((s) => s.busy);
  const sewerHasDesign = useSewerStore((s) => s.design !== null);
  const tool = useUIStore((s) => s.tool);
  const setTool = useUIStore((s) => s.setTool);
  const openModal = useUIStore((s) => s.openModal);
  const waterSelected = useUIStore((s) => s.selection !== null || s.multiSelection !== null);
  const waterCanUndo = useNetworkStore((s) => s.past.length > 0);
  const waterCanRedo = useNetworkStore((s) => s.future.length > 0);
  const waterFileName = useNetworkStore((s) => s.fileName);
  const waterTitle = useNetworkStore((s) => s.model.title[0]);
  // 하수 모드에서는 실행 취소·삭제·전체 보기·해석 실행이 하수 프로젝트(useSewerStore)에 작용한다.
  const hasSelection = sewer ? sewerSelected : waterSelected;
  const canUndo = sewer ? sewerCanUndo : waterCanUndo;
  const canRedo = sewer ? sewerCanRedo : waterCanRedo;
  const undo = () => (sewer ? useSewerStore.getState().undo() : useNetworkStore.getState().undo());
  const redo = () => (sewer ? useSewerStore.getState().redo() : useNetworkStore.getState().redo());
  const fileName = sewer ? sewerName : waterFileName;
  const title = sewer ? sewerName : waterTitle;
  const simStatus = useSimulationStore((s) => s.status);
  const progress = useSimulationStore((s) => s.progress);
  const validating = useValidationStore((s) => s.status === 'running');
  const running = sewer && !swmmViewer ? sewerBusy !== null : simStatus === 'running';
  const tools = sewer ? SEWER_TOOL_LIST : TOOLS;

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-panel px-3">
      <div className="mr-2 flex items-baseline gap-2">
        <span className="text-sm font-semibold tracking-tight text-ink">{APP_NAME}</span>
      </div>
      <DomainToggle />
      <span className="hidden max-w-40 truncate text-[11px] text-ink-muted xl:inline" title={fileName ?? title}>
        {fileName ?? title ?? ''}
      </span>
      <Divider />

      <Menu label="파일" icon={FolderOpen}>
        {(close) =>
          sewer ? (
            <>
              <MenuItem
                icon={FilePlus}
                label="새 하수 관망 (빈 관망)"
                onClick={() => {
                  close();
                  newSewerProject();
                }}
              />
              <MenuItem
                icon={FolderOpen}
                label="하수 프로젝트 열기 (.json)"
                onClick={() => {
                  close();
                  sewerFileInput.current?.click();
                }}
              />
              <MenuItem
                icon={FileInput}
                label="SWMM .inp → 편집 가능한 하수 관망으로 가져오기"
                onClick={() => {
                  close();
                  swmmImportInput.current?.click();
                }}
              />
              <MenuItem
                icon={FileInput}
                label="하수도 GIS(SHP: 관거·맨홀·처리분구)에서 관망 만들기"
                onClick={() => {
                  close();
                  sewerGisInput.current?.click();
                }}
              />
              <MenuItem
                icon={Users}
                label="수용가·건물·연결관·지도로 오수 유입량 넣기"
                onClick={() => {
                  close();
                  useUIStore.getState().openModal('sewage');
                }}
              />
              <div className="my-1 border-t border-line" />
              <MenuItem
                icon={Save}
                label="하수 프로젝트 저장 (.json)"
                hint="Ctrl+S"
                onClick={() => {
                  close();
                  saveSewerProject();
                }}
              />
              <MenuItem
                icon={Download}
                label="SWMM .inp 내보내기 (설계 결과 기준)"
                onClick={() => {
                  close();
                  exportSewerInp();
                }}
              />
              {sewerHasDesign && (
                <MenuItem
                  icon={Download}
                  label="설계 결과 CSV"
                  onClick={() => {
                    close();
                    exportSewerCsv();
                  }}
                />
              )}
              <div className="my-1 border-t border-line" />
              <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">예제</div>
              <MenuItem
                icon={Spline}
                label="분기형 우·오수 관망 예제"
                onClick={() => {
                  close();
                  loadSewerDemo();
                }}
              />
            </>
          ) : (
          <>
            <MenuItem
              icon={FilePlus}
              label="새 프로젝트"
              onClick={() => {
                close();
                newProject();
              }}
            />
            <MenuItem
              icon={FolderOpen}
              label="열기 (EPANET·SWMM .inp / .geojson / .shp·.zip)"
              hint="Ctrl+O"
              onClick={() => {
                close();
                fileInput.current?.click();
              }}
            />
            <div className="my-1 border-t border-line" />
            <MenuItem
              icon={Download}
              label="EPANET .inp 내보내기"
              hint="Ctrl+S"
              onClick={() => {
                close();
                exportInp();
              }}
            />
            <MenuItem
              icon={FileBraces}
              label="GeoJSON 내보내기"
              onClick={() => {
                close();
                exportGeoJsonFile();
              }}
            />
            <MenuItem
              icon={Download}
              label="Shapefile 내보내기 (EPSG:5186, .zip)"
              onClick={() => {
                close();
                exportShapefile('EPSG:5186');
              }}
            />
            <MenuItem
              icon={Download}
              label="Shapefile 내보내기 (경위도, .zip)"
              onClick={() => {
                close();
                exportShapefile('wgs84');
              }}
            />
            <MenuItem
              icon={Download}
              label="DXF 내보내기 (CAD, EPSG:5186)"
              onClick={() => {
                close();
                exportDxf();
              }}
            />
            <MenuItem
              icon={Download}
              label="수리계산 결과표 CSV (지금 시각)"
              onClick={() => {
                close();
                exportResultTables();
              }}
            />
            <div className="my-1 border-t border-line" />
            <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">샘플 관망</div>
            {SAMPLES.map((sample) => (
              <MenuItem
                key={sample.file}
                icon={Spline}
                label={sample.label}
                onClick={() => {
                  close();
                  void loadSample(sample.file);
                }}
              />
            ))}
          </>
          )
        }
      </Menu>
      <Menu label="데이터" icon={ChartSpline}>
        {(close) => {
          const item = (icon: LucideIcon, label: string, run: () => void) => (
            <MenuItem
              icon={icon}
              label={label}
              onClick={() => {
                close();
                run();
              }}
            />
          );
          const head = (text: string) => <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">{text}</div>;
          return (
            <>
              {head('공통 · 관망 만들기')}
              {item(Users, '수용가 자료로 관망 초안 만들기 (상수·하수)', () => openModal('draft'))}
              {item(LandPlot, '용지 조서 · 용지도 (지적도, 상수·하수)', () => openModal('land'))}
              <div className="my-1 border-t border-line" />
              {sewer ? (
                <>
                  {head('우수 · 하수')}
                  {item(SlidersHorizontal, '설계 조건 · 일괄 표 편집 (유역·강우 포함)', () => openModal('sewer'))}
                  {item(FileInput, 'SWMM .inp → 편집 가능한 하수 관망으로 가져오기', () => swmmImportInput.current?.click())}
                  {item(FileInput, '하수도 GIS(SHP)에서 관망 만들기', () => sewerGisInput.current?.click())}
                  {item(Users, '수용가·건물·연결관·지도로 오수 유입량 넣기', () => openModal('sewage'))}
                  {item(Mountain, '지반고 보정 — 지형 타일 (매설 깊이 유지)', () => void correctSewerGround(true))}
                  {item(Mountain, '지반고 보정 — 지형 타일 (지반고만)', () => void correctSewerGround(false))}
                  {item(RefreshCw, '설계 결과를 관망에 반영', applyDesignToProject)}
                  <div className="my-1 border-t border-line" />
                  {head('읽기 전용 SWMM 보기')}
                  {item(FolderOpen, 'SWMM .inp 열기 → 해석 · 하수 검토', () => fileInput.current?.click())}
                  {item(CloudRain, '우수관망 예제로 해보기', () => void loadSample('sample-sewer.inp'))}
                </>
              ) : (
                <>
              {head('상수 (EPANET)')}
              {item(Settings2, '해석 옵션 · 수요 패턴 · 수질', () => openModal('simulation'))}
              {item(ChartSpline, '펌프·배수지 곡선', () => openModal('curves'))}
              {item(Workflow, '제어 규칙 (CONTROLS / RULES)', () => openModal('controls'))}
              {item(Users, '수용가·건물·지도로 절점 수요량 넣기', () => openModal('waterDemand'))}
              {item(LayoutGrid, '용도지역 분담유량 (수요량 배분)', () => openModal('allocate'))}
              {item(Wrench, '관망 정리 (절점·관 병합, ID 재부여)', () => openModal('tools'))}
              {item(Route, '도로 따라 관로 맞추기 · 표고 보정', () => openModal('correction'))}
              {item(Flame, '소화용수 분석', () => openModal('fireflow'))}
              <div className="my-1 border-t border-line" />
              {head('우수 · 하수 (SWMM)')}
              {item(FolderOpen, 'SWMM .inp 열기 → 해석 · 하수 검토', () => fileInput.current?.click())}
              {item(CloudRain, '우수관망 예제로 해보기', () => void loadSample('sample-sewer.inp'))}
              {item(Waves, '하수관 자동 설계 (우·오수)', () => openModal('sewer'))}
                </>
              )}
            </>
          );
        }}
      </Menu>
      <input
        ref={fileInput}
        id="file-open-input"
        type="file"
        accept=".inp,.geojson,.json,.shp,.dbf,.prj,.cpg,.zip"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) void importFiles(files);
        }}
      />
      <input
        ref={sewerFileInput}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void openSewerFile(file).then(fitToSewer);
        }}
      />
      <input
        ref={sewerGisInput}
        type="file"
        multiple
        accept=".shp,.dbf,.prj,.cpg,.shx,.zip"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) void openSewerGisFiles(files);
        }}
      />
      <input
        ref={swmmImportInput}
        type="file"
        accept=".inp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importSwmmFileAsSewer(file);
        }}
      />
      <Divider />

      <div className="flex items-center gap-0.5" role="toolbar" aria-label={sewer ? '하수 편집 도구' : '편집 도구'}>
        {tools.map(({ tool: id, label, shortcut, icon }) => (
          <ToolbarButton
            key={id}
            icon={icon}
            label={label}
            title={`${label} (${shortcut})`}
            active={tool === id}
            showLabel="wide"
            disabled={sewer && swmmViewer}
            onClick={() => setTool(id)}
          />
        ))}
      </div>
      <Divider />

      <ToolbarButton icon={Undo2} label="실행 취소" title="실행 취소 (Ctrl+Z)" disabled={!canUndo} onClick={undo} />
      <ToolbarButton icon={Redo2} label="다시 실행" title="다시 실행 (Ctrl+Y)" disabled={!canRedo} onClick={redo} />
      <ToolbarButton icon={Trash} label="선택 삭제" title="선택 객체 삭제 (Delete)" disabled={!hasSelection} onClick={sewer ? deleteSewerSelection : deleteSelection} />
      <ToolbarButton icon={Maximize} label="전체 보기" title="관망 전체 보기 (F)" onClick={sewer ? fitToSewer : fitToNetwork} />

      <div className="ml-auto flex items-center gap-1.5">
        {sewer ? (
          <ToolbarButton icon={SlidersHorizontal} label="설계 조건" title="설계 조건 · 일괄 표 편집" showLabel onClick={() => openModal('sewer')} />
        ) : (
          <>
            <ToolbarButton
              icon={validating ? LoaderCircle : ShieldCheck}
              label="관망 검증"
              showLabel
              disabled={validating}
              onClick={() => void runNetworkValidation()}
            />
            <ToolbarButton icon={Settings2} label="해석 옵션" showLabel onClick={() => openModal('simulation')} />
          </>
        )}
        <ToolbarButton icon={BookOpen} label="사용 설명서" title="쉬운 사용설명서 (새 탭) — 안에서 자세한 설명서로도 갈 수 있어요" onClick={() => window.open(`${import.meta.env.BASE_URL}guide.html`, '_blank', 'noopener')} />
        <button
          type="button"
          disabled={running}
          onClick={() => void (sewer && !swmmViewer ? runSewerFromMap() : runSimulation())}
          title={sewer && !swmmViewer ? '자동 설계 → SWMM 해석 (F5)' : '수리해석 실행 (F5)'}
          className="relative inline-flex h-8 items-center gap-1.5 overflow-hidden rounded bg-accent-strong px-3 text-xs font-semibold text-white transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-80"
        >
          {running && !sewer && <span className="absolute inset-y-0 left-0 bg-white/20" style={{ width: `${Math.round(progress * 100)}%` }} />}
          {running ? <LoaderCircle size={15} className="relative animate-spin" /> : <Play size={15} className="relative" />}
          <span className="relative whitespace-nowrap">{running ? '해석 중…' : sewer && !swmmViewer ? '설계·해석 실행' : '해석 실행'}</span>
        </button>
      </div>
    </header>
  );
}
