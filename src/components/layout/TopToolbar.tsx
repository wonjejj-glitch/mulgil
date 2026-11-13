import {
  BookOpen,
  CloudRain,
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
import { APP_NAME, SAMPLES } from '../../config';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { useUIStore, type Tool } from '../../store/useUIStore';
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
  const tool = useUIStore((s) => s.tool);
  const setTool = useUIStore((s) => s.setTool);
  const openModal = useUIStore((s) => s.openModal);
  const hasSelection = useUIStore((s) => s.selection !== null || s.multiSelection !== null);
  const canUndo = useNetworkStore((s) => s.past.length > 0);
  const canRedo = useNetworkStore((s) => s.future.length > 0);
  const undo = useNetworkStore((s) => s.undo);
  const redo = useNetworkStore((s) => s.redo);
  const fileName = useNetworkStore((s) => s.fileName);
  const title = useNetworkStore((s) => s.model.title[0]);
  const simStatus = useSimulationStore((s) => s.status);
  const progress = useSimulationStore((s) => s.progress);
  const validating = useValidationStore((s) => s.status === 'running');
  const running = simStatus === 'running';

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-panel px-3">
      <div className="mr-2 flex items-baseline gap-2">
        <span className="text-sm font-semibold tracking-tight text-ink">{APP_NAME}</span>
        <span className="hidden max-w-48 truncate text-[11px] text-ink-muted xl:inline" title={fileName ?? title}>
          {fileName ?? title ?? ''}
        </span>
      </div>
      <Divider />

      <Menu label="파일" icon={FolderOpen}>
        {(close) => (
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
        )}
      </Menu>
      <Menu label="데이터" icon={ChartSpline}>
        {(close) => (
          <>
            <MenuItem
              icon={Settings2}
              label="해석 옵션 · 수요 패턴 · 수질"
              onClick={() => {
                close();
                openModal('simulation');
              }}
            />
            <MenuItem
              icon={ChartSpline}
              label="펌프·배수지 곡선"
              onClick={() => {
                close();
                openModal('curves');
              }}
            />
            <MenuItem
              icon={Workflow}
              label="제어 규칙 (CONTROLS / RULES)"
              onClick={() => {
                close();
                openModal('controls');
              }}
            />
            <div className="my-1 border-t border-line" />
            <MenuItem
              icon={Users}
              label="수용가 자료로 관망 초안 만들기"
              onClick={() => {
                close();
                openModal('draft');
              }}
            />
            <MenuItem
              icon={LayoutGrid}
              label="용도지역 분담유량 (수요량 배분)"
              onClick={() => {
                close();
                openModal('allocate');
              }}
            />
            <MenuItem
              icon={Wrench}
              label="관망 정리 (절점·관 병합, ID 재부여)"
              onClick={() => {
                close();
                openModal('tools');
              }}
            />
            <div className="my-1 border-t border-line" />
            <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">우수 · 하수 (SWMM)</div>
            <MenuItem
              icon={FolderOpen}
              label="SWMM .inp 열기 → 해석 · 결과 보기"
              onClick={() => {
                close();
                fileInput.current?.click();
              }}
            />
            <MenuItem
              icon={CloudRain}
              label="우수관망 예제로 해보기"
              onClick={() => {
                close();
                void loadSample('sample-sewer.inp');
              }}
            />
            <MenuItem
              icon={Waves}
              label="하수관 자동 설계 (우·오수)"
              onClick={() => {
                close();
                openModal('sewer');
              }}
            />
            <MenuItem
              icon={Route}
              label="도로 따라 관로 맞추기 · 표고 보정"
              onClick={() => {
                close();
                openModal('correction');
              }}
            />
            <MenuItem
              icon={Flame}
              label="소화용수 분석"
              onClick={() => {
                close();
                openModal('fireflow');
              }}
            />
          </>
        )}
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
      <Divider />

      <div className="flex items-center gap-0.5" role="toolbar" aria-label="편집 도구">
        {TOOLS.map(({ tool: id, label, shortcut, icon }) => (
          <ToolbarButton
            key={id}
            icon={icon}
            label={label}
            title={`${label} (${shortcut})`}
            active={tool === id}
            showLabel="wide"
            onClick={() => setTool(id)}
          />
        ))}
      </div>
      <Divider />

      <ToolbarButton icon={Undo2} label="실행 취소" title="실행 취소 (Ctrl+Z)" disabled={!canUndo} onClick={undo} />
      <ToolbarButton icon={Redo2} label="다시 실행" title="다시 실행 (Ctrl+Y)" disabled={!canRedo} onClick={redo} />
      <ToolbarButton icon={Trash} label="선택 삭제" title="선택 객체 삭제 (Delete)" disabled={!hasSelection} onClick={deleteSelection} />
      <ToolbarButton icon={Maximize} label="전체 보기" title="관망 전체 보기 (F)" onClick={fitToNetwork} />

      <div className="ml-auto flex items-center gap-1.5">
        <ToolbarButton
          icon={validating ? LoaderCircle : ShieldCheck}
          label="관망 검증"
          showLabel
          disabled={validating}
          onClick={() => void runNetworkValidation()}
        />
        <ToolbarButton icon={Settings2} label="해석 옵션" showLabel onClick={() => openModal('simulation')} />
        <ToolbarButton icon={BookOpen} label="사용 설명서" title="사용 설명서 (새 탭)" onClick={() => window.open(`${import.meta.env.BASE_URL}manual.html`, '_blank', 'noopener')} />
        <button
          type="button"
          disabled={running}
          onClick={() => void runSimulation()}
          title="수리해석 실행 (F5)"
          className="relative inline-flex h-8 items-center gap-1.5 overflow-hidden rounded bg-accent-strong px-3 text-xs font-semibold text-white transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-80"
        >
          {running && <span className="absolute inset-y-0 left-0 bg-white/20" style={{ width: `${Math.round(progress * 100)}%` }} />}
          {running ? <LoaderCircle size={15} className="relative animate-spin" /> : <Play size={15} className="relative" />}
          <span className="relative whitespace-nowrap">{running ? '해석 중…' : '해석 실행'}</span>
        </button>
      </div>
    </header>
  );
}
