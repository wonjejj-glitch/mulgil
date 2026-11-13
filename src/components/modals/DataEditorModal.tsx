import { CircleCheck, Plus, Trash, TriangleExclamationPoint } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  buildControlLine,
  checkControls,
  checkCurve,
  curveUsages,
  deleteCurve,
  renameCurve,
  type ControlAction,
  type ControlTrigger,
} from '../../core/model/curvesControls';
import { nextId } from '../../core/model/networkEdit';
import { unitLabels } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useUIStore } from '../../store/useUIStore';
import { Button, NumberField, SelectField, TextField } from '../ui/fields';
import { Modal } from '../ui/Modal';

const USAGE_LABEL = { pump: '펌프', tank: '배수지', valve: 'GPV 밸브' } as const;

function Note({ tone = 'muted', children }: { tone?: 'muted' | 'warn' | 'good'; children: ReactNode }) {
  const icon =
    tone === 'warn' ? (
      <TriangleExclamationPoint size={13} className="mt-px shrink-0 text-warn" />
    ) : tone === 'good' ? (
      <CircleCheck size={13} className="mt-px shrink-0 text-good" />
    ) : null;
  return <p className={`mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed ${tone === 'muted' ? 'text-ink-muted' : 'text-ink'}`}>{icon}{children}</p>;
}

/* ------------------------------------------------------------------ 곡선 */

