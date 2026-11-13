import { ArrowLeftRight, LocateFixed, Trash } from 'lucide-react';
import { useMemo } from 'react';
import { deleteSelection } from '../../app/actions';
import { linkValueAt, nodeValueAt } from '../../core/engine/simulationManager';
import { computeSupplyZones, nodeContributions } from '../../core/engine/supplyZones';
import type { NetworkLink, NetworkNode, PipeStatus, SourceType, ValveType } from '../../core/model/types';
import { formatClock, formatNumber, qualityLabel, qualityUnit, roughnessLabel, unitLabels, type UnitLabels } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useSimulationStore } from '../../store/useSimulationStore';
import { useUIStore } from '../../store/useUIStore';
import { wgs84ToEpsg } from '../../utils/geoMath';
import { Button, FieldRow, NumberField, ReadonlyValue, Section, SelectField, TextField } from '../ui/fields';
import { MultiSelectionPanel } from './MultiSelectionPanel';

const NODE_TYPE_LABEL = { junction: '절점 (Junction)', reservoir: '수원지 (Reservoir)', tank: '배수지 (Tank)' } as const;
const LINK_TYPE_LABEL = { pipe: '관로 (Pipe)', pump: '펌프 (Pump)', valve: '밸브 (Valve)' } as const;

const STATUS_OPTIONS: { value: PipeStatus; label: string }[] = [
  { value: 'Open', label: '개방 (Open)' },
  { value: 'Closed', label: '폐쇄 (Closed)' },
  { value: 'CV', label: '체크밸브 (CV)' },
];
const VALVE_OPTIONS: { value: ValveType; label: string }[] = [
  { value: 'PRV', label: 'PRV 감압' },
  { value: 'PSV', label: 'PSV 압력유지' },
  { value: 'PBV', label: 'PBV 압력차단' },
  { value: 'FCV', label: 'FCV 유량조절' },
  { value: 'TCV', label: 'TCV 교축' },
  { value: 'GPV', label: 'GPV 범용' },
];

function usePatternOptions(current: string) {
  const patterns = useNetworkStore((s) => s.model.patterns);
  return useMemo(() => {
    const options = [{ value: '', label: '(없음)' }, ...Object.keys(patterns).map((id) => ({ value: id, label: id }))];
    if (current && !(current in patterns)) options.push({ value: current, label: `${current} (미정의)` });
    return options;
  }, [patterns, current]);
}

function useCurveOptions(current: string) {
  const curves = useNetworkStore((s) => s.model.curves);
  return useMemo(() => {
    const options = [{ value: '', label: '(없음)' }, ...Object.keys(curves).map((id) => ({ value: id, label: id }))];
    if (current && !(current in curves)) options.push({ value: current, label: `${current} (미정의)` });
    return options;
  }, [curves, current]);
}

function ResultRow({ label, value, unit, digits = 2 }: { label: string; value: number | undefined; unit: string; digits?: number }) {
  return (
    <div className="flex items-baseline justify-between py-0.5 text-xs">
      <span className="text-ink-soft">{label}</span>
      <span className="tabular-nums text-ink">
        {value === undefined ? '—' : formatNumber(value, digits)} <span className="text-ink-muted">{unit}</span>
      </span>
    </div>
  );
}

function ResultsHeader() {
  const time = useSimulationStore((s) => (s.results ? s.results.times[s.stepIndex] : null));
  const stale = useSimulationStore((s) => s.resultsRevision) !== useNetworkStore((s) => s.revision);
  if (time === null) return null;
  return (
    <span className="text-[11px] text-ink-muted">
      {formatClock(time)} 기준{stale && <span className="ml-1 text-warn">· 편집 전 결과</span>}
    </span>
  );
}

const SOURCE_OPTIONS: { value: SourceType | ''; label: string }[] = [
  { value: '', label: '(없음)' },
  { value: 'CONCEN', label: '유입 농도 (CONCEN)' },
  { value: 'SETPOINT', label: '설정 농도 (SETPOINT)' },
  { value: 'FLOWPACED', label: '농도 증가 (FLOWPACED)' },
  { value: 'MASS', label: '질량 유입 (MASS)' },
];

