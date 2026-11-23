/** 하수 모드 우측 패널: 관망 요약·설계 실행, 선택한 맨홀/관거 속성 편집, 설계값·검토 판정. */
import { ArrowDownToLine, ClipboardList, FileUp, Gauge, Mountain, Play, RefreshCw, Repeat, SlidersHorizontal, Trash2, TriangleExclamationPoint, Wand2 } from 'lucide-react';
import { NgiiLink } from '../ui/DataLinks';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { applyDesignToProject, fitOutfallDepth, runSewerDesign, runSewerOptimize } from '../../app/sewerActions';
import { correctSewerGround, correctSewerGroundFromFiles, deleteSewerSelection, importSewerSurvey, runSewerAsBuiltFromMap, runSewerFromMap } from '../../app/sewerMapActions';
import { formatNumber } from '../../core/model/units';
import { idProblem, renameSewerConduit, renameSewerNode, setSewerNodeKind, sewerSummary } from '../../core/sewer/edit';
import { isGeoreferenced } from '../../core/sewer/mapFrame';
import { REVIEW_KINDS, reviewSewer, type Verdict } from '../../core/sewer/review';
import { buildNetwork } from '../../core/sewer/topology';
import type { SewerBoundary, SewerCatchment, SewerConduit, SewerNode, SewerNodeKind } from '../../core/sewer/types';
import { parseSewerProject, SewerValidationError } from '../../core/sewer/validate';
import { PumpSection } from './PumpSection';
import { useSewerStore } from '../../store/useSewerStore';
import { useUIStore } from '../../store/useUIStore';
import { Button, FieldRow, NumberField, ReadonlyValue, Section, SelectField, TextField } from '../ui/fields';

const VERDICT_CLASS: Record<Verdict, string> = { GOOD: 'text-good', NG: 'font-semibold text-[#f3a5a5]', '-': 'text-ink-muted' };

function Row({ label, unit, children }: { label: string; unit?: string; children: ReactNode }) {
  return (
    <FieldRow label={label} unit={unit} plain>
      <ReadonlyValue>{children}</ReadonlyValue>
    </FieldRow>
  );
}

function toastIdProblem(problem: string): false {
  useUIStore.getState().pushToast({ level: 'warning', title: 'ID 를 바꿀 수 없습니다', message: problem });
  return false;
}

