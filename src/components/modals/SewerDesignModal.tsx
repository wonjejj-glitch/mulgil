import { CircleCheck, Download, FilePlus2, FolderOpen, Map as MapIcon, Play, Plus, RefreshCw, Repeat, Save, SkipForward, Trash, TriangleExclamationPoint, Undo2, Wand2 } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, Area } from 'recharts';
import {
  applyDesignToProject,
  exportSewerCsv,
  exportSewerInp,
  openSewerFile,
  runSewerDesign,
  runSewerOptimize,
  runSewerSimulation,
  saveSewerProject,
  showSewerOnMap,
} from '../../app/sewerActions';
import type { DesignMode } from '../../core/sewer/design';
import { DEFAULT_REVIEW, REVIEW_KINDS, reviewCsv, reviewSewer, type ReviewCriteria, type ReviewKind, type Verdict } from '../../core/sewer/review';
import { buildNetwork } from '../../core/sewer/topology';
import { baseName, downloadText } from '../../utils/files';
import type { SewerCatchment, SewerConduit, SewerNode, SewerProject } from '../../core/sewer/types';
import { parseSewerProject } from '../../core/sewer/validate';
import { formatNumber } from '../../core/model/units';
import { useSewerStore } from '../../store/useSewerStore';
import { useUIStore } from '../../store/useUIStore';
import { Button, NumberField, SelectField, TextField } from '../ui/fields';
import { Modal } from '../ui/Modal';

type Tab = 'input' | 'conditions' | 'design' | 'check' | 'review';

const Note = ({ children, tone }: { children: ReactNode; tone?: 'warn' }) => (
  <p className={`mt-1.5 text-[11px] leading-relaxed ${tone === 'warn' ? 'text-ink' : 'text-ink-muted'}`}>
    {tone === 'warn' && <TriangleExclamationPoint size={12} className="mr-1 inline text-warn" />}
    {children}
  </p>
);

/* ------------------------------------------------------------------ 편집 표 */

interface Column<T> {
  key: keyof T & string;
  label: string;
  kind: 'text' | 'number' | 'select';
  width?: string;
  options?: { value: string; label: string }[];
  /** 설계가 계산하는 값이면 연한 글씨로 표시 */
  computed?: boolean;
}

function EditableTable<T extends object>({
  rows,
  columns,
  onChange,
  onAdd,
  onRemove,
  addLabel,
}: {
  rows: T[];
  columns: Column<T>[];
  onChange: (index: number, key: keyof T & string, value: string | number) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  addLabel: string;
}) {
  return (
    <div>
      <div className="max-h-56 overflow-auto rounded border border-line">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-panel text-ink-soft">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className="whitespace-nowrap px-1.5 py-1 text-left font-medium">
                  {c.label}
                </th>
              ))}
              <th className="w-7" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-line/50">
                {columns.map((c) => {
                  const value = (row as Record<string, unknown>)[c.key];
                  return (
                    <td key={c.key} className="px-1 py-0.5" style={{ minWidth: c.width ?? '84px' }}>
                      {c.kind === 'number' ? (
                        <NumberField value={Number(value)} onCommit={(v) => onChange(i, c.key, v)} />
                      ) : c.kind === 'select' ? (
                        <SelectField value={String(value)} options={c.options ?? []} onChange={(v) => onChange(i, c.key, v)} />
                      ) : (
                        <TextField value={String(value ?? '')} onCommit={(v) => onChange(i, c.key, v)} />
                      )}
                    </td>
                  );
                })}
                <td className="px-1">
                  <button type="button" aria-label={`${i + 1}번째 행 삭제`} onClick={() => onRemove(i)} className="rounded p-1 text-ink-muted hover:bg-critical/20 hover:text-[#f3a5a5]">
                    <Trash size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button className="mt-1.5" onClick={onAdd}>
        <Plus size={13} />
        {addLabel}
      </Button>
    </div>
  );
}

