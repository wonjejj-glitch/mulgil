/** 용지 조서·용지도 (지적도): 관로가 지나는 필지의 편입 면적·개략 보상비, CSV 조서와 DXF 용지도. */
import { Download, Eye, EyeOff, LandPlot, LoaderCircle, RefreshCw } from 'lucide-react';
import { autoWidth, clearLand, exportLandDxf, exportTakeoffCsv, runLandTakeoff } from '../../app/landActions';
import { useLandStore } from '../../store/useLandStore';
import { useUIStore } from '../../store/useUIStore';
import { Button, NumberField } from '../ui/fields';
import { Modal } from '../ui/Modal';

const won = (v: number) => (v >= 1e8 ? `${(v / 1e8).toFixed(2)}억 원` : `${Math.round(v / 10000).toLocaleString()}만 원`);

export function LandModal() {
  const s = useLandStore();
  const domain = useUIStore((u) => u.domain);
  const hasKey = useUIStore((u) => u.vworldKey !== '');
  const close = () => useUIStore.getState().openModal(null);
  const r = s.result;

  return (
    <Modal
      title="용지 조서 · 용지도 (지적도)"
      onClose={close}
      widthClass="w-[760px]"
      footer={
        <>
          {r && (
            <span className="mr-auto flex gap-2">
              <Button onClick={exportTakeoffCsv}>
                <Download size={12} /> 편입토지조서 (엑셀 CSV)
              </Button>
              <Button onClick={exportLandDxf}>
                <Download size={12} /> 용지도 (DXF)
              </Button>
            </span>
          )}
          <Button onClick={close}>닫기</Button>
        </>
      }
    >
      <div className="space-y-4 text-xs">
        <p className="text-ink-soft">
          지금 열린 <b>{domain === 'sewer' ? '하수' : '상수'} 관망</b>의 관로를 따라 브이월드 연속지적도를 받아, 관로가 지나는 필지마다 편입 면적과 개략 보상비(공시지가 기준)를 계산합니다.
        </p>
        {!hasKey && <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">브이월드 인증키가 없습니다. 왼쪽 패널 배경지도의 브이월드 키 칸에 넣으세요.</p>}

        <section>
          <h3 className="mb-1 font-semibold text-ink">편입 폭</h3>
          <div className="flex flex-wrap items-center gap-4 text-ink-soft">
            <label className="flex items-center gap-1">
              <input type="radio" checked={s.settings.widthMode === 'auto'} onChange={() => s.setSettings({ widthMode: 'auto' })} /> 관경으로 자동 (터파기 폭 = 관경 × 1.2 + 0.6 m, 최소 0.8 m — 예: Ø300 → {autoWidth(0.3).toFixed(2)} m)
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={s.settings.widthMode === 'fixed'} onChange={() => s.setSettings({ widthMode: 'fixed' })} /> 모든 관로
              <span className="w-16">
                <NumberField value={s.settings.width} min={0.1} step={0.1} onCommit={(v) => s.setSettings({ width: Math.max(0.1, v), widthMode: 'fixed' })} />
              </span>
              m
            </label>
          </div>
          <label className="mt-2 flex items-center gap-2 text-ink-soft">
            개략 보상비 = 편입 면적 × 공시지가 ×
            <span className="w-16">
              <NumberField value={s.settings.factor} min={0} step={0.1} onCommit={(v) => s.setSettings({ factor: Math.max(0, v) })} />
            </span>
            (감정평가 보정 배율, 예시)
          </label>
        </section>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={s.busy !== null || !hasKey} onClick={() => void runLandTakeoff()}>
            <LandPlot size={13} /> 지적도 받고 계산
          </Button>
          {s.parcels.length > 0 && (
            <>
              <Button disabled={s.busy !== null} onClick={() => void runLandTakeoff(true)} title="관망을 옮기거나 늘렸으면 지적도를 다시 받습니다">
                <RefreshCw size={12} /> 지적도 다시 받기
              </Button>
              <Button onClick={() => s.set({ show: !s.show })}>
                {s.show ? <EyeOff size={12} /> : <Eye size={12} />} 지도에서 {s.show ? '숨기기' : '보이기'}
              </Button>
              <Button onClick={clearLand}>지우기</Button>
            </>
          )}
          {s.busy && (
            <span className="flex items-center gap-1 text-ink-soft">
              <LoaderCircle size={13} className="animate-spin" /> {s.busy}
            </span>
          )}
        </div>
        {s.error && <p className="rounded border border-red-500/40 bg-red-500/10 p-2 text-red-300">{s.error}</p>}

        {r && (
          <section>
            <h3 className="mb-1 font-semibold text-ink">
              편입 {r.rows.length.toLocaleString()}필지 · {Math.round(r.totalTaken).toLocaleString()} m² — 사유지 등 {Math.round(r.privateTaken).toLocaleString()} m² · 개략 보상비 {won(r.totalCost)}
            </h3>
            <p className="text-[11px] text-ink-muted">
              공공용지(도로·하천·구거 등) {Math.round(r.publicTaken).toLocaleString()} m² · 지적도 밖으로 나간 부분 {Math.round(r.uncovered).toLocaleString()} m² · 받은 필지 {s.parcels.length.toLocaleString()} · 좌표 {s.plane}
            </p>
            <div className="mt-1 max-h-56 overflow-y-auto rounded border border-line">
              <table className="w-full tabular-nums">
                <thead className="sticky top-0 bg-panel text-left text-[11px] text-ink-muted">
                  <tr>
                    <th className="px-2 py-1">번호</th>
                    <th className="px-2 py-1">소재지 · 지번</th>
                    <th className="px-2 py-1">지목</th>
                    <th className="px-2 py-1 text-right">면적 m²</th>
                    <th className="px-2 py-1 text-right">편입 m²</th>
                    <th className="px-2 py-1 text-right">공시지가</th>
                    <th className="px-2 py-1 text-right">개략 보상비</th>
                  </tr>
                </thead>
                <tbody>
                  {r.rows.slice(0, 500).map((row, i) => (
                    <tr key={row.pnu} className={`border-t border-line/60 ${row.isPublic ? 'text-ink-muted' : ''}`}>
                      <td className="px-2 py-0.5">{i + 1}</td>
                      <td className="px-2">{row.addr.replace(/^\S+\s\S+\s/, '')} {row.jibun.replace(/\D+$/, '') === row.addr.split(' ').pop() ? '' : row.jibun}</td>
                      <td className="px-2">{row.jimok}</td>
                      <td className="px-2 text-right">{row.parcelArea.toFixed(0)}</td>
                      <td className="px-2 text-right">{row.takenArea.toFixed(1)}</td>
                      <td className="px-2 text-right">{row.price ? row.price.toLocaleString() : '-'}</td>
                      <td className="px-2 text-right">{row.isPublic ? '공공용지' : row.price ? won(row.cost) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        <p className="text-[11px] leading-relaxed text-ink-muted">
          개략 조서입니다. 면적은 연속지적도 기준이라 토지대장 면적과 다를 수 있고, 보상비는 공시지가 × 배율의 참고값(감정평가 아님)입니다. 소유자는 공개 자료에 없어 조서에 빈칸으로 두니 토지대장으로 채우세요. 지도에서 주황 = 사유지 등 편입 필지, 파랑 = 도로·하천 등 공공용지입니다.
        </p>
      </div>
    </Modal>
  );
}
