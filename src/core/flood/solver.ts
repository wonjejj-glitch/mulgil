/**
 * 2차원 지표면 침수 확산 해석 (국부 관성 근사, Bates et al. 2010 · de Almeida et al. 2012 의 LISFLOOD-FP 방식).
 *
 * - 격자: 정사각 셀(cell m), 행 0 이 북쪽. z = 지반고(m), h = 수심(m).
 * - 셀 경계 단위폭 유량 q(m²/s)를 운동량식(관성 + 수면경사 + Manning 마찰)으로 갱신하고 연속식으로 수심을 갱신한다.
 * - 입력: 맨홀 월류 유량 시계열(SWMM 결과의 Flooding, m³/s)을 그 맨홀이 있는 셀에 넣는다 (1D→2D 한 방향 연결 —
 *   지표의 물이 다시 관으로 들어가는 것은 계산하지 않는다).
 * - 경계: 격자 가장자리는 자유 유출(빠져나간 양은 '영역 밖 유출'로 집계).
 *
 * 건물·담장 같은 장애물은 DEM 에 없으면 반영되지 않는다. 결과는 개략 침수 범위·수심 판단용이다.
 */

export const GRAVITY = 9.81;

export interface FloodGrid {
  nx: number;
  ny: number;
  /** 셀 크기 (m) */
  cell: number;
  /** 지반고, 길이 nx*ny, 인덱스 = j*nx + i (j=0 이 북쪽 행) */
  z: Float32Array;
}

export interface FloodSource {
  /** 셀 인덱스 */
  index: number;
  /** 시각(s) 오름차순 */
  times: number[];
  /** 유입량 (m³/s), 시각 사이는 선형 보간, 범위 밖은 0 */
  flows: number[];
}

export interface FloodParams {
  /** 지표 Manning n (기본 0.035) */
  manning: number;
  /** 총 계산 시간 (s) */
  duration: number;
  /** 수심 스냅샷 간격 (s) */
  frameInterval: number;
  /** CFL 계수 (기본 0.7) */
  alpha?: number;
  /** 최대 시간 간격 (s, 기본 10) */
  maxDt?: number;
  /** 이 수심(m) 미만은 마른 셀 (기본 0.001) */
  dryDepth?: number;
}

export interface FloodResult {
  maxDepth: Float32Array;
  /** 최대 수심이 나타난 시각 (s) */
  maxTime: Float32Array;
  /** 스냅샷 수심 (cm, Uint16) */
  frames: Uint16Array[];
  frameTimes: number[];
  injected: number;
  outflow: number;
  stored: number;
  steps: number;
}

function sourceFlow(s: FloodSource, t: number): number {
  const { times, flows } = s;
  if (times.length === 0 || t < times[0] || t > times[times.length - 1]) return 0;
  let k = 0;
  while (k + 1 < times.length && times[k + 1] < t) k++;
  if (k + 1 >= times.length) return flows[k];
  const span = times[k + 1] - times[k];
  return span > 0 ? flows[k] + ((flows[k + 1] - flows[k]) * (t - times[k])) / span : flows[k];
}

