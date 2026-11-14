/** 하단 '시간최대계수' 탭: 수요 배율을 바꿔 다시 해석하고, 여러 계수의 수압·유속을 한 표로 비교한다. */
import { Download, Play } from 'lucide-react';
import { useMemo, useState } from 'react';
import { defaultCriteria } from '../../core/engine/criteria';
import { demandMultiplier, parseFactors, scenariosCsv, type FactorScenario } from '../../core/engine/peakFactor';
import { unitLabels } from '../../core/model/units';
import { applyDemandFactor, runFactorSweep } from '../../app/peakActions';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { useUIStore } from '../../store/useUIStore';
import { downloadText } from '../../utils/files';
import { Button, NumberField } from '../ui/fields';

export function PeakFactorPanel() {
  const extra = useNetworkStore((s) => s.model.options.extra);
  const flowUnits = useNetworkStore((s) => s.model.options.flowUnits);
  const running = useSimulationStore((s) => s.status === 'running');
  const current = demandMultiplier(extra);
  const units = unitLabels(flowUnits);
  const criteria = useMemo(() => defaultCriteria({ options: { flowUnits } as never }), [flowUnits]);
  const [factor, setFactor] = useState(1.5);
  const [list, setList] = useState('1.0, 1.3, 1.5, 1.8, 2.0');
  const [rows, setRows] = useState<FactorScenario[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const factors = parseFactors(list);

  const sweep = async () => {
    setRows([]);
    setBusy(`0 / ${factors.length}`);
    const acc: FactorScenario[] = [];
    await runFactorSweep(factors, criteria, (row, done) => {
      acc.push(row);
      setRows([...acc]);
      setBusy(`${done} / ${factors.length}`);
    });
    setBusy(null);
  };

  const focusNode = (id: string) => {
    const node = useNetworkStore.getState().model.nodes[id];
    if (!node) return;
    const ui = useUIStore.getState();
    ui.select({ kind: 'node', id });
    ui.setHighlight({ nodeIds: [id], linkIds: [] });
    ui.flyTo(node.position, 17);
  };
  const focusLink = (id: string) => {
    const ui = useUIStore.getState();
    ui.select({ kind: 'link', id });
    ui.setHighlight({ nodeIds: [], linkIds: [id] });
  };

  const bad = (n: number) => (n > 0 ? 'text-[#f3a5a5]' : 'text-ink-muted');
  return (
    <div className="flex h-full min-h-0 gap-3 p-2 text-xs">
      <div className="flex w-72 shrink-0 flex-col gap-2">
        <div>
          <h3 className="font-semibold text-ink">지금 관망의 수요 배율: {current}</h3>
          <p className="text-[10px] text-ink-muted">
            모든 절점 기본 수요량 × 배율로 해석합니다 (EPANET Demand Multiplier). 수요량이 일평균이면 시간최대계수(예: 1.5)를, 이미 시간최대 값이면 1.0 을 쓰세요.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="w-24">
            <span className="text-[10px] text-ink-muted">적용할 계수</span>
            <NumberField value={factor} min={0.1} step={0.1} onCommit={setFactor} />
          </label>
          <Button variant="primary" disabled={running} onClick={() => void applyDemandFactor(factor)} title="관망의 수요 배율을 바꾸고 바로 해석합니다 (Ctrl+Z 로 되돌림)">
            <Play size={12} /> 적용하고 해석
          </Button>
        </div>
        <div className="border-t border-line pt-2">
          <h3 className="font-semibold text-ink">계수별 비교</h3>
          <p className="text-[10px] text-ink-muted">관망은 바꾸지 않고 계수마다 따로 해석합니다. 쉼표로 최대 8개.</p>
          <input
            aria-label="비교할 계수"
            value={list}
            onChange={(e) => setList(e.target.value)}
            className="mt-1 h-7 w-full rounded border border-line bg-canvas px-2 text-ink outline-none focus:border-accent"
          />
          <div className="mt-1.5 flex gap-2">
            <Button disabled={busy !== null || factors.length === 0} onClick={() => void sweep()}>
              <Play size={12} /> {busy ? `해석 중 ${busy}` : `${factors.length}개 계수 비교 해석`}
            </Button>
            <Button disabled={rows.length === 0} onClick={() => downloadText('시간최대계수_비교.csv', `${String.fromCharCode(0xfeff)}${scenariosCsv(rows, units.pressure, units.velocity)}`, 'text/csv;charset=utf-8')}>
              <Download size={12} /> CSV
            </Button>
          </div>
          <p className="mt-1 text-[10px] text-ink-muted">
            판정 기준: 수압 {criteria.minPressure.toFixed(1)}~{criteria.maxPressure.toFixed(1)} {units.pressure}, 유속 {criteria.minVelocity.toFixed(1)}~{criteria.maxVelocity.toFixed(1)} {units.velocity}
          </p>
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded border border-line">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-ink-muted">
            계수별 비교 해석을 누르면 계수마다 최저 수압·최대 유속과 기준을 벗어난 개수가 여기에 나옵니다. 줄을 누르면 그 계수를 관망에 적용해 해석합니다.
          </div>
        ) : (
          <table className="w-full tabular-nums">
            <thead className="sticky top-0 bg-panel text-ink-soft">
              <tr>
                {['계수', `최저 수압 (${units.pressure})`, '위치', `최고 수압`, `최대 유속 (${units.velocity})`, '위치', '저수압', '고수압', '저유속', '고유속', '음압', ''].map((h, i) => (
                  <th key={i} className={`whitespace-nowrap px-2 py-1 font-medium ${i === 2 || i === 5 ? 'text-left' : 'text-right'}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.factor} className={`border-t border-line/60 ${Math.abs(r.factor - current) < 1e-6 ? 'bg-accent/10' : ''}`}>
                  <td className="px-2 py-1 text-right font-semibold text-ink">{r.factor}</td>
                  <td className={`px-2 py-1 text-right ${r.minPressure < criteria.minPressure ? 'text-[#f3a5a5]' : 'text-ink'}`}>{r.minPressure.toFixed(2)}</td>
                  <td className="cursor-pointer px-2 py-1 text-ink-soft hover:text-ink" onClick={() => focusNode(r.minPressureNode)}>
                    {r.minPressureNode}
                  </td>
                  <td className={`px-2 py-1 text-right ${r.maxPressure > criteria.maxPressure ? 'text-[#f3a5a5]' : 'text-ink'}`}>{r.maxPressure.toFixed(2)}</td>
                  <td className={`px-2 py-1 text-right ${r.maxVelocity > criteria.maxVelocity ? 'text-[#f3a5a5]' : 'text-ink'}`}>{r.maxVelocity.toFixed(2)}</td>
                  <td className="cursor-pointer px-2 py-1 text-ink-soft hover:text-ink" onClick={() => focusLink(r.maxVelocityLink)}>
                    {r.maxVelocityLink}
                  </td>
                  <td className={`px-2 py-1 text-right ${bad(r.lowPressure)}`}>{r.lowPressure}</td>
                  <td className={`px-2 py-1 text-right ${bad(r.highPressure)}`}>{r.highPressure}</td>
                  <td className={`px-2 py-1 text-right ${bad(r.lowVelocity)}`}>{r.lowVelocity}</td>
                  <td className={`px-2 py-1 text-right ${bad(r.highVelocity)}`}>{r.highVelocity}</td>
                  <td className={`px-2 py-1 text-right ${bad(r.negative)}`}>{r.negative}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right">
                    <button type="button" disabled={running} className="text-accent hover:underline disabled:opacity-40" onClick={() => void applyDemandFactor(r.factor)}>
                      적용
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
