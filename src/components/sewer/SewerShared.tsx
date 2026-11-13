/** 하수 설계 화면 공용 조각: 종단도, 검토 목록, SWMM 해석 요약. 설계 대화상자(SewerDesignModal)와 하수 모드 하단 도크가 함께 쓴다. */
import { CircleCheck, Download, SkipForward, TriangleExclamationPoint } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatNumber } from '../../core/model/units';
import { DEFAULT_REVIEW, REVIEW_KINDS, reviewCsv, reviewSewer, type ReviewCriteria, type ReviewKind, type ReviewRow, type Verdict } from '../../core/sewer/review';
import { buildNetwork } from '../../core/sewer/topology';
import type { SewerConduit, SewerProject } from '../../core/sewer/types';
import { useSewerStore } from '../../store/useSewerStore';
import { baseName, downloadText } from '../../utils/files';
import { Button, NumberField, SelectField } from '../ui/fields';

export const Note = ({ children, tone }: { children: ReactNode; tone?: 'warn' }) => (
  <p className={`mt-1.5 text-[11px] leading-relaxed ${tone === 'warn' ? 'text-ink' : 'text-ink-muted'}`}>
    {tone === 'warn' && <TriangleExclamationPoint size={12} className="mr-1 inline text-warn" />}
    {children}
  </p>
);

/* ------------------------------------------------------------------ 종단도 */

