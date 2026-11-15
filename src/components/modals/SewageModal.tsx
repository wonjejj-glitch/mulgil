/** 수용가·건물·하수연결관으로 맨홀 오수 유입량 넣기. 읽기는 app/sewageImport.ts, 배분은 core/sewer/sewage.ts. */
import { Download, FileUp, LoaderCircle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { readSewageFiles, type SewageInput } from '../../app/sewageImport';
import { isGeoreferenced } from '../../core/sewer/mapFrame';
import { assignSewage, DEFAULT_SEWAGE, sewageCsv, sourcesFromConnections, type SewageOptions } from '../../core/sewer/sewage';
import { useSewerGisStore } from '../../store/useSewerGisStore';
import { useSewerStore } from '../../store/useSewerStore';
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

export function SewageModal() {
  const project = useSewerStore((s) => s.project);
  const gisCrs = useSewerGisStore((s) => s.data?.crs ?? null);
  const close = () => useUIStore.getState().openModal(null);
  const input = useRef<HTMLInputElement>(null);
  const [crs, setCrs] = useState<string>('auto');
  const [data, setData] = useState<SewageInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [o, setO] = useState<SewageOptions>(DEFAULT_SEWAGE);
  const set = (patch: Partial<SewageOptions>) => setO((prev) => ({ ...prev, ...patch }));
  const georef = isGeoreferenced(project);

  const load = async (files: File[]) => {
    setBusy(true);
    setError(null);
    try {
      const preferTm = gisCrs && /^EPSG:518[5-8]$/.test(gisCrs) ? gisCrs : null;
      setData(await readSewageFiles(files, crs, preferTm));
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onlyConnections = !!data && data.sources.length === 0 && data.connections.length > 0;
  const result = useMemo(() => {
    if (!data || !georef) return null;
    const sources = onlyConnections ? sourcesFromConnections(project, data.connections) : data.sources;
    return assignSewage(project, sources, data.connections, o);
  }, [data, project, o, onlyConnections, georef]);

  const apply = () => {
    if (!result) return;
    const flows = result.flows;
    useSewerStore.getState().edit((d) => {
      for (const n of d.nodes) if (n.kind === 'JUNCTION') n.base_flow = Math.round((flows.get(n.id) ?? 0) * 1e7) / 1e7;
    });
    const s = result.stats;
    useUIStore.getState().pushToast({
      level: s.unassigned > 0 ? 'warning' : 'success',
      title: `오수 유입량 반영 — 맨홀 ${result.perNode.length.toLocaleString()}곳 · 일평균 ${Math.round(s.totalM3day).toLocaleString()} m³/일`,
      message: `연결관으로 ${s.viaConnection.toLocaleString()} · 가까운 관거로 ${s.viaNearest.toLocaleString()}${s.unassigned ? ` · ${o.maxDistance} m 안에 관거가 없어 뺀 ${s.unassigned}곳` : ''}. 첨두 배율 ×${o.peakFactor} 적용. ‘현황 해석’을 실행하세요. Ctrl+Z 로 되돌릴 수 있습니다.`,
    });
    close();
  };

  const total = result?.stats.totalM3day ?? 0;
  return (
    <Modal
      title="수용가·건물·연결관으로 오수 유입량 넣기"
      onClose={close}
      widthClass="w-[680px]"
      footer={
        <>
          {result && (
            <Button className="mr-auto" onClick={() => downloadText(`${project.name.replace(/[/\\:*?"<>|\s]+/g, '_').slice(0, 40)}_맨홀별_오수량.csv`, sewageCsv(result, o.peakFactor), 'text/csv;charset=utf-8')}>
              <Download size={12} /> 맨홀별 CSV
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
        {!georef && <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">도면 좌표 관망이라 수용가 위치와 겹칠 수 없습니다. 실제 좌표(EPSG:5186 등)로 된 관망에서 쓰세요.</p>}
        <section>
          <h3 className="mb-1 font-semibold text-ink">자료</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy} onClick={() => input.current?.click()}>
              <FileUp size={12} /> 파일 고르기
            </Button>
            <select className="rounded border border-line bg-raised px-2 py-1 text-ink" value={crs} onChange={(e) => setCrs(e.target.value)} title="CSV 와 .prj 없는 SHP 의 좌표계">
              {CRS_CHOICES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            {busy && <LoaderCircle size={14} className="animate-spin text-ink-muted" />}
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
              if (files.length) void load(files);
            }}
          />
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] text-ink-muted">
            <li><b className="text-ink-soft">수용가 대장 CSV</b>: X·Y(또는 경도·위도) + 사용량 또는 세대수 열 — 있으면 가장 정확합니다.</li>
            <li><b className="text-ink-soft">건물 SHP</b>(점·면): 세대수(세대수·HHLD_CNT·가구수 등) 열이 있으면 씁니다.</li>
            <li><b className="text-ink-soft">하수연결관 SHP</b>(선): 집이 어느 관으로 들어가는지 정합니다. 수용가·건물 자료가 없으면 연결관 하나를 건물 하나로 봅니다. 우수(SBA003) 연결관은 뺍니다.</li>
          </ul>
          {data && (
            <div className="mt-2 space-y-0.5 text-[11px] text-ink-soft">
              {data.labels.map((l) => (
                <p key={l}>{l}</p>
              ))}
              {onlyConnections && <p className="text-amber-300">수용가·건물 자료가 없어 오수 연결관 {data.connections.length.toLocaleString()}개를 건물 하나씩으로 봅니다(세대수는 아래 ‘자료 없을 때 세대수’).</p>}
              {data.warnings.slice(0, 5).map((w) => (
                <p key={w} className="text-ink-muted">
                  {w}
                </p>
              ))}
            </div>
          )}
          {error && <p className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-red-300">{error}</p>}
        </section>

        <section>
          <h3 className="mb-1 font-semibold text-ink">오수량 원단위</h3>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ['personsPerHousehold', '세대당 인원 (인)', 0.1],
                ['litersPerCapita', '1인 1일 오수량 (L)', 10],
                ['conversion', '오수전환율 (사용량 × )', 0.05],
                ['defaultHouseholds', '자료 없을 때 세대수', 1],
                ['peakFactor', '첨두 배율 (해석 유량 = 일평균 ×)', 0.1],
                ['maxDistance', '관거 찾는 거리 (m)', 10],
              ] as const
            ).map(([key, label, step]) => (
              <label key={key}>
                <span className="text-[11px] text-ink-muted">{label}</span>
                <NumberField value={o[key]} min={0} step={step} onCommit={(v) => set({ [key]: Math.max(key === 'conversion' ? 0 : 0.01, key === 'conversion' ? Math.min(1, v) : v) })} />
              </label>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-ink-muted">기본값은 예시입니다. 사업의 하수도정비기본계획 원단위(1인 1일 오수량, 일최대·시간최대 계수)로 바꾸세요. 첨두 배율 1 이면 일평균 오수량을 넣습니다.</p>
        </section>

        {result && (
          <section>
            <h3 className="mb-1 font-semibold text-ink">
              결과 — 맨홀 {result.perNode.length.toLocaleString()}곳 · 일평균 {total.toLocaleString(undefined, { maximumFractionDigits: 1 })} m³/일 · 해석 유량 합 {((total * o.peakFactor) / 86.4).toFixed(2)} L/s
            </h3>
            <p className="text-[11px] text-ink-muted">
              수용가·건물 {result.stats.sources.toLocaleString()} · 연결관으로 {result.stats.viaConnection.toLocaleString()} · 가까운 관거로 {result.stats.viaNearest.toLocaleString()}
              {result.stats.unassigned > 0 && ` · 관거가 멀어 뺀 ${result.stats.unassigned.toLocaleString()}`}
              {result.stats.defaulted > 0 && ` · 사용량·세대수 없어 기본 세대수 ${result.stats.defaulted.toLocaleString()}`}
            </p>
            <div className="mt-1 max-h-40 overflow-y-auto rounded border border-line">
              <table className="w-full tabular-nums">
                <thead className="sticky top-0 bg-panel text-left text-[11px] text-ink-muted">
                  <tr>
                    <th className="px-2 py-1">맨홀</th>
                    <th className="px-2 py-1 text-right">수용가·건물</th>
                    <th className="px-2 py-1 text-right">세대</th>
                    <th className="px-2 py-1 text-right">m³/일</th>
                    <th className="px-2 py-1 text-right">해석 L/s</th>
                  </tr>
                </thead>
                <tbody>
                  {result.perNode.slice(0, 200).map((r) => (
                    <tr key={r.id} className="border-t border-line/60">
                      <td className="px-2 py-0.5 text-ink">{r.id}</td>
                      <td className="px-2 text-right">{r.sources}</td>
                      <td className="px-2 text-right">{Math.round(r.households * 10) / 10}</td>
                      <td className="px-2 text-right">{r.m3day.toFixed(2)}</td>
                      <td className="px-2 text-right">{((r.m3day * o.peakFactor) / 86.4).toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">‘관망에 적용’은 모든 맨홀의 상시 유입량을 이 값으로 바꿉니다(실행 취소 가능). 관거 중간으로 들어가는 집은 그 관의 상류 맨홀에 넣습니다.</p>
          </section>
        )}
      </div>
    </Modal>
  );
}
