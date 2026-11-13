import { CircleCheck, CircleX, LoaderCircle, TriangleExclamationPoint } from 'lucide-react';
import { useMemo, useState } from 'react';
import { applyValidationFixes, runNetworkValidation } from '../../app/actions';
import { ISSUE_TYPE_LABELS, ISSUE_TYPE_ORDER, type ValidationIssueType } from '../../core/validation';
import type { AutoFixSelection } from '../../core/validation/autoFix';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useUIStore } from '../../store/useUIStore';
import { useValidationStore } from '../../store/useValidationStore';
import { Button, NumberField } from '../ui/fields';
import { Modal } from '../ui/Modal';

interface FixInfo {
  /** 자동 보정을 지원하는 유형인지. */
  auto: boolean;
  severity: 'error' | 'warning';
  text: string;
}

const FIX_INFO: Record<ValidationIssueType, FixInfo> = {
  noSource: { auto: false, severity: 'error', text: '수동 조치 — 수원지 또는 배수지를 추가해야 합니다.' },
  disconnected: { auto: false, severity: 'error', text: '수동 조치 — 수원과 잇는 관로를 추가하거나 해당 구역을 삭제하세요.' },
  orphanNode: { auto: true, severity: 'error', text: '고립 절점을 삭제합니다.' },
  selfLoop: { auto: true, severity: 'error', text: '시점과 종점이 같은 링크를 삭제합니다.' },
  duplicatePipe: { auto: true, severity: 'warning', text: '나중에 정의된 중복 관로를 삭제합니다.' },
  microPipe: { auto: true, severity: 'warning', text: '양 끝 절점을 하나로 합칩니다 (수요량은 합산).' },
  crossing: {
    auto: true,
    severity: 'warning',
    text: '교차점에 절점을 만들고 두 관로를 분할합니다. 입체 교차(실제로는 연결되지 않은 관로)일 수 있으니 확인 후 적용하세요.',
  },
  tee: { auto: true, severity: 'warning', text: '절점 위치에서 관로를 분할해 연결합니다.' },
};

/** 교차 미분할은 정상적인 입체 교차일 수 있어 기본으로는 보정 대상에서 뺀다. */
const DEFAULT_CHECKED: Record<ValidationIssueType, boolean> = {
  noSource: false,
  disconnected: false,
  orphanNode: true,
  selfLoop: true,
  duplicatePipe: true,
  microPipe: true,
  crossing: false,
  tee: true,
};

function emptyCounts(): Record<ValidationIssueType, number> {
  return { noSource: 0, disconnected: 0, orphanNode: 0, selfLoop: 0, duplicatePipe: 0, microPipe: 0, crossing: 0, tee: 0 };
}

