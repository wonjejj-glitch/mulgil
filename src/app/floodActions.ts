/**
 * 2차원 침수 해석 실행: 하수 SWMM 결과(맨홀 월류) → 지반고 격자(지형 타일 또는 수치지형도) → 워커에서 확산 계산.
 * 계산은 core/flood/solver.ts, 준비는 core/flood/prepare.ts.
 */
import type { FloodRequest, FloodResponse } from '../core/flood/flood.worker';
import { asciiGrid, cellCenter, demOffset, gridFrame, overflowSources } from '../core/flood/prepare';
import type { FloodResult } from '../core/flood/solver';
import { SEWER_CRS, sewerFrame, xyToLngLat } from '../core/sewer/mapFrame';
import { useFloodStore } from '../store/useFloodStore';
import { useSewerStore } from '../store/useSewerStore';
import { useUIStore } from '../store/useUIStore';
import { downloadText } from '../utils/files';
import { IdwInterpolator } from '../core/terrain/elevation';
import { interpolatorFromFiles, sampleTerrainTiles } from './terrainFetch';

let worker: Worker | null = null;
let rejectWorker: ((e: Error) => void) | null = null;
/** 실행마다 늘린다. 중지하거나 새로 실행하면 이전 실행은 결과를 버리고 조용히 끝난다. */
let runId = 0;
const CANCELLED = '침수 해석을 중지했습니다.';