function nextId(prefix: string, taken: string[]): string {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

const NODE_COLUMNS: Column<SewerNode>[] = [
  { key: 'id', label: 'ID', kind: 'text', width: '72px' },
  { key: 'kind', label: '종류', kind: 'select', options: [{ value: 'JUNCTION', label: '맨홀' }, { value: 'OUTFALL', label: '방류구' }], width: '80px' },
  { key: 'x', label: 'X (m)', kind: 'number' },
  { key: 'y', label: 'Y (m)', kind: 'number' },
  { key: 'ground', label: '지반고 (m)', kind: 'number' },
  { key: 'invert', label: '관저고 (m)', kind: 'number' },
  { key: 'base_flow', label: '오수 (m³/s)', kind: 'number' },
  { key: 'boundary', label: '방류 경계', kind: 'select', options: [{ value: 'FREE', label: 'FREE' }, { value: 'NORMAL', label: 'NORMAL' }, { value: 'FIXED', label: 'FIXED' }], width: '88px' },
  { key: 'stage', label: 'FIXED 수위', kind: 'number' },
];
const CONDUIT_COLUMNS: Column<SewerConduit>[] = [
  { key: 'id', label: 'ID', kind: 'text', width: '72px' },
  { key: 'upstream', label: '상류 절점', kind: 'text', width: '78px' },
  { key: 'downstream', label: '하류 절점', kind: 'text', width: '78px' },
  { key: 'length', label: '연장 (m)', kind: 'number' },
  { key: 'diameter', label: '관경 (m)', kind: 'number' },
  { key: 'roughness', label: 'Manning n', kind: 'number' },
];
const CATCHMENT_COLUMNS: Column<SewerCatchment>[] = [
  { key: 'id', label: 'ID', kind: 'text', width: '72px' },
  { key: 'outlet', label: '유출 맨홀', kind: 'text', width: '78px' },
  { key: 'area', label: '면적 (ha)', kind: 'number' },
  { key: 'impervious', label: '불투수율 (%)', kind: 'number' },
  { key: 'runoff_coefficient', label: '유출계수 C', kind: 'number' },
  { key: 'width', label: '폭 (m)', kind: 'number' },
  { key: 'slope', label: '경사 (%)', kind: 'number' },
];

function InputTab() {
  const project = useSewerStore((s) => s.project);
  const edit = useSewerStore((s) => s.edit);
  const fileInput = useRef<HTMLInputElement | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void openSewerFile(f);
          }}
        />
        <Button onClick={() => fileInput.current?.click()}>
          <FolderOpen size={13} />
          프로젝트 열기 (.json)
        </Button>
        <Button onClick={saveSewerProject}>
          <Save size={13} />
          저장
        </Button>
        <Button onClick={() => useSewerStore.getState().loadDemo()}>
          <FilePlus2 size={13} />
          예제 불러오기
        </Button>
        <div className="ml-auto flex items-center gap-2 text-xs text-ink-soft">
          프로젝트 이름
          <div className="w-56">
            <TextField value={project.name} onCommit={(v) => edit((d) => void (d.name = v))} />
          </div>
        </div>
      </div>

      <section>
        <h3 className="mb-1.5 text-xs font-semibold text-ink">절점 (맨홀·방류구)</h3>
        <EditableTable<SewerNode>
          rows={project.nodes}
          columns={NODE_COLUMNS}
          addLabel="절점 추가"
          onAdd={() =>
            edit((d) => {
              const last = d.nodes[d.nodes.length - 1];
              d.nodes.push({ id: nextId('MH', d.nodes.map((n) => n.id)), x: (last?.x ?? 0) + 50, y: last?.y ?? 0, ground: last?.ground ?? 100, invert: (last?.ground ?? 100) - 1.8, kind: 'JUNCTION', base_flow: 0, boundary: 'FREE', stage: null });
            })
          }
          onRemove={(i) => edit((d) => void d.nodes.splice(i, 1))}
          onChange={(i, key, value) =>
            edit((d) => {
              const node = d.nodes[i] as unknown as Record<string, unknown>;
              if (key === 'stage') node.stage = Number.isFinite(Number(value)) && String(value) !== '' ? Number(value) : null;
              else node[key] = value;
              if (key === 'id') {
                const old = project.nodes[i].id;
                for (const c of d.conduits) {
                  if (c.upstream === old) c.upstream = String(value);
                  if (c.downstream === old) c.downstream = String(value);
                }
                for (const s of d.catchments) if (s.outlet === old) s.outlet = String(value);
              }
            })
          }
        />
        <Note>
          관저고는 설계하면 다시 계산됩니다(방류구 관저고만 고정). 방류 경계 FIXED 는 ‘FIXED 수위’(절대 표고)를 함께 입력하세요. X·Y 가 EPSG:5186 범위(예: 234000, 417000)면 지도에서 그
          위치에 놓입니다.
        </Note>
      </section>

      <section>
        <h3 className="mb-1.5 text-xs font-semibold text-ink">관로 (원형관)</h3>
        <EditableTable<SewerConduit>
          rows={project.conduits}
          columns={CONDUIT_COLUMNS}
          addLabel="관로 추가"
          onAdd={() =>
            edit((d) => {
              const ids = d.nodes.map((n) => n.id);
              d.conduits.push({ id: nextId('P', d.conduits.map((c) => c.id)), upstream: ids[0] ?? '', downstream: ids[1] ?? '', length: 100, diameter: 0.25, roughness: 0.013, inlet_offset: 0, outlet_offset: 0 });
            })
          }
          onRemove={(i) => edit((d) => void d.conduits.splice(i, 1))}
          onChange={(i, key, value) => edit((d) => void ((d.conduits[i] as unknown as Record<string, unknown>)[key] = value))}
        />
        <Note>맨홀 하나에는 하류 관로가 정확히 1개여야 합니다(가지형 관망). 관경·옵셋은 자동 설계가 정합니다.</Note>
      </section>

      <section>
        <h3 className="mb-1.5 text-xs font-semibold text-ink">유역 (강우 유출)</h3>
        <EditableTable<SewerCatchment>
          rows={project.catchments}
          columns={CATCHMENT_COLUMNS}
          addLabel="유역 추가"
          onAdd={() =>
            edit((d) => {
              const first = d.nodes.find((n) => n.kind === 'JUNCTION');
              d.catchments.push({ id: nextId('S', d.catchments.map((c) => c.id)), outlet: first?.id ?? '', area: 1, impervious: 60, width: 100, slope: 1, runoff_coefficient: 0.65, horton_max: 75, horton_min: 5, horton_decay: 4 });
            })
          }
          onRemove={(i) => edit((d) => void d.catchments.splice(i, 1))}
          onChange={(i, key, value) => edit((d) => void ((d.catchments[i] as unknown as Record<string, unknown>)[key] = value))}
        />
        <Note>설계 유량은 합리식 Q = C·I·A/360 (I: 설계 강우강도, A: ha)로 구하고, SWMM 해석은 불투수율·침투(Horton)·폭·경사로 유출을 계산합니다. 두 방식의 유출은 같지 않습니다.</Note>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ 설계 조건 */

