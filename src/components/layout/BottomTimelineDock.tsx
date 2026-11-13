import {
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleExclamationPoint,
  Info,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  SquareDashedMousePointer,
  TriangleExclamationPoint,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { fixSingleIssue, focusIssue, runNetworkValidation, selectIssueObjects } from '../../app/actions';
import { formatClock } from '../../core/model/units';
import { ISSUE_TYPE_LABELS, ISSUE_TYPE_ORDER, type ValidationIssue } from '../../core/validation';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { useUIStore, type BottomTab } from '../../store/useUIStore';
import { useValidationStore } from '../../store/useValidationStore';
import { Button } from '../ui/fields';
import { ProfilePanel } from './ProfilePanel';
import { ResultsTablePanel } from './ResultsTablePanel';
import { TimeSeriesPanel } from './TimeSeriesPanel';

const MAX_LISTED_ISSUES = 400;

/** 시간 슬라이더와 재생 컨트롤. 재생 중에는 일정 간격으로 다음 시간 스텝으로 넘어간다. */
function TimeControls() {
  const results = useSimulationStore((s) => s.results);
  const stepIndex = useSimulationStore((s) => s.stepIndex);
  const playing = useSimulationStore((s) => s.playing);
  const setStep = useSimulationStore((s) => s.setStep);
  const setPlaying = useSimulationStore((s) => s.setPlaying);
  const stale = useSimulationStore((s) => s.resultsRevision) !== useNetworkStore((s) => s.revision);
  const stepCount = results?.stepCount ?? 0;

  useEffect(() => {
    if (!playing || stepCount < 2) return;
    const timer = window.setInterval(() => {
      const state = useSimulationStore.getState();
      state.setStep((state.stepIndex + 1) % stepCount);
    }, 650);
    return () => window.clearInterval(timer);
  }, [playing, stepCount]);

  if (!results || stepCount === 0) return <span className="text-[11px] text-ink-muted">해석 결과 없음</span>;
  const multi = stepCount > 1;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <button
        type="button"
        className="rounded p-1 text-ink-soft hover:bg-raised hover:text-ink disabled:opacity-30"
        title="이전 시각"
        disabled={!multi}
        onClick={() => setStep(stepIndex - 1)}
      >
        <SkipBack size={14} />
      </button>
      <button
        type="button"
        className="rounded bg-raised p-1.5 text-ink hover:bg-line disabled:opacity-30"
        title={playing ? '일시정지 (Space)' : '시간대별 애니메이션 재생 (Space)'}
        disabled={!multi}
        onClick={() => setPlaying(!playing)}
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <button
        type="button"
        className="rounded p-1 text-ink-soft hover:bg-raised hover:text-ink disabled:opacity-30"
        title="다음 시각"
        disabled={!multi}
        onClick={() => setStep(stepIndex + 1)}
      >
        <SkipForward size={14} />
      </button>
      <input
        type="range"
        aria-label="모의 시각"
        className="h-1 min-w-24 flex-1 cursor-pointer"
        min={0}
        max={Math.max(0, stepCount - 1)}
        step={1}
        value={stepIndex}
        disabled={!multi}
        onChange={(event) => setStep(Number(event.target.value))}
      />
      <span className="w-28 shrink-0 text-right text-xs tabular-nums text-ink">
        {formatClock(results.times[stepIndex] ?? 0)}
        <span className="text-ink-muted"> / {formatClock(results.times[stepCount - 1] ?? 0)}</span>
      </span>
      {stale && (
        <span className="shrink-0 rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] text-warn" title="관망을 편집한 뒤 다시 해석하지 않았습니다.">
          편집 전 결과
        </span>
      )}
    </div>
  );
}

