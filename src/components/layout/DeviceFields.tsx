/** 펌프 설계점(유량·양정)·밸브 설정값 입력 — 오른쪽 속성 패널의 펌프·밸브 칸. */
import { linkValueAt, nodeValueAt } from '../../core/engine/simulationManager';
import { nextId } from '../../core/model/networkEdit';
import type { Pump, Valve, ValveType } from '../../core/model/types';
import { formatNumber, type UnitLabels } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { FieldRow, NumberField, SelectField } from '../ui/fields';

/** 밸브 종류별 설정값의 뜻과 단위 */
function valveSettingMeaning(type: ValveType, labels: UnitLabels): { label: string; unit: string; hint: string } {
  switch (type) {
    case 'PRV':
      return { label: '감압 설정 압력', unit: labels.pressure, hint: '밸브 하류 압력을 이 값 이하로 낮춥니다. 상류 압력이 이보다 낮으면 그대로 통과합니다.' };
    case 'PSV':
      return { label: '유지 압력', unit: labels.pressure, hint: '밸브 상류 압력을 이 값 이상으로 유지합니다.' };
    case 'PBV':
      return { label: '압력 차', unit: labels.pressure, hint: '밸브 앞뒤에 이 만큼 압력을 떨어뜨립니다.' };
    case 'FCV':
      return { label: '제한 유량', unit: labels.flow, hint: '이 유량 이상 흐르지 않게 막습니다.' };
    case 'TCV':
      return { label: '손실계수', unit: '', hint: '부분 개방 밸브의 손실계수(K)입니다.' };
    case 'GPV':
      return { label: '손실 곡선', unit: '', hint: '유량-손실수두 곡선 ID 입니다.' };
  }
}

export function ValveSettingFields({ link, labels }: { link: Valve; labels: UnitLabels }) {
  const updateLink = useNetworkStore((s) => s.updateLink);
  const curves = useNetworkStore((s) => s.model.curves);
  const down = useNetworkStore((s) => s.model.nodes[link.endNodeId]);
  const up = useNetworkStore((s) => s.model.nodes[link.startNodeId]);
  const results = useSimulationStore((s) => s.results);
  const step = useSimulationStore((s) => s.stepIndex);
  const m = valveSettingMeaning(link.valveType, labels);
  const value = Number(link.setting);
  const pressureAt = (id: string) => (results ? nodeValueAt(results, 'pressure', step, id) : undefined);

  return (
    <>
      <FieldRow label={m.label} unit={m.unit}>
        {link.valveType === 'GPV' ? (
          <SelectField
            value={link.setting}
            options={[{ value: '', label: '(없음)' }, ...Object.keys(curves).map((id) => ({ value: id, label: id }))]}
            onChange={(setting) => updateLink(link.id, { setting })}
          />
        ) : (
          <NumberField value={Number.isFinite(value) ? value : 0} min={0} onCommit={(v) => updateLink(link.id, { setting: String(v) })} />
        )}
      </FieldRow>
      <p className="mb-1 text-[11px] text-ink-muted">{m.hint}</p>
      {link.valveType === 'PRV' && down && Number.isFinite(value) && (
        <p className="mb-1 text-[11px] text-ink-soft">
          하류 {down.id}(표고 {formatNumber(down.elevation, 1)} {labels.elevation}) 기준 감압 후 수두 {formatNumber(down.elevation + value, 1)} {labels.elevation}
        </p>
      )}
      {up && down && link.valveType !== 'GPV' && pressureAt(up.id) !== undefined && pressureAt(down.id) !== undefined && (
        <p className="mb-1 text-[11px] text-ink-soft">
          지금 시각 수압: 상류 {up.id} {formatNumber(pressureAt(up.id)!, 1)} → 하류 {down.id} {formatNumber(pressureAt(down.id)!, 1)} {labels.pressure}
        </p>
      )}
      {link.valveType === 'PRV' && results && down && Number.isFinite(value) && (() => {
        const q = linkValueAt(results, 'flow', step, link.id);
        const p = pressureAt(down.id);
        if (q === undefined || p === undefined || Math.abs(q) > 1e-3 || p <= value + 0.5) return null;
        return (
          <p className="mb-1 rounded bg-[#3a3220] px-1.5 py-1 text-[11px] text-[#f0d28a]">
            지금 시각 밸브가 닫혀 있습니다 — 하류 {down.id} 가 다른 관으로도 물을 받아 설정 압력보다 높습니다. 감압하려면 하류 구역으로 들어가는 다른 관에도
            감압밸브를 두거나 그 관을 닫으세요(‘감압·가압 후보 제안’이 구역 경계를 찾아 줍니다).
          </p>
        );
      })()}
    </>
  );
}

/**
 * 펌프 설계점: 한 점 양정 곡선(유량·양정)을 바로 고친다.
 * 곡선이 없거나 한 점이면 여기서 정하고, 여러 점 곡선이면 곡선 편집기에서 고치도록 안내한다.
 */
export function PumpDutyFields({ link, labels }: { link: Pump; labels: UnitLabels }) {
  const curve = useNetworkStore((s) => (link.headCurve ? s.model.curves[link.headCurve] : undefined));
  const commit = useNetworkStore((s) => s.commit);
  if (curve && curve.length > 1) {
    return <p className="mb-1 text-[11px] text-ink-muted">양정 곡선 {link.headCurve} 은 {curve.length}점 곡선입니다 — 곡선 편집기에서 고치세요.</p>;
  }
  const [flow, head] = curve?.[0] ?? [0, 0];
  const set = (q: number, h: number) =>
    commit((d) => {
      const pump = d.links[link.id];
      if (!pump || pump.type !== 'pump') return;
      let id = pump.headCurve;
      if (!id || !d.curves[id]) {
        id = nextId(`${link.id}_H`, d.curves);
        pump.headCurve = id;
      }
      d.curves[id] = [[q, h]];
      pump.power = 0;
    });
  const ready = flow > 0 && head > 0;
  return (
    <>
      <FieldRow label="설계 유량" unit={labels.flow}>
        <NumberField value={flow} min={0} onCommit={(q) => set(q, head > 0 ? head : labels.elevation === 'ft' ? 100 : 30)} />
      </FieldRow>
      <FieldRow label="양정" unit={labels.elevation}>
        <NumberField value={head} min={0} onCommit={(h) => set(flow > 0 ? flow : 1, h)} />
      </FieldRow>
      <p className="mb-1 text-[11px] text-ink-muted">
        {ready
          ? `한 점 곡선(${link.headCurve}): EPANET 이 이 점을 지나는 곡선을 만듭니다 — 체절 양정 ${formatNumber(head * 1.33, 1)} ${labels.elevation}, 최대 유량 ${formatNumber(flow * 2, 2)} ${labels.flow}.`
          : '설계 유량과 양정을 넣으면 한 점 양정 곡선으로 해석합니다. 비워 두면 아래 정동력으로 해석합니다.'}
      </p>
    </>
  );
}