/** 절점의 수질 입력: 초기 수질, 유입원. 수질 해석 모드가 켜져 있을 때만 보인다. */
function NodeQualityEditor({ node }: { node: NetworkNode }) {
  const quality = useNetworkStore((s) => s.model.options.quality);
  const updateNode = useNetworkStore((s) => s.updateNode);
  const commit = useNetworkStore((s) => s.commit);
  const patternOptions = usePatternOptions(node.source?.pattern ?? '');
  if (quality.mode === 'NONE') return null;

  if (quality.mode === 'TRACE') {
    const isTrace = quality.traceNode === node.id;
    return (
      <Section title="수질 (추적)">
        {isTrace ? (
          <p className="text-[11px] text-ink-muted">이 절점에서 공급된 물의 비율(%)을 추적하고 있습니다.</p>
        ) : (
          <Button
            className="w-full"
            onClick={() =>
              commit((draft) => {
                draft.options.quality.traceNode = node.id;
              })
            }
          >
            이 절점을 추적 대상으로 지정
          </Button>
        )}
      </Section>
    );
  }

  const unit = quality.mode === 'AGE' ? '시간' : quality.chemUnits;
  return (
    <Section title={quality.mode === 'AGE' ? '수질 (수령)' : `수질 (${quality.chemName})`}>
      <FieldRow label={quality.mode === 'AGE' ? '초기 수령' : '초기 농도'} unit={unit}>
        <NumberField value={node.initQuality ?? 0} min={0} onCommit={(initQuality) => updateNode(node.id, { initQuality })} />
      </FieldRow>
      {quality.mode === 'CHEMICAL' && (
        <>
          <FieldRow label="유입원">
            <SelectField
              value={node.source?.type ?? ''}
              options={SOURCE_OPTIONS}
              onChange={(type) =>
                commit((draft) => {
                  const target = draft.nodes[node.id];
                  if (!target) return;
                  if (type === '') delete target.source;
                  else target.source = { type, strength: target.source?.strength ?? 1, pattern: target.source?.pattern ?? '' };
                })
              }
            />
          </FieldRow>
          {node.source && (
            <>
              <FieldRow label={node.source.type === 'MASS' ? '유입률' : '기준 농도'} unit={node.source.type === 'MASS' ? '질량/분' : unit}>
                <NumberField
                  value={node.source.strength}
                  min={0}
                  onCommit={(strength) =>
                    commit((draft) => {
                      const target = draft.nodes[node.id];
                      if (target?.source) target.source.strength = strength;
                    })
                  }
                />
              </FieldRow>
              <FieldRow label="농도 패턴">
                <SelectField
                  value={node.source.pattern}
                  options={patternOptions}
                  onChange={(pattern) =>
                    commit((draft) => {
                      const target = draft.nodes[node.id];
                      if (target?.source) target.source.pattern = pattern;
                    })
                  }
                />
              </FieldRow>
            </>
          )}
          <p className="mt-1 text-[11px] leading-snug text-ink-muted">
            수원지는 초기 농도가 곧 공급 농도입니다. 정수장 출구 등 중간 지점의 재염소 투입은 유입원으로 지정하세요.
          </p>
        </>
      )}
    </Section>
  );
}

/** 선택 절점에 물을 대는 수원별 기여율 (현재 시각). */
function SupplyContributions({ nodeId }: { nodeId: string }) {
  const model = useNetworkStore((s) => s.model);
  const results = useSimulationStore((s) => s.results);
  const stepIndex = useSimulationStore((s) => s.stepIndex);
  const list = useMemo(() => {
    if (!results) return [];
    const index = results.nodeIndex.get(nodeId);
    if (index === undefined) return [];
    return nodeContributions(computeSupplyZones(model, results, stepIndex), index);
  }, [model, results, stepIndex, nodeId]);
  if (!results) return null;
  return (
    <div className="mt-1.5 border-t border-line/60 pt-1.5">
      <p className="mb-1 text-[11px] text-ink-muted">공급 수원 기여율</p>
      {list.length === 0 ? (
        <p className="text-[11px] text-ink-soft">이 시각에 유입되는 물이 없습니다.</p>
      ) : (
        list.map(({ sourceId, fraction }) => (
          <div key={sourceId} className="flex items-center gap-2 py-0.5 text-xs">
            <span className="w-14 truncate text-ink-soft">{sourceId}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded bg-raised">
              <span className="block h-full rounded bg-accent" style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
            </span>
            <span className="w-12 text-right tabular-nums text-ink">{(fraction * 100).toFixed(1)}%</span>
          </div>
        ))
      )}
    </div>
  );
}