export function simulateFlood(grid: FloodGrid, sources: FloodSource[], params: FloodParams, onProgress?: (t: number) => void): FloodResult {
  const { nx, ny, cell, z } = grid;
  const N = nx * ny;
  const g = GRAVITY;
  const n2 = params.manning * params.manning;
  const alpha = params.alpha ?? 0.7;
  const maxDt = params.maxDt ?? 10;
  const dry = params.dryDepth ?? 0.001;
  const area = cell * cell;

  const h = new Float64Array(N);
  // qx: 셀 (i,j) 와 (i+1,j) 사이 (i=-1..nx-1 → 인덱스 j*(nx+1)+i+1), 동쪽 + 방향
  const qx = new Float64Array((nx + 1) * ny);
  // qy: 셀 (i,j) 와 (i,j+1) 사이 (j=-1..ny-1 → (j+1)*nx+i), 남쪽(행 증가) + 방향
  const qy = new Float64Array(nx * (ny + 1));
  const maxDepth = new Float32Array(N);
  const maxTime = new Float32Array(N);
  const frames: Uint16Array[] = [];
  const frameTimes: number[] = [];

  // 활성 범위 (젖은 셀 + 1). 처음에는 유입 셀만.
  let i0 = nx, i1 = -1, j0 = ny, j1 = -1;
  const grow = (i: number, j: number) => {
    if (i < i0) i0 = i;
    if (i > i1) i1 = i;
    if (j < j0) j0 = j;
    if (j > j1) j1 = j;
  };
  const active = sources.filter((s) => s.index >= 0 && s.index < N && s.flows.some((f) => f > 0));

  let si0 = 0, si1 = -1, sj0 = 0, sj1 = -1;
  let t = 0;
  let injected = 0;
  let outflow = 0;
  let steps = 0;
  let nextFrame = 0;

  const snapshot = () => {
    const f = new Uint16Array(N);
    for (let k = 0; k < N; k++) {
      const v = h[k];
      if (v >= 0.01) f[k] = Math.min(65535, Math.round(v * 100));
    }
    frames.push(f);
    frameTimes.push(t);
  };

  while (t < params.duration - 1e-9) {
    // 활성 범위를 젖은 셀 + 유입 셀로 다시 잡는다
    // 물은 한 단계에 이웃 셀까지만 가므로, 젖은 셀은 지난 단계 계산 범위(si0..si1, sj0..sj1) 안에만 있다
    i0 = nx; i1 = -1; j0 = ny; j1 = -1;
    let hmax = 0;
    for (const s of active) {
      if (sourceFlow(s, t) > 0 || sourceFlow(s, t + maxDt) > 0 || h[s.index] > dry) grow(s.index % nx, Math.floor(s.index / nx));
      if (h[s.index] > hmax) hmax = h[s.index];
    }
    for (let j = sj0; j <= sj1; j++) {
      const row = j * nx;
      for (let i = si0; i <= si1; i++) {
        const v = h[row + i];
        if (v > dry) {
          grow(i, j);
          if (v > hmax) hmax = v;
        }
      }
    }
    if (i1 < 0) {
      // 물이 전혀 없다: 다음 유입 시작까지 건너뛴다
      si0 = 0; si1 = -1; sj0 = 0; sj1 = -1;
      let next = params.duration;
      for (const s of active) for (let k = 0; k < s.times.length; k++) if (s.flows[k] > 0 && s.times[k] > t) next = Math.min(next, k > 0 ? s.times[k - 1] : s.times[k]);
      if (next <= t) next = t + maxDt;
      while (nextFrame <= Math.min(next, params.duration) + 1e-9 && nextFrame <= params.duration) {
        t = nextFrame;
        snapshot();
        nextFrame += params.frameInterval;
      }
      t = Math.min(Math.max(next, t), params.duration);
      if (t >= params.duration - 1e-9) break;
      continue;
    }
    i0 = Math.max(0, i0 - 1); i1 = Math.min(nx - 1, i1 + 1);
    j0 = Math.max(0, j0 - 1); j1 = Math.min(ny - 1, j1 + 1);
    si0 = i0; si1 = i1; sj0 = j0; sj1 = j1;

    let dt = hmax > 0.001 ? (alpha * cell) / Math.sqrt(g * hmax) : maxDt;
    dt = Math.min(dt, maxDt, params.duration - t);
    if (nextFrame > t && nextFrame - t < dt) dt = Math.max(1e-3, nextFrame - t);

    // 1) x 방향 유량 (내부 경계)
    for (let j = j0; j <= j1; j++) {
      const row = j * nx;
      for (let i = Math.max(0, i0 - 1); i <= Math.min(nx - 2, i1); i++) {
        const a = row + i, b = a + 1;
        const k = j * (nx + 1) + i + 1;
        const ea = z[a] + h[a], eb = z[b] + h[b];
        const hf = Math.max(ea, eb) - Math.max(z[a], z[b]);
        if (hf <= dry) {
          qx[k] = 0;
          continue;
        }
        const q0 = qx[k];
        let q = (q0 - g * hf * dt * ((eb - ea) / cell)) / (1 + (g * dt * n2 * Math.abs(q0)) / Math.pow(hf, 7 / 3));
        // 내보내는 셀이 음수가 되지 않게 (네 면으로 나눠 가진다고 보고 제한)
        const donor = q > 0 ? h[a] : h[b];
        const lim = (donor * cell) / (4 * dt);
        if (q > lim) q = lim;
        else if (q < -lim) q = -lim;
        qx[k] = q;
      }
    }
    // 2) y 방향 유량
    for (let j = Math.max(0, j0 - 1); j <= Math.min(ny - 2, j1); j++) {
      for (let i = i0; i <= i1; i++) {
        const a = j * nx + i, b = a + nx;
        const k = (j + 1) * nx + i;
        const ea = z[a] + h[a], eb = z[b] + h[b];
        const hf = Math.max(ea, eb) - Math.max(z[a], z[b]);
        if (hf <= dry) {
          qy[k] = 0;
          continue;
        }
        const q0 = qy[k];
        let q = (q0 - g * hf * dt * ((eb - ea) / cell)) / (1 + (g * dt * n2 * Math.abs(q0)) / Math.pow(hf, 7 / 3));
        const donor = q > 0 ? h[a] : h[b];
        const lim = (donor * cell) / (4 * dt);
        if (q > lim) q = lim;
        else if (q < -lim) q = -lim;
        qy[k] = q;
      }
    }
    // 3) 가장자리 자유 유출 (한계류 근사)
    const edgeOut = (index: number) => {
      const v = h[index];
      if (v <= dry) return 0;
      return Math.min(v * Math.sqrt(g * v), (v * cell) / (4 * dt));
    };
    if (i0 === 0) for (let j = j0; j <= j1; j++) qx[j * (nx + 1)] = -edgeOut(j * nx);
    if (i1 === nx - 1) for (let j = j0; j <= j1; j++) qx[j * (nx + 1) + nx] = edgeOut(j * nx + nx - 1);
    if (j0 === 0) for (let i = i0; i <= i1; i++) qy[i] = -edgeOut(i);
    if (j1 === ny - 1) for (let i = i0; i <= i1; i++) qy[ny * nx + i] = edgeOut((ny - 1) * nx + i);

    // 4) 수심 갱신
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * nx + i;
        const west = qx[j * (nx + 1) + i];
        const east = qx[j * (nx + 1) + i + 1];
        const north = qy[j * nx + i];
        const south = qy[(j + 1) * nx + i];
        let v = h[c] + (dt * (west - east + north - south)) / cell;
        if (v < 0) v = 0;
        h[c] = v;
      }
    }
    // 가장자리로 나간 양
    if (i0 === 0) for (let j = j0; j <= j1; j++) outflow += -qx[j * (nx + 1)] * cell * dt;
    if (i1 === nx - 1) for (let j = j0; j <= j1; j++) outflow += qx[j * (nx + 1) + nx] * cell * dt;
    if (j0 === 0) for (let i = i0; i <= i1; i++) outflow += -qy[i] * cell * dt;
    if (j1 === ny - 1) for (let i = i0; i <= i1; i++) outflow += qy[ny * nx + i] * cell * dt;

    // 5) 맨홀 월류 유입 (구간 중앙값)
    for (const s of active) {
      const q = sourceFlow(s, t + dt / 2);
      if (q > 0) {
        h[s.index] += (q * dt) / area;
        injected += q * dt;
      }
    }

    t += dt;
    steps++;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * nx + i;
        if (h[c] > maxDepth[c]) {
          maxDepth[c] = h[c];
          maxTime[c] = t;
        }
      }
    }
    if (t >= nextFrame - 1e-6) {
      snapshot();
      nextFrame += params.frameInterval;
    }
    if (steps % 200 === 0) onProgress?.(t);
  }
  if (frameTimes.length === 0 || frameTimes[frameTimes.length - 1] < t - 1e-6) snapshot();
  let stored = 0;
  for (let k = 0; k < N; k++) stored += h[k] * area;
  return { maxDepth, maxTime, frames, frameTimes, injected, outflow, stored, steps };
}

/** 침수 면적 집계 (m²): 수심 구간별. */
export const DEPTH_CLASSES = [0.05, 0.2, 0.5, 1.0];

export function floodAreas(depth: ArrayLike<number>, cell: number, scale = 1): { classes: number[]; total: number; max: number; maxIndex: number } {
  const classes = DEPTH_CLASSES.map(() => 0);
  let max = 0, maxIndex = -1;
  for (let k = 0; k < depth.length; k++) {
    const d = depth[k] * scale;
    if (d > max) [max, maxIndex] = [d, k];
    for (let c = DEPTH_CLASSES.length - 1; c >= 0; c--) {
      if (d >= DEPTH_CLASSES[c]) {
        classes[c] += cell * cell;
        break;
      }
    }
  }
  return { classes, total: classes.reduce((a, b) => a + b, 0), max, maxIndex };
}
