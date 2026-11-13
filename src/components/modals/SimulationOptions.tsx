import { Play, Plus, Trash, TriangleExclamationPoint } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { runSimulation } from '../../app/actions';
import { patternUsageCount, renamePattern } from '../../core/model/curvesControls';
import type { QualityMode } from '../../core/model/types';
import { defaultRoughness, FLOW_UNIT_OPTIONS, HEADLOSS_OPTIONS, isUsUnits } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useUIStore } from '../../store/useUIStore';
import { Button, NumberField, SelectField, TextField } from '../ui/fields';
import { Modal } from '../ui/Modal';

/** 일반적인 생활용수 일 변동 패턴 (1시간 간격 24개). */
const DAY_PATTERN = [0.55, 0.45, 0.4, 0.4, 0.5, 0.75, 1.1, 1.45, 1.5, 1.3, 1.15, 1.1, 1.15, 1.1, 1.0, 0.95, 1.0, 1.15, 1.4, 1.5, 1.35, 1.1, 0.85, 0.65];

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, unit, hint, children }: { label: string; unit?: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[150px_150px_1fr] items-center gap-3 py-0.5">
      <span className="text-xs text-ink-soft">
        {label}
        {unit && <span className="ml-1 text-ink-muted">{unit}</span>}
      </span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-ink-muted">{hint}</span>}
    </label>
  );
}

function Note({ tone = 'muted', children }: { tone?: 'muted' | 'warn'; children: ReactNode }) {
  if (tone === 'warn') {
    return (
      <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink">
        <TriangleExclamationPoint size={13} className="mt-px shrink-0 text-warn" />
        {children}
      </p>
    );
  }
  return <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">{children}</p>;
}

/** 패턴 배율을 막대로 보여 주는 작은 미리보기. */
function PatternBars({ values }: { values: number[] }) {
  const width = 120;
  const height = 28;
  const max = Math.max(...values, 1e-9);
  const step = width / Math.max(values.length, 1);
  return (
    <svg width={width} height={height} role="img" aria-label="패턴 배율 미리보기" className="shrink-0">
      {values.map((value, index) => {
        const barHeight = Math.max(1, (value / max) * (height - 2));
        return <rect key={index} x={index * step + 0.5} y={height - barHeight} width={Math.max(1, step - 1)} height={barHeight} rx={1} fill="#3987e5" />;
      })}
      <line x1={0} y1={height - 0.5} x2={width} y2={height - 0.5} stroke="#3a4350" strokeWidth={1} />
    </svg>
  );
}