function NodeEditor({ node, labels }: { node: NetworkNode; labels: UnitLabels }) {
  const updateNode = useNetworkStore((s) => s.updateNode);
  const renameNode = useNetworkStore((s) => s.renameNode);
  const select = useUIStore((s) => s.select);
  const pushToast = useUIStore((s) => s.pushToast);
  const flyTo = useUIStore((s) => s.flyTo);
  const results = useSimulationStore((s) => s.results);
  const stepIndex = useSimulationStore((s) => s.stepIndex);
  const patternOptions = usePatternOptions(node.type === 'tank' ? '' : node.pattern);
  const curveOptions = useCurveOptions(node.type === 'tank' ? node.volumeCurve : '');
  const degree = useNetworkStore((s) => {
    let count = 0;
    for (const id in s.model.links) {
      const link = s.model.links[id];
      if (link.startNodeId === node.id || link.endNodeId === node.id) count++;
    }
    return count;
  });
  const patch = (value: Partial<NetworkNode>) => updateNode(node.id, value);
  const inKorea = node.position[0] > 122 && node.position[0] < 134 && node.position[1] > 31 && node.position[1] < 45;
  const tm = inKorea ? wgs84ToEpsg('EPSG:5186', node.position) : null;

  return (
    <>
      <Section
        title={NODE_TYPE_LABEL[node.type]}
        action={
          <button type="button" title="지도에서 보기" className="text-ink-muted hover:text-ink" onClick={() => flyTo(node.position)}>
            <LocateFixed size={14} />
          </button>
        }
      >
        <FieldRow label="ID">
          <TextField
            value={node.id}
            onCommit={(next) => {
              if (!renameNode(node.id, next)) {
                pushToast({ level: 'warning', title: 'ID 를 바꿀 수 없습니다', message: '이미 있는 ID 이거나 공백·31자 초과 등 허용되지 않는 형식입니다.' });
                return false;
              }
              select({ kind: 'node', id: next });
              return true;
            }}
          />
        </FieldRow>
        {node.type === 'junction' && (
          <>
            <FieldRow label="표고" unit={labels.elevation}>
              <NumberField value={node.elevation} onCommit={(elevation) => patch({ elevation })} />
            </FieldRow>
            <FieldRow label="기본 수요량" unit={labels.flow}>
              <NumberField value={node.demand} onCommit={(demand) => patch({ demand })} />
            </FieldRow>
            <FieldRow label="수요 패턴">
              <SelectField value={node.pattern} options={patternOptions} onChange={(pattern) => patch({ pattern })} />
            </FieldRow>
          </>
        )}
        {node.type === 'reservoir' && (
          <>
            <FieldRow label="총수두" unit={labels.elevation}>
              <NumberField value={node.elevation} onCommit={(elevation) => patch({ elevation })} />
            </FieldRow>
            <FieldRow label="수두 패턴">
              <SelectField value={node.pattern} options={patternOptions} onChange={(pattern) => patch({ pattern })} />
            </FieldRow>
          </>
        )}
        {node.type === 'tank' && (
          <>
            <FieldRow label="바닥 표고" unit={labels.elevation}>
              <NumberField value={node.elevation} onCommit={(elevation) => patch({ elevation })} />
            </FieldRow>
            <FieldRow label="초기 수위" unit={labels.elevation}>
              <NumberField value={node.initLevel} min={0} onCommit={(initLevel) => patch({ initLevel })} />
            </FieldRow>
            <FieldRow label="최저 수위" unit={labels.elevation}>
              <NumberField value={node.minLevel} min={0} onCommit={(minLevel) => patch({ minLevel })} />
            </FieldRow>
            <FieldRow label="최고 수위" unit={labels.elevation}>
              <NumberField value={node.maxLevel} min={0} onCommit={(maxLevel) => patch({ maxLevel })} />
            </FieldRow>
            <FieldRow label="직경" unit={labels.tankDiameter}>
              <NumberField value={node.diameter} min={0} onCommit={(diameter) => patch({ diameter })} />
            </FieldRow>
            <FieldRow label="체적 곡선">
              <SelectField value={node.volumeCurve} options={curveOptions} onChange={(volumeCurve) => patch({ volumeCurve })} />
            </FieldRow>
          </>
        )}
      </Section>

      <Section title="위치">
        <FieldRow label="경도">
          <ReadonlyValue>{node.position[0].toFixed(7)}</ReadonlyValue>
        </FieldRow>
        <FieldRow label="위도">
          <ReadonlyValue>{node.position[1].toFixed(7)}</ReadonlyValue>
        </FieldRow>
        {tm && (
          <FieldRow label="EPSG:5186">
            <ReadonlyValue>
              {tm[0].toFixed(2)}, {tm[1].toFixed(2)}
            </ReadonlyValue>
          </FieldRow>
        )}
        <FieldRow label="연결 링크">
          <ReadonlyValue>{degree}개</ReadonlyValue>
        </FieldRow>
      </Section>

      <NodeQualityEditor node={node} />

      {results && (
        <Section title="해석 결과" action={<ResultsHeader />}>
          {node.type === 'tank' ? (
            <ResultRow label="수위" value={nodeValueAt(results, 'pressure', stepIndex, node.id)} unit={labels.pressure} />
          ) : node.type === 'junction' ? (
            <ResultRow label="수압" value={nodeValueAt(results, 'pressure', stepIndex, node.id)} unit={labels.pressure} />
          ) : null}
          <ResultRow label="수두" value={nodeValueAt(results, 'head', stepIndex, node.id)} unit={labels.elevation} />
          <ResultRow
            label={node.type === 'junction' ? '수요량' : '유출입량'}
            value={nodeValueAt(results, 'demand', stepIndex, node.id)}
            unit={labels.flow}
          />
          {results.quality && (
            <ResultRow
              label={qualityLabel(results.quality)}
              value={nodeValueAt(results, 'quality', stepIndex, node.id)}
              unit={qualityUnit(results.quality)}
              digits={3}
            />
          )}
          {node.type === 'junction' && <SupplyContributions nodeId={node.id} />}
        </Section>
      )}
    </>
  );
}