function IssueRow({ issue, active }: { issue: ValidationIssue; active: boolean }) {
  return (
    <li
      className={`group flex cursor-pointer items-center gap-2 border-b border-line/60 px-3 py-1.5 text-xs hover:bg-raised ${
        active ? 'bg-raised' : ''
      }`}
      onClick={() => focusIssue(issue)}
    >
      {issue.severity === 'error' ? (
        <CircleExclamationPoint size={14} className="shrink-0 text-critical" />
      ) : (
        <TriangleExclamationPoint size={14} className="shrink-0 text-warn" />
      )}
      <span className="w-20 shrink-0 text-ink-soft">{ISSUE_TYPE_LABELS[issue.type]}</span>
      <span className="min-w-0 flex-1 truncate text-ink" title={issue.message}>
        {issue.message}
      </span>
      {(issue.nodeIds.length > 0 || issue.linkIds.length > 0) && (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-soft opacity-0 hover:border-accent hover:text-ink group-hover:opacity-100 focus:opacity-100"
          title="관련 객체를 다중 선택 (우측 패널에서 일괄 삭제·편집)"
          onClick={(event) => {
            event.stopPropagation();
            selectIssueObjects([issue]);
          }}
        >
          <SquareDashedMousePointer size={11} /> 선택
        </button>
      )}
      {issue.fixable && (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-soft opacity-0 hover:border-accent hover:text-ink group-hover:opacity-100 focus:opacity-100"
          title="이 항목만 자동 보정"
          onClick={(event) => {
            event.stopPropagation();
            void fixSingleIssue(issue);
          }}
        >
          <Wrench size={11} /> 보정
        </button>
      )}
    </li>
  );
}

function ValidationPanel() {
  const status = useValidationStore((s) => s.status);
  const issues = useValidationStore((s) => s.issues);
  const activeIssueId = useValidationStore((s) => s.activeIssueId);
  const checkedRevision = useValidationStore((s) => s.checkedRevision);
  const revision = useNetworkStore((s) => s.revision);
  const openModal = useUIStore((s) => s.openModal);

  const sorted = useMemo(() => {
    const order = new Map(ISSUE_TYPE_ORDER.map((type, index) => [type, index]));
    return [...issues].sort((a, b) => (order.get(a.type) ?? 0) - (order.get(b.type) ?? 0));
  }, [issues]);
  const fixableCount = useMemo(() => issues.filter((i) => i.fixable).length, [issues]);
  const disconnected = useMemo(() => issues.filter((i) => i.type === 'disconnected'), [issues]);
  const stale = status === 'done' && checkedRevision !== revision;

  if (status === 'idle') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-ink-muted">
        <span>고립 절점, 중복·미소 관로, 단절 구역, 교차 미분할 지점을 자동으로 찾습니다.</span>
        <Button variant="primary" onClick={() => void runNetworkValidation()}>
          관망 검증 실행
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
        {status === 'running' ? (
          <span className="text-ink-soft">검증 중…</span>
        ) : issues.length === 0 ? (
          <span className="inline-flex items-center gap-1.5 text-ink">
            <CircleCheck size={14} className="text-good" /> 오류가 없습니다.
          </span>
        ) : (
          <span className="text-ink">
            오류 {issues.length.toLocaleString()}건 <span className="text-ink-muted">· 자동 보정 가능 {fixableCount.toLocaleString()}건</span>
          </span>
        )}
        {stale && <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] text-warn">편집 후 다시 검증 필요</span>}
        <div className="ml-auto flex gap-1.5">
          {disconnected.length > 0 && (
            <Button
              disabled={stale}
              title="수원에 연결되지 않은 블록의 절점·관로를 모두 선택합니다. 우측 패널에서 한 번에 삭제할 수 있습니다."
              onClick={() => selectIssueObjects(disconnected)}
            >
              <SquareDashedMousePointer size={12} /> 단절 구역 {disconnected.length}곳 선택
            </Button>
          )}
          <Button onClick={() => void runNetworkValidation(false)} disabled={status === 'running'}>
            다시 검증
          </Button>
          <Button variant="primary" disabled={fixableCount === 0 || stale} onClick={() => openModal('validation')}>
            <Wrench size={12} /> 일괄 보정…
          </Button>
        </div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {sorted.slice(0, MAX_LISTED_ISSUES).map((issue) => (
          <IssueRow key={issue.id} issue={issue} active={issue.id === activeIssueId} />
        ))}
        {sorted.length > MAX_LISTED_ISSUES && (
          <li className="px-3 py-2 text-[11px] text-ink-muted">
            외 {(sorted.length - MAX_LISTED_ISSUES).toLocaleString()}건 — 일괄 보정 후 다시 검증하면 나머지가 표시됩니다.
          </li>
        )}
      </ul>
    </div>
  );
}

