import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { linkSeries, nodeSeries, type SimulationResults } from '../../core/engine/simulationManager';
import type { NetworkModel } from '../../core/model/types';
import { formatClock, formatNumber, isUsUnits, qualityLabel, qualityUnit, unitLabels } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { useUIStore } from '../../store/useUIStore';

/** 차트 색: 측정 항목(계열)별로 고정. 텍스트는 항상 잉크 색을 쓴다. */
const SERIES_BLUE = '#3987e5';
const SERIES_AQUA = '#199e70';
const SERIES_ORANGE = '#ec835a';
const GRID = '#2a313b';
const AXIS = '#8b8a84';
const CRITICAL = '#d03b3b';

interface ChartSpec {
  title: string;
  unit: string;
  color: string;
  values: number[];
  /** 기준선 (예: 최소 수압 15 m). */
  threshold?: { value: number; label: string };
}

function niceHourTicks(maxHours: number): number[] {
  const step = maxHours <= 12 ? 1 : maxHours <= 24 ? 3 : maxHours <= 72 ? 6 : 24;
  const ticks: number[] = [];
  for (let h = 0; h <= maxHours + 1e-9; h += step) ticks.push(h);
  return ticks;
}

function SeriesChart({ spec, times, stepIndex, onPickStep }: { spec: ChartSpec; times: number[]; stepIndex: number; onPickStep: (step: number) => void }) {
  const data = useMemo(() => times.map((t, index) => ({ hour: t / 3600, value: spec.values[index], index })), [times, spec.values]);
  const maxHours = times.length > 0 ? times[times.length - 1] / 3600 : 0;
  const current = spec.values[stepIndex];
  // 기준선은 기준에 못 미치는 시간대가 있을 때만 그린다 (그때는 축 범위를 넓혀 항상 보이게 한다).
  const threshold = spec.threshold;
  const showThreshold = threshold !== undefined && spec.values.some((value) => value < threshold.value);
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 px-1 pb-1">
        <span className="min-w-0 truncate text-xs font-medium text-ink" title={spec.title}>
          {spec.title} <span className="font-normal text-ink-muted">{spec.unit}</span>
        </span>
        <span className="text-xs tabular-nums text-ink-soft">
          {formatClock(times[stepIndex] ?? 0)} · <span className="text-ink">{current === undefined ? '—' : formatNumber(current, 2)}</span>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 6, right: 14, bottom: 0, left: 0 }}
            onClick={(state) => {
              const index = Number(state?.activeTooltipIndex);
              if (Number.isInteger(index)) onPickStep(index);
            }}
          >
            <CartesianGrid stroke={GRID} strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="hour"
              type="number"
              domain={[0, maxHours]}
              ticks={niceHourTicks(maxHours)}
              tickFormatter={(h: number) => `${h}h`}
              tick={{ fill: AXIS, fontSize: 10 }}
              stroke={GRID}
              tickLine={false}
            />
            <YAxis
              width={46}
              tick={{ fill: AXIS, fontSize: 10 }}
              stroke={GRID}
              tickLine={false}
              axisLine={false}
              domain={['auto', 'auto']}
              tickFormatter={(v: number) => formatNumber(v, 1)}
            />
            <Tooltip
              cursor={{ stroke: AXIS, strokeWidth: 1 }}
              isAnimationActive={false}
              contentStyle={{ background: '#161a20', border: '1px solid #2a313b', borderRadius: 6, fontSize: 12, padding: '6px 8px' }}
              labelStyle={{ color: '#c3c2b7' }}
              itemStyle={{ color: '#f0efec' }}
              labelFormatter={(hour) => formatClock(Number(hour) * 3600)}
              formatter={(value) => [`${formatNumber(Number(value), 3)} ${spec.unit}`, spec.title]}
            />
            {showThreshold && threshold && (
              <ReferenceLine
                y={threshold.value}
                stroke={CRITICAL}
                strokeDasharray="4 4"
                ifOverflow="extendDomain"
                label={{ value: threshold.label, fill: '#c3c2b7', fontSize: 10, position: 'insideBottomRight' }}
              />
            )}
            <ReferenceLine x={(times[stepIndex] ?? 0) / 3600} stroke="#f0efec" strokeOpacity={0.55} />
            <Line
              type="monotone"
              dataKey="value"
              stroke={spec.color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: '#161a20', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** 선택 객체가 없을 때 보여 주는 관망 전체 지표: 시간대별 총 수요량과 최저 수압. */
function systemSeries(
  results: SimulationResults,
  model: NetworkModel,
): { demand: number[]; minPressure: number[]; minQuality: number[]; maxQuality: number[] } {
  const junctionIndexes: number[] = [];
  results.nodeIds.forEach((id, index) => {
    if (model.nodes[id]?.type === 'junction') junctionIndexes.push(index);
  });
  const count = results.nodeIds.length;
  const hasQuality = results.quality !== null;
  const demand: number[] = [];
  const minPressure: number[] = [];
  const minQuality: number[] = [];
  const maxQuality: number[] = [];
  for (let step = 0; step < results.stepCount; step++) {
    let total = 0;
    let min = Infinity;
    let qMin = Infinity;
    let qMax = -Infinity;
    for (const index of junctionIndexes) {
      total += results.node.demand[step * count + index];
      const pressure = results.node.pressure[step * count + index];
      if (pressure < min) min = pressure;
      if (hasQuality) {
        const value = results.node.quality[step * count + index];
        if (value < qMin) qMin = value;
        if (value > qMax) qMax = value;
      }
    }
    demand.push(total);
    minPressure.push(Number.isFinite(min) ? min : 0);
    minQuality.push(Number.isFinite(qMin) ? qMin : 0);
    maxQuality.push(Number.isFinite(qMax) ? qMax : 0);
  }
  return { demand, minPressure, minQuality, maxQuality };
}

/** 시계열 차트 탭: 선택한 절점(수압·수요량) 또는 관로(유량·유속)의 시간 변화. */
export function TimeSeriesPanel() {
  const results = useSimulationStore((s) => s.results);
  const stepIndex = useSimulationStore((s) => s.stepIndex);
  const setStep = useSimulationStore((s) => s.setStep);
  const status = useSimulationStore((s) => s.status);
  const selection = useUIStore((s) => s.selection);
  const model = useNetworkStore((s) => s.model);

  const charts = useMemo<{ heading: string; specs: ChartSpec[] } | null>(() => {
    if (!results) return null;
    const labels = unitLabels(model.options.flowUnits);
    const lowPressure = isUsUnits(model.options.flowUnits) ? 21 : 15;
    const threshold = { value: lowPressure, label: `최소 ${lowPressure} ${labels.pressure}` };
    const q = results.quality;
    const isChlorine = q?.mode === 'CHEMICAL' && q.name.toLowerCase() === 'chlorine' && qualityUnit(q) === 'mg/L';
    const qualitySpec = (values: number[]): ChartSpec[] =>
      q
        ? [
            {
              title: qualityLabel(q),
              unit: qualityUnit(q),
              color: SERIES_ORANGE,
              values,
              threshold: isChlorine ? { value: 0.1, label: '최소 0.1 mg/L' } : undefined,
            },
          ]
        : [];

    if (selection?.kind === 'node' && results.nodeIndex.has(selection.id)) {
      const node = model.nodes[selection.id];
      const isTank = node?.type === 'tank';
      const kind = node?.type === 'reservoir' ? '수원지' : isTank ? '배수지' : '절점';
      const first: ChartSpec =
        node?.type === 'reservoir'
          ? { title: '수두', unit: labels.elevation, color: SERIES_BLUE, values: nodeSeries(results, 'head', selection.id) }
          : {
              title: isTank ? '수위' : '수압',
              unit: labels.pressure,
              color: SERIES_BLUE,
              values: nodeSeries(results, 'pressure', selection.id),
              threshold: isTank ? undefined : threshold,
            };
      return {
        heading: `${kind} ${selection.id}`,
        specs: [
          first,
          { title: node?.type === 'junction' ? '수요량' : '유출입량', unit: labels.flow, color: SERIES_AQUA, values: nodeSeries(results, 'demand', selection.id) },
          ...qualitySpec(nodeSeries(results, 'quality', selection.id)),
        ],
      };
    }
    if (selection?.kind === 'link' && results.linkIndex.has(selection.id)) {
      return {
        heading: `링크 ${selection.id}`,
        specs: [
          { title: '유량', unit: labels.flow, color: SERIES_BLUE, values: linkSeries(results, 'flow', selection.id) },
          { title: '유속', unit: labels.velocity, color: SERIES_AQUA, values: linkSeries(results, 'velocity', selection.id) },
          ...qualitySpec(linkSeries(results, 'quality', selection.id)),
        ],
      };
    }
    const system = systemSeries(results, model);
    return {
      heading: '관망 전체',
      specs: [
        { title: '최저 수압', unit: labels.pressure, color: SERIES_BLUE, values: system.minPressure, threshold },
        { title: '총 수요량', unit: labels.flow, color: SERIES_AQUA, values: system.demand },
        ...(q && q.mode !== 'TRACE'
          ? qualitySpec(q.mode === 'AGE' ? system.maxQuality : system.minQuality).map((spec) => ({
              ...spec,
              title: q.mode === 'AGE' ? '최대 수령' : `최저 ${spec.title}`,
            }))
          : []),
      ],
    };
  }, [results, selection, model]);

  if (!results || !charts) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-ink-muted">
        {status === 'running'
          ? '수리해석을 실행하고 있습니다…'
          : status === 'error'
            ? '해석이 실패했습니다. 해석 로그 탭에서 원인을 확인하세요.'
            : '상단의 ‘해석 실행’을 누르면 시간대별 수압·유량 결과와 그래프가 여기에 표시됩니다.'}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-4 px-3 pb-2 pt-2">
      <div className="flex w-28 shrink-0 flex-col justify-center border-r border-line pr-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">대상</span>
        <span className="mt-0.5 break-all text-sm font-semibold text-ink">{charts.heading}</span>
        <span className="mt-2 text-[11px] leading-snug text-ink-muted">
          {selection ? '그래프를 클릭하면 해당 시각으로 이동합니다.' : '절점이나 관로를 선택하면 개별 시계열을 봅니다.'}
        </span>
      </div>
      {charts.specs.map((spec) => (
        <SeriesChart key={spec.title} spec={spec} times={results.times} stepIndex={stepIndex} onPickStep={setStep} />
      ))}
    </div>
  );
}