function LinkEditor({ link, labels }: { link: NetworkLink; labels: UnitLabels }) {
  const updateLink = useNetworkStore((s) => s.updateLink);
  const renameLink = useNetworkStore((s) => s.renameLink);
  const reverseLink = useNetworkStore((s) => s.reverseLink);
  const setPipeAutoLength = useNetworkStore((s) => s.setPipeAutoLength);
  const headloss = useNetworkStore((s) => s.model.options.headloss);
  const flowUnits = useNetworkStore((s) => s.model.options.flowUnits);
  const select = useUIStore((s) => s.select);
  const pushToast = useUIStore((s) => s.pushToast);
  const results = useSimulationStore((s) => s.results);
  const stepIndex = useSimulationStore((s) => s.stepIndex);
  const curveOptions = useCurveOptions(link.type === 'pump' ? link.headCurve : '');
  const patternOptions = usePatternOptions(link.type === 'pump' ? link.pattern : '');
  const patch = (value: Partial<NetworkLink>) => updateLink(link.id, value);

  return (
    <>
      <Section title={LINK_TYPE_LABEL[link.type]}>
        <FieldRow label="ID">
          <TextField
            value={link.id}
            onCommit={(next) => {
              if (!renameLink(link.id, next)) {
                pushToast({ level: 'warning', title: 'ID 를 바꿀 수 없습니다', message: '이미 있는 ID 이거나 공백·31자 초과 등 허용되지 않는 형식입니다.' });
                return false;
              }
              select({ kind: 'link', id: next });
              return true;
            }}
          />
        </FieldRow>
        <FieldRow label="시점 → 종점" plain>
          <div className="flex min-w-0 items-center gap-1.5">
            <button type="button" className="truncate text-xs text-accent hover:underline" onClick={() => select({ kind: 'node', id: link.startNodeId })}>
              {link.startNodeId}
            </button>
            <span className="text-ink-muted">→</span>
            <button type="button" className="truncate text-xs text-accent hover:underline" onClick={() => select({ kind: 'node', id: link.endNodeId })}>
              {link.endNodeId}
            </button>
            <button type="button" title="방향 뒤집기" className="ml-auto text-ink-muted hover:text-ink" onClick={() => reverseLink(link.id)}>
              <ArrowLeftRight size={14} />
            </button>
          </div>
        </FieldRow>

        {link.type === 'pipe' && (
          <>
            <FieldRow label="연장" unit={labels.length}>
              <NumberField value={link.length} min={0} onCommit={(length) => patch({ length })} />
            </FieldRow>
            <label className="flex items-center gap-2 py-1 pl-[100px] text-[11px] text-ink-soft">
              <input
                type="checkbox"
                className="accent-accent"
                checked={!link.isCustomLength}
                onChange={(event) => setPipeAutoLength(link.id, event.target.checked)}
              />
              형상에서 자동 계산
            </label>
            <FieldRow label="관경" unit={labels.diameter}>
              <NumberField value={link.diameter} min={0} onCommit={(diameter) => patch({ diameter })} />
            </FieldRow>
            <FieldRow label={roughnessLabel(headloss, flowUnits)}>
              <NumberField value={link.roughness} min={0} onCommit={(roughness) => patch({ roughness })} />
            </FieldRow>
            <FieldRow label="부차손실계수">
              <NumberField value={link.minorLoss} min={0} onCommit={(minorLoss) => patch({ minorLoss })} />
            </FieldRow>
            <FieldRow label="초기 상태">
              <SelectField value={link.status} options={STATUS_OPTIONS} onChange={(status) => patch({ status })} />
            </FieldRow>
            <FieldRow label="꺾임점">
              <ReadonlyValue>{link.vertices.length}개</ReadonlyValue>
            </FieldRow>
          </>
        )}

        {link.type === 'pump' && (
          <>
            <FieldRow label="양정 곡선">
              <SelectField value={link.headCurve} options={curveOptions} onChange={(headCurve) => patch({ headCurve })} />
            </FieldRow>
            <FieldRow label="정동력" unit={labels.power}>
              <NumberField value={link.power} min={0} disabled={link.headCurve !== ''} onCommit={(power) => patch({ power })} />
            </FieldRow>
            <FieldRow label="회전수 비">
              <NumberField value={link.speed} min={0} onCommit={(speed) => patch({ speed })} />
            </FieldRow>
            <FieldRow label="운전 패턴">
              <SelectField value={link.pattern} options={patternOptions} onChange={(pattern) => patch({ pattern })} />
            </FieldRow>
            <p className="mt-1 text-[11px] text-ink-muted">양정 곡선이 없으면 정동력(POWER)으로 해석합니다.</p>
          </>
        )}

        {link.type === 'valve' && (
          <>
            <FieldRow label="종류">
              <SelectField value={link.valveType} options={VALVE_OPTIONS} onChange={(valveType) => patch({ valveType })} />
            </FieldRow>
            <FieldRow label="관경" unit={labels.diameter}>
              <NumberField value={link.diameter} min={0} onCommit={(diameter) => patch({ diameter })} />
            </FieldRow>
            <FieldRow label="설정값">
              <TextField value={link.setting} onCommit={(setting) => patch({ setting: setting || '0' })} />
            </FieldRow>
            <FieldRow label="부차손실계수">
              <NumberField value={link.minorLoss} min={0} onCommit={(minorLoss) => patch({ minorLoss })} />
            </FieldRow>
          </>
        )}
      </Section>

      {results && (
        <Section title="해석 결과" action={<ResultsHeader />}>
          <ResultRow label="유량" value={linkValueAt(results, 'flow', stepIndex, link.id)} unit={labels.flow} />
          <ResultRow label="유속" value={linkValueAt(results, 'velocity', stepIndex, link.id)} unit={labels.velocity} />
          <ResultRow label="손실수두" value={linkValueAt(results, 'headloss', stepIndex, link.id)} unit={labels.headloss} />
          {link.type === 'pipe' && (
            <ResultRow label="단위 손실수두" value={linkValueAt(results, 'unitHeadloss', stepIndex, link.id)} unit={labels.unitHeadloss} />
          )}
          {results.quality && (
            <ResultRow
              label={qualityLabel(results.quality)}
              value={linkValueAt(results, 'quality', stepIndex, link.id)}
              unit={qualityUnit(results.quality)}
              digits={3}
            />
          )}
        </Section>
      )}
    </>
  );
}