function NodeSection({ node }: { node: SewerNode }) {
  const edit = useSewerStore((s) => s.edit);
  const select = useSewerStore((s) => s.select);
  const designed = useSewerStore((s) => s.design?.project.nodes.find((n) => n.id === node.id));
  const result = useSewerStore((s) => s.simulation?.node_summary[node.id]);
  const patch = (recipe: (n: SewerNode) => void) => edit((d) => void d.nodes.filter((n) => n.id === node.id).forEach(recipe));
  const outfall = node.kind === 'OUTFALL';
  return (
    <Section title={`${outfall ? '방류구' : '맨홀'} ${node.id}`}>
      <FieldRow label="ID">
        <TextField
          value={node.id}
          onCommit={(next) => {
            const problem = idProblem(useSewerStore.getState().project.nodes.map((n) => n.id), node.id, next);
            if (problem) return toastIdProblem(problem);
            edit((d) => void renameSewerNode(d, node.id, next));
            select({ kind: 'node', id: next });
          }}
        />
      </FieldRow>
      <FieldRow label="종류">
        <SelectField<SewerNodeKind>
          value={node.kind}
          options={[{ value: 'JUNCTION', label: '맨홀' }, { value: 'OUTFALL', label: '방류구' }]}
          onChange={(kind) => edit((d) => setSewerNodeKind(d, node.id, kind))}
        />
      </FieldRow>
      <FieldRow label="지반고" unit="m">
        <NumberField value={node.ground} onCommit={(v) => patch((n) => void (n.ground = v))} />
      </FieldRow>
      <FieldRow label="관저고" unit="m">
        <NumberField value={node.invert} onCommit={(v) => patch((n) => void (n.invert = v))} />
      </FieldRow>
      <Row label="깊이" unit="m">
        <span className={node.ground > node.invert ? '' : 'text-[#f3a5a5]'}>{formatNumber(node.ground - node.invert, 2)}</span>
      </Row>
      <FieldRow label="오수 유입" unit="m³/s">
        <NumberField value={node.base_flow} min={0} disabled={outfall} onCommit={(v) => patch((n) => void (n.base_flow = v))} />
      </FieldRow>
      <FieldRow label="방류 경계">
        <SelectField<SewerBoundary>
          value={node.boundary}
          disabled={!outfall}
          options={[{ value: 'FREE', label: 'FREE (자유 방류)' }, { value: 'NORMAL', label: 'NORMAL (등류)' }, { value: 'FIXED', label: 'FIXED (고정 수위)' }]}
          onChange={(boundary) =>
            patch((n) => {
              n.boundary = boundary;
              n.stage = boundary === 'FIXED' ? (n.stage ?? n.invert) : null;
            })
          }
        />
      </FieldRow>
      {node.boundary === 'FIXED' && (
        <FieldRow label="고정 수위" unit="m">
          <NumberField value={node.stage ?? node.invert} onCommit={(v) => patch((n) => void (n.stage = v))} />
        </FieldRow>
      )}
      <Row label="X · Y" unit="m">
        {formatNumber(node.x, 1)} · {formatNumber(node.y, 1)}
      </Row>
      {!outfall && <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">맨홀 관저고는 자동 설계가 다시 정합니다(방류구 관저고만 고정).</p>}
      {(designed || result) && (
        <div className="mt-1.5 border-t border-line/60 pt-1.5">
          <p className="mb-0.5 text-[11px] text-ink-muted">설계·해석 결과</p>
          {designed && (
            <Row label="설계 관저고" unit="m">
              {formatNumber(designed.invert, 3)} (깊이 {formatNumber(designed.ground - designed.invert, 2)})
            </Row>
          )}
          {result && (
            <>
              <Row label="최대 수두" unit="m">
                {formatNumber(result.max_hgl, 2)}
              </Row>
              <Row label="최대 수심" unit="m">
                {formatNumber(result.max_depth, 2)}
              </Row>
              <Row label="월류">
                <span className={result.flood_hours > 0 ? 'text-[#f3a5a5]' : 'text-good'}>
                  {result.flood_hours > 0 ? `${formatNumber(result.flood_volume_m3, 1)} m³ · ${formatNumber(result.flood_hours, 2)} h` : '없음'}
                  {result.surcharged ? ' · 만관 초과' : ''}
                </span>
              </Row>
            </>
          )}
        </div>
      )}
    </Section>
  );
}

function ConduitSection({ conduit }: { conduit: SewerConduit }) {
  const edit = useSewerStore((s) => s.edit);
  const select = useSewerStore((s) => s.select);
  const design = useSewerStore((s) => s.design);
  const simulation = useSewerStore((s) => s.simulation);
  const patch = (recipe: (c: SewerConduit) => void) => edit((d) => void d.conduits.filter((c) => c.id === conduit.id).forEach(recipe));
  const row = design?.rows.find((r) => r.id === conduit.id);
  const review = useMemo(() => (design ? reviewSewer(design, simulation).find((r) => r.id === conduit.id) : undefined), [design, simulation, conduit.id]);
  return (
    <Section title={`관거 ${conduit.id}`}>
      <FieldRow label="ID">
        <TextField
          value={conduit.id}
          onCommit={(next) => {
            const problem = idProblem(useSewerStore.getState().project.conduits.map((c) => c.id), conduit.id, next);
            if (problem) return toastIdProblem(problem);
            edit((d) => void renameSewerConduit(d, conduit.id, next));
            select({ kind: 'conduit', id: next });
          }}
        />
      </FieldRow>
      <FieldRow label="상류 → 하류" plain>
        <span className="flex gap-1 text-xs">
          <button type="button" className="text-accent hover:underline" onClick={() => select({ kind: 'node', id: conduit.upstream })}>
            {conduit.upstream}
          </button>
          →
          <button type="button" className="text-accent hover:underline" onClick={() => select({ kind: 'node', id: conduit.downstream })}>
            {conduit.downstream}
          </button>
        </span>
      </FieldRow>
      <FieldRow label="연장" unit="m">
        <NumberField value={conduit.length} min={0.01} onCommit={(v) => patch((c) => void (c.length = v))} />
      </FieldRow>
      <FieldRow label="관경" unit="m">
        <NumberField value={conduit.diameter} min={0.01} onCommit={(v) => patch((c) => void (c.diameter = v))} />
      </FieldRow>
      <FieldRow label="Manning n">
        <NumberField value={conduit.roughness} min={0.001} step={0.001} onCommit={(v) => patch((c) => void (c.roughness = Math.min(0.1, v)))} />
      </FieldRow>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">관경은 자동 설계가 다시 정합니다. 절점을 끌어 옮기면 연장은 평면 거리로 다시 계산됩니다.</p>
      {row ? (
        <div className="mt-1.5 border-t border-line/60 pt-1.5">
          <p className="mb-0.5 text-[11px] text-ink-muted">설계 결과</p>
          <Row label="설계 관경" unit="m">
            {row.diameter}
          </Row>
          <Row label="설계 유량" unit="m³/s">
            {row.flow.toFixed(4)}
          </Row>
          <Row label="경사" unit="‰">
            {(row.slope * 1000).toFixed(2)}
          </Row>
          <Row label="유속" unit="m/s">
            {row.velocity.toFixed(2)}
          </Row>
          <Row label="수심비 d/D">{row.depth_ratio.toFixed(2)}</Row>
          <Row label="토피" unit="m">
            {row.cover.toFixed(2)}
          </Row>
          <Row label="상태">
            <span className={row.status.startsWith('적합') ? 'text-good' : 'text-[#f3a5a5]'} title={row.status}>
              {row.status}
            </span>
          </Row>
          {review && (
            <>
              <p className="mb-0.5 mt-1.5 text-[11px] text-ink-muted">검토 목록 판정{simulation ? '' : ' (동수위는 해석 후)'}</p>
              {REVIEW_KINDS.map((k) => (
                <Row key={k.kind} label={k.label}>
                  <span className={VERDICT_CLASS[review.verdict[k.kind]]} title={k.rule}>
                    {review.verdict[k.kind]}
                  </span>
                </Row>
              ))}
            </>
          )}
        </div>
      ) : (
        <p className="mt-1.5 border-t border-line/60 pt-1.5 text-[11px] text-ink-muted">자동 설계를 실행하면 설계 관경·경사·유속·d/D·토피와 검토 판정이 여기에 표시됩니다.</p>
      )}
    </Section>
  );
}

function CatchmentSection({ catchment }: { catchment: SewerCatchment }) {
  const edit = useSewerStore((s) => s.edit);
  const nodes = useSewerStore((s) => s.project.nodes);
  const junctions = useMemo(() => nodes.filter((n) => n.kind === 'JUNCTION').map((n) => n.id), [nodes]);
  const intensity = useSewerStore((s) => s.project.options.design_intensity);
  const patch = (recipe: (c: SewerCatchment) => void) =>
    edit((d) => {
      const c = d.catchments.find((x) => x.id === catchment.id);
      if (c) recipe(c);
    });
  const drawn = Boolean(catchment.polygon);
  const q = (catchment.runoff_coefficient * intensity * catchment.area) / 360;
  return (
    <Section
      title={`유역 ${catchment.id}`}
      action={
        <button type="button" className="text-[11px] text-ink-muted hover:text-critical" onClick={deleteSewerSelection} title="이 유역을 지웁니다 (Delete)">
          <Trash2 size={13} />
        </button>
      }
    >
      <FieldRow label="출구 맨홀">
        <SelectField<string> value={catchment.outlet} options={junctions.map((id) => ({ value: id, label: id }))} onChange={(v) => patch((c) => void (c.outlet = v))} />
      </FieldRow>
      <FieldRow label="면적" unit="ha">
        {drawn ? <ReadonlyValue>{catchment.area.toFixed(4)}</ReadonlyValue> : <NumberField value={catchment.area} min={0.0001} step={0.01} onCommit={(v) => patch((c) => void (c.area = v))} />}
      </FieldRow>
      <FieldRow label="유출계수 C">
        <NumberField value={catchment.runoff_coefficient} min={0} step={0.05} onCommit={(v) => patch((c) => void (c.runoff_coefficient = Math.min(1, v)))} />
      </FieldRow>
      <FieldRow label="불투수율" unit="%">
        <NumberField value={catchment.impervious} min={0} step={5} onCommit={(v) => patch((c) => void (c.impervious = Math.min(100, v)))} />
      </FieldRow>
      <FieldRow label="경사" unit="%">
        <NumberField value={catchment.slope} min={0.01} step={0.1} onCommit={(v) => patch((c) => void (c.slope = Math.min(100, v)))} />
      </FieldRow>
      <FieldRow label="폭 (SWMM)" unit="m">
        <NumberField value={catchment.width} min={1} onCommit={(v) => patch((c) => void (c.width = v))} />
      </FieldRow>
      <Row label="합리식 유출량" unit="m³/s">
        {q.toFixed(4)}
      </Row>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
        {drawn ? '면적·폭은 그린 경계에서 계산했습니다. ' : ''}Q = C · I · A / 360 (I = 설계 강우강도 {intensity} mm/h). SWMM 해석은 강우 곡선과 Horton 침투로 유출을 계산합니다.
      </p>
    </Section>
  );
}

/** 지반고·관저고 보정: 지형 타일 · 수치지형도(DXF·SHP·XYZ) · 맨홀 측량 성과 표. */
function CorrectionSection({ disabled, georeferenced }: { disabled: boolean; georeferenced: boolean }) {
  const [keepDepth, setKeepDepth] = useState(true);
  const terrainInput = useRef<HTMLInputElement>(null);
  const surveyInput = useRef<HTMLInputElement>(null);
  return (
    <Section title="지반고 · 관저고 보정">
      <label className="mb-1.5 flex items-center gap-1.5 text-[11px] text-ink-soft">
        <input type="checkbox" checked={keepDepth} onChange={(e) => setKeepDepth(e.target.checked)} />
        관저고도 같은 만큼 옮기기 (매설 깊이 유지)
      </label>
      <div className="grid grid-cols-2 gap-1.5">
        <Button disabled={disabled || !georeferenced} onClick={() => terrainInput.current?.click()} title="수치지형도 DXF(등고선·표고점), Shapefile(.shp 묶음·.zip), 표고점 텍스트(.xyz·.csv)로 지반고를 보간합니다">
          <FileUp size={13} />
          수치지형도
        </Button>
        <Button disabled={disabled} onClick={() => void correctSewerGround(keepDepth)} title="온라인 지형 타일(SRTM 30 m 급, 수 m 오차)에서 지반고를 읽습니다">
          <Mountain size={13} />
          지형 타일
        </Button>
        <Button className="col-span-2" disabled={disabled} onClick={() => surveyInput.current?.click()} title="맨홀번호·지반고·관저고(또는 깊이) 열이 있는 CSV 를 같은 번호의 맨홀에 넣습니다">
          <ClipboardList size={13} />
          맨홀 측량 성과 (CSV) 반영
        </Button>
      </div>
      <p className="mt-1.5 text-[10px] leading-relaxed text-ink-muted">
        측량 성과 표 머리글 예: 맨홀번호, 지반고, 관저고 (또는 깊이). 측량 관저고로 검토하려면 ‘현황 해석’을 쓰세요 — 자동 설계는 관저고를 다시 계산합니다.
        {!georeferenced && ' 도면 좌표 관망이라 수치지형도 보정은 쓸 수 없습니다.'}
        <NgiiLink />
      </p>
      <input
        ref={terrainInput}
        type="file"
        multiple
        accept=".dxf,.shp,.dbf,.prj,.cpg,.shx,.zip,.xyz,.txt,.csv,.pts"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length > 0) void correctSewerGroundFromFiles(files, keepDepth);
        }}
      />
      <input
        ref={surveyInput}
        type="file"
        accept=".csv,.txt,.tsv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importSewerSurvey(file);
        }}
      />
    </Section>
  );
}

