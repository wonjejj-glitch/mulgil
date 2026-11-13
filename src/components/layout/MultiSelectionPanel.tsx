import { Mountain, Scan, Trash, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { deleteMultiSelection, focusObjects } from '../../app/actions';
import type { NetworkLink, NetworkModel, NetworkNode, PipeStatus } from '../../core/model/types';
import { formatNumber, roughnessLabel, unitLabels } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useUIStore, type MultiSelection } from '../../store/useUIStore';
import { distanceMeters } from '../../utils/geoMath';
import { Button, FieldRow, Section, SelectField } from '../ui/fields';

const INPUT_CLASS =
  'h-7 w-full min-w-0 rounded border border-line bg-field px-2 text-xs tabular-nums text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent';

/** 모든 값이 같으면 그 값, 다르면 undefined. */
function common<T>(values: T[]): T | undefined {
  if (values.length === 0) return undefined;
  const first = values[0];
  return values.every((v) => v === first) ? first : undefined;
}

/** 여러 객체의 숫자 속성 입력: 값이 섞여 있으면 비워 두고 '여러 값'을 보인다. 입력한 값은 모두에게 적용. */
function BulkNumberField({ values, onCommit, min }: { values: number[]; onCommit: (value: number) => void; min?: number }) {
  const shared = common(values);
  const initial = shared === undefined ? '' : String(shared);
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);
  const commit = () => {
    if (draft.trim() === '' || draft === initial) {
      setDraft(initial);
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || (min !== undefined && parsed < min)) {
      setDraft(initial);
      return;
    }
    onCommit(parsed);
  };
  return (
    <input
      type="number"
      step="any"
      className={INPUT_CLASS}
      value={draft}
      placeholder={values.length > 0 ? `여러 값 (${formatNumber(Math.min(...values))}~${formatNumber(Math.max(...values))})` : ''}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(initial);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

const MIXED = '__mixed__';

/** 서로 멀리 떨어진 두 절점 (두 번 훑기 근사). */
function farthestPair(nodes: NetworkNode[]): string[] {
  const farthestFrom = (origin: NetworkNode) => {
    let best = origin;
    let bestDistance = -1;
    for (const node of nodes) {
      const d = distanceMeters(origin.position, node.position);
      if (d > bestDistance) {
        best = node;
        bestDistance = d;
      }
    }
    return best;
  };
  const a = farthestFrom(nodes[0]);
  const b = farthestFrom(a);
  return [a.id, b.id];
}

function selected(model: NetworkModel, multi: MultiSelection) {
  const nodes = multi.nodeIds.map((id) => model.nodes[id]).filter((n): n is NetworkNode => n !== undefined);
  const links = multi.linkIds.map((id) => model.links[id]).filter((l): l is NetworkLink => l !== undefined);
  return {
    nodes,
    links,
    junctions: nodes.filter((n) => n.type === 'junction'),
    pipes: links.filter((l) => l.type === 'pipe'),
  };
}

/** 우측 패널: 다중 선택 요약과 일괄 속성 편집. */
export function MultiSelectionPanel({ multi }: { multi: MultiSelection }) {
  const model = useNetworkStore((s) => s.model);
  const commit = useNetworkStore((s) => s.commit);
  const labels = unitLabels(model.options.flowUnits);
  const sel = useMemo(() => selected(model, multi), [model, multi]);
  const [scale, setScale] = useState('1.1');

  const patternOptions = useMemo(
    () => [{ value: MIXED, label: '(여러 값)' }, { value: '', label: '(없음)' }, ...Object.keys(model.patterns).map((id) => ({ value: id, label: id }))],
    [model.patterns],
  );
  const statusOptions: { value: PipeStatus | typeof MIXED; label: string }[] = [
    { value: MIXED, label: '(여러 값)' },
    { value: 'Open', label: '개방 (Open)' },
    { value: 'Closed', label: '폐쇄 (Closed)' },
    { value: 'CV', label: '체크밸브 (CV)' },
  ];

  const junctionIds = sel.junctions.map((n) => n.id);
  const pipeIds = sel.pipes.map((l) => l.id);
  const updateJunctions = (recipe: (node: Extract<NetworkNode, { type: 'junction' }>) => void) =>
    commit((draft) => {
      for (const id of junctionIds) {
        const node = draft.nodes[id];
        if (node?.type === 'junction') recipe(node);
      }
    });
  const updatePipes = (recipe: (link: Extract<NetworkLink, { type: 'pipe' }>) => void) =>
    commit((draft) => {
      for (const id of pipeIds) {
        const link = draft.links[id];
        if (link?.type === 'pipe') recipe(link);
      }
    });

  const totalLength = sel.pipes.reduce((sum, p) => sum + (p.type === 'pipe' ? p.length : 0), 0);
  const totalDemand = sel.junctions.reduce((sum, n) => sum + (n.type === 'junction' ? n.demand : 0), 0);
  const ui = useUIStore.getState;
  const scaleValue = Number(scale);

  return (
    <>
      <Section
        title="다중 선택"
        action={
          <button type="button" title="선택 해제 (Esc)" className="text-ink-muted hover:text-ink" onClick={() => ui().setMultiSelection(null)}>
            <X size={14} />
          </button>
        }
      >
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
          <span className="text-ink-soft">절점</span>
          <span className="text-right tabular-nums text-ink">{sel.junctions.length.toLocaleString()}개</span>
          <span className="text-ink-soft">수원지·배수지</span>
          <span className="text-right tabular-nums text-ink">{(sel.nodes.length - sel.junctions.length).toLocaleString()}개</span>
          <span className="text-ink-soft">관로</span>
          <span className="text-right tabular-nums text-ink">{sel.pipes.length.toLocaleString()}개</span>
          <span className="text-ink-soft">펌프·밸브</span>
          <span className="text-right tabular-nums text-ink">{(sel.links.length - sel.pipes.length).toLocaleString()}개</span>
          <span className="text-ink-soft">관로 연장 합계</span>
          <span className="text-right tabular-nums text-ink">
            {formatNumber(totalLength, 0)} {labels.length}
          </span>
          <span className="text-ink-soft">수요량 합계</span>
          <span className="text-right tabular-nums text-ink">
            {formatNumber(totalDemand)} {labels.flow}
          </span>
        </div>
        <div className="mt-2.5 flex gap-1.5">
          <Button className="flex-1" onClick={() => focusObjects({ nodeIds: multi.nodeIds, linkIds: multi.linkIds })} title="선택 범위로 지도 이동">
            <Scan size={13} />
            위치 보기
          </Button>
          <Button
            className="flex-1"
            disabled={sel.nodes.length < 2}
            title="선택 절점 중 서로 가장 먼 두 절점으로 종단면도를 그립니다"
            onClick={() => {
              ui().setProfileWaypoints(farthestPair(sel.nodes));
              ui().setBottomTab('profile');
            }}
          >
            <Mountain size={13} />
            종단면도
          </Button>
        </div>
      </Section>

      {sel.junctions.length > 0 && (
        <Section title={`절점 일괄 편집 (${sel.junctions.length.toLocaleString()})`}>
          <FieldRow label="표고" unit={labels.elevation}>
            <BulkNumberField values={sel.junctions.map((n) => n.elevation)} onCommit={(v) => updateJunctions((n) => void (n.elevation = v))} />
          </FieldRow>
          <FieldRow label="기본 수요량" unit={labels.flow}>
            <BulkNumberField
              values={sel.junctions.map((n) => (n.type === 'junction' ? n.demand : 0))}
              onCommit={(v) => updateJunctions((n) => void (n.demand = v))}
            />
          </FieldRow>
          <FieldRow label="수요 패턴">
            <SelectField
              value={common(sel.junctions.map((n) => (n.type === 'junction' ? n.pattern : ''))) ?? MIXED}
              options={patternOptions.map((o) => ({ ...o, disabled: o.value === MIXED }))}
              onChange={(pattern) => {
                if (pattern !== MIXED) updateJunctions((n) => void (n.pattern = pattern));
              }}
            />
          </FieldRow>
          <FieldRow label="수요량 배율 ×" plain>
            <div className="flex gap-1.5">
              <input type="number" step="any" min={0} className={INPUT_CLASS} value={scale} onChange={(event) => setScale(event.target.value)} />
              <Button
                disabled={!(scaleValue >= 0) || scaleValue === 1}
                title="선택 절점의 기본 수요량에 배율을 곱합니다 (장래 수요 증가 검토 등)"
                onClick={() => updateJunctions((n) => void (n.demand = Number((n.demand * scaleValue).toPrecision(10))))}
              >
                적용
              </Button>
            </div>
          </FieldRow>
        </Section>
      )}

      {sel.pipes.length > 0 && (
        <Section title={`관로 일괄 편집 (${sel.pipes.length.toLocaleString()})`}>
          <FieldRow label="관경" unit={labels.diameter}>
            <BulkNumberField
              min={0}
              values={sel.pipes.map((l) => (l.type === 'pipe' ? l.diameter : 0))}
              onCommit={(v) => updatePipes((l) => void (l.diameter = v))}
            />
          </FieldRow>
          <FieldRow label={roughnessLabel(model.options.headloss, model.options.flowUnits)}>
            <BulkNumberField
              min={0}
              values={sel.pipes.map((l) => (l.type === 'pipe' ? l.roughness : 0))}
              onCommit={(v) => updatePipes((l) => void (l.roughness = v))}
            />
          </FieldRow>
          <FieldRow label="부차손실계수">
            <BulkNumberField
              min={0}
              values={sel.pipes.map((l) => (l.type === 'pipe' ? l.minorLoss : 0))}
              onCommit={(v) => updatePipes((l) => void (l.minorLoss = v))}
            />
          </FieldRow>
          <FieldRow label="초기 상태">
            <SelectField
              value={common(sel.pipes.map((l) => (l.type === 'pipe' ? l.status : 'Open'))) ?? MIXED}
              options={statusOptions.map((o) => ({ ...o, disabled: o.value === MIXED }))}
              onChange={(status) => {
                if (status !== MIXED) updatePipes((l) => void (l.status = status));
              }}
            />
          </FieldRow>
        </Section>
      )}

      <div className="px-3 py-3 text-[11px] leading-relaxed text-ink-muted">
        Ctrl/Shift+클릭으로 객체를 넣고 뺄 수 있습니다. 구역 선택(A)에서 Shift 를 누른 채 다각형을 닫으면 기존 선택에 더합니다. 일괄 편집은 실행
        취소(Ctrl+Z) 한 번으로 되돌릴 수 있습니다.
      </div>

      <div className="mt-auto border-t border-line p-3">
        <Button variant="danger" className="w-full" onClick={deleteMultiSelection}>
          <Trash size={13} />
          선택 삭제 ({(multi.nodeIds.length + multi.linkIds.length).toLocaleString()}개, 연결 링크 포함)
        </Button>
      </div>
    </>
  );
}
