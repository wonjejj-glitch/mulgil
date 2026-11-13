import { Download, Flame, LoaderCircle, MapPin, TriangleExclamationPoint } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { focusObjects, runSimulation } from '../../app/actions';
import { CSV_BOM } from '../../core/engine/resultsExport';
import { fireFlowManager, nodeValueAt, SimulationError } from '../../core/engine/simulationManager';
import { writeInp } from '../../core/io/inpWriter';
import type { FlowUnits } from '../../core/model/types';
import { formatClock, formatNumber, isUsUnits, unitLabels } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { useUIStore } from '../../store/useUIStore';
import { baseName, downloadText } from '../../utils/files';
import { Button, NumberField, SelectField } from '../ui/fields';
import { Modal } from '../ui/Modal';

/** 소화전 1개 기준 소화 유량 1 m³/분 을 각 유량 단위로. US 는 관례값 500 gpm. */
const DEFAULT_FIRE_FLOW: Record<FlowUnits, number> = {
  LPS: 16.7, LPM: 1000, CMH: 60, CMD: 1440, MLD: 1.44, GPM: 500, CFS: 1.11, MGD: 0.72, IMGD: 0.6, AFD: 2.21,
};

function Row({ label, unit, hint, children }: { label: string; unit?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[140px_140px_1fr] items-center gap-3 py-0.5">
      <span className="text-xs text-ink-soft">
        {label}
        {unit && <span className="ml-1 text-ink-muted">{unit}</span>}
      </span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-ink-muted">{hint}</span>}
    </label>
  );
}