// 하수 해석 결과가 바뀌면 침수 결과는 맞지 않으므로 지운다
let lastRun = useSewerStore.getState().run;
useSewerStore.subscribe((s) => {
  if (s.run === lastRun) return;
  lastRun = s.run;
  if (useFloodStore.getState().busy) cancelFlood();
  if (useFloodStore.getState().result) useFloodStore.getState().clear();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

function runWorker(request: FloodRequest, onProgress: (fraction: number) => void): Promise<FloodResult> {
  worker?.terminate();
  const w = new Worker(new URL('../core/flood/flood.worker.ts', import.meta.url), { type: 'module' });
  worker = w;
  return new Promise((resolve, reject) => {
    rejectWorker = reject;
    w.onmessage = (event: MessageEvent<FloodResponse>) => {
      const m = event.data;
      if (m.type === 'progress') onProgress(m.duration > 0 ? m.t / m.duration : 0);
      else {
        w.terminate();
        if (worker === w) worker = null;
        if (m.type === 'done') resolve(m.result);
        else reject(new Error(m.message));
      }
    };
    w.onerror = (e) => {
      w.terminate();
      if (worker === w) worker = null;
      reject(new Error(e.message || '침수 해석 워커를 시작하지 못했습니다.'));
    };
    w.postMessage(request);
  });
}

export function cancelFlood(): void {
  runId++;
  worker?.terminate();
  worker = null;
  rejectWorker?.(new Error(CANCELLED));
  rejectWorker = null;
  useFloodStore.getState().setBusy(null);
}

export async function runFloodAnalysis(files: File[] = []): Promise<void> {
  const flood = useFloodStore.getState();
  const ui = useUIStore.getState();
  const sewer = useSewerStore.getState();
  if (flood.busy) return;
  const run = sewer.run;
  const project = sewer.design?.project;
  if (!run || !project) {
    ui.pushToast({ level: 'info', title: '먼저 하수 해석을 하세요', message: '‘설계·해석’ 또는 ‘현황 해석’으로 SWMM 결과를 만든 뒤 침수 해석을 실행합니다.' });
    return;
  }
  const local = sewerFrame(project).kind !== 'epsg';
  // 도면 좌표 관망은 실제 위치를 몰라 지형 자료와 겹칠 수 없으므로 맨홀 지반고로 지형을 만든다
  const s = local ? { ...flood.settings, dem: 'manholes' as const } : flood.settings;
  if (s.dem === 'files' && files.length === 0) {
    ui.pushToast({ level: 'info', title: '수치지형도 파일을 고르세요' });
    return;
  }
  const id = ++runId;
  const stale = () => id !== runId;
  const t0 = performance.now();
  try {
    const f = gridFrame(project, s.cell, s.margin);
    const { sources, nodes } = overflowSources(project, run.output, f);
    if (sources.length === 0) {
      ui.pushToast({ level: 'success', title: '월류한 맨홀이 없습니다', message: '이번 강우·관망 조건에서는 지표로 넘친 물이 없어 침수 해석을 하지 않았습니다.' });
      return;
    }
    const geo = sewerFrame(project);
    const N = f.nx * f.ny;
    const points = Array.from({ length: N }, (_, k) => {
      const [x, y] = cellCenter(f, k);
      return xyToLngLat(geo, x, y);
    });

    // 1) 지반고 격자
    const z = new Float32Array(N).fill(NaN);
    let demLabel = '';
    if (s.dem === 'files') {
      flood.setBusy('수치지형도 읽는 중…');
      const { idw, points: count, layers } = await interpolatorFromFiles(files, SEWER_CRS);
      if (stale()) return;
      for (let k = 0; k < N; k++) {
        const v = idw.at(points[k]);
        if (v) z[k] = v.z;
        if (k % 4000 === 0) {
          useFloodStore.getState().setBusy(`수치지형도로 격자 지반고 만드는 중… ${Math.round((k / N) * 100)}%`);
          await tick();
          if (stale()) return;
        }
      }
      demLabel = `수치지형도 (${layers.slice(0, 3).join(', ')} · 표고 ${count.toLocaleString()}점)`;
    }
    if (s.dem === 'manholes') {
      flood.setBusy('맨홀 지반고로 격자 지반고 만드는 중…');
      const idw = new IdwInterpolator(
        project.nodes.map((n) => ({ position: xyToLngLat(geo, n.x, n.y), z: n.ground })),
        Math.max(300, s.margin * 3),
        8,
      );
      // 맨홀에서 먼 곳은 알 수 없으므로 가장 높은 맨홀보다 높게 두어 물이 그쪽으로 빠지지 않게 한다
      const wall = Math.max(...project.nodes.map((n) => n.ground)) + 2;
      for (let k = 0; k < N; k++) {
        z[k] = idw.at(points[k])?.z ?? wall;
        if (k % 4000 === 0) {
          useFloodStore.getState().setBusy(`맨홀 지반고로 격자 지반고 만드는 중… ${Math.round((k / N) * 100)}%`);
          await tick();
          if (stale()) return;
        }
      }
      demLabel = `맨홀 지반고 보간 (${project.nodes.length.toLocaleString()}점${local ? ' · 도면 좌표 관망' : ''})`;
    }
    const missing: number[] = [];
    for (let k = 0; k < N; k++) if (!Number.isFinite(z[k])) missing.push(k);
    if (missing.length > 0) {
      flood.setBusy('지형 타일 받는 중…');
      const values = await sampleTerrainTiles(
        missing.map((k) => points[k]),
        (d, t) => useFloodStore.getState().setBusy(`지형 타일 받는 중… ${d}/${t}`),
        15,
      );
      if (stale()) return;
      missing.forEach((k, i) => (z[k] = values[i]));
      demLabel = demLabel ? `${demLabel} + 빈 곳 지형 타일 ${missing.length.toLocaleString()}셀` : '온라인 지형 타일 (SRTM 30 m 급)';
    }
    const fit = demOffset(project, f, z);
    const shift = s.fitDem && s.dem !== 'manholes';
    if (shift && fit.samples > 0) for (let k = 0; k < N; k++) z[k] += fit.offset;

    // 2) 확산 계산
    const duration = run.output.periods * run.output.reportStepSec + s.extraMinutes * 60;
    const frameInterval = Math.max(60, Math.ceil(duration / 48 / 60) * 60);
    useFloodStore.getState().setBusy('침수 확산 계산 중… 0%');
    const result = await runWorker(
      { grid: { nx: f.nx, ny: f.ny, cell: f.cell, z }, sources, params: { manning: s.manning, duration, frameInterval } },
      (p) => useFloodStore.getState().setBusy(`침수 확산 계산 중… ${Math.round(p * 100)}%`),
    );
    if (stale()) return;
    useFloodStore.getState().setResult({
      frame: f,
      z,
      result,
      overflow: nodes,
      info: { demLabel, offset: shift ? fit.offset : 0, offsetSpread: fit.spread, duration, elapsedMs: performance.now() - t0 },
    });
    const total = nodes.reduce((a, n) => a + n.volume, 0);
    ui.pushToast({
      level: 'success',
      title: `침수 해석 완료 — 월류 맨홀 ${nodes.length}곳 · 넘친 물 ${Math.round(total).toLocaleString()} m³`,
      message: '지도에 최대 침수 수심이 표시됩니다. 아래 ‘침수 해석’ 탭에서 시간대별로 볼 수 있습니다.',
    });
  } catch (error) {
    if (stale()) return;
    const msg = error instanceof Error ? error.message : String(error);
    useFloodStore.getState().setError(msg);
    ui.pushToast({ level: 'error', title: '침수 해석을 하지 못했습니다', message: msg });
  } finally {
    if (!stale()) useFloodStore.getState().setBusy(null);
  }
}

/** 지금 보이는 수심(최대 또는 선택 시각)을 ESRI ASCII Grid + .prj 로 저장한다. */
export function exportFloodGrid(): void {
  const { frame, result, frameIndex } = useFloodStore.getState();
  const project = useSewerStore.getState().design?.project;
  if (!frame || !result) return;
  const values = frameIndex < 0 ? result.maxDepth : Float32Array.from(result.frames[frameIndex], (v) => v / 100);
  const label = frameIndex < 0 ? '최대수심' : `수심_${Math.round(result.frameTimes[frameIndex] / 60)}분`;
  const name = (project?.name ?? 'sewer').replace(/[/\\:*?"<>|\s]+/g, '_').slice(0, 40);
  downloadText(`${name}_침수_${label}.asc`, asciiGrid(frame, values));
  if (project && sewerFrame(project).kind === 'epsg') {
    downloadText(
      `${name}_침수_${label}.prj`,
      'PROJCS["Korea_2000_Korea_Central_Belt_2010",GEOGCS["GCS_Korea_2000",DATUM["D_Korea_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",200000.0],PARAMETER["False_Northing",600000.0],PARAMETER["Central_Meridian",127.0],PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",38.0],UNIT["Meter",1.0]]',
    );
  }
}
