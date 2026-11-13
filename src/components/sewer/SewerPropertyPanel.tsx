/** 하수 모드 우측 패널: 관망 요약·설계 실행, 선택한 맨홀/관거 속성 편집, 설계값·검토 판정. */
import { ArrowDownToLine, Mountain, Play, RefreshCw, Repeat, SlidersHorizontal, TriangleExclamationPoint, Wand2 } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { applyDesignToProject, fitOutfallDepth, runSewerDesign, runSewerOptimize } from '../../app/sewerActions';
import { correctSewerGround, runSewerFromMap } from '../../app/sewerMapActions';
import { formatNumber } from '../../core/model/units';
import { idProblem, renameSewerConduit, renameSewerNode, setSewerNodeKind, sewerSummary } from '../../core/sewer/edit';
import { isGeoreferenced } from '../../core/sewer/mapFrame';
import { REVIEW_KINDS, reviewSewer, type Verdict } from '../../core/sewer/review';
import { buildNetwork } from '../../core/sewer/topology';
import type { SewerBoundary, SewerConduit, SewerNode, SewerNodeKind } from '../../core/sewer/types';
import { parseSewerProject, SewerValidationError } from '../../core/sewer/validate';
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
            {design.feasible ? '자동 설계: 모든 제약 만족' : `자동 설계: 제약 위반 ${design.issues.length}건`} — 입력에는 아직 반영하지 않았습니다.
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
          <Button disabled={!design} onClick={applyDesignToProject} title="설계한 관경·관저고·옵셋을 관망에 반영합니다 (실행 취소 가능)">
            <RefreshCw size={13} />
            설계 반영
          </Button>
          <Button onClick={fitOutfallDepth} title="마지막 관이 필요한 경사를 갖도록 방류구 관저고를 다시 정합니다">
            <ArrowDownToLine size={13} />
            방류구 깊이
          </Button>
          <Button disabled={busy !== null} onClick={() => void correctSewerGround(true)} title="온라인 지형 타일에서 모든 절점의 지반고를 읽어 넣습니다 (매설 깊이 유지, 실행 취소 가능)">
            <Mountain size={13} />
            지반고 보정
          </Button>
        </div>
        <Button className="mt-1.5 w-full" onClick={() => useUIStore.getState().openModal('sewer')} title="설계 제약·강우·유역과 맨홀·관거 표를 한꺼번에 편집합니다">
          <SlidersHorizontal size={13} />
          설계 조건 · 일괄 표 편집
        </Button>
        {busy && <p className="mt-1.5 text-[11px] text-ink-soft">{busy}</p>}
      </Section>

      {node && <NodeSection key={node.id} node={node} />}
      {conduit && <ConduitSection key={conduit.id} conduit={conduit} />}
      {!node && !conduit && (
        <div className="px-3 py-3 text-[11px] leading-relaxed text-ink-muted">
          지도에서 맨홀·관거를 클릭하면 속성을 편집할 수 있습니다. 맨홀(M)·방류구(O)를 찍고 관거(C)는 상류 → 하류 순서로 잇습니다. 맨홀을 끌면 옮겨지고 Delete 로 지웁니다.
        </div>
      )}
    </aside>
  );
}