function ProjectSummary({ labels }: { labels: UnitLabels }) {
  const model = useNetworkStore((s) => s.model);
  const summary = useMemo(() => {
    let demand = 0;
    let junctions = 0;
    let length = 0;
    for (const id in model.nodes) {
      const node = model.nodes[id];
      if (node.type === 'junction') {
        junctions++;
        demand += node.demand;
      }
    }
    for (const id in model.links) {
      const link = model.links[id];
      if (link.type === 'pipe') length += link.length;
    }
    return { demand, junctions, length };
  }, [model.nodes, model.links]);

  return (
    <>
      <Section title="프로젝트">
        <p className="mb-2 break-words text-xs text-ink">{model.title[0] ?? '(제목 없음)'}</p>
        {model.title.slice(1).map((line, index) => (
          <p key={index} className="break-words text-[11px] text-ink-muted">
            {line}
          </p>
        ))}
      </Section>
      <Section title="요약">
        <ResultRow label="절점" value={summary.junctions} unit="개" digits={0} />
        <ResultRow label="링크" value={Object.keys(model.links).length} unit="개" digits={0} />
        <ResultRow label="총 관로 연장" value={summary.length} unit={labels.length} digits={0} />
        <ResultRow label="기본 수요량 합계" value={summary.demand} unit={labels.flow} />
        <ResultRow label="모의 시간" value={model.times.duration / 3600} unit="시간" digits={1} />
        <div className="flex items-baseline justify-between py-0.5 text-xs">
          <span className="text-ink-soft">손실수두 공식</span>
          <span className="text-ink">{model.options.headloss}</span>
        </div>
      </Section>
      <div className="px-3 py-3 text-[11px] leading-relaxed text-ink-muted">
        지도에서 절점이나 관로를 클릭하면 속성을 편집할 수 있습니다. 절점은 선택 도구로 끌어서 옮길 수 있고, 연결된 관로의 연장이 자동으로 다시 계산됩니다.
      </div>
    </>
  );
}

