/**
 * 감압·가압 후보 제안 (설계기준 검토 탭에서 연다).
 * 수압 기준을 벗어난 구역마다 감압밸브 설정압 / 가압펌프 양정·유량·동력과 블록 경계 제수밸브 후보를 표로 보여 주고,
 * 고른 것을 관망에 넣어 다시 해석한 뒤 적용 전·후 위반 수를 비교한다. 최종 결정은 엔지니어가 한다.
 */
import { CircleCheck, Eye, LoaderCircle, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { runSimulation } from '../../app/actions';
import { checkCriteria, defaultCriteria } from '../../core/engine/criteria';
import { applyPressureFixes, DEFAULT_PRESSURE_FIX, proposePressureFixes, zoneOutcomes, type FixCandidate, type ZoneOutcome } from '../../core/engine/pressureFix';
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
  /** 기준을 벗어난 절점 ID */
  highIds: string[];
  lowIds: string[];
}

function countViolations(model: NetworkModel, r: SimulationResults, min: number, max: number, skip: Set<string>): Counts {
  const hits = checkCriteria(model, r, { minPressure: min, maxPressure: max, minVelocity: 0, maxVelocity: Infinity }).filter((h) => !skip.has(h.id));
  const highIds = hits.filter((h) => h.kind === 'highPressure').map((h) => h.id);
  const lowIds = hits.filter((h) => h.kind === 'lowPressure').map((h) => h.id);
  return { high: highIds.length, low: lowIds.length, highIds, lowIds };
}

/** 남은 위반 절점이 어디에 있는지: 기존 펌프·밸브에 바로 붙은 절점 / 고르지 않은 후보 구역 / 그 밖(작은 구역 등) */
interface Remainder {
  device: number;
  unchosen: number;
  rest: number;
}

function remainderOf(model: NetworkModel, ids: string[], unchosenZone: Set<string>): Remainder {
  const atDevice = new Set<string>();
  for (const l of Object.values(model.links)) {
    if (l.type === 'pipe') continue;
    atDevice.add(l.startNodeId);
    atDevice.add(l.endNodeId);
  }
  const out: Remainder = { device: 0, unchosen: 0, rest: 0 };
  for (const id of ids) {
    if (atDevice.has(id)) out.device++;
    else if (unchosenZone.has(id)) out.unchosen++;
    else out.rest++;
  }
  return out;
}