function LogPanel() {
  const log = useSimulationStore((s) => s.log);
  if (log.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-ink-muted">해석을 실행하면 엔진 메시지와 경고가 여기에 기록됩니다.</div>;
  }
  return (
    <ul className="h-full overflow-y-auto px-3 py-2 text-xs leading-relaxed">
      {log.map((entry, index) => (
        <li key={index} className="flex gap-2 py-0.5">
          {entry.level === 'error' ? (
            <CircleExclamationPoint size={14} className="mt-0.5 shrink-0 text-critical" />
          ) : entry.level === 'warning' ? (
            <TriangleExclamationPoint size={14} className="mt-0.5 shrink-0 text-warn" />
          ) : (
            <Info size={14} className="mt-0.5 shrink-0 text-ink-muted" />
          )}
          <span className={`break-all ${entry.level === 'info' ? 'text-ink-soft' : 'text-ink'}`}>{entry.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** 하단 도크: 시간 슬라이더, 시계열 차트, 관망 검증 결과, 해석 로그. */
export function BottomTimelineDock() {
  const tab = useUIStore((s) => s.bottomTab);
  const setTab = useUIStore((s) => s.setBottomTab);
  const collapsed = useUIStore((s) => s.bottomCollapsed);
  const setCollapsed = useUIStore((s) => s.setBottomCollapsed);
  const issueCount = useValidationStore((s) => s.issues.length);
  const logAlerts = useSimulationStore((s) => s.log.filter((entry) => entry.level !== 'info').length);

  const tabs: { id: BottomTab; label: string; badge?: number }[] = [
    { id: 'timeline', label: '시계열' },
    { id: 'profile', label: '종단면도' },
    { id: 'table', label: '결과 표' },
    { id: 'validation', label: '관망 검증 결과', badge: issueCount },
    { id: 'log', label: '해석 로그', badge: logAlerts },
  ];

  return (
    <section className={`flex shrink-0 flex-col border-t border-line bg-panel ${collapsed ? 'h-10' : 'h-64'}`}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <div className="flex shrink-0 items-center" role="tablist">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id && !collapsed}
              onClick={() => setTab(item.id)}
              className={`inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-xs transition-colors ${
                tab === item.id && !collapsed ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink-soft'
              }`}
            >
              {item.label}
              {item.badge ? (
                <span className="rounded-full bg-raised px-1.5 text-[10px] tabular-nums text-ink-soft">{item.badge.toLocaleString()}</span>
              ) : null}
            </button>
          ))}
        </div>
        <span className="mx-2 h-5 w-px shrink-0 bg-line" />
        <TimeControls />
        <button
          type="button"
          className="ml-1 shrink-0 rounded p-1 text-ink-muted hover:bg-raised hover:text-ink"
          title={collapsed ? '패널 펼치기' : '패널 접기'}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </div>
      {!collapsed && (
        <div className="min-h-0 flex-1">
          {tab === 'timeline' && <TimeSeriesPanel />}
          {tab === 'profile' && <ProfilePanel />}
          {tab === 'table' && <ResultsTablePanel />}
          {tab === 'validation' && <ValidationPanel />}
          {tab === 'log' && <LogPanel />}
        </div>
      )}
    </section>
  );
}
