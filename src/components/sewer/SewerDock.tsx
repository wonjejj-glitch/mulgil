/** 하수 모드 하단 도크: 종단도 · 검토 목록 · SWMM 해석 요약. */
import { Download, Map as MapIcon } from 'lucide-react';
import { useMemo } from 'react';
import { showSewerOnMap } from '../../app/sewerActions';
import { focusSewerObject } from '../../app/sewerMapActions';
import { buildNetwork } from '../../core/sewer/topology';
import { planDxf, profileDxf, profileStations, quantityCsv, quantityTakeoff } from '../../core/sewer/drawings';
import { downloadText } from '../../utils/files';
import { useSewerStore } from '../../store/useSewerStore';
import { useUIStore, type SewerBottomTab } from '../../store/useUIStore';
import { Button } from '../ui/fields';
import { SewerProfile, SewerReviewList, SewerSimulationSummary } from './SewerShared';
import { FloodPanel } from './FloodPanel';
import { GisAuditPanel } from './GisAuditPanel';

const TABS: { id: SewerBottomTab; label: string }[] = [
  { id: 'profile', label: '종단도' },
  { id: 'review', label: '검토 목록' },
  { id: 'simulation', label: 'SWMM 해석 요약' },
  { id: 'flood', label: '침수 해석' },
  { id: 'quantity', label: '수량 산출' },
  { id: 'audit', label: '자료 점검' },
];