function ConditionsTab() {
  const project = useSewerStore((s) => s.project);
  const edit = useSewerStore((s) => s.edit);
  const designMode = useSewerStore((s) => s.designMode);
  const c = project.constraints;
  const o = project.options;
  const [diameterText, setDiameterText] = useState<string | null>(null);
  const [rainText, setRainText] = useState<string | null>(null);

  const field = (label: string, unit: string, value: number, onCommit: (v: number) => void, min?: number) => (
    <label className="grid grid-cols-[170px_110px_1fr] items-center gap-2 py-0.5">
      <span className="text-xs text-ink-soft">{label}</span>
      <NumberField value={value} min={min} onCommit={onCommit} />
      <span className="text-[11px] text-ink-muted">{unit}</span>
    </label>
  );

  return (
    <div className="grid grid-cols-2 gap-6">
      <section>
        <h3 className="mb-1.5 text-xs font-semibold text-ink">설계 제약</h3>
        <Note tone="warn">기본값은 SewerStudio 의 예제값이며 한국 하수도시설기준으로 검증된 값이 아닙니다. 사용하는 기준에 맞게 직접 입력하세요.</Note>
        <div className="mt-2">
          {field('최소 토피', 'm', c.min_cover, (v) => edit((d) => void (d.constraints.min_cover = v)), 0)}
          {field('최대 굴착깊이', 'm', c.max_depth, (v) => edit((d) => void (d.constraints.max_depth = v)), 0)}
          {field('최소 경사', 'm/m', c.min_slope, (v) => edit((d) => void (d.constraints.min_slope = v)), 0)}
          {field('최대 경사', 'm/m', c.max_slope, (v) => edit((d) => void (d.constraints.max_slope = v)), 0)}
          {field('최소 유속 (설계 유량에서)', 'm/s', c.min_velocity, (v) => edit((d) => void (d.constraints.min_velocity = v)), 0)}
          {field('최대 유속', 'm/s', c.max_velocity, (v) => edit((d) => void (d.constraints.max_velocity = v)), 0)}
          {field('최대 충만율 d/D', '(≤ 0.9)', c.max_depth_ratio, (v) => edit((d) => void (d.constraints.max_depth_ratio = v)), 0)}
          {field('반복 검토 최대 횟수', '회 (≤ 15)', c.max_iterations, (v) => edit((d) => void (d.constraints.max_iterations = Math.round(v))), 1)}
          {field('연속성 오차 허용', '%', c.continuity_tolerance, (v) => edit((d) => void (d.constraints.continuity_tolerance = v)), 0)}
          <label className="grid grid-cols-[170px_1fr] items-center gap-2 py-0.5">
            <span className="text-xs text-ink-soft">소유량 관로 처리</span>
            <SelectField
              value={designMode}
              options={[
                { value: 'practical', label: '실무: 최소 관경·경사 (유속 미달 표시)' },
                { value: 'compat', label: '원본 호환: 가장 큰 관경' },
              ]}
              onChange={(v) => useSewerStore.getState().setDesignMode(v as DesignMode)}
            />
          </label>
          <Note>유량이 너무 작아 어떤 경사로도 최소 유속을 못 내는 관(주로 상류 말단)을 어떻게 둘지. ‘원본 호환’은 SewerStudio 와 같게 가장 큰 관경을 넣습니다.</Note>
          <div className="mt-2">
            <p className="mb-1 text-xs text-ink-soft">표준 관경 (m, 오름차순)</p>
            <input
              type="text"
              aria-label="표준 관경"
              spellCheck={false}
              value={diameterText ?? c.diameters.join(' ')}
              onChange={(e) => setDiameterText(e.target.value)}
              onBlur={() => {
                if (diameterText === null) return;
                const list = diameterText.split(/[\s,]+/).filter(Boolean).map(Number);
                setDiameterText(null);
                if (list.length > 0 && list.every((x) => Number.isFinite(x))) edit((d) => void (d.constraints.diameters = list));
              }}
              className="h-7 w-full rounded border border-line bg-field px-2 font-mono text-[11px] text-ink outline-none focus:border-accent"
            />
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-1.5 text-xs font-semibold text-ink">강우·해석</h3>
        <div>
          {field('설계 강우강도 (합리식)', 'mm/h', o.design_intensity, (v) => edit((d) => void (d.options.design_intensity = v)), 0)}
          {field('해석 시간', '분', o.duration_minutes, (v) => edit((d) => void (d.options.duration_minutes = Math.round(v))), 10)}
          {field('출력 간격', '초', o.report_seconds, (v) => edit((d) => void (d.options.report_seconds = Math.round(v))), 1)}
          {field('계산 간격', '초', o.routing_seconds, (v) => edit((d) => void (d.options.routing_seconds = v)), 0.1)}
          {field('강우 간격', '분', o.rain_interval_minutes, (v) => edit((d) => void (d.options.rain_interval_minutes = Math.round(v))), 1)}
          <label className="grid grid-cols-[170px_110px_1fr] items-center gap-2 py-0.5">
            <span className="text-xs text-ink-soft">흐름 계산</span>
            <SelectField value={o.routing} options={[{ value: 'DYNWAVE', label: '동적파' }, { value: 'KINWAVE', label: '운동파' }]} onChange={(v) => edit((d) => void (d.options.routing = v))} />
          </label>
        </div>
        <div className="mt-2">
          <p className="mb-1 text-xs text-ink-soft">강우 곡선 (시작 후 분, mm/h — 다음 점까지 일정)</p>
          <input
            type="text"
            aria-label="강우 곡선"
            spellCheck={false}
            value={rainText ?? o.rainfall.map((p) => `${p.minute}:${p.intensity}`).join('  ')}
            onChange={(e) => setRainText(e.target.value)}
            onBlur={() => {
              if (rainText === null) return;
              const pts = rainText
                .split(/[\s,]+/)
                .filter(Boolean)
                .map((t) => t.split(':').map(Number));
              setRainText(null);
              if (pts.length > 0 && pts.every((p) => p.length === 2 && p.every(Number.isFinite))) edit((d) => void (d.options.rainfall = pts.map(([minute, intensity]) => ({ minute, intensity }))));
            }}
            className="h-7 w-full rounded border border-line bg-field px-2 font-mono text-[11px] text-ink outline-none focus:border-accent"
          />
          <Note>예: 0:0 10:20 20:55 40:25 60:0 — 첫 점은 0분, 마지막 점은 해석 시간보다 앞서야 하고 강우 간격의 배수여야 합니다.</Note>
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ 설계 결과 + 종단도 */

function Profile({ project, start, onStart }: { project: SewerProject; start?: string; onStart?: (id: string) => void }) {
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
    <div className="mt-3">
      <div className="mb-1 flex items-center gap-2 text-xs text-ink-soft">
        <span className="font-semibold text-ink">종단도</span>
        시작 절점
        <div className="w-28">
          <SelectField value={startId || data[0].id} options={nodeOptions} onChange={setStartId} />
        </div>
        <span className="text-[11px] text-ink-muted">하류 방류구까지 · {simulation ? '파란 점선: 최대 수두(HGL, SWMM)' : '해석하면 최대 수두선이 함께 그려집니다'}</span>
      </div>
      <div className="h-52">
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

function DesignTab() {
  const design = useSewerStore((s) => s.design);
  const busy = useSewerStore((s) => s.busy);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy !== null} onClick={() => runSewerDesign()}>
          <Wand2 size={13} />
          ① 자동 설계
        </Button>
        <Button disabled={!design} onClick={applyDesignToProject} title="설계한 관경·관저고·옵셋을 입력 표에 반영합니다 (실행 취소 가능)">
          <RefreshCw size={13} />
          설계 결과를 입력에 반영
        </Button>
        <Button disabled={!design} onClick={exportSewerCsv}>
          <Download size={13} />
          CSV
        </Button>
        <Button disabled={!design} onClick={exportSewerInp}>
          <Download size={13} />
          SWMM .inp
        </Button>
      </div>
      <Note>
        상류부터 지반 경사 예산·유속을 만족하는 가장 작은 표준 관경을 고르고, 맨홀마다 공통 관정을 맞춘 뒤 경사·토피·굴착깊이·유속·d/D 를 다시 검토합니다. 비용 최적화나 수면곡선(GVF)
        해석이 아닌 초기 설계 휴리스틱입니다.
      </Note>
      {!design ? (
        <p className="mt-6 text-center text-xs text-ink-muted">‘① 자동 설계’를 누르면 관경·관저고·옵셋과 제약 검토 결과가 여기에 표시됩니다.</p>
      ) : (
        <>
          <div className={`mt-3 flex items-center gap-2 rounded border px-3 py-2 text-xs ${design.feasible ? 'border-good/40 bg-good/10 text-ink' : 'border-warn/40 bg-warn/10 text-ink'}`}>
            {design.feasible ? <CircleCheck size={14} className="text-good" /> : <TriangleExclamationPoint size={14} className="text-warn" />}
            {design.feasible ? '모든 제약을 만족합니다.' : `제약 위반 ${design.issues.length}건`}
          </div>
          {design.issues.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-[11px] text-ink">
              {design.issues.map((m, i) => (
                <li key={i}>· {m}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 max-h-52 overflow-auto rounded border border-line">
            <table className="w-full text-xs tabular-nums">
              <thead className="sticky top-0 bg-panel text-ink-soft">
                <tr>
                  {['관로', '관경 (m)', '설계 유량 (m³/s)', '경사', '유속 (m/s)', 'd/D', '토피 (m)', '상태'].map((h, i) => (
                    <th key={h} className={`px-2 py-1 font-medium ${i === 0 || i === 7 ? 'text-left' : 'text-right'}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {design.rows.map((r) => (
                  <tr key={r.id} className="border-t border-line/50">
                    <td className="px-2 py-0.5 text-ink">{r.id}</td>
                    <td className="px-2 py-0.5 text-right text-ink">{r.diameter}</td>
                    <td className="px-2 py-0.5 text-right text-ink-soft">{r.flow.toFixed(4)}</td>
                    <td className="px-2 py-0.5 text-right text-ink-soft">{r.slope.toFixed(4)}</td>
                    <td className="px-2 py-0.5 text-right text-ink-soft">{r.velocity.toFixed(2)}</td>
                    <td className="px-2 py-0.5 text-right text-ink-soft">{r.depth_ratio.toFixed(2)}</td>
                    <td className="px-2 py-0.5 text-right text-ink-soft">{r.cover.toFixed(2)}</td>
                    <td className={`px-2 py-0.5 ${r.status === '적합' ? 'text-good' : 'text-[#f3a5a5]'}`}>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Profile project={design.project} />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 해석·반복 검토 */

function CheckTab() {
  const design = useSewerStore((s) => s.design);
  const simulation = useSewerStore((s) => s.simulation);
  const outcome = useSewerStore((s) => s.outcome);
  const busy = useSewerStore((s) => s.busy);
  const run = useSewerStore((s) => s.run);

  const flooded = simulation ? Object.entries(simulation.node_summary).filter(([, n]) => n.flood_hours > 0) : [];
  const surcharged = simulation ? Object.entries(simulation.node_summary).filter(([, n]) => n.surcharged) : [];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy !== null} onClick={() => void runSewerSimulation()}>
          <Play size={13} />
          ② SWMM 해석
        </Button>
        <Button variant="primary" disabled={busy !== null} onClick={() => void runSewerOptimize()}>
          <Repeat size={13} />
          ③ 반복 검토 (자동 관경 확대)
        </Button>
        <Button disabled={!design} onClick={showSewerOnMap} title="설계한 관망을 지도의 우수·하수 보기로 엽니다 (해석 결과가 있으면 함께)">
          <MapIcon size={13} />
          지도에서 보기
        </Button>
        {busy && <span className="text-xs text-ink-soft">{busy}</span>}
      </div>
      <Note>
        ② 는 설계한 관망을 SWMM 동적파로 해석해 월류·만관 초과·연속성 오차를 봅니다. ③ 은 설계 → 해석 → 용량 부족·월류 관로의 관경을 한 규격씩 키우는 과정을 조건이 맞을 때까지(최대 반복
        횟수) 되풀이합니다. 해석 엔진: {run ? `EPA SWMM ${run.engineVersion}` : '브라우저 내장 SWMM'} — 원본 SewerStudio 는 공식 5.2.4 를 썼고 이 앱은 WASM 빌드를 씁니다.
      </Note>

      {simulation && (
        <div className="mt-3">
          <div className={`flex items-center gap-2 rounded border px-3 py-2 text-xs ${simulation.quality_ok && flooded.length === 0 && surcharged.length === 0 ? 'border-good/40 bg-good/10' : 'border-warn/40 bg-warn/10'}`}>
            {simulation.quality_ok && flooded.length === 0 && surcharged.length === 0 ? <CircleCheck size={14} className="text-good" /> : <TriangleExclamationPoint size={14} className="text-warn" />}
            <span className="text-ink">
              월류 {flooded.length}곳 · 만관 초과(수두가 관정 위) {surcharged.length}곳 · 연속성 오차 {Object.entries(simulation.continuity).map(([k, v]) => `${k.replace(' Continuity', '')} ${v}%`).join(', ')}
              {!simulation.quality_ok && ' — 오차 또는 SWMM 경고 검토 필요'}
            </span>
          </div>
          {simulation.warnings.length > 0 && <Note tone="warn">{simulation.warnings.slice(0, 3).join(' | ')}</Note>}
          <div className="mt-2 max-h-44 overflow-auto rounded border border-line">
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
      )}

      {outcome && (
        <div className="mt-3">
          <h3 className="mb-1 text-xs font-semibold text-ink">
            반복 이력 — {outcome.converged ? '수렴' : '미수렴'}: {outcome.stop_reason}
          </h3>
          <div className="overflow-auto rounded border border-line">
            <table className="w-full text-xs">
              <thead className="bg-panel text-ink-soft">
                <tr>
                  {['회차', '용량 부족·월류 관로', '유속 초과', '설계 위반', '해석 품질', '결과'].map((h) => (
                    <th key={h} className="px-2 py-1 text-left font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {outcome.history.map((h) => (
                  <tr key={h.iteration} className="border-t border-line/50 align-top">
                    <td className="px-2 py-0.5 text-ink">{h.iteration}</td>
                    <td className="px-2 py-0.5 text-ink-soft">{h.critical_links.length > 0 ? `${h.critical_links.length}개: ${h.critical_links.join(', ')}` : '없음'}</td>
                    <td className="px-2 py-0.5 text-ink-soft">{h.velocity_violations.length > 0 ? h.velocity_violations.join(', ') : '없음'}</td>
                    <td className="px-2 py-0.5 text-ink-soft">{h.design_issues.length > 0 ? `${h.design_issues.length}건` : '없음'}</td>
                    <td className="px-2 py-0.5 text-ink-soft">{h.quality_ok ? '통과' : '검토 필요'}</td>
                    <td className={`px-2 py-0.5 ${h.converged ? 'text-good' : 'text-warn'}`}>{h.converged ? '조건 만족' : '관경 확대'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {!simulation && !outcome && <p className="mt-6 text-center text-xs text-ink-muted">② 또는 ③ 을 실행하면 해석 결과가 여기에 표시됩니다.</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ 검토 목록 */

const VERDICT_CLASS: Record<Verdict, string> = { GOOD: 'text-good', NG: 'text-[#f3a5a5] font-semibold', '-': 'text-ink-muted' };

function ReviewTab() {
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
    if (row) setProfileStart(row.upstream);
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

  if (!design) return <p className="mt-6 text-center text-xs text-ink-muted">‘설계 결과’ 탭에서 ① 자동 설계를 먼저 실행하세요. 동수위 판정은 ② SWMM 해석 뒤에 나옵니다.</p>;
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
        기존 하수 설계 프로그램의 검토 목록과 같은 판정입니다. 하늘색 관로번호 = 시작관·관말. 행을 누르면 아래 종단도가 그 관로부터 그려집니다.
        {!simulation && ' 동수위는 ② SWMM 해석 뒤에 판정합니다(지금은 -).'}
      </Note>
      <div className="mt-2 max-h-60 overflow-auto rounded border border-line">
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
      <Profile project={design.project} start={profileStart} onStart={setProfileStart} />
    </div>
  );
}

/* ------------------------------------------------------------------ 대화상자 */

function SewerDialog() {
  const [tab, setTab] = useState<Tab>('input');
  const project = useSewerStore((s) => s.project);
  const error = useSewerStore((s) => s.error);
  const canUndo = useSewerStore((s) => s.past.length > 0);
  const close = () => useUIStore.getState().openModal(null);

  const validation = useMemo(() => {
    try {
      parseSewerProject(JSON.parse(JSON.stringify(project)));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [project]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'input', label: '관망 입력' },
    { id: 'conditions', label: '설계 조건' },
    { id: 'design', label: '설계 결과' },
    { id: 'check', label: '해석·반복 검토' },
    { id: 'review', label: '검토 목록' },
  ];
  return (
    <Modal
      title="하수관 자동 설계 (우·오수 중력 관망)"
      onClose={close}
      widthClass="w-[960px]"
      footer={
        <>
          <Button variant="ghost" disabled={!canUndo} onClick={() => useSewerStore.getState().undo()} title="입력 편집 되돌리기">
            <Undo2 size={13} />
            되돌리기
          </Button>
          <span className="mr-auto text-[11px] text-ink-muted">단위: m · m³/s · ha · mm/h. 가지형(수지상) 하수관만 지원합니다.</span>
          <Button onClick={close}>닫기</Button>
        </>
      }
    >
      <div className="-mx-4 -mt-3 mb-3 flex border-b border-line px-2" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`border-b-2 px-3 py-2 text-xs transition-colors ${tab === t.id ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink-soft'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {(error || validation) && (
        <p className="mb-3 flex items-start gap-1.5 rounded border border-critical/40 bg-critical/10 px-3 py-2 text-[11px] leading-relaxed text-ink">
          <TriangleExclamationPoint size={13} className="mt-px shrink-0 text-warn" />
          <span className="break-words">{error ?? validation}</span>
        </p>
      )}
      {tab === 'input' && <InputTab />}
      {tab === 'conditions' && <ConditionsTab />}
      {tab === 'design' && <DesignTab />}
      {tab === 'check' && <CheckTab />}
      {tab === 'review' && <ReviewTab />}
    </Modal>
  );
}

/** 하수관 자동 설계 대화상자. */
export function SewerDesignModal() {
  const open = useUIStore((s) => s.modal === 'sewer');
  return open ? <SewerDialog /> : null;
}