function ValidationDialog() {
  const status = useValidationStore((s) => s.status);
  const issues = useValidationStore((s) => s.issues);
  const checkedRevision = useValidationStore((s) => s.checkedRevision);
  const microPipeLength = useValidationStore((s) => s.options.microPipeLength);
  const setOptions = useValidationStore((s) => s.setOptions);
  const revision = useNetworkStore((s) => s.revision);
  const [checked, setChecked] = useState(DEFAULT_CHECKED);
  const [applying, setApplying] = useState(false);

  const counts = useMemo(() => {
    const total = emptyCounts();
    const fixable = emptyCounts();
    for (const issue of issues) {
      total[issue.type]++;
      if (issue.fixable) fixable[issue.type]++;
    }
    return { total, fixable };
  }, [issues]);

  const running = status === 'running';
  const busy = running || applying;
  const stale = status === 'done' && checkedRevision !== revision;
  const selectedTypes = ISSUE_TYPE_ORDER.filter((type) => FIX_INFO[type].auto && checked[type] && counts.fixable[type] > 0);
  const selectedCount = selectedTypes.reduce((sum, type) => sum + counts.fixable[type], 0);

  const close = () => useUIStore.getState().openModal(null);
  const apply = async () => {
    if (busy || selectedCount === 0) return;
    const selection: AutoFixSelection = {};
    for (const type of selectedTypes) selection[type] = true;
    setApplying(true);
    try {
      await applyValidationFixes(selection);
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal
      title="관망 검증 및 일괄 보정"
      onClose={close}
      widthClass="w-[640px]"
      footer={
        <>
          <span className="mr-auto text-[11px] text-ink-muted">보정은 실행 취소(Ctrl+Z) 한 번으로 되돌릴 수 있습니다.</span>
          <Button
            onClick={() => {
              close();
              useUIStore.getState().setBottomTab('validation');
            }}
          >
            목록에서 보기
          </Button>
          <Button variant="primary" disabled={busy || stale || selectedCount === 0} onClick={() => void apply()}>
            {applying && <LoaderCircle size={13} className="animate-spin" />}
            선택 항목 보정 ({selectedCount.toLocaleString()}건)
          </Button>
        </>
      }
    >
      {status === 'idle' && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-line bg-raised px-3 py-2.5 text-xs text-ink-soft">
          <span>아직 관망 검증을 실행하지 않았습니다.</span>
          <Button variant="primary" onClick={() => void runNetworkValidation(false)}>
            관망 검증 실행
          </Button>
        </div>
      )}
      {running && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-line bg-raised px-3 py-2.5 text-xs text-ink-soft">
          <LoaderCircle size={14} className="animate-spin text-accent" />
          검증 중…
        </div>
      )}
      {status === 'error' && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-critical/60 bg-critical/10 px-3 py-2.5 text-xs text-ink">
          <CircleX size={14} className="shrink-0 text-critical" />
          관망 검증에 실패했습니다. 다시 검증을 눌러 주세요.
        </div>
      )}
      {status === 'done' && issues.length === 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-good/50 bg-good/10 px-3 py-2.5 text-xs text-ink">
          <CircleCheck size={14} className="shrink-0 text-good" />
          오류가 발견되지 않았습니다.
        </div>
      )}
      {stale && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-warn/50 bg-warn/10 px-3 py-2.5 text-xs text-ink">
          <TriangleExclamationPoint size={14} className="shrink-0 text-warn" />
          검증 이후 관망이 수정되었습니다. 다시 검증한 뒤 보정하세요.
        </div>
      )}

      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-left text-[11px] text-ink-muted">
            <th className="w-7 pb-1.5 font-medium">
              <span className="sr-only">보정 선택</span>
            </th>
            <th className="pb-1.5 font-medium">오류 유형</th>
            <th className="w-12 pb-1.5 text-right font-medium">건수</th>
            <th className="pb-1.5 pl-4 font-medium">보정 방법</th>
          </tr>
        </thead>
        <tbody>
          {ISSUE_TYPE_ORDER.map((type) => {
            const info = FIX_INFO[type];
            const count = counts.total[type];
            const canFix = info.auto && counts.fixable[type] > 0;
            const Icon = info.severity === 'error' ? CircleX : TriangleExclamationPoint;
            return (
              <tr key={type} className={`border-t border-line align-top ${count === 0 ? 'opacity-45' : ''}`}>
                <td className="py-2">
                  {canFix && (
                    <input
                      type="checkbox"
                      aria-label={`${ISSUE_TYPE_LABELS[type]} 자동 보정`}
                      className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-accent"
                      checked={checked[type]}
                      disabled={busy}
                      onChange={(event) => setChecked((previous) => ({ ...previous, [type]: event.target.checked }))}
                    />
                  )}
                </td>
                <td className="whitespace-nowrap py-2 pr-2 text-ink">
                  <span className="inline-flex items-center gap-1.5">
                    <Icon
                      size={13}
                      className={info.severity === 'error' ? 'text-critical' : 'text-warn'}
                      aria-label={info.severity === 'error' ? '오류' : '경고'}
                    />
                    {ISSUE_TYPE_LABELS[type]}
                  </span>
                </td>
                <td className="py-2 text-right tabular-nums text-ink">{count.toLocaleString()}</td>
                <td className="py-2 pl-4 leading-relaxed text-ink-soft">{info.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          미소 관로 기준
          <span className="w-20">
            <NumberField value={microPipeLength} min={0.01} step={0.1} disabled={busy} onCommit={(value) => setOptions({ microPipeLength: value })} />
          </span>
          <span className="text-ink-muted">m 미만</span>
        </label>
        <span className="text-[11px] text-ink-muted">다음 검증부터 적용됩니다.</span>
        <Button className="ml-auto" disabled={busy} onClick={() => void runNetworkValidation(false)}>
          다시 검증
        </Button>
      </div>
    </Modal>
  );
}

/** 관망 오류 요약과 유형별 일괄 보정(Auto-fix) 대화상자. */
export function ValidationModal() {
  const open = useUIStore((s) => s.modal === 'validation');
  return open ? <ValidationDialog /> : null;
}