function FireFlowDialog() {
  const model = useNetworkStore((s) => s.model);
  const revision = useNetworkStore((s) => s.revision);
  const fileName = useNetworkStore((s) => s.fileName);
  const results = useSimulationStore((s) => s.results);
  const resultsRevision = useSimulationStore((s) => s.resultsRevision);
  const lastRun = useSimulationStore((s) => s.fireFlow);
  const multi = useUIStore((s) => s.multiSelection);
  const flowUnits = model.options.flowUnits;
  const labels = unitLabels(flowUnits);
  const us = isUsUnits(flowUnits);

  const peakStep = useMemo(() => {
    if (!results) return 0;
    let best = 0;
    let bestDemand = -Infinity;
    const n = results.nodeIds.length;
    for (let s = 0; s < results.stepCount; s++) {
      let total = 0;
      results.nodeIds.forEach((id, i) => {
        if (model.nodes[id]?.type === 'junction') total += results.node.demand[s * n + i];
      });
      if (total > bestDemand) {
        bestDemand = total;
        best = s;
      }
    }
    return best;
  }, [results, model.nodes]);

  const [fireFlow, setFireFlow] = useState(lastRun?.fireFlow ?? DEFAULT_FIRE_FLOW[flowUnits]);
  const [minPressure, setMinPressure] = useState(lastRun?.minPressure ?? (us ? 20 : 10));
  const [step, setStep] = useState(String(peakStep));
  const multiJunctions = useMemo(() => (multi ? multi.nodeIds.filter((id) => model.nodes[id]?.type === 'junction') : []), [multi, model.nodes]);
  const [scope, setScope] = useState<'all' | 'selection'>(multiJunctions.length > 0 ? 'selection' : 'all');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    fireFlowManager.cancel();
    useUIStore.getState().openModal(null);
  };

  const stale = !results || resultsRevision !== revision;
  const stepIndex = Math.min(Number(step) || 0, (results?.stepCount ?? 1) - 1);

  const run = async () => {
    if (!results) return;
    const targets = scope === 'selection' ? multiJunctions : Object.keys(model.nodes).filter((id) => model.nodes[id].type === 'junction');
    const tankLevels: Record<string, number> = {};
    for (const id in model.nodes) {
      if (model.nodes[id].type !== 'tank') continue;
      const level = nodeValueAt(results, 'pressure', stepIndex, id);
      if (level !== undefined) tankLevels[id] = level;
    }
    setRunning(true);
    setError(null);
    setProgress(0);
    try {
      const result = await fireFlowManager.run(
        { inp: writeInp(model, { forEngine: true }), nodeIds: targets, fireFlow, time: results.times[stepIndex], tankLevels },
        setProgress,
      );
      useSimulationStore.getState().setFireFlow({ result, fireFlow, minPressure, time: results.times[stepIndex], revision });
    } catch (e) {
      if (!(e instanceof SimulationError && e.message === '분석이 취소되었습니다.')) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const view = useMemo(() => {
    if (!lastRun) return null;
    // 해석 실패(NaN)를 맨 앞에, 나머지는 잔류 수압이 낮은 순
    const key = (p: number) => (Number.isNaN(p) ? -Infinity : p);
    const rows = [...lastRun.result.nodes].sort((a, b) => key(a.residualPressure) - key(b.residualPressure));
    const failing = rows.filter((r) => !(r.residualPressure >= lastRun.minPressure));
    const systemIssues = rows.filter((r) => r.minSystemPressure < 0);
    return { rows, failing, systemIssues };
  }, [lastRun]);

  const exportCsv = () => {
    if (!lastRun || !view) return;
    const head = `절점,정적 수압 (${labels.pressure}),잔류 수압 (${labels.pressure}),관망 최저 수압 (${labels.pressure}),최저 수압 절점,판정`;
    const lines = view.rows.map((r) =>
      [r.nodeId, r.staticPressure.toFixed(3), r.residualPressure.toFixed(3), r.minSystemPressure.toFixed(3), r.minSystemNodeId, r.residualPressure >= lastRun.minPressure ? '적합' : '미달'].join(','),
    );
    downloadText(`${baseName(fileName ?? 'network')}_소화용수.csv`, CSV_BOM + [head, ...lines].join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
  };

  return (
    <Modal
      title="소화용수 분석"
      onClose={close}
      widthClass="w-[720px]"
      footer={
        <>
          <span className="mr-auto text-[11px] text-ink-muted">절점마다 소화 유량을 하나씩 더해 정상 상태로 반복 해석합니다.</span>
          <Button onClick={close}>닫기</Button>
          <Button variant="primary" disabled={!results || running || fireFlow <= 0} onClick={() => void run()}>
            {running ? <LoaderCircle size={13} className="animate-spin" /> : <Flame size={13} />}
            {running ? `분석 중… ${Math.round(progress * 100)}%` : '분석 실행'}
          </Button>
        </>
      }
    >
      {!results ? (
        <div className="flex items-center gap-3 rounded-md border border-line bg-raised/40 p-3 text-xs text-ink-soft">
          <TriangleExclamationPoint size={15} className="shrink-0 text-warn" />
          분석 시각의 수요·배수지 수위를 쓰려면 먼저 기간 수리해석이 필요합니다.
          <Button variant="primary" className="ml-auto" onClick={() => void runSimulation()}>
            수리해석 실행
          </Button>
        </div>
      ) : (
        <>
          <Row label="소화 유량" unit={labels.flow} hint={us ? '관례 500 gpm' : '소화전 1개 기준 1 m³/분 (= 16.7 L/s)'}>
            <NumberField value={fireFlow} min={0} onCommit={setFireFlow} />
          </Row>
          <Row label="최소 잔류 수압" unit={labels.pressure} hint={us ? '관례 20 psi' : '화재 시 소화전 0.1 MPa (약 10 m) 이상'}>
            <NumberField value={minPressure} onCommit={setMinPressure} />
          </Row>
          <Row label="분석 시각" hint={Number(step) === peakStep ? '총 수요량이 가장 큰 시각' : undefined}>
            <SelectField value={step} options={results.times.map((t, i) => ({ value: String(i), label: formatClock(t) + (i === peakStep ? ' (최대 수요)' : '') }))} onChange={setStep} />
          </Row>
          <Row label="대상 절점">
            <SelectField
              value={scope}
              options={[
                { value: 'all', label: `모든 절점 (${Object.values(model.nodes).filter((n) => n.type === 'junction').length})` },
                { value: 'selection', label: `다중 선택 (${multiJunctions.length})`, disabled: multiJunctions.length === 0 },
              ]}
              onChange={setScope}
            />
          </Row>
          {stale && <p className="mt-1.5 text-[11px] text-warn">관망을 편집한 뒤 수리해석을 다시 하지 않았습니다. 배수지 수위가 편집 전 결과 기준입니다.</p>}
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
            배수지 수위는 기간 해석의 해당 시각 값을 쓰고, 'AT TIME' 제어 등 시간에 따른 운전 변화는 반영하지 않습니다.
          </p>
          {error && <p className="mt-2 text-xs text-[#f3a5a5]">분석 실패: {error}</p>}
        </>
      )}

      {lastRun && view && (
        <section className="mt-4 border-t border-line pt-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-ink">
              {formatClock(lastRun.time)} · {formatNumber(lastRun.fireFlow)} {labels.flow} · 기준 {formatNumber(lastRun.minPressure)} {labels.pressure}
            </span>
            <span className={view.failing.length > 0 ? 'text-warn' : 'text-good'}>
              미달 {view.failing.length.toLocaleString()} / {view.rows.length.toLocaleString()}개
            </span>
            {lastRun.revision !== revision && <span className="text-[11px] text-warn">· 편집 전 결과</span>}
            <div className="ml-auto flex gap-1.5">
              <Button
                disabled={view.failing.length === 0}
                onClick={() => {
                  const ids = view.failing.map((r) => r.nodeId);
                  close();
                  focusObjects({ nodeIds: ids, linkIds: [] });
                }}
              >
                <MapPin size={13} />
                미달 절점 지도에 표시
              </Button>
              <Button onClick={exportCsv}>
                <Download size={13} />
                CSV
              </Button>
            </div>
          </div>
          {view.systemIssues.length > 0 && (
            <p className="mt-1 text-[11px] text-ink">
              <TriangleExclamationPoint size={12} className="mr-1 inline text-warn" />
              {view.systemIssues.length}개 절점에서는 소화 시 관망 어딘가에 음압이 생깁니다.
            </p>
          )}
          <div className="mt-2 max-h-64 overflow-auto rounded border border-line">
            <table className="w-full text-xs tabular-nums">
              <thead className="sticky top-0 bg-panel text-ink-soft">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">절점</th>
                  <th className="px-2 py-1 text-right font-medium">정적 수압</th>
                  <th className="px-2 py-1 text-right font-medium">잔류 수압</th>
                  <th className="px-2 py-1 text-right font-medium">관망 최저 수압</th>
                  <th className="px-2 py-1 text-left font-medium">최저 절점</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.slice(0, 300).map((r) => {
                  const fail = !(r.residualPressure >= lastRun.minPressure);
                  return (
                    <tr
                      key={r.nodeId}
                      className="cursor-pointer border-t border-line/50 hover:bg-raised"
                      onClick={() => useUIStore.getState().select({ kind: 'node', id: r.nodeId })}
                    >
                      <td className="px-2 py-0.5 text-ink">{r.nodeId}</td>
                      <td className="px-2 py-0.5 text-right text-ink-soft">{formatNumber(r.staticPressure)}</td>
                      <td className={`px-2 py-0.5 text-right ${fail ? 'font-semibold text-[#f3a5a5]' : 'text-ink'}`}>{formatNumber(r.residualPressure)}</td>
                      <td className={`px-2 py-0.5 text-right ${r.minSystemPressure < 0 ? 'text-[#f3a5a5]' : 'text-ink-soft'}`}>{formatNumber(r.minSystemPressure)}</td>
                      <td className="px-2 py-0.5 text-ink-muted">{r.minSystemNodeId}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {lastRun.result.failedNodeIds.length > 0 && (
            <p className="mt-1 text-[11px] text-warn">해석이 실패한 절점 {lastRun.result.failedNodeIds.length}개: {lastRun.result.failedNodeIds.slice(0, 10).join(', ')}</p>
          )}
        </section>
      )}
    </Modal>
  );
}

/** 소화용수(Fire-flow) 분석 대화상자. */
export function FireFlowModal() {
  const open = useUIStore((s) => s.modal === 'fireflow');
  return open ? <FireFlowDialog /> : null;
}