export function SewerPropertyPanel() {
  const project = useSewerStore((s) => s.project);
  const design = useSewerStore((s) => s.design);
  const selection = useSewerStore((s) => s.selection);
  const standard = useSewerStore((s) => s.standard);
  const busy = useSewerStore((s) => s.busy);
  const error = useSewerStore((s) => s.error);
  const edit = useSewerStore((s) => s.edit);
  const summary = useMemo(() => sewerSummary(project), [project]);
  const georeferenced = useMemo(() => isGeoreferenced(project), [project]);
  // 설계할 수 있는 상태인지 (스키마 + 가지형 위상) — 편집 중에 바로 알려 준다
  const problem = useMemo(() => {
    if (project.nodes.length === 0) return null;
    try {
      buildNetwork(parseSewerProject(JSON.parse(JSON.stringify(project))));
      return null;
    } catch (error) {
      if (error instanceof SewerValidationError) return error.details.slice(0, 2).map((d) => (d.loc.length ? `${d.loc.join('.')}: ` : '') + d.msg).join(' / ');
      return error instanceof Error ? error.message : String(error);
    }
  }, [project]);

  const node = selection?.kind === 'node' ? project.nodes.find((n) => n.id === selection.id) : undefined;
  const conduit = selection?.kind === 'conduit' ? project.conduits.find((c) => c.id === selection.id) : undefined;
  const catchment = selection?.kind === 'catchment' ? project.catchments.find((c) => c.id === selection.id) : undefined;
  const pump = selection?.kind === 'pump' ? project.pumps?.find((p) => p.id === selection.id) : undefined;

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-line bg-panel">
      <Section title="하수 관망 (편집)">
        <FieldRow label="이름">
          <TextField value={project.name} onCommit={(v) => edit((d) => void (d.name = v))} />
        </FieldRow>
        <Row label="맨홀 · 방류구">
          {summary.manholes.toLocaleString()}개 · {summary.outfalls}개
        </Row>
        <Row label="관거">{summary.conduits.toLocaleString()}개</Row>
        <Row label="총 연장" unit="m">
          {formatNumber(summary.totalLength, 1)}
        </Row>
        <Row label="유역">{project.catchments.length}개</Row>
        <Row label="좌표">{georeferenced ? 'EPSG:5186' : '도면 좌표 (기준 위치에 배치)'}</Row>
        <Row label="설계기준">
          <span title={standard ?? '기본 제약값은 예제값이며 검증된 설계기준이 아닙니다.'}>{standard ?? '예제값 (기준 미적용)'}</span>
        </Row>
        {problem && (
          <p className="mt-1.5 flex items-start gap-1.5 rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-[11px] leading-relaxed text-ink">
            <TriangleExclamationPoint size={12} className="mt-0.5 shrink-0 text-warn" />
            <span className="break-words">{problem}</span>
          </p>
        )}
        {error && error !== problem && (
          <p className="mt-1.5 break-words rounded border border-critical/40 bg-critical/10 px-2 py-1.5 text-[11px] leading-relaxed text-ink">{error}</p>
        )}
        {design && (
          <p className={`mt-1.5 rounded border px-2 py-1.5 text-[11px] ${design.feasible ? 'border-good/40 bg-good/10' : 'border-warn/40 bg-warn/10'} text-ink`}>
            {design.asBuilt
              ? `현황 해석: ${design.feasible ? '모든 기준 만족' : `기준 위반 ${design.issues.length}건`} — 관경·관저고는 입력 그대로입니다.`
              : `${design.feasible ? '자동 설계: 모든 제약 만족' : `자동 설계: 제약 위반 ${design.issues.length}건`} — 입력에는 아직 반영하지 않았습니다.`}
          </p>
        )}
        {design?.notes && (
          <p className="mt-1 px-0.5 text-[11px] leading-relaxed text-ink-muted" title={design.notes.slice(0, 30).join('\n')}>
            참고: 최소유속 미달 {design.notes.length}개 — 유량이 적은 오수관에서 흔하며 위반으로 세지 않습니다(퇴적 점검 대상).
          </p>
        )}
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <Button disabled={busy !== null} onClick={() => runSewerDesign()} title="관경·관저고·옵셋을 정하고 제약을 검토합니다">
            <Wand2 size={13} />
            자동 설계
          </Button>
          <Button variant="primary" disabled={busy !== null} onClick={() => void runSewerFromMap()} title="자동 설계 → SWMM 해석 (F5)">
            <Play size={13} />
            설계·해석
          </Button>
          <Button disabled={busy !== null} onClick={() => void runSewerOptimize()} title="설계 → 해석 → 용량 부족 관로 관경 확대를 수렴할 때까지 되풀이합니다">
            <Repeat size={13} />
            반복 검토
          </Button>
          <Button disabled={!design || design.asBuilt} onClick={applyDesignToProject} title="설계한 관경·관저고·옵셋을 관망에 반영합니다 (실행 취소 가능)">
            <RefreshCw size={13} />
            설계 반영
          </Button>
          <Button onClick={fitOutfallDepth} title="마지막 관이 필요한 경사를 갖도록 방류구 관저고를 다시 정합니다">
            <ArrowDownToLine size={13} />
            방류구 깊이
          </Button>
          <Button disabled={busy !== null} onClick={() => void runSewerAsBuiltFromMap()} title="자동 설계 없이 지금 관경·관저고(측량값) 그대로 검토하고 SWMM 해석합니다">
            <Gauge size={13} />
            현황 해석
          </Button>
        </div>
        <Button className="mt-1.5 w-full" onClick={() => useUIStore.getState().openModal('sewer')} title="설계 제약·강우·유역과 맨홀·관거 표를 한꺼번에 편집합니다">
          <SlidersHorizontal size={13} />
          설계 조건 · 일괄 표 편집
        </Button>
        {busy && <p className="mt-1.5 text-[11px] text-ink-soft">{busy}</p>}
      </Section>

      <CorrectionSection disabled={busy !== null} georeferenced={georeferenced} />

      {node && <NodeSection key={node.id} node={node} />}
      {conduit && <ConduitSection key={conduit.id} conduit={conduit} />}
      {catchment && <CatchmentSection key={catchment.id} catchment={catchment} />}
      {pump && <PumpSection key={pump.id} pump={pump} />}
      {!node && !conduit && !catchment && !pump && (
        <div className="px-3 py-3 text-[11px] leading-relaxed text-ink-muted">
          지도에서 맨홀·관거·유역을 클릭하면 속성을 편집할 수 있습니다. 맨홀(M)·방류구(O)를 찍고 관거(C)는 상류 → 하류 순서로 잇습니다. 유역(A)은 경계를 그리면 면적과 출구 맨홀이 정해집니다. 자연유하가 안 되는 곳은 펌프장(P)으로 습정 → 토출 맨홀을 잇습니다. 맨홀을 끌면 옮겨지고 Delete 로 지웁니다.
        </div>
      )}
    </aside>
  );
}