function CurvePointsEditor({ curveId, points, pumpCurve }: { curveId: string; points: [number, number][]; pumpCurve: boolean }) {
  const commit = useNetworkStore((s) => s.commit);
  const setPoint = (index: number, axis: 0 | 1, value: number) =>
    commit((draft) => {
      const list = draft.curves[curveId];
      if (list?.[index]) list[index][axis] = value;
    });
  const addPoint = () =>
    commit((draft) => {
      const list = draft.curves[curveId];
      if (!list) return;
      const last = list[list.length - 1] ?? [0, 0];
      list.push([
        Number((last[0] + (last[0] > 0 ? last[0] * 0.5 : 10)).toPrecision(6)),
        Number((pumpCurve ? Math.max(0, last[1] * 0.7) : last[1] * 1.5 + 1).toPrecision(6)),
      ]);
    });
  const removePoint = (index: number) =>
    commit((draft) => {
      const list = draft.curves[curveId];
      if (list && list.length > 1) list.splice(index, 1);
    });
  return (
    <div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[11px] text-ink-muted">
            <th className="w-8 pb-1 text-left font-normal">#</th>
            <th className="pb-1 text-left font-normal">X</th>
            <th className="pb-1 text-left font-normal">Y</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {points.map(([x, y], index) => (
            <tr key={index}>
              <td className="py-0.5 text-ink-muted">{index + 1}</td>
              <td className="py-0.5 pr-1.5">
                <NumberField value={x} onCommit={(value) => setPoint(index, 0, value)} />
              </td>
              <td className="py-0.5 pr-1.5">
                <NumberField value={y} onCommit={(value) => setPoint(index, 1, value)} />
              </td>
              <td className="py-0.5">
                <button
                  type="button"
                  aria-label={`${index + 1}번째 점 삭제`}
                  disabled={points.length <= 1}
                  onClick={() => removePoint(index)}
                  className="rounded p-1 text-ink-muted hover:bg-critical/20 hover:text-[#f3a5a5] disabled:opacity-30"
                >
                  <Trash size={13} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Button className="mt-1.5" onClick={addPoint}>
        <Plus size={13} />점 추가
      </Button>
    </div>
  );
}

function CurvesTab() {
  const curves = useNetworkStore((s) => s.model.curves);
  const model = useNetworkStore((s) => s.model);
  const commit = useNetworkStore((s) => s.commit);
  const flowUnits = useNetworkStore((s) => s.model.options.flowUnits);
  const labels = unitLabels(flowUnits);
  const ids = Object.keys(curves);
  const [activeId, setActiveId] = useState<string | null>(ids[0] ?? null);
  const active = activeId && activeId in curves ? activeId : (ids[0] ?? null);
  const usages = useMemo(() => (active ? curveUsages(model, active) : []), [model, active]);
  const points = active ? curves[active] : [];
  // 아직 아무도 쓰지 않는 곡선은 모양으로 종류를 짐작한다 (1점 또는 우하향 = 양정 곡선).
  const tankCurve = usages.some((u) => u.kind === 'tank');
  const pumpCurve =
    usages.some((u) => u.kind === 'pump') ||
    (!tankCurve && usages.length === 0 && (points.length === 1 || (points.length > 1 && points[points.length - 1][1] < points[0][1])));
  const check = active ? checkCurve(points, pumpCurve) : null;
  const pushToast = useUIStore((s) => s.pushToast);

  const add = (kind: 'pump' | 'volume') => {
    let newId = '';
    commit((draft) => {
      newId = nextId(kind === 'pump' ? 'PC' : 'VC', draft.curves);
      // 펌프: 설계점 1점 곡선(EPANET 이 차단 양정 133%·최대 유량 200% 로 확장), 체적: 수위-체적 2점
      draft.curves[newId] = kind === 'pump' ? [[flowUnits === 'CMD' ? 1000 : 10, 40]] : [[0, 0], [5, 500]];
    });
    setActiveId(newId);
  };

  const xLabel = pumpCurve ? `유량 (${labels.flow})` : tankCurve ? `수위 (${labels.elevation})` : 'X';
  const yLabel = pumpCurve ? `양정 (${labels.elevation})` : tankCurve ? `체적 (${labels.elevation === 'm' ? 'm³' : 'ft³'})` : 'Y';

  return (
    <div className="grid grid-cols-[180px_1fr] gap-4">
      <div>
        <ul className="max-h-80 space-y-0.5 overflow-y-auto">
          {ids.length === 0 && <li className="text-[11px] text-ink-muted">곡선이 없습니다.</li>}
          {ids.map((id) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => setActiveId(id)}
                className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs ${
                  id === active ? 'bg-accent-strong text-white' : 'text-ink-soft hover:bg-raised hover:text-ink'
                }`}
              >
                <span className="truncate">{id}</span>
                <span className="text-[10px] opacity-70">{curves[id].length}점</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-col gap-1.5">
          <Button onClick={() => add('pump')}>
            <Plus size={13} />
            펌프 양정 곡선
          </Button>
          <Button onClick={() => add('volume')}>
            <Plus size={13} />
            배수지 체적 곡선
          </Button>
        </div>
      </div>

      {active ? (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="w-40">
              <TextField
                value={active}
                onCommit={(next) => {
                  let ok = false;
                  commit((draft) => {
                    ok = renameCurve(draft, active, next);
                  });
                  if (!ok) {
                    pushToast({ level: 'warning', title: '곡선 ID 를 바꿀 수 없습니다', message: '이미 있는 ID 이거나 허용되지 않는 형식입니다.' });
                    return false;
                  }
                  setActiveId(next);
                  return true;
                }}
              />
            </div>
            <span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
              {usages.length === 0 ? '사용하는 객체 없음' : `사용: ${usages.map((u) => `${USAGE_LABEL[u.kind]} ${u.id}`).join(', ')}`}
            </span>
            <button
              type="button"
              title="곡선 삭제 (펌프는 정동력 펌프로 바뀝니다)"
              aria-label={`곡선 ${active} 삭제`}
              onClick={() => commit((draft) => deleteCurve(draft, active))}
              className="rounded p-1.5 text-ink-muted hover:bg-critical/20 hover:text-[#f3a5a5]"
            >
              <Trash size={14} />
            </button>
          </div>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4">
            <CurvePointsEditor curveId={active} points={points} pumpCurve={pumpCurve} />
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={points.map(([x, y]) => ({ x, y }))} margin={{ top: 6, right: 8, bottom: 14, left: 0 }}>
                  <CartesianGrid stroke="#2a313b" vertical={false} />
                  <XAxis
                    dataKey="x"
                    type="number"
                    domain={[0, 'dataMax']}
                    tick={{ fill: '#8b8a84', fontSize: 10 }}
                    stroke="#2a313b"
                    label={{ value: xLabel, fill: '#8b8a84', fontSize: 10, position: 'insideBottom', offset: -8 }}
                  />
                  <YAxis
                    width={44}
                    tick={{ fill: '#8b8a84', fontSize: 10 }}
                    stroke="#2a313b"
                    domain={[0, 'auto']}
                    label={{ value: yLabel, fill: '#8b8a84', fontSize: 10, angle: -90, position: 'insideLeft', offset: 12 }}
                  />
                  <Tooltip
                    isAnimationActive={false}
                    contentStyle={{ background: '#161a20', border: '1px solid #2a313b', borderRadius: 6, fontSize: 12 }}
                    labelFormatter={(x) => `X ${x}`}
                    formatter={(value) => [value, 'Y']}
                  />
                  <Line type="monotone" dataKey="y" stroke="#3987e5" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          {check && !check.ok && <Note tone="warn">{check.message}</Note>}
          {check?.ok && <Note tone="good">EPANET 이 받아들이는 형식입니다.</Note>}
          {pumpCurve && points.length === 1 && (
            <Note>1점 곡선은 설계점으로 보고, 엔진이 체절 양정(설계 양정의 133%)과 최대 유량(설계 유량의 200%)으로 곡선을 만듭니다.</Note>
          )}
        </div>
      ) : (
        <div className="flex items-center text-xs text-ink-muted">왼쪽에서 곡선을 추가하세요. 펌프의 양정 곡선, 배수지의 체적 곡선으로 지정할 수 있습니다.</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 제어 규칙 */

function ControlBuilder({ onAdd }: { onAdd: (line: string) => void }) {
  const links = useNetworkStore((s) => s.model.links);
  const nodes = useNetworkStore((s) => s.model.nodes);
  const linkIds = useMemo(() => Object.keys(links), [links]);
  const tankIds = useMemo(() => Object.keys(nodes).filter((id) => nodes[id].type !== 'reservoir'), [nodes]);
  const [linkId, setLinkId] = useState(linkIds.find((id) => links[id].type !== 'pipe') ?? linkIds[0] ?? '');
  const [action, setAction] = useState<ControlAction>('CLOSED');
  const [setting, setSetting] = useState(1);
  const [triggerKind, setTriggerKind] = useState<ControlTrigger['kind']>('node');
  const [hours, setHours] = useState(6);
  const [nodeId, setNodeId] = useState(tankIds.find((id) => nodes[id].type === 'tank') ?? tankIds[0] ?? '');
  const [comparison, setComparison] = useState<'ABOVE' | 'BELOW'>('ABOVE');
  const [value, setValue] = useState(4);
  useEffect(() => {
    if (!(linkId in links)) setLinkId(linkIds[0] ?? '');
  }, [linkId, links, linkIds]);

  const trigger: ControlTrigger =
    triggerKind === 'node' ? { kind: 'node', nodeId, comparison, value } : { kind: triggerKind, hours };
  const preview = linkId ? buildControlLine(linkId, action, setting, trigger) : '';
  const disabled = !linkId || (triggerKind === 'node' && !nodeId);
  const isTank = nodes[nodeId]?.type === 'tank';

  return (
    <div className="rounded-md border border-line bg-raised/40 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
        <span>링크</span>
        <div className="w-28">
          <SelectField value={linkId} options={linkIds.map((id) => ({ value: id, label: `${id} (${links[id].type === 'pipe' ? '관로' : links[id].type === 'pump' ? '펌프' : '밸브'})` }))} onChange={setLinkId} />
        </div>
        <span>을(를)</span>
        <div className="w-28">
          <SelectField
            value={action}
            options={[
              { value: 'OPEN', label: '개방/가동' },
              { value: 'CLOSED', label: '폐쇄/정지' },
              { value: 'SETTING', label: '설정값 변경' },
            ]}
            onChange={setAction}
          />
        </div>
        {action === 'SETTING' && (
          <div className="w-20">
            <NumberField value={setting} onCommit={setSetting} />
          </div>
        )}
        <div className="w-32">
          <SelectField
            value={triggerKind}
            options={[
              { value: 'node', label: '절점 조건일 때' },
              { value: 'time', label: '모의 경과 시각에' },
              { value: 'clock', label: '하루 중 시각에' },
            ]}
            onChange={setTriggerKind}
          />
        </div>
        {triggerKind === 'node' ? (
          <>
            <div className="w-24">
              <SelectField value={nodeId} options={tankIds.map((id) => ({ value: id, label: id }))} onChange={setNodeId} />
            </div>
            <span>{isTank ? '수위가' : '수압이'}</span>
            <div className="w-20">
              <NumberField value={value} onCommit={setValue} />
            </div>
            <div className="w-20">
              <SelectField
                value={comparison}
                options={[
                  { value: 'ABOVE', label: '초과' },
                  { value: 'BELOW', label: '미만' },
                ]}
                onChange={setComparison}
              />
            </div>
          </>
        ) : (
          <>
            <div className="w-20">
              <NumberField value={hours} min={0} onCommit={setHours} />
            </div>
            <span>시</span>
          </>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-field px-2 py-1 font-mono text-[11px] text-ink">{preview || '—'}</code>
        <Button variant="primary" disabled={disabled} onClick={() => onAdd(preview)}>
          <Plus size={13} />
          추가
        </Button>
      </div>
    </div>
  );
}

function SectionEditor({ section }: { section: 'CONTROLS' | 'RULES' }) {
  const lines = useNetworkStore((s) => s.model.extraSections[section]);
  const model = useNetworkStore((s) => s.model);
  const commit = useNetworkStore((s) => s.commit);
  const current = useMemo(() => lines ?? [], [lines]);
  const [text, setText] = useState(current.join('\n'));
  useEffect(() => setText(current.join('\n')), [current]);

  const issues = useMemo(() => checkControls(model, section, text.split('\n')), [model, section, text]);

  const apply = (nextText: string) => {
    const next = nextText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (next.length === current.length && next.every((line, i) => line === current[i])) return;
    commit((draft) => {
      if (next.length === 0) delete draft.extraSections[section];
      else draft.extraSections[section] = next;
    });
  };

  return (
    <div>
      {section === 'CONTROLS' && (
        <ControlBuilder
          onAdd={(line) => {
            const next = [...text.split('\n').filter((l) => l.trim()), line].join('\n');
            setText(next);
            apply(next);
          }}
        />
      )}
      <textarea
        aria-label={`[${section}] 원문`}
        spellCheck={false}
        rows={section === 'RULES' ? 12 : 7}
        value={text}
        placeholder={
          section === 'CONTROLS'
            ? 'LINK PU1 OPEN IF NODE T1 BELOW 1.5\nLINK PU1 CLOSED IF NODE T1 ABOVE 4.5\nLINK V1 0.8 AT CLOCKTIME 6:00 AM'
            : 'RULE 1\nIF TANK T1 LEVEL BELOW 1.5\nAND SYSTEM CLOCKTIME >= 6 AM\nTHEN PUMP PU1 STATUS IS OPEN\nPRIORITY 1'
        }
        onChange={(event) => setText(event.target.value)}
        onBlur={() => apply(text)}
        className="mt-2 w-full resize-y rounded border border-line bg-field px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-muted/60 focus:border-accent"
      />
      {issues.length === 0 ? (
        current.length > 0 && <Note tone="good">객체 참조{section === 'CONTROLS' ? '와 형식' : ''}에 문제가 없습니다.</Note>
      ) : (
        <ul className="mt-1.5 space-y-0.5">
          {issues.slice(0, 12).map((issue, index) => (
            <li key={index} className="flex items-start gap-1.5 text-[11px] text-ink">
              <TriangleExclamationPoint size={13} className="mt-px shrink-0 text-warn" />
              <span>
                <span className="text-ink-muted">{issue.line + 1}행:</span> {issue.message}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Note>
        {section === 'CONTROLS'
          ? '단순 제어: 시각이나 절점(배수지 수위·절점 수압) 조건에 따라 링크 상태를 바꿉니다. 입력란을 벗어나면 저장됩니다.'
          : '규칙 기반 제어(RULE … IF … THEN … PRIORITY): AND/OR 조건을 조합할 수 있습니다. 문법 오류는 해석 실행 시 엔진이 알려 줍니다.'}
      </Note>
    </div>
  );
}

type Tab = 'curves' | 'controls' | 'rules';

function DataEditorDialog({ initialTab }: { initialTab: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const close = () => useUIStore.getState().openModal(null);
  const tabs: { id: Tab; label: string }[] = [
    { id: 'curves', label: '곡선 (펌프·배수지)' },
    { id: 'controls', label: '단순 제어 [CONTROLS]' },
    { id: 'rules', label: '규칙 제어 [RULES]' },
  ];
  return (
    <Modal title="곡선·제어 규칙 편집" onClose={close} widthClass="w-[760px]" footer={<Button onClick={close}>닫기</Button>}>
      <div className="-mx-4 -mt-3 mb-3 flex border-b border-line px-2" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`border-b-2 px-3 py-2 text-xs transition-colors ${
              tab === item.id ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink-soft'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === 'curves' && <CurvesTab />}
      {tab === 'controls' && <SectionEditor key="controls" section="CONTROLS" />}
      {tab === 'rules' && <SectionEditor key="rules" section="RULES" />}
    </Modal>
  );
}

/** 곡선·단순 제어·규칙 제어 편집 대화상자. */
export function DataEditorModal() {
  const modal = useUIStore((s) => s.modal);
  if (modal !== 'curves' && modal !== 'controls') return null;
  return <DataEditorDialog initialTab={modal} />;
}
