import { MapPinned, Plus, RotateCcw, X } from 'lucide-react';
import { useMemo } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { focusObjects } from '../../app/actions';
import { useProfilePath } from '../../app/useProfilePath';
import { nodeValueAt } from '../../core/engine/simulationManager';
import { FEET_PER_METER, formatClock, formatNumber, isUsUnits, PSI_PER_METER, unitLabels } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { useUIStore } from '../../store/useUIStore';
import { Button } from '../ui/fields';

const GROUND = '#8a7356';
const HGL = '#3987e5';
const ENVELOPE = '#3987e5';
const LIMIT = '#d03b3b';
const GRID = '#2a313b';
const AXIS = '#8b8a84';

interface ProfileDatum {
  distance: number;
  id: string;
  kind: string;
  /** 지반고. 수원지는 지반고가 없으므로 null. */
  ground: number | null;
  head: number | null;
  envelope: [number, number] | null;
  /** 최소 수압 기준 수두 (지반고 + 최소 수압). */
  limit: number | null;
  pressure: number | null;
}

function WaypointChips() {
  const waypoints = useUIStore((s) => s.profileWaypoints);
  const setWaypoints = useUIStore((s) => s.setProfileWaypoints);
  const nodes = useNetworkStore((s) => s.model.nodes);
  return (
    <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
      {waypoints.map((id, index) => (
        <span key={`${id}:${index}`} className="flex items-center">
          {index > 0 && <span className="px-0.5 text-ink-muted">→</span>}
          <span
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
              id in nodes ? 'border-line bg-raised text-ink' : 'border-critical/60 text-[#f3a5a5] line-through'
            }`}
          >
            {index === 0 ? '시점 ' : index === waypoints.length - 1 ? '종점 ' : ''}
            {id}
            <button
              type="button"
              aria-label={`${id} 빼기`}
              className="text-ink-muted hover:text-ink"
              onClick={() => setWaypoints(waypoints.filter((_, i) => i !== index))}
            >
              <X size={11} />
            </button>
          </span>
        </span>
      ))}
    </div>
  );
}

/** 종단면도 탭: 두(또는 여러) 절점 사이 최단 경로의 지반고·동수두선(HGL)·최소 수압선. */
export function ProfilePanel() {
  const path = useProfilePath();
  const nodes = useNetworkStore((s) => s.model.nodes);
  const flowUnits = useNetworkStore((s) => s.model.options.flowUnits);
  const results = useSimulationStore((s) => s.results);
  const stepIndex = useSimulationStore((s) => s.stepIndex);
  const waypoints = useUIStore((s) => s.profileWaypoints);
  const tool = useUIStore((s) => s.tool);
  const selection = useUIStore((s) => s.selection);
  const labels = unitLabels(flowUnits);
  const us = isUsUnits(flowUnits);
  /** 최소 수압(수두 환산). SI 15 m, US 21 psi → ft. */
  const minPressureHead = us ? (21 / PSI_PER_METER) * FEET_PER_METER : 15;

  const data = useMemo<ProfileDatum[]>(() => {
    if (!path) return [];
    return path.nodeIds.map((id, index) => {
      const node = nodes[id];
      const ground = node && node.type !== 'reservoir' ? node.elevation : null;
      let head: number | null = null;
      let envelope: [number, number] | null = null;
      let pressure: number | null = null;
      if (results) {
        head = nodeValueAt(results, 'head', stepIndex, id) ?? null;
        const p = nodeValueAt(results, 'pressure', stepIndex, id);
        pressure = node?.type === 'junction' && p !== undefined ? p : null;
        const nodeIndex = results.nodeIndex.get(id);
        if (nodeIndex !== undefined && results.stepCount > 1) {
          let min = Infinity;
          let max = -Infinity;
          const count = results.nodeIds.length;
          for (let s = 0; s < results.stepCount; s++) {
            const v = results.node.head[s * count + nodeIndex];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          envelope = [min, max];
        }
      }
      return {
        distance: Number(path.distances[index].toFixed(2)),
        id,
        kind: node?.type === 'reservoir' ? '수원지' : node?.type === 'tank' ? '배수지' : '절점',
        ground,
        head,
        envelope,
        limit: node?.type === 'junction' && ground !== null ? ground + minPressureHead : null,
        pressure,
      };
    });
  }, [path, nodes, results, stepIndex, minPressureHead]);

  const summary = useMemo(() => {
    let lowest: ProfileDatum | null = null;
    for (const d of data) if (d.pressure !== null && (!lowest || d.pressure < (lowest.pressure ?? Infinity))) lowest = d;
    return { lowest, length: path ? path.distances[path.distances.length - 1] : 0 };
  }, [data, path]);

  const ui = useUIStore.getState;
  const addSelected = () => {
    if (selection?.kind !== 'node') return;
    const current = ui().profileWaypoints;
    if (current[current.length - 1] === selection.id) return;
    ui().setProfileWaypoints([...current, selection.id]);
  };

  const toolbar = (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-3 py-1.5">
      <Button
        variant={tool === 'profile' ? 'primary' : 'default'}
        title="지도에서 절점을 차례로 클릭해 시점·경유점·종점을 지정합니다"
        onClick={() => ui().setTool(tool === 'profile' ? 'select' : 'profile')}
      >
        <MapPinned size={13} />
        {tool === 'profile' ? '지정 중… (클릭해서 끝내기)' : '지도에서 지정'}
      </Button>
      <Button disabled={selection?.kind !== 'node'} onClick={addSelected} title="우측 패널에 선택된 절점을 경유점으로 추가">
        <Plus size={13} />
        선택 절점 추가
      </Button>
      <Button variant="ghost" disabled={waypoints.length === 0} onClick={() => ui().setProfileWaypoints([])}>
        <RotateCcw size={13} />
        초기화
      </Button>
      <WaypointChips />
      {path && (
        <span className="ml-auto shrink-0 whitespace-nowrap text-[11px] tabular-nums text-ink-muted">
          연장 {formatNumber(summary.length, 1)} {labels.length} · 절점 {path.nodeIds.length}개
          {summary.lowest && (
            <>
              {' '}
              · 최저 수압{' '}
              <button type="button" className="text-ink hover:underline" onClick={() => focusObjects({ nodeIds: [summary.lowest!.id], linkIds: [] })}>
                {summary.lowest.id} {formatNumber(summary.lowest.pressure ?? 0, 2)} {labels.pressure}
              </button>
            </>
          )}
        </span>
      )}
    </div>
  );

  if (!path) {
    const broken = waypoints.length >= 2;
    return (
      <div className="flex h-full min-h-0 flex-col">
        {toolbar}
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-ink-muted">
          {broken
            ? '경유 절점 사이가 관로로 이어져 있지 않습니다. 절점을 다시 지정하세요.'
            : waypoints.length === 1
              ? '종점 절점을 하나 더 지정하세요.'
              : '‘지도에서 지정’을 누른 뒤 시점과 종점 절점을 클릭하면 관로 연장 기준 최단 경로의 종단면도가 그려집니다.'}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      <div className="min-h-0 flex-1 px-2 pb-1 pt-2">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 4, right: 16, bottom: 0, left: 0 }}
            onClick={(state) => {
              const index = Number(state?.activeTooltipIndex);
              const datum = Number.isInteger(index) ? data[index] : undefined;
              if (datum) useUIStore.getState().select({ kind: 'node', id: datum.id });
            }}
          >
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="distance"
              type="number"
              domain={[0, 'dataMax']}
              tick={{ fill: AXIS, fontSize: 10 }}
              stroke={GRID}
              tickLine={false}
              tickFormatter={(v: number) => `${formatNumber(v, 0)}`}
              unit={` ${labels.length}`}
            />
            <YAxis
              width={50}
              tick={{ fill: AXIS, fontSize: 10 }}
              stroke={GRID}
              tickLine={false}
              axisLine={false}
              domain={['auto', 'auto']}
              tickFormatter={(v: number) => formatNumber(v, 0)}
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: AXIS, strokeWidth: 1 }}
              contentStyle={{ background: '#161a20', border: '1px solid #2a313b', borderRadius: 6, fontSize: 12, padding: '6px 8px' }}
              labelStyle={{ color: '#c3c2b7' }}
              itemStyle={{ color: '#f0efec' }}
              labelFormatter={(_, payload) => {
                const datum = payload?.[0]?.payload as ProfileDatum | undefined;
                return datum ? `${datum.kind} ${datum.id} · ${formatNumber(datum.distance, 1)} ${labels.length}` : '';
              }}
              formatter={(value, name, item) => {
                const datum = item.payload as ProfileDatum;
                if (name === 'head' && datum.pressure !== null)
                  return [`${formatNumber(Number(value), 2)} ${labels.elevation} (수압 ${formatNumber(datum.pressure, 2)} ${labels.pressure})`, '동수두'];
                const title = name === 'ground' ? '지반고' : name === 'head' ? '동수두' : '최소 수압선';
                return [`${formatNumber(Number(value), 2)} ${labels.elevation}`, title];
              }}
            />
            <Area
              type="linear"
              dataKey="ground"
              name="ground"
              stroke={GROUND}
              fill={GROUND}
              fillOpacity={0.35}
              strokeWidth={1.5}
              connectNulls
              baseValue="dataMin"
              isAnimationActive={false}
            />
            {results && results.stepCount > 1 && (
              <Area
                type="linear"
                dataKey="envelope"
                name="envelope"
                stroke="none"
                fill={ENVELOPE}
                fillOpacity={0.14}
                tooltipType="none"
                isAnimationActive={false}
              />
            )}
            <Line type="linear" dataKey="limit" name="limit" stroke={LIMIT} strokeDasharray="4 4" strokeWidth={1.25} dot={false} connectNulls isAnimationActive={false} />
            {results && (
              <Line
                type="linear"
                dataKey="head"
                name="head"
                stroke={HGL}
                strokeWidth={2}
                dot={{ r: 2.5, fill: HGL, strokeWidth: 0 }}
                activeDot={{ r: 4.5, stroke: '#161a20', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flex shrink-0 items-center gap-4 overflow-hidden whitespace-nowrap px-3 pb-1.5 text-[11px] text-ink-muted">
        <Legend color={GROUND} label="지반고" />
        {results ? (
          <>
            <Legend color={HGL} label={`동수두선 (${formatClock(results.times[stepIndex] ?? 0)})`} />
            {results.stepCount > 1 && <Legend color={ENVELOPE} label="시간대별 수두 범위" faded />}
          </>
        ) : (
          <span>해석을 실행하면 동수두선이 함께 그려집니다.</span>
        )}
        <Legend color={LIMIT} label={`최소 수압선 (지반고 + ${us ? '21 psi' : '15 m'})`} dashed />
      </div>
    </div>
  );
}

function Legend({ color, label, dashed, faded }: { color: string; label: string; dashed?: boolean; faded?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-0 w-4"
        style={{ borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${color}`, opacity: faded ? 0.45 : 1, borderTopWidth: faded ? 6 : 2 }}
      />
      {label}
    </span>
  );
}
