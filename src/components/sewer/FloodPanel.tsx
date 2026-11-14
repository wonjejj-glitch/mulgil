/** 하수 모드 하단 '침수 해석' 탭: 설정 · 실행 · 시간 슬라이더 · 침수 면적 · 월류 맨홀 · 내보내기. */
import { Download, Eye, EyeOff, FileUp, Play, Square } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { cancelFlood, exportFloodGrid, runFloodAnalysis } from '../../app/floodActions';
import { focusSewerObject } from '../../app/sewerMapActions';
import { cellCenter } from '../../core/flood/prepare';
import { DEPTH_CLASSES, floodAreas } from '../../core/flood/solver';
import { sewerFrame, xyToLngLat } from '../../core/sewer/mapFrame';
import { useFloodStore } from '../../store/useFloodStore';
import { useSewerStore } from '../../store/useSewerStore';
import { useUIStore } from '../../store/useUIStore';
import { FLOOD_COLORS } from '../map/floodLayer';
import { NgiiLink } from '../ui/DataLinks';
import { Button, NumberField } from '../ui/fields';

const minutes = (s: number) => `${Math.floor(s / 3600)}:${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`;
const rgba = (c: number[]) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(2)})`;

export function FloodPanel() {
  const settings = useFloodStore((s) => s.settings);
  const setSettings = useFloodStore((s) => s.setSettings);
  const frame = useFloodStore((s) => s.frame);
  const result = useFloodStore((s) => s.result);
  const overflow = useFloodStore((s) => s.overflow);
  const info = useFloodStore((s) => s.info);
  const frameIndex = useFloodStore((s) => s.frameIndex);
  const setFrameIndex = useFloodStore((s) => s.setFrameIndex);
  const show = useFloodStore((s) => s.show);
  const setShow = useFloodStore((s) => s.setShow);
  const busy = useFloodStore((s) => s.busy);
  const hasRun = useSewerStore((s) => s.run !== null && s.design !== null);
  const project = useSewerStore((s) => s.design?.project ?? null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);

  const stats = useMemo(() => {
    if (!result || !frame) return null;
    return frameIndex < 0 ? floodAreas(result.maxDepth, frame.cell) : floodAreas(result.frames[frameIndex] ?? [], frame.cell, 0.01);
  }, [result, frame, frameIndex]);

  const flyToCell = (index: number) => {
    if (!frame || !project || index < 0) return;
    const [x, y] = cellCenter(frame, index);
    useUIStore.getState().flyTo(xyToLngLat(sewerFrame(project), x, y), 17);
  };

  const ha = (m2: number) => (m2 / 10000).toFixed(m2 < 10000 ? 3 : 2);
  const totalOverflow = overflow.reduce((a, n) => a + n.volume, 0);

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto p-2 text-xs">
      {/* 설정 */}
      <div className="w-64 shrink-0 space-y-1.5">
        <h3 className="font-semibold text-ink">2차원 지표 침수 해석</h3>
        <p className="text-[10px] leading-relaxed text-ink-muted">
          SWMM 해석에서 맨홀로 넘친 물(월류)을 지반고 격자 위에 흘려 침수 범위·수심을 계산합니다(국부 관성 2차원 해석, 관으로 되돌아가는 물은 계산하지 않음).
        </p>
        <div className="flex gap-3 text-[11px] text-ink-soft">
          <label className="flex items-center gap-1">
            <input type="radio" checked={settings.dem === 'tiles'} onChange={() => setSettings({ dem: 'tiles' })} /> 지형 타일
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={settings.dem === 'files'} onChange={() => setSettings({ dem: 'files' })} /> 수치지형도
          </label>
        </div>
        {settings.dem === 'files' && (
          <div>
            <Button onClick={() => fileInput.current?.click()}>
              <FileUp size={12} /> {files.length > 0 ? `${files.length}개 파일` : 'DXF·SHP·XYZ 고르기'}
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".dxf,.shp,.dbf,.prj,.cpg,.shx,.zip,.xyz,.txt,.csv,.pts"
              className="hidden"
              onChange={(e) => {
                setFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            <p className="mt-0.5 text-[10px] text-ink-muted">
              <NgiiLink />
            </p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-1.5">
          <label>
            <span className="text-[10px] text-ink-muted">셀 크기 (m)</span>
            <NumberField value={settings.cell} min={1} onCommit={(v) => setSettings({ cell: Math.max(1, v) })} />
          </label>
          <label>
            <span className="text-[10px] text-ink-muted">관망 밖 여유 (m)</span>
            <NumberField value={settings.margin} min={0} onCommit={(v) => setSettings({ margin: Math.max(0, v) })} />
          </label>
          <label>
            <span className="text-[10px] text-ink-muted">지표 조도 n</span>
            <NumberField value={settings.manning} min={0.01} step={0.005} onCommit={(v) => setSettings({ manning: Math.min(0.2, Math.max(0.01, v)) })} />
          </label>
          <label>
            <span className="text-[10px] text-ink-muted">해석 뒤 추가 (분)</span>
            <NumberField value={settings.extraMinutes} min={0} onCommit={(v) => setSettings({ extraMinutes: Math.max(0, v) })} />
          </label>
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-ink-soft" title="격자 지반고 전체를 맨홀 지반고(중앙값 차이)에 맞춰 평행 이동합니다. 지형 타일의 높이 기준 차이를 줄입니다.">
          <input type="checkbox" checked={settings.fitDem} onChange={(e) => setSettings({ fitDem: e.target.checked })} />
          지반고를 맨홀 지반고에 맞춤
        </label>
        <div className="flex gap-1.5">
          <Button variant="primary" disabled={busy !== null || !hasRun} onClick={() => void runFloodAnalysis(files)} title={hasRun ? '' : '먼저 설계·해석 또는 현황 해석을 하세요'}>
            <Play size={12} /> 침수 해석 실행
          </Button>
          {busy && (
            <Button onClick={cancelFlood}>
              <Square size={12} /> 중지
            </Button>
          )}
        </div>
        {busy && <p className="text-[11px] text-ink-soft">{busy}</p>}
        {!hasRun && <p className="text-[10px] text-ink-muted">먼저 ‘설계·해석’(F5) 또는 ‘현황 해석’으로 SWMM 결과를 만드세요.</p>}
      </div>

      {/* 결과 */}
      {result && frame && stats ? (
        <>
          <div className="w-72 shrink-0 space-y-1.5">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-ink">{frameIndex < 0 ? '최대 침수 수심' : `수심 — ${minutes(result.frameTimes[frameIndex])} 시점`}</h3>
              <button type="button" className="ml-auto text-ink-muted hover:text-ink" onClick={() => setShow(!show)} title={show ? '지도에서 숨기기' : '지도에 보이기'}>
                {show ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
            </div>
            <input
              type="range"
              aria-label="시각"
              min={-1}
              max={result.frames.length - 1}
              value={frameIndex}
              onChange={(e) => setFrameIndex(Number(e.target.value))}
              className="w-full"
            />
            <p className="text-[10px] text-ink-muted">맨 왼쪽 = 전 시간 최대 수심 · 오른쪽으로 끌면 시간대별 (0:00 ~ {minutes(result.frameTimes[result.frameTimes.length - 1] ?? 0)})</p>
            <table className="w-full tabular-nums">
              <tbody>
                {DEPTH_CLASSES.map((d, c) => (
                  <tr key={d} className="border-t border-line/60">
                    <td className="px-1 py-0.5">
                      <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: rgba(FLOOD_COLORS[Math.min(FLOOD_COLORS.length - 1, c + 1)][1]) }} />
                      {c < DEPTH_CLASSES.length - 1 ? `${d}~${DEPTH_CLASSES[c + 1]} m` : `${d} m 이상`}
                    </td>
                    <td className="px-1 text-right">{ha(stats.classes[c])} ha</td>
                  </tr>
                ))}
                <tr className="border-t border-line font-semibold text-ink">
                  <td className="px-1 py-0.5">침수 면적 (0.05 m 이상)</td>
                  <td className="px-1 text-right">{ha(stats.total)} ha</td>
                </tr>
              </tbody>
            </table>
            <p className="text-[11px] text-ink-soft">
              최대 수심 {stats.max.toFixed(2)} m{' '}
              <button type="button" className="text-accent hover:underline" onClick={() => flyToCell(stats.maxIndex)}>
                위치 보기
              </button>
            </p>
            <Button onClick={exportFloodGrid} title="지금 보이는 수심 격자를 ESRI ASCII Grid(.asc, +.prj)로 저장합니다 — QGIS·ArcGIS 에서 열립니다">
              <Download size={12} /> 수심 격자 (.asc)
            </Button>
          </div>
          <div className="w-64 shrink-0 space-y-1">
            <h3 className="font-semibold text-ink">월류 맨홀 {overflow.length}곳 · {Math.round(totalOverflow).toLocaleString()} m³</h3>
            <ul className="max-h-32 overflow-y-auto rounded border border-line">
              {overflow.map((n) => (
                <li key={n.id} className="flex cursor-pointer gap-2 border-b border-line/60 px-2 py-0.5 hover:bg-raised" onClick={() => focusSewerObject({ kind: 'node', id: n.id })}>
                  <span className="w-16 text-ink">{n.id}</span>
                  <span className="ml-auto tabular-nums text-ink-soft">{Math.round(n.volume).toLocaleString()} m³</span>
                  <span className="w-20 text-right tabular-nums text-ink-muted">최대 {(n.peak * 1000).toFixed(0)} L/s</span>
                </li>
              ))}
            </ul>
            <p className="text-[10px] leading-relaxed text-ink-muted">
              물수지: 넘친 물 {Math.round(result.injected).toLocaleString()} m³ = 지표에 남음 {Math.round(result.stored).toLocaleString()} + 영역 밖 유출{' '}
              {Math.round(result.outflow).toLocaleString()} m³
              <br />
              격자 {frame.nx}×{frame.ny} · 셀 {frame.cell} m · {info?.demLabel}
              {info && info.offset !== 0 && ` · 지반고 ${info.offset >= 0 ? '+' : ''}${info.offset.toFixed(2)} m 맞춤(맨홀 편차 ±${info.offsetSpread.toFixed(2)} m)`}
              {info && ` · 계산 ${(info.elapsedMs / 1000).toFixed(1)} 초`}
            </p>
            <p className="text-[10px] leading-relaxed text-ink-muted">
              건물·담장은 지반고 자료에 없으면 반영되지 않습니다. 지형 타일(30 m 급)은 개략 판단용이고, 설계 검토에는 수치지형도를 쓰세요.
            </p>
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-ink-muted">
          {hasRun ? '‘침수 해석 실행’을 누르면 월류한 물이 지표로 어디까지 퍼지는지 지도에 표시합니다.' : '하수 해석 결과가 있어야 침수 해석을 할 수 있습니다.'}
        </div>
      )}
    </div>
  );
}