function PatternRow({ id, values, demandJunctions }: { id: string; values: number[]; demandJunctions: number }) {
  const commit = useNetworkStore((s) => s.commit);
  const usage = useNetworkStore((s) => patternUsageCount(s.model, id));
  const [draft, setDraft] = useState(values.join(' '));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(values.join(' '));
    setInvalid(false);
  }, [values]);

  const apply = () => {
    const parsed = draft
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (parsed.length === 0 || parsed.some((value) => !Number.isFinite(value) || value < 0)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed.length === values.length && parsed.every((value, index) => value === values[index])) {
      setDraft(values.join(' '));
      return;
    }
    commit((draftModel) => {
      draftModel.patterns[id] = parsed;
    });
  };

  const assignToAll = () =>
    commit((draftModel) => {
      for (const nodeId in draftModel.nodes) {
        const node = draftModel.nodes[nodeId];
        if (node.type === 'junction' && node.demand > 0) node.pattern = id;
      }
    });

  const remove = () =>
    commit((draftModel) => {
      delete draftModel.patterns[id];
      for (const nodeId in draftModel.nodes) {
        const node = draftModel.nodes[nodeId];
        if (node.type !== 'tank' && node.pattern === id) node.pattern = '';
      }
      for (const linkId in draftModel.links) {
        const link = draftModel.links[linkId];
        if (link.type === 'pump' && link.pattern === id) link.pattern = '';
      }
    });

  const average = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

  return (
    <li className="rounded-md border border-line bg-raised/50 p-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="w-32">
            <TextField
              value={id}
              onCommit={(next) => {
                let ok = false;
                commit((draftModel) => {
                  ok = renamePattern(draftModel, id, next);
                });
                return ok;
              }}
            />
          </div>
          <p className="mt-0.5 text-[11px] tabular-nums text-ink-muted">
            {values.length}개 구간 · 평균 {average.toFixed(2)} · 사용 {usage}곳
          </p>
        </div>
        <PatternBars values={values} />
        <Button onClick={assignToAll} disabled={demandJunctions === 0} title={`수요량이 있는 절점 ${demandJunctions.toLocaleString()}개에 이 패턴을 지정합니다`}>
          모든 수요 절점에 적용
        </Button>
        <button
          type="button"
          aria-label={`패턴 ${id} 삭제`}
          title="패턴 삭제 (참조하는 절점·펌프의 패턴 지정도 함께 해제)"
          onClick={remove}
          className="rounded p-1.5 text-ink-muted transition-colors hover:bg-critical/20 hover:text-[#f3a5a5]"
        >
          <Trash size={14} />
        </button>
      </div>
      <input
        type="text"
        aria-label={`패턴 ${id} 배율`}
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        className={`mt-2 h-7 w-full rounded border bg-field px-2 font-mono text-[11px] text-ink outline-none transition-colors focus:border-accent ${
          invalid ? 'border-critical' : 'border-line'
        }`}
      />
      {invalid && <p className="mt-1 text-[11px] text-[#f3a5a5]">0 이상의 숫자를 공백이나 쉼표로 구분해 입력하세요.</p>}
    </li>
  );
}

function AdvancedOptions({ lines }: { lines: string[] }) {
  const commit = useNetworkStore((s) => s.commit);
  const [text, setText] = useState(lines.join('\n'));
  const [dropped, setDropped] = useState(0);
  useEffect(() => setText(lines.join('\n')), [lines]);

  const apply = () => {
    const entered = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const kept = entered.filter((line) => !/^(units|headloss)\b/i.test(line));
    setDropped(entered.length - kept.length);
    if (kept.length === lines.length && kept.every((line, index) => line === lines[index])) {
      setText(lines.join('\n'));
      return;
    }
    commit((draftModel) => {
      draftModel.options.extra = kept;
    });
  };

  return (
    <>
      <textarea
        aria-label="EPANET OPTIONS 원문"
        spellCheck={false}
        rows={Math.min(8, Math.max(3, lines.length + 1))}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={apply}
        className="w-full resize-y rounded border border-line bg-field px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink outline-none transition-colors focus:border-accent"
      />
      <Note>EPANET [OPTIONS] 원문 줄입니다 (예: Accuracy 0.001, Unbalanced Continue 10). Units 와 Headloss 는 위 항목에서 설정하세요.</Note>
      {dropped > 0 && <Note tone="warn">Units / Headloss 줄 {dropped}개는 위 항목과 겹쳐 제외했습니다.</Note>}
    </>
  );
}

const QUALITY_MODE_OPTIONS: { value: QualityMode; label: string }[] = [
  { value: 'NONE', label: '수질 해석 안 함' },
  { value: 'CHEMICAL', label: '물질 농도 (잔류염소 등)' },
  { value: 'AGE', label: '수령 (체류시간)' },
  { value: 'TRACE', label: '수원 추적 (기여율)' },
];
const CHEM_UNIT_OPTIONS = [
  { value: 'mg/L', label: 'mg/L' },
  { value: 'ug/L', label: 'µg/L' },
];