const safeName = (s: string) => s.replace(/[/\\:*?"<>|\s]+/g, '_').slice(0, 60) || 'sewer';

function Empty({ children }: { children: string }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-xs leading-relaxed text-ink-muted">{children}</div>;
}

function ProfileTab() {
  const input = useSewerStore((s) => s.project);
  const design = useSewerStore((s) => s.design);
  const selection = useSewerStore((s) => s.selection);
  const simulation = useSewerStore((s) => s.simulation);
  // 설계가 있으면 설계한 관저고·관경으로 그린다
  const project = design?.project ?? input;
  const problem = useMemo(() => {
    try {
      buildNetwork(project);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, [project]);
  if (project.conduits.length === 0) return <Empty>맨홀과 방류구를 관거로 이으면 종단도가 그려집니다.</Empty>;
  if (problem) return <Empty>{`종단도를 그릴 수 없습니다 — ${problem}`}</Empty>;
  let start = '';
  if (selection?.kind === 'node') start = project.nodes.find((n) => n.id === selection.id && n.kind === 'JUNCTION')?.id ?? '';
  else if (selection?.kind === 'conduit') start = project.conduits.find((c) => c.id === selection.id)?.upstream ?? '';
  return (
    <div className="h-full overflow-y-auto px-3 pb-1">
      <SewerProfile project={project} start={start} onStart={(id) => focusSewerObject({ kind: 'node', id })} heightClass="h-40" className="mt-2" />
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            const hgl = simulation ? Object.fromEntries(Object.entries(simulation.node_summary).map(([id, n]) => [id, n.max_hgl])) : undefined;
            const stations = profileStations(project, start || undefined, hgl);
            downloadText(`${safeName(project.name)}_종단면도_${stations[0]?.id ?? ''}.dxf`, profileDxf(project, stations), 'application/dxf');
          }}
          title="지금 종단도(시작 맨홀 → 방류구)를 CAD 도면(DXF R12)으로 저장합니다: 지반고·관정·관저·맨홀·기입란·관경별 터파기 단면"
        >
          <Download size={12} /> 종단면도 DXF
        </Button>
        <Button onClick={() => downloadText(`${safeName(project.name)}_평면도_5186.dxf`, planDxf(project), 'application/dxf')} title="맨홀·관거·유역 평면도를 EPSG:5186 좌표 DXF 로 저장합니다 (관거 옆 관경·연장·경사)">
          <Download size={12} /> 평면도 DXF
        </Button>
      </div>
      <p className="text-[11px] text-ink-muted">
        지도에서 맨홀·관거를 고르면 그 지점부터 방류구까지 그립니다. {design ? '설계한 관저고·관경 기준입니다.' : '자동 설계 전이라 입력한 관저고·관경 기준입니다.'}
      </p>
    </div>
  );
}

function QuantityTab() {
  const input = useSewerStore((s) => s.project);
  const design = useSewerStore((s) => s.design);
  const rules = useSewerStore((s) => s.designRules);
  const q = useMemo(() => quantityTakeoff(input, design, rules.dropPipeAt ?? 0.6), [input, design, rules.dropPipeAt]);
  if (input.conduits.length === 0) return <Empty>관거를 그리면 관경별 연장·맨홀 규격별 개수·개략 토공량이 여기에 나옵니다.</Empty>;
  const cell = 'px-2 py-0.5 text-right tabular-nums';
  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto p-2 text-xs">
      <div className="min-w-44 shrink-0">
        <h3 className="font-semibold text-ink">관거</h3>
        <table className="mt-1 w-full">
          <thead className="text-ink-soft">
            <tr>
              <th className="px-2 text-left font-medium">관경</th>
              <th className="px-2 text-right font-medium">개소</th>
              <th className="px-2 text-right font-medium">연장 (m)</th>
            </tr>
          </thead>
          <tbody>
            {q.pipes.map((p) => (
              <tr key={p.diameter} className="border-t border-line/60">
                <td className="px-2 py-0.5 text-ink">D{Math.round(p.diameter * 1000)}</td>
                <td className={cell}>{p.count}</td>
                <td className={cell}>{p.length.toFixed(1)}</td>
              </tr>
            ))}
            <tr className="border-t border-line font-semibold text-ink">
              <td className="px-2 py-0.5">계</td>
              <td className={cell}>{q.pipes.reduce((s, p) => s + p.count, 0)}</td>
              <td className={cell}>{q.totalLength.toFixed(1)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="min-w-80 shrink-0">
        <h3 className="font-semibold text-ink">맨홀 (깊이 = 지반고 − 관저고)</h3>
        <table className="mt-1 w-full">
          <thead className="text-ink-soft">
            <tr>
              <th className="px-2 text-left font-medium">규격</th>
              {q.depthBins.map((b) => (
                <th key={b} className="whitespace-nowrap px-2 text-right font-medium">
                  {b}
                </th>
              ))}
              <th className="px-2 text-right font-medium">계</th>
            </tr>
          </thead>
          <tbody>
            {q.manholes.map((m) => (
              <tr key={m.type} className="border-t border-line/60">
                <td className="px-2 py-0.5 text-ink">{m.type}</td>
                {m.bins.map((n, i) => (
                  <td key={i} className={`${cell} ${n ? 'text-ink' : 'text-ink-muted'}`}>
                    {n}
                  </td>
                ))}
                <td className={`${cell} font-semibold text-ink`}>{m.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-[11px] text-ink-muted">
          방류구 {q.outfalls}개 · 부관(낙차) 맨홀 {q.drops}개{design ? '' : ' (자동 설계 후 집계)'} · 규격은 접속 최대 관경으로 고른 일반 예시(1호 D600 이하 …)
        </p>
      </div>
      <div className="w-60 shrink-0">
        <h3 className="font-semibold text-ink">개략 토공</h3>
        <table className="mt-1 w-full">
          <tbody>
            {(
              [
                ['터파기', q.earth.excavation, 'm³'],
                ['관 점유 체적', q.earth.pipeVolume, 'm³'],
                ['모래 기초', q.earth.bedding, 'm³'],
                ['되메우기', q.earth.backfill, 'm³'],
                ['잔토 처리', q.earth.surplus, 'm³'],
                ['포장 깨기·복구', q.earth.pavement, 'm²'],
              ] as const
            ).map(([label, v, unit]) => (
              <tr key={label} className="border-t border-line/60">
                <td className="px-2 py-0.5 text-ink-soft">{label}</td>
                <td className={cell}>{v.toFixed(1)}</td>
                <td className="px-1 text-ink-muted">{unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-[11px] text-ink-muted">터파기 폭 = 관경×1.2 + 0.6 m (최소 0.8 m), 기초 0.1 m, 수직 굴착 가정. 사업 표준도 기준으로 확인하세요.</p>
        <Button className="mt-1.5" onClick={() => downloadText(`${safeName(input.name)}_수량산출.csv`, `${String.fromCharCode(0xfeff)}${quantityCsv(q, input.name)}`, 'text/csv;charset=utf-8')}>
          <Download size={12} /> 수량 CSV
        </Button>
      </div>
    </div>
  );
}

export function SewerDock() {
  const tab = useUIStore((s) => s.sewerBottomTab);
  const setTab = useUIStore((s) => s.setSewerBottomTab);
  const collapsed = useUIStore((s) => s.bottomCollapsed);
  const setCollapsed = useUIStore((s) => s.setBottomCollapsed);
  const busy = useSewerStore((s) => s.busy);
  const design = useSewerStore((s) => s.design);
  const simulation = useSewerStore((s) => s.simulation);
  const engine = useSewerStore((s) => s.run?.engineVersion);
  const status = busy ?? (simulation ? `SWMM 해석 완료${engine ? ` (${engine})` : ''}` : design ? (design.feasible ? '자동 설계 완료 — 제약 만족' : `자동 설계 완료 — 위반 ${design.issues.length}건`) : '설계 결과 없음');
  return (
    <section className={`flex shrink-0 flex-col border-t border-line bg-panel ${collapsed ? 'h-10' : 'h-64'}`}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <div className="flex shrink-0 items-center" role="tablist">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id && !collapsed}
              onClick={() => setTab(item.id)}
              className={`inline-flex h-10 items-center border-b-2 px-3 text-xs transition-colors ${tab === item.id && !collapsed ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink-soft'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="mx-2 h-5 w-px shrink-0 bg-line" />
        <span className="truncate text-[11px] text-ink-muted">{status}</span>
        <button type="button" className="ml-auto shrink-0 rounded p-1 text-ink-muted hover:bg-raised hover:text-ink" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '펼치기' : '접기'}>
          {collapsed ? '▲' : '▼'}
        </button>
      </div>
      {!collapsed && (
        <div className="min-h-0 flex-1">
          {tab === 'profile' ? (
            <ProfileTab />
          ) : tab === 'review' ? (
            <div className="h-full overflow-y-auto p-2">
              <SewerReviewList
                showProfile={false}
                tableClass=""
                onPick={(row) => focusSewerObject({ kind: 'conduit', id: row.id })}
                emptyMessage="‘설계·해석 실행’(F5) 또는 우측 패널의 ‘자동 설계’를 누르면 관로별 검토 목록이 표시됩니다. 동수위 판정은 SWMM 해석 뒤에 나옵니다."
              />
            </div>
          ) : tab === 'flood' ? (
            <FloodPanel />
          ) : tab === 'quantity' ? (
            <QuantityTab />
          ) : tab === 'audit' ? (
            <GisAuditPanel />
          ) : !simulation ? (
            <Empty>‘설계·해석 실행’(F5)을 누르면 자동 설계한 관망을 SWMM 으로 해석해 월류·만관 초과·연속성 오차를 보여 줍니다.</Empty>
          ) : (
            <div className="h-full overflow-y-auto p-2">
              <div className="flex items-center gap-2">
                <Button onClick={showSewerOnMap} title="설계한 관망을 읽기 전용 SWMM 보기로 열어 시간대별 수심·유량을 봅니다. 닫으면 하수 편집 화면으로 돌아옵니다.">
                  <MapIcon size={13} />
                  시간대별 결과 보기 (SWMM 보기)
                </Button>
                <span className="text-[11px] text-ink-muted">맨홀 색: 초록 정상 · 주황 만관 초과 · 빨강 월류</span>
              </div>
              <SewerSimulationSummary className="mt-2" tableClass="" />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
