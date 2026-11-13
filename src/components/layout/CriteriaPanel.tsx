/** 하단 '설계기준 검토' 탭: 수압·유속 기준 위반 목록과 수원별 물수지. */
import { SquareDashedMousePointer } from 'lucide-react';
import { useMemo, useState } from 'react';
import { checkCriteria, CRITERIA_LABELS, defaultCriteria, waterBalance, type CriteriaHit, type CriteriaKind, type WaterCriteria } from '../../core/engine/criteria';
import { linkPath } from '../../core/model/networkEdit';
import type { NetworkModel } from '../../core/model/types';
import { formatClock, formatNumber, isUsUnits, unitLabels } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { useUIStore } from '../../store/useUIStore';
import { midpointOfPath } from '../../utils/geoMath';
import { Button, NumberField } from '../ui/fields';

const KINDS: CriteriaKind[] = ['lowPressure', 'highPressure', 'lowVelocity', 'highVelocity'];

function focusHit(hit: CriteriaHit): void {
  const model = useNetworkStore.getState().model;
  const ui = useUIStore.getState();
  const isNode = hit.kind === 'lowPressure' || hit.kind === 'highPressure';
  if (isNode) {
    const node = model.nodes[hit.id];
    if (!node) return;
    ui.select({ kind: 'node', id: hit.id });
    ui.setHighlight({ nodeIds: [hit.id], linkIds: [] });
    ui.flyTo(node.position, 17);
  } else {
    const link = model.links[hit.id];
    if (!link) return;
    ui.select({ kind: 'link', id: hit.id });
    ui.setHighlight({ nodeIds: [], linkIds: [hit.id] });
    ui.flyTo(midpointOfPath(linkPath(model, link)).position, 17);
  }
  useSimulationStore.getState().setStep(hit.step);
}