/** 종단도: 시작 절점(없으면 가장 먼 상류)에서 방류구까지 지반고·관정·관저·최대 수두. */
export function SewerProfile({
  project,
  start,
  onStart,
  heightClass = 'h-52',
  className = 'mt-3',
}: {
  project: SewerProject;
  start?: string;
  onStart?: (id: string) => void;
  heightClass?: string;
  className?: string;
}) {
  const simulation = useSewerStore((s) => s.simulation);
  const [ownStart, setOwnStart] = useState('');
  const startId = start ?? ownStart;
  const setStartId = onStart ?? setOwnStart;
  const data = useMemo(() => {
    let graph;
    try {
      graph = buildNetwork(project);
    } catch {
      return [];
    }
    // 가장 먼 상류 절점(기본) 또는 선택한 절점에서 방류구까지 하류로 따라간다
    const depth = new Map<string, number>();
    for (const id of [...graph.order].reverse()) {
      const outs = graph.out.get(id)!;
      depth.set(id, outs.length === 0 ? 0 : Math.max(...outs.map((e) => (depth.get(e.to) ?? 0) + e.conduit.length)));
    }
    const start = startId && graph.nodes.has(startId) ? startId : [...graph.nodes.keys()].sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0))[0];
    const out: { distance: number; id: string; ground: number; crown: number; invert: number; hgl: number | null }[] = [];
    let id: string | undefined = start;
    let distance = 0;
    while (id) {
      const n = graph.nodes.get(id)!;
      const diam = Math.max(...[...graph.inn.get(id)!.map((e) => e.conduit.diameter), ...graph.out.get(id)!.map((e) => e.conduit.diameter)]);
      out.push({ distance, id, ground: n.ground, crown: n.invert + diam, invert: n.invert, hgl: simulation?.node_summary[id]?.max_hgl ?? null });
      const next: { to: string; conduit: SewerConduit } | undefined = graph.out.get(id)![0];
      if (!next) break;
      distance += next.conduit.length;
      id = next.to;
    }
    return out;
  }, [project, startId, simulation]);
  if (data.length < 2) return null;
  const nodeOptions = project.nodes.filter((n) => n.kind === 'JUNCTION').map((n) => ({ value: n.id, label: n.id }));
  return (
    <div className={className}>
      <div className="mb-1 flex items-center gap-2 text-xs text-ink-soft">
        <span className="font-semibold text-ink">종단도</span>
        시작 절점
        <div className="w-28">
          <SelectField value={startId || data[0].id} options={nodeOptions} onChange={setStartId} />
        </div>
        <span className="text-[11px] text-ink-muted">하류 방류구까지 · {simulation ? '파란 점선: 최대 수두(HGL, SWMM)' : '해석하면 최대 수두선이 함께 그려집니다'}</span>
      </div>
      <div className={heightClass}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 6, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#2a313b" vertical={false} />
            <XAxis dataKey="distance" type="number" domain={[0, 'dataMax']} tick={{ fill: '#8b8a84', fontSize: 10 }} stroke="#2a313b" tickFormatter={(v: number) => `${formatNumber(v, 0)} m`} />
            <YAxis width={48} tick={{ fill: '#8b8a84', fontSize: 10 }} stroke="#2a313b" domain={['auto', 'auto']} tickFormatter={(v: number) => formatNumber(v, 1)} />
            <Tooltip
              isAnimationActive={false}
              contentStyle={{ background: '#161a20', border: '1px solid #2a313b', borderRadius: 6, fontSize: 12 }}
              labelFormatter={(_, p) => `${(p?.[0]?.payload as { id?: string })?.id ?? ''} · ${formatNumber(Number(p?.[0]?.payload?.distance), 1)} m`}
              formatter={(v, name) => [`${formatNumber(Number(v), 2)} m`, name === 'ground' ? '지반고' : name === 'crown' ? '관정' : name === 'invert' ? '관저' : '최대 수두']}
            />
            <Legend formatter={(v) => (v === 'ground' ? '지반고' : v === 'crown' ? '관정' : v === 'invert' ? '관저' : '최대 수두')} wrapperStyle={{ fontSize: 11 }} />
            <Area type="linear" dataKey="ground" stroke="#8a7356" fill="#8a7356" fillOpacity={0.3} baseValue="dataMin" isAnimationActive={false} />
            <Line type="linear" dataKey="crown" stroke="#3987e5" strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} />
            <Line type="linear" dataKey="invert" stroke="#199e70" strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} />
            {simulation && <Line type="linear" dataKey="hgl" stroke="#ec835a" strokeDasharray="5 4" strokeWidth={1.75} dot={false} connectNulls isAnimationActive={false} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 검토 목록 */

const VERDICT_CLASS: Record<Verdict, string> = { GOOD: 'text-good', NG: 'text-[#f3a5a5] font-semibold', '-': 'text-ink-muted' };

/**
 * 검토 목록 (기존 하수 설계 프로그램의 판정 체계). 설계 대화상자와 하수 모드 하단 도크가 함께 쓴다.
 * onPick: 행을 눌렀을 때 (지도 선택 등). showProfile: 표 아래에 종단도를 그릴지.
 */
export function SewerReviewList({
  onPick,
  showProfile = true,
  emptyMessage = '‘설계 결과’ 탭에서 ① 자동 설계를 먼저 실행하세요. 동수위 판정은 ② SWMM 해석 뒤에 나옵니다.',
  tableClass = 'max-h-60',
}: {
  onPick?: (row: ReviewRow) => void;
  showProfile?: boolean;
  emptyMessage?: string;
  tableClass?: string;
}) {
  const design = useSewerStore((s) => s.design);
  const simulation = useSewerStore((s) => s.simulation);
  const [criteria, setCriteria] = useState<ReviewCriteria>(DEFAULT_REVIEW);
  const [filter, setFilter] = useState<ReviewKind | 'all' | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const rows = useMemo(() => (design ? reviewSewer(design, simulation, criteria) : []), [design, simulation, criteria]);
  const counts = useMemo(() => Object.fromEntries(REVIEW_KINDS.map((k) => [k.kind, rows.filter((r) => r.verdict[k.kind] === 'NG').length])) as Record<ReviewKind, number>, [rows]);
  // 처음 열면 NG 가 있는 첫 유형(Overflow → 최소 유속 → 최대 유속 → 동수위 → 역경사)을 보여 준다
  const active = filter ?? REVIEW_KINDS.find((k) => counts[k.kind] > 0)?.kind ?? 'all';
  const shown = active === 'all' ? rows : rows.filter((r) => r.verdict[active] === 'NG');
  const ngRows = rows.filter((r) => r.ng);
  const [profileStart, setProfileStart] = useState('');
  const pick = (id: string) => {
    setCurrent(id);
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    setProfileStart(row.upstream);
    onPick?.(row);
  };
  const focus = (id: string) => {
    pick(id);
    // 필터를 바꾼 직후에도 행이 그려진 다음 스크롤되게 한 프레임 미룬다
    requestAnimationFrame(() => rowRefs.current.get(id)?.scrollIntoView({ block: 'nearest' }));
  };
  const nextNg = () => {
    if (ngRows.length === 0) return;
    const i = ngRows.findIndex((r) => r.id === current);
    const next = ngRows[(i + 1) % ngRows.length];
    if (active !== 'all' && next.verdict[active] !== 'NG') setFilter('all');
    focus(next.id);
  };
  const f =(x: number | null, d: number) => (x === null || !Number.isFinite(x) ? '—' : x.toFixed(d));

  if (!design) return <p className="mt-6 text-center text-xs text-ink-muted">{emptyMessage}</p>;
  return (
    <div>
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="w-24">
          <span className="text-[11px] text-ink-muted">최소 유속 (m/s)</span>
          <NumberField value={criteria.minVelocity} min={0} onCommit={(v) => setCriteria({ ...criteria, minVelocity: v })} />
        </label>
        <label className="w-24">
          <span className="text-[11px] text-ink-muted">최대 유속 (m/s)</span>
          <NumberField value={criteria.maxVelocity} min={0} onCommit={(v) => setCriteria({ ...criteria, maxVelocity: v })} />
        </label>
        <label className="w-28">
          <span className="text-[11px] text-ink-muted">동수위 기준 GL+ (m)</span>
          <NumberField value={criteria.hglAboveGround} onCommit={(v) => setCriteria({ ...criteria, hglAboveGround: v })} />
        </label>
        <label className="w-32">
          <span className="text-[11px] text-ink-muted">판정 유속</span>
          <SelectField
            value={criteria.velocityBasis}
            options={[{ value: 'actual', label: '실유속' }, { value: 'full', label: '만관 유속' }]}
            onChange={(v) => setCriteria({ ...criteria, velocityBasis: v as ReviewCriteria['velocityBasis'] })}
          />
        </label>
        <div className="ml-auto flex gap-2">
          <Button disabled={ngRows.length === 0} onClick={nextNg} title="다음 NG 관로로 이동">
            <SkipForward size={13} />
            다음 NG ({ngRows.length})
          </Button>
          <Button onClick={() => downloadText(`${baseName(design.project.name || 'sewer')}_검토목록.csv`, reviewCsv(rows), 'text/csv;charset=utf-8')}>
            <Download size={13} />
            CSV
          </Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1" role="tablist" aria-label="검토 유형">
        {[{ kind: 'all' as const, label: '전체', rule: '모든 관로' }, ...REVIEW_KINDS].map((k) => {
          const n = k.kind === 'all' ? ngRows.length : counts[k.kind];
          return (
            <button
              key={k.kind}
              type="button"
              role="tab"
              title={k.rule}
              aria-selected={active === k.kind}
              onClick={() => setFilter(k.kind)}
              className={`rounded border px-2 py-1 text-[11px] ${active === k.kind ? 'border-accent bg-accent/15 text-ink' : 'border-line text-ink-soft hover:text-ink'}`}
            >
              {k.label} <span className={n > 0 ? 'text-[#f3a5a5]' : 'text-ink-muted'}>{n}</span>
            </button>
          );
        })}
      </div>
      <Note>
        기존 하수 설계 프로그램의 검토 목록과 같은 판정입니다. 하늘색 관로번호 = 시작관·관말. {showProfile ? '행을 누르면 아래 종단도가 그 관로부터 그려집니다.' : '행을 누르면 지도가 그 관거로 갑니다.'}
        {!simulation && ' 동수위는 SWMM 해석 뒤에 판정합니다(지금은 -).'}
      </Note>
      <div className={`mt-2 overflow-auto rounded border border-line ${tableClass}`}>
        <table className="w-full text-[11px] tabular-nums">
          <thead className="sticky top-0 z-10 bg-panel text-ink-soft">
            <tr>
              {['관로', '시점→종점', '관경', '연장', '누가연장', '토피(시/종)', '구배‰', '설계유량', '만관유량', '실유속', 'd/D', '사용율%', '동수위(시/종)', ...REVIEW_KINDS.map((k) => k.label)].map((h, i) => (
                <th key={h} className={`whitespace-nowrap px-1.5 py-1 font-medium ${i < 2 ? 'text-left' : 'text-right'}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={r.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(r.id, el);
                  else rowRefs.current.delete(r.id);
                }}
                onClick={() => pick(r.id)}
                className={`cursor-pointer border-t border-line/50 ${current === r.id ? 'bg-accent/20' : 'hover:bg-raised'}`}
              >
                <td className={`px-1.5 py-0.5 ${r.isStart || r.isEnd ? 'text-[#7cc4f0]' : 'text-ink'}`}>{r.id}</td>
                <td className="whitespace-nowrap px-1.5 py-0.5 text-ink-soft">
                  {r.upstream}→{r.downstream}
                </td>
                <td className="px-1.5 py-0.5 text-right">{r.diameter}</td>
                <td className="px-1.5 py-0.5 text-right text-ink-soft">{f(r.length, 1)}</td>
                <td className="px-1.5 py-0.5 text-right text-ink-soft">{f(r.cumLength, 1)}</td>
                <td className="whitespace-nowrap px-1.5 py-0.5 text-right text-ink-soft">
                  {f(r.coverUp, 2)}/{f(r.coverDown, 2)}
                </td>
                <td className="px-1.5 py-0.5 text-right text-ink-soft">{f(r.slopePermil, 2)}</td>
                <td className="px-1.5 py-0.5 text-right text-ink-soft">{f(r.flow, 4)}</td>
                <td className="px-1.5 py-0.5 text-right text-ink-soft">{f(r.fullFlow, 4)}</td>
                <td className="px-1.5 py-0.5 text-right text-ink-soft">{f(r.velocity, 2)}</td>
                <td className="px-1.5 py-0.5 text-right text-ink-soft">{f(r.depthRatio, 2)}</td>
                <td className="px-1.5 py-0.5 text-right text-ink-soft">{f(r.usage, 0)}</td>
                <td className="whitespace-nowrap px-1.5 py-0.5 text-right text-ink-soft">
                  {f(r.hglUp, 2)}/{f(r.hglDown, 2)}
                </td>
                {REVIEW_KINDS.map((k) => (
                  <td key={k.kind} className={`px-1.5 py-0.5 text-right ${VERDICT_CLASS[r.verdict[k.kind]]}`}>
                    {r.verdict[k.kind]}
                  </td>
                ))}
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={18} className="px-2 py-4 text-center text-ink-muted">
                  해당 유형의 NG 관로가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {showProfile && <SewerProfile project={design.project} start={profileStart} onStart={setProfileStart} />}
    </div>
  );
}

/* ------------------------------------------------------------------ 해석 요약 */

/** SWMM 해석 요약: 월류·만관 초과·연속성 오차와 관로별 최대값. */
export function SewerSimulationSummary({ className = 'mt-3', tableClass = 'max-h-44' }: { className?: string; tableClass?: string }) {
  const design = useSewerStore((s) => s.design);
  const simulation = useSewerStore((s) => s.simulation);
  if (!simulation) return null;
  const flooded = Object.entries(simulation.node_summary).filter(([, n]) => n.flood_hours > 0);
  const surcharged = Object.entries(simulation.node_summary).filter(([, n]) => n.surcharged);
  return (
    <div className={className}>
          <div className={`flex items-center gap-2 rounded border px-3 py-2 text-xs ${simulation.quality_ok && flooded.length === 0 && surcharged.length === 0 ? 'border-good/40 bg-good/10' : 'border-warn/40 bg-warn/10'}`}>
            {simulation.quality_ok && flooded.length === 0 && surcharged.length === 0 ? <CircleCheck size={14} className="text-good" /> : <TriangleExclamationPoint size={14} className="text-warn" />}
            <span className="text-ink">
              월류 {flooded.length}곳 · 만관 초과(수두가 관정 위) {surcharged.length}곳 · 연속성 오차 {Object.entries(simulation.continuity).map(([k, v]) => `${k.replace(' Continuity', '')} ${v}%`).join(', ')}
              {!simulation.quality_ok && ' — 오차 또는 SWMM 경고 검토 필요'}
            </span>
          </div>
          {simulation.warnings.length > 0 && <Note tone="warn">{simulation.warnings.slice(0, 3).join(' | ')}</Note>}
          <div className={`mt-2 overflow-auto rounded border border-line ${tableClass}`}>
            <table className="w-full text-xs tabular-nums">
              <thead className="sticky top-0 bg-panel text-ink-soft">
                <tr>
                  {['관로', '최대 유량 (m³/s)', '최대 유속 (m/s)', '최대 d/D'].map((h, i) => (
                    <th key={h} className={`px-2 py-1 font-medium ${i === 0 ? 'text-left' : 'text-right'}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(simulation.link_summary).map(([id, l]) => (
                  <tr key={id} className="border-t border-line/50">
                    <td className="px-2 py-0.5 text-ink">{id}</td>
                    <td className="px-2 py-0.5 text-right text-ink-soft">{l.max_flow.toFixed(3)}</td>
                    <td className="px-2 py-0.5 text-right text-ink-soft">{l.max_velocity.toFixed(2)}</td>
                    <td className={`px-2 py-0.5 text-right ${l.max_depth_ratio > (design?.project.constraints.max_depth_ratio ?? 0.8) + 0.005 ? 'text-[#f3a5a5]' : 'text-ink-soft'}`}>{l.max_depth_ratio.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
  );
}