function QualityGroup() {
  const quality = useNetworkStore((s) => s.model.options.quality);
  const reactions = useNetworkStore((s) => s.model.options.reactions);
  const qualityStep = useNetworkStore((s) => s.model.times.qualityStep);
  const nodes = useNetworkStore((s) => s.model.nodes);
  const commit = useNetworkStore((s) => s.commit);
  const [sourceConc, setSourceConc] = useState(1.0);

  const sourceNodes = useMemo(() => Object.values(nodes).filter((n) => n.type !== 'junction'), [nodes]);
  const traceOptions = useMemo(() => {
    const options = [{ value: '', label: '(선택)' }, ...sourceNodes.map((n) => ({ value: n.id, label: n.id }))];
    if (quality.traceNode && !sourceNodes.some((n) => n.id === quality.traceNode)) {
      options.push({ value: quality.traceNode, label: quality.traceNode in nodes ? quality.traceNode : `${quality.traceNode} (없음)` });
    }
    return options;
  }, [sourceNodes, quality.traceNode, nodes]);
  const currentSourceConc = sourceNodes.length > 0 ? (sourceNodes[0].initQuality ?? 0) : 0;

  return (
    <Group title="수질 해석">
      <Row label="해석 종류">
        <SelectField
          value={quality.mode}
          options={QUALITY_MODE_OPTIONS}
          onChange={(mode) =>
            commit((draft) => {
              draft.options.quality.mode = mode;
              if (mode === 'TRACE' && !draft.options.quality.traceNode && sourceNodes[0]) draft.options.quality.traceNode = sourceNodes[0].id;
            })
          }
        />
      </Row>
      {quality.mode === 'CHEMICAL' && (
        <>
          <Row label="물질 이름" hint="Chlorine 이면 잔류염소 기준(0.1~4.0 mg/L)으로 색을 칠합니다">
            <TextField
              value={quality.chemName}
              onCommit={(chemName) =>
                commit((draft) => {
                  draft.options.quality.chemName = chemName.replace(/\s+/g, '_') || 'Chlorine';
                })
              }
            />
          </Row>
          <Row label="농도 단위">
            <SelectField
              value={quality.chemUnits}
              options={CHEM_UNIT_OPTIONS}
              onChange={(chemUnits) =>
                commit((draft) => {
                  draft.options.quality.chemUnits = chemUnits;
                })
              }
            />
          </Row>
          <Row label="체적 반응계수" unit="1/일" hint="염소 감소는 음수 (일반적으로 -0.1 ~ -1.5)">
            <NumberField
              value={reactions.globalBulk}
              onCommit={(globalBulk) =>
                commit((draft) => {
                  draft.options.reactions.globalBulk = globalBulk;
                })
              }
            />
          </Row>
          <Row label="관벽 반응계수" unit="m/일" hint="관 노후·재질에 따른 소모 (음수)">
            <NumberField
              value={reactions.globalWall}
              onCommit={(globalWall) =>
                commit((draft) => {
                  draft.options.reactions.globalWall = globalWall;
                })
              }
            />
          </Row>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-ink-soft">수원지·배수지 초기 농도</span>
            <div className="w-24">
              <NumberField value={sourceConc} min={0} onCommit={setSourceConc} />
            </div>
            <Button
              disabled={sourceNodes.length === 0}
              onClick={() =>
                commit((draft) => {
                  for (const node of sourceNodes) {
                    const target = draft.nodes[node.id];
                    if (target) target.initQuality = sourceConc;
                  }
                })
              }
            >
              {sourceNodes.length}곳에 일괄 적용
            </Button>
          </div>
          <Note>
            현재 첫 수원 농도: {currentSourceConc} {quality.chemUnits}. 절점별 초기 농도와 재염소 투입(유입원)은 우측 속성 패널에서 지정합니다.
          </Note>
        </>
      )}
      {quality.mode === 'AGE' && <Note>수원에서 공급된 물이 각 지점까지 도달하는 데 걸린 시간을 계산합니다. 수령은 시간이 지나며 안정되므로 모의시간을 48시간 이상으로 두는 것이 좋습니다.</Note>}
      {quality.mode === 'TRACE' && (
        <>
          <Row label="추적 대상 절점">
            <SelectField
              value={quality.traceNode}
              options={traceOptions}
              onChange={(traceNode) =>
                commit((draft) => {
                  draft.options.quality.traceNode = traceNode;
                })
              }
            />
          </Row>
          <Note>각 지점에 공급되는 물 중 대상 절점에서 온 물의 비율(%)을 계산합니다. 여러 수원의 급수 구역 경계를 확인할 때 씁니다.</Note>
          {!quality.traceNode && <Note tone="warn">추적 대상 절점을 선택해야 해석할 수 있습니다.</Note>}
        </>
      )}
      {quality.mode !== 'NONE' && (
        <Row label="수질 계산 간격" unit="분">
          <NumberField
            value={qualityStep / 60}
            min={0.1}
            step={1}
            onCommit={(minutes) =>
              commit((draft) => {
                draft.times.qualityStep = Math.max(1, Math.round(minutes * 60));
              })
            }
          />
        </Row>
      )}
    </Group>
  );
}

