/**
 * 상수: 수용가 CSV · 건물 SHP · 지도(OpenStreetMap) 건물로 절점 기본 수요량 넣기.
 * 파일 읽기는 app/sewageImport.ts(하수와 같은 형식), 배분은 core/model/buildingEstimate.ts.
 */
import { Building2, Download, FileUp, LoaderCircle, Map as MapIcon } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { DATA_GO_KR_KEY, registerHouseholdsAlong } from '../../app/buildingRegister';
import { fetchOsmBuildings } from '../../app/osmBuildings';
import { linkPath } from '../../core/model/networkEdit';
import { readSewageFiles } from '../../app/sewageImport';
import { assignWaterDemand, DEFAULT_WATER_DEMAND, estimateBuildings, type DemandSource, type WaterDemandOptions } from '../../core/model/buildingEstimate';
import { m3dToFlowUnits } from '../../core/model/landUse';
import { xyToLngLat } from '../../core/sewer/mapFrame';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useUIStore } from '../../store/useUIStore';
import { downloadText } from '../../utils/files';
import { Button, NumberField } from '../ui/fields';
import { Modal } from '../ui/Modal';

const CRS_CHOICES = [
  ['auto', '자동 (.prj 또는 좌표 범위)'],
  ['EPSG:5186', 'EPSG:5186 중부원점'],
  ['EPSG:5187', 'EPSG:5187 동부원점'],
  ['EPSG:5185', 'EPSG:5185 서부원점'],
  ['EPSG:5188', 'EPSG:5188 동해원점'],
  ['EPSG:5179', 'EPSG:5179 UTM-K'],
  ['wgs84', 'WGS84 경위도'],
] as const;

