/** 하수 오른쪽 패널: 중계펌프장(습정 → 토출) 속성·자동 설계값·SWMM 결과. */
import { Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { deleteSewerPump, idProblem, renameSewerPump } from '../../core/sewer/edit';
import { PUMP_HEAD_MARGIN, pumpDuties, WET_WELL_MINUTES, type PumpDuty } from '../../core/sewer/pumps';
import type { SewerProject, SewerPump } from '../../core/sewer/types';
import { useSewerStore } from '../../store/useSewerStore';
import { useUIStore } from '../../store/useUIStore';
import { Button, FieldRow, NumberField, Section, TextField } from '../ui/fields';

function dutyOf(project: SewerProject, id: string): PumpDuty | null {
  try {
    return pumpDuties(project).find((d) => d.id === id) ?? null;
  } catch {
    return null;
  }
}

/** 자동/직접 입력 칸: 자동이면 계산값을 흐리게 보여 주고, 숫자를 넣으면 직접 값이 된다. */
function AutoField({ label, unit, value, auto, onAuto, onValue, step }: { label: string; unit: string; value: number | null; auto: boolean; onAuto: (on: boolean) => void; onValue: (v: number) => void; step?: number }) {
  return (
    <FieldRow label={label} unit={unit}>
      <div className="flex items-center gap-1.5">
        <div className={`min-w-0 flex-1 ${auto ? 'opacity-60' : ''}`}>
          <NumberField value={value ?? 0} min={0} step={step} onCommit={onValue} />
        </div>
        <label className="flex shrink-0 items-center gap-1 text-[11px] text-ink-soft" title="자동: 관망에서 계산한 값을 씁니다">
          <input type="checkbox" className="accent-accent" checked={auto} onChange={(e) => onAuto(e.target.checked)} />
          자동
        </label>
      </div>
    </FieldRow>
  );
}

export function PumpSection({ pump }: { pump: SewerPump }) {
  const project = useSewerStore((s) => s.project);
  const design = useSewerStore((s) => s.design);
  const simulation = useSewerStore((s) => s.simulation);
  const edit = useSewerStore((s) => s.edit);
  const select = useSewerStore((s) => s.select);
  const patch = (recipe: (p: SewerPump) => void) => edit((d) => void (d.pumps ?? []).filter((p) => p.id === pump.id).forEach(recipe));
  // 설계 결과가 있으면 설계한 관저고로 실양정을 본다
  const duty = useMemo(() => dutyOf(design?.project ?? project, pump.id) ?? dutyOf(project, pump.id), [design, project, pump.id]);
  const result = simulation?.pump_summary?.[pump.id];
  const well = simulation?.node_summary[pump.wet_well];
  const wellNode = (design?.project ?? project).nodes.find((n) => n.id === pump.wet_well);

  return (
    <Section title={`중계펌프장 ${pump.id}`}>
      <FieldRow label="ID">
        <TextField
          value={pump.id}
          onCommit={(next) => {
            const p = useSewerStore.getState().project;
            const problem = idProblem([...p.conduits.map((c) => c.id), ...(p.pumps ?? []).map((x) => x.id)], pump.id, next);
            if (problem) {
              useUIStore.getState().pushToast({ level: 'warning', title: 'ID 를 바꿀 수 없습니다', message: problem });
              return false;
            }
            edit((d) => void renameSewerPump(d, pump.id, next));
            select({ kind: 'pump', id: next });
            return true;
          }}
        />
      </FieldRow>
      <FieldRow label="습정 → 토출" plain>
        <span className="flex gap-1 text-xs">
          <button type="button" className="text-accent hover:underline" onClick={() => select({ kind: 'node', id: pump.wet_well })}>
            {pump.wet_well}
          </button>
          →
          <button type="button" className="text-accent hover:underline" onClick={() => select({ kind: 'node', id: pump.discharge })}>
            {pump.discharge}
          </button>
        </span>
      </FieldRow>
      <AutoField
        label="펌프 용량"
        unit="m³/s"
        step={0.001}
        value={pump.capacity ?? duty?.capacity ?? null}
        auto={pump.capacity === null}
        onAuto={(on) => patch((p) => void (p.capacity = on ? null : (duty?.capacity ?? 0.01)))}
        onValue={(v) => patch((p) => void (p.capacity = v > 0 ? v : null))}
      />
      <AutoField
        label="전양정"
        unit="m"
        step={0.1}
        value={pump.head ?? duty?.head ?? null}
        auto={pump.head === null}
        onAuto={(on) => patch((p) => void (p.head = on ? null : (duty?.head ?? 5)))}
        onValue={(v) => patch((p) => void (p.head = v > 0 ? v : null))}
      />
      <FieldRow label="가동 수심" unit="m">
        <NumberField value={pump.on_depth} min={0.1} step={0.1} onCommit={(v) => patch((p) => void (p.on_depth = v))} />
      </FieldRow>
      <FieldRow label="정지 수심" unit="m">
        <NumberField value={pump.off_depth} min={0} step={0.1} onCommit={(v) => patch((p) => void (p.off_depth = v))} />
      </FieldRow>
      <AutoField
        label="습정 바닥면적"
        unit="m²"
        step={0.5}
        value={pump.area ?? duty?.area ?? null}
        auto={pump.area === null}
        onAuto={(on) => patch((p) => void (p.area = on ? null : (duty?.area ?? 10)))}
        onValue={(v) => patch((p) => void (p.area = v > 0 ? v : null))}
      />
      {duty && (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
          습정 유입 설계유량 {(duty.inflow * 1000).toFixed(1)} L/s · 실양정 {duty.staticLift.toFixed(2)} m (토출 맨홀 관저 − 습정 바닥{design ? ', 설계 관저고 기준' : ''}).
          자동 값: 용량 = 유입 설계유량, 전양정 = 실양정 + {PUMP_HEAD_MARGIN} m(압송관·밸브 손실 개략), 바닥면적 = 용량 × {WET_WELL_MINUTES}분 ÷ (가동 − 정지 수심). 압송관이 길면 마찰손실을 계산해 전양정을 직접 넣으세요.
        </p>
      )}
      {result && (
        <div className="mt-1.5 border-t border-line/60 pt-1.5 text-xs">
          <p className="mb-0.5 text-[11px] text-ink-muted">SWMM 해석 결과</p>
          <div className="flex justify-between py-0.5">
            <span className="text-ink-soft">가동률 · 기동 횟수</span>
            <span className="tabular-nums text-ink">
              {result.utilized.toFixed(1)} % · {result.startups}회
            </span>
          </div>
          <div className="flex justify-between py-0.5">
            <span className="text-ink-soft">평균 · 최대 토출량</span>
            <span className="tabular-nums text-ink">
              {(result.avg_flow * 1000).toFixed(1)} · {(result.max_flow * 1000).toFixed(1)} L/s
            </span>
          </div>
          {well && wellNode && (
            <div className="flex justify-between py-0.5">
              <span className="text-ink-soft">습정 최고 수심</span>
              <span className={`tabular-nums ${well.flood_hours > 0 ? 'text-[#f3a5a5]' : 'text-ink'}`}>
                {well.max_depth.toFixed(2)} m / 깊이 {(wellNode.ground - wellNode.invert).toFixed(2)} m{well.flood_hours > 0 ? ` — 월류 ${well.flood_hours.toFixed(2)} 시간` : ''}
              </span>
            </div>
          )}
          {(result.off_curve_low > 0 || result.off_curve_high > 0) && (
            <p className="mt-1 rounded bg-[#3a3220] px-1.5 py-1 text-[11px] text-[#f0d28a]">
              펌프 곡선 밖 운전 시간 {Math.max(result.off_curve_low, result.off_curve_high).toFixed(1)} % — {result.off_curve_high > 0 ? '필요 양정이 펌프 체절 양정보다 높습니다. 전양정을 올리세요.' : '양정이 너무 낮은 구간입니다(토출 측이 낮음).'}
            </p>
          )}
          {well && well.flood_hours > 0 && (
            <p className="mt-1 rounded bg-[#3a3220] px-1.5 py-1 text-[11px] text-[#f0d28a]">습정이 넘칩니다 — 펌프 용량을 키우거나 습정 바닥면적을 늘리세요.</p>
          )}
        </div>
      )}
      <Button className="mt-2 w-full" onClick={() => edit((d) => void deleteSewerPump(d, pump.id))} title="펌프장을 지웁니다 (습정 맨홀은 남음, 실행 취소 가능)">
        <Trash2 size={13} />
        펌프장 지우기
      </Button>
    </Section>
  );
}
