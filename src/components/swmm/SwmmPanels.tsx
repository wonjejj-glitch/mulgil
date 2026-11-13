import { Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { closeSwmm, runSwmmAnalysis } from '../../app/actions';
import {
  daysToDate,
  linkSeriesOf,
  linkValue,
  nodeSeriesOf,
  nodeValue,
  subValue,
  type SwmmOutput,
} from '../../core/swmm/outReader';
import { routingOf } from '../../core/swmm/inpReader';
import { formatNumber } from '../../core/model/units';
import { useSwmmStore, type SwmmBottomTab } from '../../store/useSwmmStore';
import { useUIStore } from '../../store/useUIStore';
import { toCss, type ThematicScale } from '../../utils/colorScales';
import { Button, FieldRow, Section, SelectField } from '../ui/fields';
import { SWMM_LINK_THEMES, SWMM_NODE_THEMES, useSwmmThematic } from './swmmThematic';

const NODE_KIND = { junction: '절점', outfall: '방류구', storage: '저류조', divider: '분류기' } as const;
const LINK_KIND = { conduit: '관거', pump: '펌프', orifice: '오리피스', weir: '위어', outlet: '배출구' } as const;

function clock(output: SwmmOutput, period: number): string {
  const d = daysToDate(output.days[period] ?? 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function Row({ label, value, unit }: { label: string; value: number | string | undefined; unit?: string }) {
  return (
    <div className="flex items-baseline justify-between py-0.5 text-xs">
      <span className="text-ink-soft">{label}</span>
      <span className="tabular-nums text-ink">
        {typeof value === 'number' ? formatNumber(value, 3) : (value ?? '—')} {unit && <span className="text-ink-muted">{unit}</span>}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ 범례 */

function ScaleBlock({ scale, shape }: { scale: ThematicScale; shape: 'node' | 'link' }) {
  const rows = scale.labels.map((label, i) => ({ label, color: scale.colors[i] })).reverse();
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-1.5 text-[11px] font-semibold text-ink">
        <span>
          {shape === 'node' ? '절점' : '관거'} · {scale.title}
        </span>
        <span className="font-normal text-ink-muted">{scale.unit}</span>
      </div>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center gap-2 text-[11px] text-ink-soft">
            {shape === 'node' ? (
              <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/40" style={{ background: toCss(row.color) }} />
            ) : (
              <span className="h-1 w-4 shrink-0 rounded-full" style={{ background: toCss(row.color) }} />
            )}
            <span className="tabular-nums">{row.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SwmmLegend() {
  const thematic = useSwmmThematic();
  if (!thematic || (!thematic.nodeScale && !thematic.linkScale)) return null;
  return (
    <div className="pointer-events-none absolute bottom-10 left-3 z-10 flex gap-4 rounded-lg border border-line bg-panel/90 px-3 py-2 shadow-lg backdrop-blur">
      {thematic.nodeScale && <ScaleBlock scale={thematic.nodeScale} shape="node" />}
      {thematic.linkScale && <ScaleBlock scale={thematic.linkScale} shape="link" />}
    </div>
  );
}

/* ------------------------------------------------------------------ 우측 패널 */

export function SwmmRightPanel() {
  const project = useSwmmStore((s) => s.project)!;
  const run = useSwmmStore((s) => s.run);
  const period = useSwmmStore((s) => s.period);
  const selection = useSwmmStore((s) => s.selection);
  const nodeTheme = useSwmmStore((s) => s.nodeTheme);
  const linkTheme = useSwmmStore((s) => s.linkTheme);
  const setNodeTheme = useSwmmStore((s) => s.setNodeTheme);
  const setLinkTheme = useSwmmStore((s) => s.setLinkTheme);
  const routing = useSwmmStore((s) => s.routing);
  const setRouting = useSwmmStore((s) => s.setRouting);
  const output = run?.output ?? null;
  const status = useSwmmStore((s) => s.status);
  const lengthUnit = project.us ? 'ft' : 'm';
  const flowUnit = output?.flowUnits ?? project.flowUnits;
  const depthUnit = lengthUnit;

  const node = selection?.kind === 'node' ? project.nodes.find((n) => n.id === selection.id) : undefined;
  const link = selection?.kind === 'link' ? project.links.find((l) => l.id === selection.id) : undefined;
  const sub = selection?.kind === 'subcatch' ? project.subcatchments.find((s) => s.id === selection.id) : undefined;
  const ni = node && output ? output.nodeIds.indexOf(node.id) : -1;
  const li = link && output ? output.linkIds.indexOf(link.id) : -1;
  const si = sub && output ? output.subcatchIds.indexOf(sub.id) : -1;

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-line bg-panel">
      <Section
        title="우수·하수관망 (SWMM)"
        action={
          <button type="button" title="SWMM 보기를 닫고 상수관망으로 돌아갑니다" className="text-ink-muted hover:text-ink" onClick={closeSwmm}>
            <X size={14} />
          </button>
        }
      >
        <p className="mb-2 break-words text-xs text-ink">{project.title || '(제목 없음)'}</p>
        <Row label="절점" value={`${project.nodes.length}개`} />
        <Row label="링크" value={`${project.links.length}개`} />
        <Row label="유역" value={`${project.subcatchments.length}개`} />
        <Row label="유량 단위" value={project.flowUnits} />
        <Row label="좌표계" value={project.crsLabel.replace(/ \(.*$/, '')} />
        <FieldRow label="흐름 계산">
          <SelectField
            value={routing}
            options={[
              { value: 'original', label: `원본 (${routingOf(project.text)})` },
              { value: 'KINWAVE', label: '운동파 (KINWAVE)' },
              { value: 'DYNWAVE', label: '동적파 (DYNWAVE)' },
              { value: 'STEADY', label: '정상류 (STEADY)' },
            ]}
            onChange={setRouting}
          />
        </FieldRow>
        <Button variant="primary" className="mt-2 w-full" disabled={status === 'running'} onClick={() => void runSwmmAnalysis()}>
          {status === 'running' ? '해석 중…' : 'SWMM 해석 실행 (F5)'}
        </Button>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
          읽기 전용 보기입니다. 입력 파일 원문을 그대로 SWMM 5.2 엔진에 넘기므로 모든 섹션이 반영됩니다. 편집은 EPA SWMM 등에서 하고 다시 불러오세요.
        </p>
      </Section>

      <Section title="색상 표시">
        <FieldRow label="절점">
          <SelectField value={nodeTheme} options={SWMM_NODE_THEMES} onChange={setNodeTheme} />
        </FieldRow>
        <FieldRow label="관거">
          <SelectField value={linkTheme} options={SWMM_LINK_THEMES} onChange={setLinkTheme} />
        </FieldRow>
        {!output && <p className="mt-1 text-[11px] text-ink-muted">해석 후 결과 색이 표시됩니다.</p>}
      </Section>

      {node && (
        <Section title={`${NODE_KIND[node.kind]} ${node.id}`}>
          <Row label="관저고 (바닥)" value={node.invert} unit={lengthUnit} />
          {node.kind !== 'outfall' && <Row label="최대 수심" value={node.maxDepth} unit={depthUnit} />}
          {output && ni >= 0 && (
            <div className="mt-1.5 border-t border-line/60 pt-1.5">
              <p className="mb-0.5 text-[11px] text-ink-muted">{clock(output, period)} 결과</p>
              <Row label="수심" value={nodeValue(output, 'depth', period, ni)} unit={depthUnit} />
              <Row label="수두" value={nodeValue(output, 'head', period, ni)} unit={depthUnit} />
              <Row label="총 유입" value={nodeValue(output, 'totalInflow', period, ni)} unit={flowUnit} />
              <Row label="월류" value={nodeValue(output, 'flooding', period, ni)} unit={flowUnit} />
            </div>
          )}
        </Section>
      )}
      {link && (
        <Section title={`${LINK_KIND[link.kind]} ${link.id}`}>
          <Row label="연결" value={`${link.from} → ${link.to}`} />
          {link.kind === 'conduit' && <Row label="연장" value={link.length} unit={lengthUnit} />}
          {link.shape && <Row label="단면" value={`${link.shape} ${link.geom1}`} />}
          {output && li >= 0 && (
            <div className="mt-1.5 border-t border-line/60 pt-1.5">
              <p className="mb-0.5 text-[11px] text-ink-muted">{clock(output, period)} 결과</p>
              <Row label="유량" value={linkValue(output, 'flow', period, li)} unit={flowUnit} />
              <Row label="수심" value={linkValue(output, 'depth', period, li)} unit={depthUnit} />
              <Row label="유속" value={linkValue(output, 'velocity', period, li)} unit={project.us ? 'ft/s' : 'm/s'} />
              <Row label="충만도" value={linkValue(output, 'capacity', period, li)} />
            </div>
          )}
        </Section>
      )}
      {sub && (
        <Section title={`유역 ${sub.id}`}>
          <Row label="유출 절점" value={sub.outlet} />
          <Row label="강우계" value={sub.gage} />
          <Row label="면적" value={sub.area} unit={project.us ? 'ac' : 'ha'} />
          <Row label="불투수율" value={sub.imperv} unit="%" />
          {output && si >= 0 && (
            <div className="mt-1.5 border-t border-line/60 pt-1.5">
              <p className="mb-0.5 text-[11px] text-ink-muted">{clock(output, period)} 결과</p>
              <Row label="강우" value={subValue(output, 'rainfall', period, si)} unit={project.us ? 'in/h' : 'mm/h'} />
              <Row label="유출량" value={subValue(output, 'runoff', period, si)} unit={flowUnit} />
              <Row label="침투" value={subValue(output, 'infiltration', period, si)} unit={project.us ? 'in/h' : 'mm/h'} />
            </div>
          )}
        </Section>
      )}
      {!node && !link && !sub && <div className="px-3 py-3 text-[11px] leading-relaxed text-ink-muted">지도에서 절점·관거·유역을 클릭하면 속성과 현재 시각의 결과가 표시됩니다.</div>}
    </aside>
  );
}

/* ------------------------------------------------------------------ 하단 도크 */

function Controls({ output }: { output: SwmmOutput }) {
  const period = useSwmmStore((s) => s.period);
  const playing = useSwmmStore((s) => s.playing);
  const setPeriod = useSwmmStore((s) => s.setPeriod);
  const setPlaying = useSwmmStore((s) => s.setPlaying);
  const count = output.periods;
  useEffect(() => {
    if (!playing || count < 2) return;
    const timer = window.setInterval(() => {
      const s = useSwmmStore.getState();
      s.setPeriod((s.period + 1) % count);
    }, 250);
    return () => window.clearInterval(timer);
  }, [playing, count]);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <button type="button" className="rounded p-1 text-ink-soft hover:bg-raised hover:text-ink" title="이전" onClick={() => setPeriod(period - 1)}>
        <SkipBack size={14} />
      </button>
      <button type="button" className="rounded bg-raised p-1.5 text-ink hover:bg-line" title={playing ? '일시정지' : '재생'} onClick={() => setPlaying(!playing)}>
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <button type="button" className="rounded p-1 text-ink-soft hover:bg-raised hover:text-ink" title="다음" onClick={() => setPeriod(period + 1)}>
        <SkipForward size={14} />
      </button>
      <input type="range" aria-label="모의 시각" className="h-1 min-w-24 flex-1 cursor-pointer" min={0} max={count - 1} step={1} value={period} onChange={(e) => setPeriod(Number(e.target.value))} />
      <span className="w-24 shrink-0 text-right text-xs tabular-nums text-ink">{clock(output, period)}</span>
    </div>
  );
}

const GRID = '#2a313b';
const AXIS = '#8b8a84';

function Chart({ title, unit, values, hours, current, color }: { title: string; unit: string; values: number[]; hours: number[]; current: number; color: string }) {
  const data = hours.map((h, i) => ({ h, v: values[i] }));
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-baseline justify-between px-1 pb-1 text-xs">
        <span className="font-medium text-ink">
          {title} <span className="font-normal text-ink-muted">{unit}</span>
        </span>
        <span className="tabular-nums text-ink">{formatNumber(values[current] ?? NaN, 3)}</span>
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 14, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="h" type="number" domain={['dataMin', 'dataMax']} tick={{ fill: AXIS, fontSize: 10 }} stroke={GRID} tickLine={false} tickFormatter={(h: number) => `${formatNumber(h, 1)}h`} />
            <YAxis width={46} tick={{ fill: AXIS, fontSize: 10 }} stroke={GRID} tickLine={false} axisLine={false} domain={['auto', 'auto']} tickFormatter={(v: number) => formatNumber(v, 2)} />
            <Tooltip isAnimationActive={false} contentStyle={{ background: '#161a20', border: '1px solid #2a313b', borderRadius: 6, fontSize: 12 }} labelFormatter={(h) => `${formatNumber(Number(h), 2)} 시간`} formatter={(v) => [formatNumber(Number(v), 4), title]} />
            <ReferenceLine x={hours[current]} stroke="#f0efec" strokeOpacity={0.55} />
            <Line type="monotone" dataKey="v" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ChartTab({ output }: { output: SwmmOutput }) {
  const selection = useSwmmStore((s) => s.selection);
  const period = useSwmmStore((s) => s.period);
  const project = useSwmmStore((s) => s.project)!;
  const hours = useMemo(() => Array.from(output.days, (d) => (d - output.days[0]) * 24), [output]);
  const flowUnit = output.flowUnits;
  const depthUnit = project.us ? 'ft' : 'm';

  const specs = useMemo(() => {
    if (selection?.kind === 'node') {
      const i = output.nodeIds.indexOf(selection.id);
      if (i >= 0)
        return {
          heading: `절점 ${selection.id}`,
          charts: [
            { title: '수심', unit: depthUnit, values: nodeSeriesOf(output, 'depth', i), color: '#3987e5' },
            { title: '총 유입', unit: flowUnit, values: nodeSeriesOf(output, 'totalInflow', i), color: '#199e70' },
            { title: '월류', unit: flowUnit, values: nodeSeriesOf(output, 'flooding', i), color: '#d03b3b' },
          ],
        };
    }
    if (selection?.kind === 'link') {
      const i = output.linkIds.indexOf(selection.id);
      if (i >= 0)
        return {
          heading: `링크 ${selection.id}`,
          charts: [
            { title: '유량', unit: flowUnit, values: linkSeriesOf(output, 'flow', i), color: '#3987e5' },
            { title: '유속', unit: project.us ? 'ft/s' : 'm/s', values: linkSeriesOf(output, 'velocity', i), color: '#199e70' },
            { title: '충만도', unit: '', values: linkSeriesOf(output, 'capacity', i), color: '#ec835a' },
          ],
        };
    }
    if (selection?.kind === 'subcatch') {
      const i = output.subcatchIds.indexOf(selection.id);
      if (i >= 0)
        return {
          heading: `유역 ${selection.id}`,
          charts: [
            { title: '강우', unit: project.us ? 'in/h' : 'mm/h', values: Array.from({ length: output.periods }, (_, t) => subValue(output, 'rainfall', t, i)), color: '#3987e5' },
            { title: '유출량', unit: flowUnit, values: Array.from({ length: output.periods }, (_, t) => subValue(output, 'runoff', t, i)), color: '#199e70' },
          ],
        };
    }
    // 시스템 변수 순서(SWMM .out): 0 기온, 1 강우, 2 적설, 3 침투, 4 유출량, 5 건기 유입, 6 지하수, 7 RDII,
    // 8 외부 유입, 9 총 측방 유입, 10 월류, 11 방류, 12 저류, 13 증발, 14 PET
    const sys = (v: number) => Array.from({ length: output.periods }, (_, t) => output.system[t * output.sysVars + v]);
    return {
      heading: '관망 전체',
      charts: [
        { title: '강우', unit: project.us ? 'in/h' : 'mm/h', values: sys(1), color: '#3987e5' },
        { title: '유출량', unit: flowUnit, values: sys(4), color: '#199e70' },
        { title: '방류', unit: flowUnit, values: sys(11), color: '#ec835a' },
      ],
    };
  }, [selection, output, flowUnit, depthUnit, project.us]);

  return (
    <div className="flex h-full min-h-0 gap-4 px-3 pb-2 pt-2">
      <div className="flex w-28 shrink-0 flex-col justify-center border-r border-line pr-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">대상</span>
        <span className="mt-0.5 break-all text-sm font-semibold text-ink">{specs.heading}</span>
        <span className="mt-2 text-[11px] leading-snug text-ink-muted">지도에서 객체를 선택하면 개별 시계열을 봅니다.</span>
      </div>
      {specs.charts.map((c) => (
        <Chart key={c.title} {...c} hours={hours} current={period} />
      ))}
    </div>
  );
}

type Row2 = { id: string; kind: string; cols: (number | string)[] };

function TableTab({ output }: { output: SwmmOutput }) {
  const project = useSwmmStore((s) => s.project)!;
  const select = useSwmmStore((s) => s.select);
  const [kind, setKind] = useState<'node' | 'link'>('node');
  const lengthUnit = project.us ? 'ft' : 'm';
  const { head, rows } = useMemo(() => {
    if (kind === 'node') {
      const rows: Row2[] = output.nodeIds.map((id, i) => {
        let maxDepth = 0, maxInflow = 0, flood = 0;
        for (let t = 0; t < output.periods; t++) {
          maxDepth = Math.max(maxDepth, nodeValue(output, 'depth', t, i));
          maxInflow = Math.max(maxInflow, nodeValue(output, 'totalInflow', t, i));
          flood += nodeValue(output, 'flooding', t, i);
        }
        return { id, kind: ['절점', '방류구', '저류조', '분류기'][output.nodeTypes[i]] ?? '', cols: [maxDepth, output.nodeMaxDepth[i], maxInflow, flood] };
      });
      return { head: ['ID', '종류', `최대 수심 (${lengthUnit})`, `한계 수심 (${lengthUnit})`, `최대 유입 (${output.flowUnits})`, '월류 합계 (유량×스텝)'], rows };
    }
    const rows: Row2[] = output.linkIds.map((id, i) => {
      let maxFlow = 0, maxVel = 0, maxCap = 0;
      for (let t = 0; t < output.periods; t++) {
        maxFlow = Math.max(maxFlow, Math.abs(linkValue(output, 'flow', t, i)));
        maxVel = Math.max(maxVel, linkValue(output, 'velocity', t, i));
        maxCap = Math.max(maxCap, linkValue(output, 'capacity', t, i));
      }
      return { id, kind: ['관거', '펌프', '오리피스', '위어', '배출구'][output.linkTypes[i]] ?? '', cols: [maxFlow, maxVel, maxCap] };
    });
    return { head: ['ID', '종류', `최대 유량 (${output.flowUnits})`, `최대 유속 (${project.us ? 'ft/s' : 'm/s'})`, '최대 충만도'], rows };
  }, [kind, output, lengthUnit, project.us]);
  const sorted = useMemo(() => [...rows].sort((a, b) => Number(b.cols[kind === 'node' ? 3 : 2]) - Number(a.cols[kind === 'node' ? 3 : 2]) || a.id.localeCompare(b.id, 'ko', { numeric: true })), [rows, kind]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
        <div className="flex overflow-hidden rounded border border-line">
          {(['node', 'link'] as const).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={`px-2.5 py-1 ${kind === k ? 'bg-accent-strong text-white' : 'text-ink-soft hover:bg-raised'}`}>
              {k === 'node' ? '절점' : '링크'}
            </button>
          ))}
        </div>
        <span className="text-ink-muted">전체 기간 최대값 · {kind === 'node' ? '월류 많은 순' : '충만도 큰 순'}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs tabular-nums">
          <thead className="sticky top-0 bg-panel">
            <tr>
              {head.map((h, i) => (
                <th key={h} className={`whitespace-nowrap border-b border-line px-2 py-1 font-medium text-ink-soft ${i < 2 ? 'text-left' : 'text-right'}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 400).map((r) => (
              <tr key={r.id} className="cursor-pointer border-b border-line/50 hover:bg-raised" onClick={() => select({ kind, id: r.id })}>
                <td className="px-2 py-0.5 text-ink">{r.id}</td>
                <td className="px-2 py-0.5 text-ink-soft">{r.kind}</td>
                {r.cols.map((c, i) => (
                  <td key={i} className="px-2 py-0.5 text-right text-ink">
                    {formatNumber(Number(c), 3)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReportTab() {
  const run = useSwmmStore((s) => s.run);
  const error = useSwmmStore((s) => s.error);
  const text = run?.report ?? error?.report ?? '';
  if (!text) return <div className="flex h-full items-center justify-center text-xs text-ink-muted">해석을 실행하면 SWMM 엔진 보고서가 여기에 표시됩니다.</div>;
  return (
    <div className="h-full overflow-auto px-3 py-2">
      {error && <p className="mb-2 text-xs font-medium text-[#f3a5a5]">{error.message}</p>}
      <pre className="whitespace-pre font-mono text-[11px] leading-snug text-ink-soft">{text}</pre>
    </div>
  );
}

export function SwmmDock() {
  const run = useSwmmStore((s) => s.run);
  const status = useSwmmStore((s) => s.status);
  const tab = useSwmmStore((s) => s.bottomTab);
  const setTab = useSwmmStore((s) => s.setBottomTab);
  const collapsed = useUIStore((s) => s.bottomCollapsed);
  const setCollapsed = useUIStore((s) => s.setBottomCollapsed);
  const output = run?.output ?? null;
  const tabs: { id: SwmmBottomTab; label: string }[] = [
    { id: 'chart', label: '시계열' },
    { id: 'table', label: '결과 표' },
    { id: 'report', label: '해석 보고서' },
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
              onClick={() => {
                setTab(item.id);
                setCollapsed(false);
              }}
              className={`inline-flex h-10 items-center border-b-2 px-3 text-xs transition-colors ${tab === item.id && !collapsed ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink-soft'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="mx-2 h-5 w-px shrink-0 bg-line" />
        {output ? <Controls output={output} /> : <span className="text-[11px] text-ink-muted">{status === 'running' ? 'SWMM 해석 중…' : '해석 결과 없음'}</span>}
        <button type="button" className="ml-auto shrink-0 rounded p-1 text-ink-muted hover:bg-raised hover:text-ink" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '펼치기' : '접기'}>
          {collapsed ? '▲' : '▼'}
        </button>
      </div>
      {!collapsed && (
        <div className="min-h-0 flex-1">
          {tab === 'report' ? (
            <ReportTab />
          ) : !output ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-ink-muted">
              {status === 'error' ? '해석이 실패했습니다. 해석 보고서 탭에서 원인을 확인하세요.' : '우측 패널의 ‘SWMM 해석 실행’(F5)을 누르면 결과가 표시됩니다.'}
            </div>
          ) : tab === 'chart' ? (
            <ChartTab output={output} />
          ) : (
            <TableTab output={output} />
          )}
        </div>
      )}
    </section>
  );
}
