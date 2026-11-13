/** 하수 모드 하단 도크: 종단도 · 검토 목록 · SWMM 해석 요약. */
import { Map as MapIcon } from 'lucide-react';
import { useMemo } from 'react';
import { showSewerOnMap } from '../../app/sewerActions';
import { focusSewerObject } from '../../app/sewerMapActions';
import { buildNetwork } from '../../core/sewer/topology';
import { useSewerStore } from '../../store/useSewerStore';
import { useUIStore, type SewerBottomTab } from '../../store/useUIStore';
import { Button } from '../ui/fields';
import { SewerProfile, SewerReviewList, SewerSimulationSummary } from './SewerShared';

const TABS: { id: SewerBottomTab; label: string }[] = [
  { id: 'profile', label: '종단도' },
  { id: 'review', label: '검토 목록' },
  { id: 'simulation', label: 'SWMM 해석 요약' },
];

function Empty({ children }: { children: string }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-xs leading-relaxed text-ink-muted">{children}</div>;
}

function ProfileTab() {
  const input = useSewerStore((s) => s.project);
  const design = useSewerStore((s) => s.design);
  const selection = useSewerStore((s) => s.selection);
  // 설계가 있으면 설계한 관저고·관경으로 그린다
  const project = design?.project ?? input;
  const problem = useMemo(() => {
    try {
      buildNetwork(project);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, [project]);
  if (project.conduits.length === 0) return <Empty>맨홀과 방류구를 관거로 이으면 종단도가 그려집니다.</Empty>;
  if (problem) return <Empty>{`종단도를 그릴 수 없습니다 — ${problem}`}</Empty>;
  let start = '';
  if (selection?.kind === 'node') start = project.nodes.find((n) => n.id === selection.id && n.kind === 'JUNCTION')?.id ?? '';
  else if (selection?.kind === 'conduit') start = project.conduits.find((c) => c.id === selection.id)?.upstream ?? '';
  return (
    <div className="h-full overflow-y-auto px-3 pb-1">
      <SewerProfile project={project} start={start} onStart={(id) => focusSewerObject({ kind: 'node', id })} heightClass="h-40" className="mt-2" />
      <p className="text-[11px] text-ink-muted">
        지도에서 맨홀·관거를 고르면 그 지점부터 방류구까지 그립니다. {design ? '설계한 관저고·관경 기준입니다.' : '자동 설계 전이라 입력한 관저고·관경 기준입니다.'}
      </p>
    </div>
  );
}

export function SewerDock() {
  const tab = useUIStore((s) => s.sewerBottomTab);
  const setTab = useUIStore((s) => s.setSewerBottomTab);
  const collapsed = useUIStore((s) => s.bottomCollapsed);
  const setCollapsed = useUIStore((s) => s.setBottomCollapsed);
  const busy = useSewerStore((s) => s.busy);
  const design = useSewerStore((s) => s.design);
  const simulation = useSewerStore((s) => s.simulation);
  const engine = useSewerStore((s) => s.run?.engineVersion);
  const status = busy ?? (simulation ? `SWMM 해석 완료${engine ? ` (${engine})` : ''}` : design ? (design.feasible ? '자동 설계 완료 — 제약 만족' : `자동 설계 완료 — 위반 ${design.issues.length}건`) : '설계 결과 없음');
  return (
    <section className={`flex shrink-0 flex-col border-t border-line bg-panel ${collapsed ? 'h-10' : 'h-64'}`}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <div className="flex shrink-0 items-center" role="tablist">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id && !collapsed}
              onClick={() => setTab(item.id)}
              className={`inline-flex h-10 items-center border-b-2 px-3 text-xs transition-colors ${tab === item.id && !collapsed ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink-soft'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="mx-2 h-5 w-px shrink-0 bg-line" />
        <span className="truncate text-[11px] text-ink-muted">{status}</span>
        <button type="button" className="ml-auto shrink-0 rounded p-1 text-ink-muted hover:bg-raised hover:text-ink" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '펼치기' : '접기'}>
          {collapsed ? '▲' : '▼'}
        </button>
      </div>
      {!collapsed && (
        <div className="min-h-0 flex-1">
          {tab === 'profile' ? (
            <ProfileTab />
          ) : tab === 'review' ? (
            <div className="h-full overflow-y-auto p-2">
              <SewerReviewList
                showProfile={false}
                tableClass=""
                onPick={(row) => focusSewerObject({ kind: 'conduit', id: row.id })}
                emptyMessage="‘설계·해석 실행’(F5) 또는 우측 패널의 ‘자동 설계’를 누르면 관로별 검토 목록이 표시됩니다. 동수위 판정은 SWMM 해석 뒤에 나옵니다."
              />
            </div>
          ) : !simulation ? (
            <Empty>‘설계·해석 실행’(F5)을 누르면 자동 설계한 관망을 SWMM 으로 해석해 월류·만관 초과·연속성 오차를 보여 줍니다.</Empty>
          ) : (
            <div className="h-full overflow-y-auto p-2">
              <div className="flex items-center gap-2">
                <Button onClick={showSewerOnMap} title="설계한 관망을 읽기 전용 SWMM 보기로 열어 시간대별 수심·유량을 봅니다. 닫으면 하수 편집 화면으로 돌아옵니다.">
                  <MapIcon size={13} />
                  시간대별 결과 보기 (SWMM 보기)
                </Button>
                <span className="text-[11px] text-ink-muted">맨홀 색: 초록 정상 · 주황 만관 초과 · 빨강 월류</span>
              </div>
              <SewerSimulationSummary className="mt-2" tableClass="" />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