interface Compare {
  before: Counts;
  after?: Counts;
  failed?: boolean;
  prv: number;
  booster: number;
  closed: number;
  skip: string[];
  zones?: ZoneOutcome[];
  remainHigh?: Remainder;
  remainLow?: Remainder;
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
  const [compare, setCompare] = useState<Compare | null>(null);
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
    const applied = chosen;
    const unchosenZone = new Set((proposal?.candidates ?? []).filter((c) => !isOn(c)).flatMap((c) => c.zoneNodeIds));
    let summary = { prv: 0, booster: 0, closed: 0, nodes: [] as string[] };
    useNetworkStore.getState().commit((d) => {
      summary = applyPressureFixes(d, chosen);
    });
    setCompare({ before, prv: summary.prv, booster: summary.booster, closed: summary.closed, skip: summary.nodes });
    await runSimulation();
    const sim = useSimulationStore.getState();
    const after = sim.status === 'done' ? sim.results : null;
    if (after) {
      const now = useNetworkStore.getState().model;
      const counts = countViolations(now, after, minP, maxP, new Set(summary.nodes));
      setCompare({
        before,
        after: counts,
        prv: summary.prv,
        booster: summary.booster,
        closed: summary.closed,
        skip: summary.nodes,
        zones: zoneOutcomes(applied, results, after, { minPressure: minP, maxPressure: maxP }),
        remainHigh: remainderOf(now, counts.highIds, unchosenZone),
        remainLow: remainderOf(now, counts.lowIds, unchosenZone),
      });
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
              <CircleCheck size={14} className="text-good" /> 적용 결과 — 감압밸브 {compare.prv}개 · 가압펌프 {compare.booster}개{compare.closed > 0 ? ` · 경계 제수밸브(닫음) ${compare.closed}개` : ''}
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
              <ResultTables compare={compare} after={compare.after} p={p} />
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
              넣은 밸브·펌프는 이름이 PRV_·BP_ 로 시작합니다(밸브 자리 절점은 위 수 세기에서 뺐습니다). 관망 전체의 최고·최저 수압은 대개 펌프 토출·흡입 쪽 절점 값이라 여기서는 손댄 구역의 값을 보입니다 — 전체
              목록은 설계기준 검토 탭에 있습니다. 남은 구역은 ‘다시 후보 보기’로 한 번 더 제안을 받거나, 기존 펌프·밸브 설정과 구역 나누기를 검토하세요.
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
                  {proposal.deviceFedZones > 0 && ` · 기존 펌프·밸브로 받는 구역 ${proposal.deviceFedZones}개(기존 설비 설정 검토)`}
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

function remainText(label: string, total: number, r: Remainder | undefined): string | null {
  if (!r || total === 0) return null;
  const parts = [
    r.unchosen > 0 ? `고르지 않은 후보 구역 ${r.unchosen.toLocaleString()}곳` : '',
    r.device > 0 ? `기존 펌프·밸브에 바로 붙은 절점 ${r.device.toLocaleString()}곳` : '',
    r.rest > 0 ? `그 밖(작은 구역·기존 설비 아래 등) ${r.rest.toLocaleString()}곳` : '',
  ].filter(Boolean);
  return `남은 ${label} ${total.toLocaleString()}곳 — ${parts.join(' · ')}`;
}

/** 적용 전·후 비교: 관망 전체 위반 수 + 손댄 구역별 수압 (다시 해석한 값) */
function ResultTables({ compare, after, p }: { compare: Compare; after: Counts; p: (v: number) => string }) {
  const zones = compare.zones ?? [];
  const prv = zones.filter((z) => z.kind === 'prv');
  const bp = zones.filter((z) => z.kind === 'booster');
  const okCount = zones.filter((z) => z.ok).length;
  const rows: [string, string, string][] = [
    ['최대 수압 초과 절점', compare.before.high.toLocaleString(), after.high.toLocaleString()],
    ['최소 수압 미달 절점', compare.before.low.toLocaleString(), after.low.toLocaleString()],
  ];
  if (prv.length > 0) rows.push([`감압 구역 최고 수압 (${prv.length}구역)`, p(Math.max(...prv.map((z) => z.before))), p(Math.max(...prv.map((z) => z.after)))]);
  if (bp.length > 0) rows.push([`가압 구역 최저 수압 (${bp.length}구역)`, p(Math.min(...bp.map((z) => z.before))), p(Math.min(...bp.map((z) => z.after)))]);
  const remain = [remainText('최대 수압 초과', after.high, compare.remainHigh), remainText('최소 수압 미달', after.low, compare.remainLow)].filter((x): x is string => x !== null);
  return (
    <div className="space-y-2">
      {zones.length > 0 && (
        <p className={okCount === zones.length ? 'font-semibold text-good' : 'font-semibold text-amber-300'}>
          {okCount === zones.length ? `손댄 구역 ${zones.length}곳 모두 기준 안으로 들어왔습니다.` : `손댄 구역 ${zones.length}곳 중 ${okCount}곳이 기준 안 — ${zones.length - okCount}곳은 확인이 필요합니다.`}
        </p>
      )}
      <div className="flex flex-wrap items-start gap-4">
        <table className="w-[22rem] tabular-nums">
          <thead className="text-ink-soft">
            <tr>
              <th className="px-2 py-1 text-left font-medium">항목</th>
              <th className="px-2 py-1 text-right font-medium">적용 전</th>
              <th className="px-2 py-1 text-right font-medium">적용 후</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, a, b]) => (
              <tr key={k} className="border-t border-line/60">
                <td className="px-2 py-1 text-ink">{k}</td>
                <td className="px-2 py-1 text-right">{a}</td>
                <td className="px-2 py-1 text-right font-semibold text-ink">{b}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {zones.length > 0 && (
          <div className="max-h-[38vh] min-w-[22rem] flex-1 overflow-auto rounded border border-line">
            <table className="w-full tabular-nums">
              <thead className="sticky top-0 bg-panel text-left text-[11px] text-ink-muted">
                <tr>
                  <th className="px-2 py-1">구역별 결과</th>
                  <th className="px-2 py-1 text-right">절점</th>
                  <th className="px-2 py-1 text-right">적용 전</th>
                  <th className="px-2 py-1 text-right">적용 후</th>
                  <th className="px-2 py-1">판정</th>
                </tr>
              </thead>
              <tbody>
                {zones.map((z) => (
                  <tr key={z.id} className="border-t border-line/60">
                    <td className="px-2 py-1 text-ink">
                      {z.id} <span className="text-ink-muted">{z.kind === 'prv' ? '최고' : '최저'}</span>
                    </td>
                    <td className="px-2 py-1 text-right">{z.nodes}</td>
                    <td className="px-2 py-1 text-right">{p(z.before)}</td>
                    <td className="px-2 py-1 text-right font-semibold text-ink">{p(z.after)}</td>
                    <td className={z.ok ? 'px-2 py-1 text-good' : 'px-2 py-1 text-amber-300'}>{z.ok ? '기준 안' : '확인 필요'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {remain.map((t) => (
        <p key={t} className="text-[11px] text-ink-soft">
          {t}
        </p>
      ))}
    </div>
  );
}