export function CriteriaPanel() {
  const model = useNetworkStore((s) => s.model);
  const results = useSimulationStore((s) => s.results);
  const [criteria, setCriteria] = useState<WaterCriteria | null>(null);
  const flowUnits = model.options.flowUnits;
  const defaults = useMemo(() => defaultCriteria({ options: { flowUnits } as NetworkModel['options'] }), [flowUnits]);
  const c = criteria ?? defaults;
  const [filter, setFilter] = useState<CriteriaKind | 'all'>('all');
  const units = unitLabels(model.options.flowUnits);
  const us = isUsUnits(model.options.flowUnits);
  const hits = useMemo(() => (results ? checkCriteria(model, results, c) : []), [model, results, c]);
  const balance = useMemo(() => (results ? waterBalance(model, results) : null), [model, results]);
  const shown = filter === 'all' ? hits : hits.filter((h) => h.kind === filter);

  if (!results) {
    return <div className="flex h-full items-center justify-center text-xs text-ink-muted">해석을 실행하면 수압·유속 설계기준 위반과 수원별 물수지가 여기에 나옵니다.</div>;
  }
  const set = (patch: Partial<WaterCriteria>) => setCriteria({ ...c, ...patch });
  const unitOf = (k: CriteriaKind) => (k === 'lowPressure' || k === 'highPressure' ? units.pressure : units.velocity);
  return (
    <div className="flex h-full min-h-0 gap-3 p-2 text-xs">
      <div className="flex min-w-0 flex-[3] flex-col">
        <div className="flex flex-wrap items-end gap-2">
          <label className="w-24">
            <span className="text-[10px] text-ink-muted">최소 수압 ({units.pressure})</span>
            <NumberField value={+c.minPressure.toFixed(2)} onCommit={(v) => set({ minPressure: v })} />
          </label>
          <label className="w-24">
            <span className="text-[10px] text-ink-muted">최대 수압 ({units.pressure})</span>
            <NumberField value={+c.maxPressure.toFixed(2)} onCommit={(v) => set({ maxPressure: v })} />
          </label>
          <label className="w-24">
            <span className="text-[10px] text-ink-muted">최소 유속 ({units.velocity})</span>
            <NumberField value={+c.minVelocity.toFixed(2)} min={0} onCommit={(v) => set({ minVelocity: v })} />
          </label>
          <label className="w-24">
            <span className="text-[10px] text-ink-muted">최대 유속 ({units.velocity})</span>
            <NumberField value={+c.maxVelocity.toFixed(2)} min={0} onCommit={(v) => set({ maxVelocity: v })} />
          </label>
          <Button
            disabled={shown.length === 0}
            onClick={() => {
              const ui = useUIStore.getState();
              const nodeIds = shown.filter((h) => h.kind === 'lowPressure' || h.kind === 'highPressure').map((h) => h.id);
              const linkIds = shown.filter((h) => h.kind === 'lowVelocity' || h.kind === 'highVelocity').map((h) => h.id);
              ui.setMultiSelection({ nodeIds: [...new Set(nodeIds)], linkIds: [...new Set(linkIds)] });
              ui.setHighlight({ nodeIds, linkIds });
            }}
            title="목록의 객체를 모두 선택해 지도에 강조합니다"
          >
            <SquareDashedMousePointer size={12} /> 지도에 모두 표시
          </Button>
        </div>
        <p className="mt-1 text-[10px] text-ink-muted">
          기본값: 최소 동수압 150 kPa ≈ 15.3 m, 최대 700 kPa ≈ 71.4 m, 유속 0.3~3.0 m/s{us ? ' (US 단위로 환산)' : ''}. 수압은 전 시간 최저·최고값, 유속은 전 시간 최대값(이것이 최소 유속보다
          작으면 정체 의심)으로 판정합니다. 최대 정수압은 무수요 해석으로 따로 확인하세요.
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1" role="tablist" aria-label="기준 유형">
          {[{ k: 'all' as const, label: '전체', n: hits.length }, ...KINDS.map((k) => ({ k, label: CRITERIA_LABELS[k], n: hits.filter((h) => h.kind === k).length }))].map((chip) => (
            <button
              key={chip.k}
              type="button"
              role="tab"
              aria-selected={filter === chip.k}
              onClick={() => setFilter(chip.k)}
              className={`rounded border px-1.5 py-0.5 text-[11px] ${filter === chip.k ? 'border-accent bg-accent/15 text-ink' : 'border-line text-ink-soft hover:text-ink'}`}
            >
              {chip.label} <span className={chip.n > 0 && chip.k !== 'all' ? 'text-[#f3a5a5]' : ''}>{chip.n.toLocaleString()}</span>
            </button>
          ))}
        </div>
        <ul className="mt-1 min-h-0 flex-1 overflow-y-auto rounded border border-line">
          {shown.length === 0 && <li className="px-3 py-3 text-center text-ink-muted">기준을 벗어난 항목이 없습니다.</li>}
          {shown.slice(0, 500).map((h) => (
            <li key={`${h.kind}:${h.id}`} className="flex cursor-pointer gap-2 border-b border-line/60 px-2 py-1 hover:bg-raised" onClick={() => focusHit(h)}>
              <span className="w-24 shrink-0 text-ink-soft">{CRITERIA_LABELS[h.kind]}</span>
              <span className="w-24 shrink-0 text-ink">{h.id}</span>
              <span className="tabular-nums text-ink">
                {formatNumber(h.value, 2)} {unitOf(h.kind)}
              </span>
              <span className="ml-auto text-ink-muted">{formatClock(results.times[h.step] ?? 0)}</span>
            </li>
          ))}
        </ul>
      </div>
      {balance && (
        <div className="flex min-w-0 flex-[2] flex-col">
          <h3 className="font-semibold text-ink">수원별 물수지</h3>
          <p className="text-[10px] text-ink-muted">
            평균 공급 {formatNumber(balance.totalSupply, 2)} / 평균 수요 {formatNumber(balance.totalDemand, 2)} {units.flow}
            {balance.unsuppliedNodes > 0 && ` · 수원에 닿지 않는 수요 절점 ${balance.unsuppliedNodes}개`} · 급수구역은 최대 수요 시각({formatClock(results.times[balance.peakStep] ?? 0)}) 기준
          </p>
          <div className="mt-1 min-h-0 flex-1 overflow-auto rounded border border-line">
            <table className="w-full tabular-nums">
              <thead className="sticky top-0 bg-panel text-ink-soft">
                <tr>
                  {['수원', '평균 유출', '최대 유출', '급수 절점', '구역 수요'].map((h, i) => (
                    <th key={h} className={`px-2 py-1 font-medium ${i === 0 ? 'text-left' : 'text-right'}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {balance.sources.map((s) => (
                  <tr key={s.id} className="border-t border-line/50">
                    <td className="px-2 py-0.5 text-ink">
                      {s.id} <span className="text-ink-muted">{s.type === 'tank' ? '배수지' : '수원지'}</span>
                    </td>
                    <td className="px-2 py-0.5 text-right">{formatNumber(s.avgOutflow, 2)}</td>
                    <td className="px-2 py-0.5 text-right">{formatNumber(s.maxOutflow, 2)}</td>
                    <td className="px-2 py-0.5 text-right">{s.zoneNodes.toLocaleString()}</td>
                    <td className="px-2 py-0.5 text-right">{formatNumber(s.zoneDemand, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[10px] text-ink-muted">유출 − 는 배수지로 들어오는(충수) 양. 단위 {units.flow}.</p>
        </div>
      )}
    </div>
  );
}