function SimulationDialog() {
  const options = useNetworkStore((s) => s.model.options);
  const times = useNetworkStore((s) => s.model.times);
  const patterns = useNetworkStore((s) => s.model.patterns);
  const nodes = useNetworkStore((s) => s.model.nodes);
  const links = useNetworkStore((s) => s.model.links);
  const commit = useNetworkStore((s) => s.commit);
  const [unitSystemChanged, setUnitSystemChanged] = useState(false);

  const roughnessDefault = defaultRoughness(options.headloss);
  const { pipeCount, pipesOffDefault } = useMemo(() => {
    let total = 0;
    let off = 0;
    for (const id in links) {
      const link = links[id];
      if (link.type !== 'pipe') continue;
      total++;
      if (link.roughness !== roughnessDefault) off++;
    }
    return { pipeCount: total, pipesOffDefault: off };
  }, [links, roughnessDefault]);
  const demandJunctions = useMemo(() => {
    let count = 0;
    for (const id in nodes) {
      const node = nodes[id];
      if (node.type === 'junction' && node.demand > 0) count++;
    }
    return count;
  }, [nodes]);

  const patternIds = Object.keys(patterns);
  const reportedSteps = times.reportStep > 0 ? Math.floor(times.duration / times.reportStep) + 1 : 1;
  const close = () => useUIStore.getState().openModal(null);

  const addDayPattern = () =>
    commit((draft) => {
      let id = 'DAY';
      for (let n = 2; id in draft.patterns; n++) id = `DAY${n}`;
      draft.patterns[id] = [...DAY_PATTERN];
    });

  return (
    <Modal
      title="해석 옵션"
      onClose={close}
      widthClass="w-[680px]"
      footer={
        <>
          <Button onClick={close}>닫기</Button>
          <Button
            variant="primary"
            onClick={() => {
              close();
              void runSimulation();
            }}
          >
            <Play size={13} />
            해석 실행
          </Button>
        </>
      }
    >
      <Group title="수리 계산">
        <Row label="유량 단위">
          <SelectField
            value={options.flowUnits}
            options={FLOW_UNIT_OPTIONS}
            onChange={(value) => {
              if (isUsUnits(value) !== isUsUnits(options.flowUnits)) setUnitSystemChanged(true);
              commit((draft) => {
                draft.options.flowUnits = value;
              });
            }}
          />
        </Row>
        {unitSystemChanged && <Note tone="warn">단위계를 바꿔도 기존 입력 값(연장·관경·표고·수요량)은 환산되지 않습니다.</Note>}
        <Row label="손실수두 공식">
          <SelectField
            value={options.headloss}
            options={HEADLOSS_OPTIONS}
            onChange={(value) =>
              commit((draft) => {
                draft.options.headloss = value;
              })
            }
          />
        </Row>
        <Note>공식을 바꾸면 조도계수의 의미가 달라집니다 (H-W: C, D-W: ε, C-M: n).</Note>
        <div className="mt-2 flex items-center gap-2">
          <Button
            disabled={pipesOffDefault === 0}
            onClick={() =>
              commit((draft) => {
                for (const id in draft.links) {
                  const link = draft.links[id];
                  if (link.type === 'pipe') link.roughness = roughnessDefault;
                }
              })
            }
          >
            모든 관로 조도계수를 기본값({roughnessDefault})으로
          </Button>
          <span className="text-[11px] tabular-nums text-ink-muted">
            관로 {pipeCount.toLocaleString()}개 중 {pipesOffDefault.toLocaleString()}개가 바뀝니다.
          </span>
        </div>
      </Group>

      <Group title="모의 시간">
        <Row label="총 모의시간" unit="시간" hint="0 이면 정상상태(단일 시점) 해석">
          <NumberField
            value={times.duration / 3600}
            min={0}
            step={1}
            onCommit={(hours) =>
              commit((draft) => {
                draft.times.duration = Math.round(hours * 3600);
              })
            }
          />
        </Row>
        <Row label="수리 계산 간격" unit="분">
          <NumberField
            value={times.hydraulicStep / 60}
            min={1}
            step={5}
            onCommit={(minutes) =>
              commit((draft) => {
                draft.times.hydraulicStep = Math.round(minutes * 60);
              })
            }
          />
        </Row>
        <Row label="패턴 간격" unit="분" hint="수요 패턴 배율 한 칸의 길이">
          <NumberField
            value={times.patternStep / 60}
            min={1}
            step={5}
            onCommit={(minutes) =>
              commit((draft) => {
                draft.times.patternStep = Math.round(minutes * 60);
              })
            }
          />
        </Row>
        <Row label="보고 간격" unit="분" hint={`결과 ${reportedSteps.toLocaleString()}개 시간 스텝`}>
          <NumberField
            value={times.reportStep / 60}
            min={1}
            step={5}
            onCommit={(minutes) =>
              commit((draft) => {
                draft.times.reportStep = Math.round(minutes * 60);
              })
            }
          />
        </Row>
        <Row label="시작 시각" unit="시">
          <NumberField
            value={times.startClockTime / 3600}
            min={0}
            step={1}
            onCommit={(hours) =>
              commit((draft) => {
                draft.times.startClockTime = Math.round(Math.min(24, hours) * 3600);
              })
            }
          />
        </Row>
        <Note>보고·패턴 간격이 수리 계산 간격보다 짧으면 EPANET 이 계산 간격을 그에 맞춰 줄입니다.</Note>
      </Group>

      <QualityGroup />

      <Group title="수요 패턴">
        {patternIds.length === 0 ? (
          <Note>패턴이 없으면 모든 시간대의 수요가 같아 결과가 시간에 따라 변하지 않습니다.</Note>
        ) : (
          <ul className="space-y-2">
            {patternIds.map((id) => (
              <PatternRow key={id} id={id} values={patterns[id]} demandJunctions={demandJunctions} />
            ))}
          </ul>
        )}
        <div className="mt-2 flex gap-2">
          <Button onClick={addDayPattern}>
            <Plus size={13} />
            일 변동 패턴 추가
          </Button>
          <Button
            onClick={() =>
              commit((draft) => {
                let id = 'PAT1';
                for (let n = 2; id in draft.patterns; n++) id = `PAT${n}`;
                draft.patterns[id] = new Array(24).fill(1);
              })
            }
          >
            <Plus size={13} />
            빈 패턴 (1.0 × 24)
          </Button>
        </div>
      </Group>

      <Group title="고급 옵션">
        <AdvancedOptions lines={options.extra} />
      </Group>
    </Modal>
  );
}

/** 수리해석 공식·단위, 모의 시간, 수요 패턴 설정 대화상자. */
export function SimulationOptions() {
  const open = useUIStore((s) => s.modal === 'simulation');
  return open ? <SimulationDialog /> : null;
}
