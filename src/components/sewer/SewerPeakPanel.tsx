/** 하수 하단 '첨두 비교' 탭: 오수 유입 배율마다 SWMM 을 돌려 만관·월류·펌프장 결과를 한 표로 비교한다. */
import { Download, Play } from 'lucide-react';
import { useState } from 'react';
import { validatedProject } from '../../app/sewerActions';
import { parseFactors } from '../../core/engine/peakFactor';
import { scaledSewerProject, sewerFactorCsv, summarizeFactor, type SewerFactorRow } from '../../core/sewer/peakSweep';
import { parseReport, summarizeSimulation } from '../../core/sewer/report';
import { asBuiltDesign } from '../../core/sewer/survey';
import { generateInp } from '../../core/sewer/inp';
import { swmmManager } from '../../core/swmm/swmmManager';
import { useSewerStore } from '../../store/useSewerStore';
import { useUIStore } from '../../store/useUIStore';
import { downloadText } from '../../utils/files';
import { Button } from '../ui/fields';

export function SewerPeakPanel() {
  const design = useSewerStore((s) => s.design);
  const hasCatchments = useSewerStore((s) => s.project.catchments.length > 0);
  const maxRatio = useSewerStore((s) => s.project.constraints.max_depth_ratio);
  const [list, setList] = useState('1.0, 1.3, 1.5, 1.8, 2.0');
  const [rain, setRain] = useState(false);
  const [rows, setRows] = useState<SewerFactorRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const factors = parseFactors(list);

  const run = async () => {
    const store = useSewerStore.getState();
    if (store.busy || busy) return;
    // 설계 결과가 있으면 그 관경·관저고로, 없으면 지금 입력(현황) 그대로
    let base = store.design?.project ?? null;
    if (!base) {
      const p = validatedProject();
      if (!p) return;
      try {
        base = asBuiltDesign(p).project;
      } catch (error) {
        store.setError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    setRows([]);
    const acc: SewerFactorRow[] = [];
    for (const f of factors) {
      setBusy(`${acc.length} / ${factors.length}`);
      try {
        const p = scaledSewerProject(base, f, rain);
        const out = await swmmManager.run(generateInp(p));
        acc.push(summarizeFactor(p, f, summarizeSimulation(p, parseReport(out.report, p))));
        setRows([...acc]);
      } catch (error) {
        useUIStore.getState().pushToast({ level: 'error', title: `배율 ${f} 해석 실패`, message: error instanceof Error ? error.message : String(error) });
        break;
      }
    }
    setBusy(null);
  };

  const bad = (n: number) => (n > 0 ? 'text-[#f3a5a5]' : 'text-ink-muted');
  const firstFlood = rows.find((r) => r.flooded > 0 || r.overRatio > 0);
  return (
    <div className="flex h-full min-h-0 gap-3 p-2 text-xs">
      <div className="flex w-72 shrink-0 flex-col gap-1.5">
        <h3 className="font-semibold text-ink">첨두계수(오수량 배율) 비교</h3>
        <p className="text-[10px] leading-relaxed text-ink-muted">
          맨홀 오수 유입에 배율을 곱해 계수마다 SWMM 으로 해석합니다. 관경·관저고는 {design ? (design.asBuilt ? '현황 해석' : '자동 설계') + ' 결과' : '지금 입력(현황)'} 그대로입니다. 오수 유입이 일평균이면 시간최대 계수(예: 1.5~2.0)까지 넣어 여유를 봅니다.
        </p>
        <input
          aria-label="비교할 배율"
          value={list}
          onChange={(e) => setList(e.target.value)}
          className="h-7 w-full rounded border border-line bg-canvas px-2 text-ink outline-none focus:border-accent"
        />
        <label className="flex items-center gap-1.5 text-[11px] text-ink-soft" title="끄면 유역(강우 유출)을 빼고 오수만 봅니다 (분류식 오수관)">
          <input type="checkbox" className="accent-accent" checked={rain} disabled={!hasCatchments} onChange={(e) => setRain(e.target.checked)} />
          강우 유출도 함께 (합류식){hasCatchments ? '' : ' — 유역 없음'}
        </label>
        <div className="flex gap-2">
          <Button disabled={busy !== null || factors.length === 0} onClick={() => void run()}>
            <Play size={12} /> {busy ? `해석 중 ${busy}` : `${factors.length}개 배율 비교 해석`}
          </Button>
          <Button disabled={rows.length === 0} onClick={() => downloadText('하수_첨두계수_비교.csv', `${String.fromCharCode(0xfeff)}${sewerFactorCsv(rows)}`, 'text/csv;charset=utf-8')}>
            <Download size={12} /> CSV
          </Button>
        </div>
        <p className="text-[10px] text-ink-muted">판정: 설계 d/D {maxRatio} 초과, 만관(관정 위 수위), 월류.</p>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded border border-line">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-ink-muted">
            비교 해석을 누르면 배율마다 최대 수심비·만관·월류 맨홀 수·최대 유속·펌프장 가동률이 여기에 나옵니다.
          </div>
        ) : (
          <>
            {rows.length === factors.length && (
              <p className={`border-b border-line px-2 py-1.5 text-[11px] ${firstFlood ? 'bg-[#3a3220] text-[#f0d28a]' : 'bg-good/10 text-ink'}`}>
                {firstFlood
                  ? `배율 ${firstFlood.factor} 부터 ${firstFlood.flooded > 0 ? `월류 맨홀 ${firstFlood.flooded}곳` : `설계 d/D 초과 관거 ${firstFlood.overRatio}개`}이 생깁니다 — 그 배율이 이 관망의 여유 한계입니다.`
                  : `배율 ${rows[rows.length - 1].factor} 까지 월류·설계 d/D 초과가 없습니다.`}
              </p>
            )}
            <table className="w-full tabular-nums">
              <thead className="sticky top-0 bg-panel text-ink-soft">
                <tr>
                  {['배율', '오수 유입 (L/s)', '최대 d/D', '관거', 'd/D 초과', '만관 맨홀', '월류 맨홀', '월류량 (m³)', '최대 유속 (m/s)', '펌프 가동률 (%)'].map((h, i) => (
                    <th key={h} className={`whitespace-nowrap px-2 py-1 font-medium ${i === 3 ? 'text-left' : 'text-right'}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.factor} className="border-t border-line/60">
                    <td className="px-2 py-1 text-right font-semibold text-ink">{r.factor}</td>
                    <td className="px-2 py-1 text-right text-ink-soft">{(r.sewage * 1000).toFixed(1)}</td>
                    <td className={`px-2 py-1 text-right ${r.maxDepthRatio > maxRatio ? 'text-[#f3a5a5]' : 'text-ink'}`}>{r.maxDepthRatio.toFixed(2)}</td>
                    <td className="cursor-pointer px-2 py-1 text-ink-soft hover:text-ink" onClick={() => useSewerStore.getState().select({ kind: 'conduit', id: r.maxDepthRatioLink })}>
                      {r.maxDepthRatioLink}
                    </td>
                    <td className={`px-2 py-1 text-right ${bad(r.overRatio)}`}>{r.overRatio}</td>
                    <td className={`px-2 py-1 text-right ${bad(r.surcharged)}`}>{r.surcharged}</td>
                    <td className={`px-2 py-1 text-right ${bad(r.flooded)}`}>{r.flooded}</td>
                    <td className={`px-2 py-1 text-right ${bad(r.floodVolume)}`}>{r.floodVolume.toFixed(1)}</td>
                    <td className="px-2 py-1 text-right text-ink">{r.maxVelocity.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right text-ink">{r.pumpUtilization === null ? '—' : r.pumpUtilization.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