export function WaterDemandModal() {
  const model = useNetworkStore((s) => s.model);
  const close = () => useUIStore.getState().openModal(null);
  const input = useRef<HTMLInputElement>(null);
  const [crs, setCrs] = useState<string>('auto');
  const [sources, setSources] = useState<DemandSource[] | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [fromMap, setFromMap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const hasVworld = useUIStore((u) => u.vworldKey !== '');
  const [error, setError] = useState<string | null>(null);
  const [o, setO] = useState<WaterDemandOptions>(DEFAULT_WATER_DEMAND);
  const units = model.options.flowUnits;

  const junctions = useMemo(
    () => Object.values(model.nodes).flatMap((n) => (n.type === 'junction' ? [{ id: n.id, position: n.position }] : [])),
    [model.nodes],
  );

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const loadFiles = (files: File[]) =>
    run(async () => {
      const d = await readSewageFiles(files, crs, null, []);
      const list = d.sources.map((s): DemandSource => ({ id: s.id, position: xyToLngLat({ kind: 'epsg' }, s.xy[0], s.xy[1]), demand: s.demand, households: s.households }));
      if (list.length === 0) throw new Error('수용가(CSV)·건물(SHP 점·면)을 읽지 못했습니다. 선(연결관)만 있는 SHP 는 상수 수요량에 쓰지 않습니다.');
      setSources(list);
      setLabels(d.labels);
      setFromMap(false);
    });

  /** 건축물대장(공공데이터포털) 세대수: 관로 주변 필지(브이월드 지적도)에 실제 세대수를 붙인다. */
  const loadRegister = () =>
    run(async () => {
      const paths = Object.values(model.links).flatMap((l) => (l.type === 'pipe' ? [linkPath(model, l)] : []));
      if (paths.length === 0) throw new Error('관로가 없습니다.');
      const r = await registerHouseholdsAlong(paths, setProgress);
      if (r.lots.length === 0) throw new Error('관로 주변 필지에서 건축물대장 건물을 찾지 못했습니다.');
      setSources(r.lots.map((l) => ({ id: l.pnu, position: l.center, households: l.households })));
      setLabels([r.label]);
      setFromMap(false);
      setProgress('');
    });

  const loadMap = () =>
    run(async () => {
      const { buildings, partsUsed } = await fetchOsmBuildings(junctions.map((j) => j.position), 100, (done, total) => setProgress(total > 1 ? `지도 건물 ${done}/${total} 구역` : ''));
      const est = estimateBuildings(buildings);
      if (est.items.length === 0) throw new Error('이 범위의 지도(OpenStreetMap)에 건물이 없습니다.');
      const c = est.byCategory;
      const fmt = (k: keyof typeof c) => `${k} ${c[k].count.toLocaleString()}동 ≈ ${Math.round(c[k].households).toLocaleString()}세대`;
      setSources(est.items.map((b) => ({ id: b.id, position: b.position, households: b.households })));
      setLabels([`지도(OpenStreetMap) 건물 ${est.items.length.toLocaleString()}동 — ${fmt('공동주택')}, ${fmt('단독주택')}, ${fmt('용도 미상')}, ${fmt('비주거')}(세대 환산) · 층수 자료 있는 건물 ${est.floorsKnown.toLocaleString()}동(${Math.round((est.floorsKnown / est.items.length) * 100)}%${partsUsed ? `, 건물 부분에서 ${partsUsed}동` : ''}), 나머지는 기본 층수`]);
      setFromMap(true);
    });

  const result = useMemo(() => (sources ? assignWaterDemand(junctions, sources, o) : null), [sources, junctions, o]);

  const apply = () => {
    if (!result) return;
    const per = new Map(result.perNode.map((r) => [r.id, r.m3day]));
    useNetworkStore.getState().commit((d) => {
      for (const n of Object.values(d.nodes)) if (n.type === 'junction') n.demand = Math.round(m3dToFlowUnits(per.get(n.id) ?? 0, d.options.flowUnits) * 10000) / 10000;
    });
    useUIStore.getState().pushToast({
      level: result.unassigned > 0 || fromMap ? 'warning' : 'success',
      title: `수요량 반영 — 절점 ${result.perNode.length.toLocaleString()}곳 · 일평균 ${Math.round(result.totalM3day).toLocaleString()} m³/일`,
      message: `${fromMap ? '지도 건물로 개략 추정한 값입니다(참고용). ' : ''}${result.unassigned ? `${o.maxDistance} m 안에 절점이 없어 뺀 ${result.unassigned}곳. ` : ''}시간 변동은 수요 패턴으로 주세요. Ctrl+Z 로 되돌릴 수 있습니다.`,
    });
    close();
  };

  const csv = () => {
    if (!result) return;
    const lines = [`절점,수용가·건물 수,세대수,일평균 사용량(m³/일),기본 수요량(${units})`];
    for (const r of result.perNode) lines.push([r.id, r.sources, Math.round(r.households * 10) / 10, r.m3day.toFixed(3), m3dToFlowUnits(r.m3day, units).toFixed(4)].join(','));
    downloadText('절점별_수요량.csv', String.fromCharCode(0xfeff) + lines.join('\n') + '\n', 'text/csv;charset=utf-8');
  };

  return (
    <Modal
      title="수용가·건물·지도로 절점 수요량 넣기"
      onClose={close}
      widthClass="w-[680px]"
      footer={
        <>
          {result && (
            <Button className="mr-auto" onClick={csv}>
              <Download size={12} /> 절점별 CSV
            </Button>
          )}
          <Button onClick={close}>취소</Button>
          <Button variant="primary" disabled={!result || result.perNode.length === 0} onClick={apply}>
            관망에 적용
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-xs">
        {junctions.length === 0 && <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">절점(Junction)이 없습니다. 관망을 먼저 여세요.</p>}
        <section>
          <h3 className="mb-1 font-semibold text-ink">자료</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy} onClick={() => input.current?.click()}>
              <FileUp size={12} /> 수용가 CSV · 건물 SHP 고르기
            </Button>
            <Button
              variant="primary"
              disabled={busy || junctions.length === 0 || !DATA_GO_KR_KEY || !hasVworld}
              onClick={() => void loadRegister()}
              title="관로 주변 필지의 건축물대장(공공데이터포털) 세대수·가구수를 받아 씁니다 — 브이월드 지적도와 함께 씁니다"
            >
              <Building2 size={12} /> 건축물대장 세대수 (정확)
            </Button>
            <Button disabled={busy || junctions.length === 0} onClick={() => void loadMap()} title="자료가 없을 때: 지도(OpenStreetMap) 건물 외곽선·층수·용도로 세대수를 개략 추정합니다">
              <MapIcon size={12} /> 지도에서 건물 읽기 (개략)
            </Button>
            <select className="rounded border border-line bg-raised px-2 py-1 text-ink" value={crs} onChange={(e) => setCrs(e.target.value)} title="CSV 와 .prj 없는 SHP 의 좌표계">
              {CRS_CHOICES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            {busy && <LoaderCircle size={14} className="animate-spin text-ink-muted" />}
            {busy && progress && <span className="text-[11px] text-ink-muted">{progress}</span>}
          </div>
          <input
            ref={input}
            type="file"
            multiple
            accept=".csv,.txt,.tsv,.shp,.dbf,.prj,.cpg,.shx,.zip"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) void loadFiles(files);
            }}
          />
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] text-ink-muted">
            <li><b className="text-ink-soft">수용가 대장 CSV</b>: X·Y(또는 경도·위도) + 사용량(월·일) 또는 세대수 — 가장 정확합니다.</li>
            <li><b className="text-ink-soft">건물 SHP</b>(점·면): 세대수 열이 있으면 씁니다.</li>
            <li><b className="text-ink-soft">건축물대장 세대수</b>: 수용가 대장이 없을 때 가장 좋은 방법 — 관로 주변 필지의 건축물대장(공동주택 세대수, 단독·다가구 가구수, 상가 등은 연면적 환산)을 받아 씁니다. 공개 사이트에서 됩니다.</li>
            <li><b className="text-ink-soft">지도에서 건물 읽기</b>: 자료가 하나도 없을 때 참고용 — OpenStreetMap 건물 면적·층수·용도로 세대수를 개략 추정합니다(정확도 낮음, 빠진 건물 있음).</li>
          </ul>
          {labels.length > 0 && (
            <div className="mt-2 space-y-0.5 text-[11px] text-ink-soft">
              {labels.map((l) => (
                <p key={l}>{l}</p>
              ))}
              {fromMap && <p className="text-amber-300">지도 건물로 추정한 세대수입니다. 아파트 층수·용도가 없는 건물은 기본값(아파트 12층, 그 밖 2층, 세대당 연면적 100 m²)으로 계산해 실제와 크게 다를 수 있습니다.</p>}
            </div>
          )}
          {error && <p className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-red-300">{error}</p>}
        </section>

        <section>
          <h3 className="mb-1 font-semibold text-ink">원단위 (사용량이 없는 수용가·건물에 씀)</h3>
          <div className="grid grid-cols-4 gap-2">
            {(
              [
                ['personsPerHousehold', '세대당 인원 (인)', 0.1],
                ['litersPerCapita', '1인 1일 급수량 (L)', 10],
                ['defaultHouseholds', '자료 없을 때 세대수', 1],
                ['maxDistance', '절점 찾는 거리 (m)', 10],
              ] as const
            ).map(([key, label, step]) => (
              <label key={key}>
                <span className="text-[11px] text-ink-muted">{label}</span>
                <NumberField value={o[key]} min={0} step={step} onCommit={(v) => setO((p) => ({ ...p, [key]: Math.max(0.01, v) }))} />
              </label>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-ink-muted">기본 수요량은 일평균으로 넣습니다. 시간 변동은 수요 패턴, 시간최대 검토는 아래 ‘시간최대계수’ 탭을 쓰세요. 원단위는 예시이니 수도정비기본계획 값으로 바꾸세요.</p>
        </section>

        {result && (
          <section>
            <h3 className="mb-1 font-semibold text-ink">
              결과 — 절점 {result.perNode.length.toLocaleString()}곳 · 일평균 {result.totalM3day.toLocaleString(undefined, { maximumFractionDigits: 1 })} m³/일 ({m3dToFlowUnits(result.totalM3day, units).toFixed(2)} {units})
            </h3>
            <p className="text-[11px] text-ink-muted">
              배분 {result.assigned.toLocaleString()}
              {result.unassigned > 0 && ` · 절점이 멀어 뺀 ${result.unassigned.toLocaleString()}`}
              {result.defaulted > 0 && ` · 사용량·세대수 없어 기본 세대수 ${result.defaulted.toLocaleString()}`}
            </p>
            <div className="mt-1 max-h-40 overflow-y-auto rounded border border-line">
              <table className="w-full tabular-nums">
                <thead className="sticky top-0 bg-panel text-left text-[11px] text-ink-muted">
                  <tr>
                    <th className="px-2 py-1">절점</th>
                    <th className="px-2 py-1 text-right">수용가·건물</th>
                    <th className="px-2 py-1 text-right">세대</th>
                    <th className="px-2 py-1 text-right">m³/일</th>
                    <th className="px-2 py-1 text-right">{units}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.perNode.slice(0, 200).map((r) => (
                    <tr key={r.id} className="border-t border-line/60">
                      <td className="px-2 py-0.5 text-ink">{r.id}</td>
                      <td className="px-2 text-right">{r.sources}</td>
                      <td className="px-2 text-right">{Math.round(r.households * 10) / 10}</td>
                      <td className="px-2 text-right">{r.m3day.toFixed(2)}</td>
                      <td className="px-2 text-right">{m3dToFlowUnits(r.m3day, units).toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">‘관망에 적용’은 모든 절점의 기본 수요량을 이 값으로 바꿉니다(배분이 없는 절점은 0, 실행 취소 가능). 수요 패턴은 그대로 둡니다.</p>
          </section>
        )}
      </div>
    </Modal>
  );
}
