/**
 * 감압·가압 후보 제안 (설계기준 검토 탭에서 연다).
 * 수압 기준을 벗어난 구역마다 감압밸브 설정압 / 가압펌프 양정·유량·동력과 블록 경계 제수밸브 후보를 표로 보여 주고,
 * 고른 것을 관망에 넣어 다시 해석한 뒤 적용 전·후 위반 수를 비교한다. 최종 결정은 엔지니어가 한다.
 */
import { CircleCheck, Eye, LoaderCircle, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { runSimulation } from '../../app/actions';
import { checkCriteria, defaultCriteria } from '../../core/engine/criteria';
import { applyPressureFixes, DEFAULT_PRESSURE_FIX, proposePressureFixes, type FixCandidate } from '../../core/engine/pressureFix';
import type { SimulationResults } from '../../core/engine/simulationManager';
import { formatNumber, isUsUnits, unitLabels } from '../../core/model/units';
import type { NetworkModel } from '../../core/model/types';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { useUIStore } from '../../store/useUIStore';
import { Button, NumberField } from '../ui/fields';
import { Modal } from '../ui/Modal';

interface Counts {
  high: number;
  low: number;
  maxP: number;
  minP: number;
}

function countViolations(model: NetworkModel, r: SimulationResults, min: number, max: number, skip: Set<string>): Counts {
  const hits = checkCriteria(model, r, { minPressure: min, maxPressure: max, minVelocity: 0, maxVelocity: Infinity }).filter((h) => !skip.has(h.id));
  const N = r.nodeIds.length;
  let maxP = -Infinity, minP = Infinity;
  for (let i = 0; i < N; i++) {
    const id = r.nodeIds[i];
    if (model.nodes[id]?.type !== 'junction' || skip.has(id)) continue;
    for (let t = 0; t < r.stepCount; t++) {
      const p = r.node.pressure[t * N + i];
      if (p > maxP) maxP = p;
      if (p < minP) minP = p;
    }
  }
  return { high: hits.filter((h) => h.kind === 'highPressure').length, low: hits.filter((h) => h.kind === 'lowPressure').length, maxP, minP };
}

export function PressureFixModal() {
  const model = useNetworkStore((s) => s.model);
  const results = useSimulationStore((s) => s.results);
  const running = useSimulationStore((s) => s.status === 'running');
  const close = () => useUIStore.getState().openModal(null);
  const us = isUsUnits(model.options.flowUnits);
  const units = unitLabels(model.options.flowUnits);
  const defaults = useMemo(() => defaultCriteria(model), [model]);
  const [minP, setMinP] = useState(defaults.minPressure);
  const [maxP, setMaxP] = useState(defaults.maxPressure);
  const [margin, setMargin] = useState(DEFAULT_PRESSURE_FIX.prvMarginM);
  const [minZone, setMinZone] = useState(DEFAULT_PRESSURE_FIX.minZoneNodes);
  /** 사용자가 고른 것/뺀 것 (없으면 추천 후보만 고른 상태) */
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [compare, setCompare] = useState<{ before: Counts; after?: Counts; failed?: boolean; prv: number; booster: number; closed: number; skip: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const proposal = useMemo(
    () => (results && !compare ? proposePressureFixes(model, results, { ...DEFAULT_PRESSURE_FIX, minPressure: minP, maxPressure: maxP, prvMarginM: margin, minZoneNodes: minZone }) : null),
    [model, results, minP, maxP, margin, minZone, compare],
  );
  const isOn = (c: FixCandidate) => picked[c.id] ?? c.recommended;
  const chosen = (proposal?.candidates ?? []).filter(isOn);

  const show = (c: FixCandidate) => {
    const ui = useUIStore.getState();
    ui.setHighlight({ nodeIds: c.zoneNodeIds, linkIds: [c.entryPipeId, ...c.closePipeIds] });
    ui.flyTo(c.position, 16);
    close();
    ui.pushToast({
      level: 'info',
      title: `${c.id}: 구역 절점 ${c.zoneNodeIds.length}개 강조`,
      message: `밸브·펌프 자리 = 관로 ${c.entryPipeId}${c.closePipeIds.length ? `, 닫을 경계관 ${c.closePipeIds.join(', ')}` : ''}. 설계기준 검토 탭의 ‘감압·가압 후보 제안’으로 돌아갑니다.`,
    });
  };

  const apply = async () => {
    if (!results || chosen.length === 0) return;
    setBusy(true);
    const before = countViolations(model, results, minP, maxP, new Set());
    let summary = { prv: 0, booster: 0, closed: 0, nodes: [] as string[] };
    useNetworkStore.getState().commit((d) => {
      summary = applyPressureFixes(d, chosen);
    });
    setCompare({ before, prv: summary.prv, booster: summary.booster, closed: summary.closed, skip: summary.nodes });
    await runSimulation();
    const sim = useSimulationStore.getState();
    const after = sim.status === 'done' ? sim.results : null;
    if (after) {
      const counts = countViolations(useNetworkStore.getState().model, after, minP, maxP, new Set(summary.nodes));
      setCompare({ before, after: counts, prv: summary.prv, booster: summary.booster, closed: summary.closed, skip: summary.nodes });
    } else {
      setCompare({ before, failed: true, prv: summary.prv, booster: summary.booster, closed: summary.closed, skip: summary.nodes });
    }
    setBusy(false);
  };

  const p = (v: number) => `${formatNumber(v, 1)} ${units.pressure}`;
  const h = (v: number) => `${formatNumber(v, 1)} ${us ? 'ft' : 'm'}`;

  return (
    <Modal
      title="감압·가압 후보 제안"
      onClose={close}
      widthClass="w-[860px]"
      footer={
        compare ? (
          <>
            <span className="mr-auto text-[11px] text-ink-muted">되돌리려면 Ctrl+Z. 저장: 파일 → EPANET .inp 내보내기(Ctrl+S).</span>
            <Button onClick={() => setCompare(null)} disabled={busy}>
              다시 후보 보기
            </Button>
            <Button variant="primary" onClick={close}>
              닫기
            </Button>
          </>
        ) : (
          <>
            <span className="mr-auto text-[11px] text-ink-muted">고른 후보 {chosen.length}개 — 넣은 뒤 바로 다시 해석해 전·후를 비교합니다.</span>
            <Button onClick={close}>취소</Button>
            <Button variant="primary" disabled={!results || chosen.length === 0 || busy || running} onClick={() => void apply()}>
              {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Wand2 size={13} />} 고른 후보 적용 후 다시 해석
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 text-xs">
        {!results && <p className="text-ink-muted">먼저 해석을 실행하세요.</p>}
        {compare ? (
          <section>
            <h3 className="mb-1 flex items-center gap-1.5 font-semibold text-ink">
              <CircleCheck size={14} className="text-good" /> 적용 결과 — 감압밸브 {compare.prv}개 · 가압펌프 {compare.booster}개 · 경계 제수밸브(닫음) {compare.closed}개
            </h3>
            {compare.failed ? (
              <p className="rounded border border-red-500/40 bg-red-500/10 p-2 text-red-300">
                넣은 뒤 해석이 풀리지 않았습니다. Ctrl+Z 로 되돌린 뒤 ‘검토 필요’ 후보를 빼고 다시 적용해 보세요(해석 로그 탭에 원인이 있습니다).
              </p>
            ) : !compare.after ? (
              <p className="text-ink-muted">
                <LoaderCircle size={12} className="mr-1 inline animate-spin" />
                다시 해석하는 중…
              </p>
            ) : (
              <table className="w-full max-w-xl tabular-nums">
                <thead className="text-ink-soft">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">항목</th>
                    <th className="px-2 py-1 text-right font-medium">적용 전</th>
                    <th className="px-2 py-1 text-right font-medium">적용 후</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['최대 수압 초과 절점', compare.before.high.toLocaleString(), compare.after.high.toLocaleString()],
                    ['최소 수압 미달 절점', compare.before.low.toLocaleString(), compare.after.low.toLocaleString()],
                    ['최고 수압', p(compare.before.maxP), p(compare.after.maxP)],
                    ['최저 수압', p(compare.before.minP), p(compare.after.minP)],
                  ].map(([k, a, b]) => (
                    <tr key={k} className="border-t border-line/60">
                      <td className="px-2 py-1 text-ink">{k}</td>
                      <td className="px-2 py-1 text-right">{a}</td>
                      <td className="px-2 py-1 text-right font-semibold text-ink">{b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
              넣은 밸브·펌프는 이름이 PRV_·BP_ 로 시작합니다(밸브 자리 절점은 위 수 세기에서 뺐습니다). 닫은 경계관 때문에 물을 받던 다른 곳의 수압이 내려가지 않았는지 지도와 설계기준 검토 탭에서 확인하세요.
              남은 위반 구역이 있으면 ‘다시 후보 보기’로 한 번 더 제안을 받을 수 있습니다.
            </p>
          </section>
        ) : (
          <>
            <section className="flex flex-wrap items-end gap-2">
              <label className="w-28">
                <span className="text-[10px] text-ink-muted">최소 수압 ({units.pressure})</span>
                <NumberField value={+minP.toFixed(2)} onCommit={(v) => setMinP(v)} />
              </label>
              <label className="w-28">
                <span className="text-[10px] text-ink-muted">최대 수압 ({units.pressure})</span>
                <NumberField value={+maxP.toFixed(2)} onCommit={(v) => setMaxP(v)} />
              </label>
              <label className="w-32">
                <span className="text-[10px] text-ink-muted">감압 목표 여유 (m)</span>
                <NumberField value={margin} min={0} onCommit={(v) => setMargin(Math.max(0, v))} />
              </label>
              <label className="w-32">
                <span className="text-[10px] text-ink-muted">최소 구역 크기 (절점)</span>
                <NumberField value={minZone} min={1} step={1} onCommit={(v) => setMinZone(Math.max(1, Math.round(v)))} />
              </label>
              {proposal && (
                <span className="pb-1 text-[11px] text-ink-soft">
                  최대 수압 초과 {proposal.highNodes.toLocaleString()} · 최소 수압 미달 {proposal.lowNodes.toLocaleString()} 절점
                  {proposal.smallZones > 0 && ` · 작은 구역 ${proposal.smallZones}개는 개별 확인`}
                  {proposal.noEntryZones > 0 && ` · 유입관을 못 찾은 구역 ${proposal.noEntryZones}개`}
                </span>
              )}
            </section>
            <p className="text-[11px] leading-relaxed text-ink-muted">
              기준을 벗어난 절점을 관로로 이어진 구역으로 묶고, 물이 가장 많이 들어오는 관에 감압밸브(PRV) 또는 가압펌프를 둡니다. 다른 유입관은 닫아 한 구역을 하나의 블록으로 만듭니다.
              감압 설정압은 구역에서 가장 낮은 곳이 (최대 수압 − 여유)가 되게 하되 높은 곳 최소 수압은 지키고, 가압 양정은 가장 낮은 수압이 (최소 수압 + 3 m)가 되게, 용량은 구역 첨두 수요로 잡습니다.
              주관로가 지나가는 구역처럼 바로 적용하기 어려운 후보는 기본으로 고르지 않습니다. <b className="text-ink-soft">후보는 판단 근거이고, 블록 경계·밸브 위치의 최종 결정은 엔지니어가 합니다.</b>
            </p>
            <div className="max-h-[46vh] overflow-auto rounded border border-line">
              <table className="w-full tabular-nums">
                <thead className="sticky top-0 bg-panel text-left text-[11px] text-ink-muted">
                  <tr>
                    <th className="px-2 py-1">
                      <input
                        type="checkbox"
                        className="accent-accent"
                        checked={(proposal?.candidates.length ?? 0) > 0 && chosen.length === proposal?.candidates.length}
                        onChange={(e) => setPicked(Object.fromEntries((proposal?.candidates ?? []).map((c) => [c.id, e.target.checked])))}
                        aria-label="모두 고르기"
                      />
                    </th>
                    <th className="px-2 py-1">후보</th>
                    <th className="px-2 py-1 text-right">구역 절점</th>
                    <th className="px-2 py-1 text-right">현재</th>
                    <th className="px-2 py-1">제안 (위치 · 설정 · 용량)</th>
                    <th className="px-2 py-1 text-right">경계관 닫기</th>
                    <th className="px-2 py-1" />
                  </tr>
                </thead>
                <tbody>
                  {proposal && proposal.candidates.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-4 text-center text-ink-muted">
                        후보가 없습니다 — 수압 기준을 벗어난 구역이 없거나, 모두 최소 구역 크기보다 작습니다.
                      </td>
                    </tr>
                  )}
                  {proposal?.candidates.map((c) => (
                    <tr key={c.id} className="border-t border-line/60 align-top">
                      <td className="px-2 py-1">
                        <input
                          type="checkbox"
                          className="accent-accent"
                          checked={isOn(c)}
                          onChange={(e) => setPicked({ ...picked, [c.id]: e.target.checked })}
                          aria-label={`${c.id} 고르기`}
                        />
                      </td>
                      <td className={`px-2 py-1 font-semibold ${c.kind === 'prv' ? 'text-amber-300' : 'text-sky-300'}`}>{c.id}</td>
                      <td className="px-2 py-1 text-right">{c.zoneNodeIds.length.toLocaleString()}</td>
                      <td className="px-2 py-1 text-right">{c.kind === 'prv' ? `최고 ${p(c.worstPressure)}` : `최저 ${p(c.worstPressure)}`}</td>
                      <td className="px-2 py-1">
                        <div className="text-ink">
                          {c.kind === 'prv'
                            ? `감압밸브 — 관로 ${c.entryPipeId} · 설정 ${p(c.prvSetting ?? 0)} → 구역 최고 약 ${p(c.expectedPressure)}`
                            : `가압펌프 — 관로 ${c.entryPipeId} · 양정 ${h(c.pumpHead ?? 0)} · 용량 ${formatNumber(c.designFlow, 1)} ${units.flow}(구역 첨두) · 동력 약 ${formatNumber(c.pumpPowerKw ?? 0, 1)} kW`}
                        </div>
                        <div className="text-[10px] text-ink-muted">
                          표고 {formatNumber(c.minElevation, 1)}~{formatNumber(c.maxElevation, 1)} · 구역 첨두 수요 {formatNumber(c.zoneDemandPeak, 1)} {units.flow}
                          {!c.recommended && ' · 검토 필요(기본으로 고르지 않음)'}
                        </div>
                        {c.notes.map((n) => (
                          <div key={n} className="text-[10px] text-amber-300/90">
                            {n}
                          </div>
                        ))}
                      </td>
                      <td className="px-2 py-1 text-right">{c.closePipeIds.length}</td>
                      <td className="px-2 py-1">
                        <button type="button" className="text-ink-soft hover:text-ink" onClick={() => show(c)} title="지도에서 구역 보기">
                          <Eye size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