/** 우측 패널: 선택한 절점/관로의 속성 편집 폼과 현재 시간대 해석 결과. */
export function RightPropertyPanel() {
  const selection = useUIStore((s) => s.selection);
  const multi = useUIStore((s) => s.multiSelection);
  const node = useNetworkStore((s) => (selection?.kind === 'node' ? s.model.nodes[selection.id] : undefined));
  const link = useNetworkStore((s) => (selection?.kind === 'link' ? s.model.links[selection.id] : undefined));
  const flowUnits = useNetworkStore((s) => s.model.options.flowUnits);
  const labels = useMemo(() => unitLabels(flowUnits), [flowUnits]);

  if (multi) {
    return (
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-line bg-panel">
        <MultiSelectionPanel multi={multi} />
      </aside>
    );
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-line bg-panel">
      {node ? (
        <NodeEditor key={`node:${node.id}`} node={node} labels={labels} />
      ) : link ? (
        <LinkEditor key={`link:${link.id}`} link={link} labels={labels} />
      ) : (
        <ProjectSummary labels={labels} />
      )}
      {(node || link) && (
        <div className="mt-auto border-t border-line p-3">
          <Button variant="danger" className="w-full" onClick={deleteSelection}>
            <Trash size={13} />
            {node ? '절점 삭제 (연결 링크 포함)' : '링크 삭제'}
          </Button>
        </div>
      )}
    </aside>
  );
}
