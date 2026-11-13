/**
 * 지반고(표고) 추출.
 *  - 온라인 지형 타일: AWS Open Data 'Terrain Tiles'(Terrarium PNG). 키 없이 쓸 수 있고, 국내는 SRTM 30 m 급 자료라
 *    수직 오차가 수 m 다. 대략적인 보정·검토용.
 *  - 수치지형도(표고점·등고선): 사용자가 가진 Shapefile 의 점·선 꼭짓점 표고를 역거리가중(IDW)으로 보간한다.
 * 이 파일은 순수 계산(타일 좌표·디코딩·보간)만 담는다. 실제 내려받기는 app/terrainFetch.ts.
 */
import type { LngLat } from '../model/types';

/* ------------------------------------------------------------------ 타일 좌표 */

export const TERRAIN_TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TILE_SIZE = 256;

/** 경위도 → 타일 내 실수 픽셀 좌표 (Web Mercator). */
export function lngLatToTilePixel(p: LngLat, z: number): { tx: number; ty: number; px: number; py: number } {
  const n = 2 ** z;
  const x = ((p[0] + 180) / 360) * n;
  const latRad = (p[1] * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  return { tx, ty, px: (x - tx) * TILE_SIZE, py: (y - ty) * TILE_SIZE };
}

/** Terrarium 인코딩: 표고(m) = R·256 + G + B/256 − 32768. */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** RGBA 타일 픽셀 배열에서 (px, py) 의 표고를 쌍선형 보간으로 읽는다. 타일 경계는 가장자리 값으로 자른다. */
export function sampleTerrarium(rgba: Uint8ClampedArray, px: number, py: number, size = TILE_SIZE): number {
  const fx = Math.max(0, Math.min(size - 1, px - 0.5));
  const fy = Math.max(0, Math.min(size - 1, py - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const at = (x: number, y: number) => {
    const i = (y * size + x) * 4;
    return decodeTerrarium(rgba[i], rgba[i + 1], rgba[i + 2]);
  };
  const tx = fx - x0;
  const ty = fy - y0;
  return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
}

/* ------------------------------------------------------------------ 표고점 IDW */

export interface ElevationPoint {
  position: LngLat;
  z: number;
}

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_EQ = 111320;

/** 표고점·등고선 꼭짓점들로 만든 보간기. 반경 안 가까운 k 개 점을 거리 제곱 역수로 가중 평균한다. */
export class IdwInterpolator {
  private cells = new Map<string, number[]>();
  private xs: Float64Array;
  private ys: Float64Array;
  private zs: Float64Array;
  private kx: number;
  private origin: LngLat;

  constructor(
    points: ElevationPoint[],
    private radius = 300,
    private k = 8,
    private cell = 100,
  ) {
    this.origin = points[0]?.position ?? [127, 37];
    this.kx = M_PER_DEG_LNG_EQ * Math.cos((this.origin[1] * Math.PI) / 180);
    this.xs = new Float64Array(points.length);
    this.ys = new Float64Array(points.length);
    this.zs = new Float64Array(points.length);
    points.forEach((p, i) => {
      const x = (p.position[0] - this.origin[0]) * this.kx;
      const y = (p.position[1] - this.origin[1]) * M_PER_DEG_LAT;
      this.xs[i] = x;
      this.ys[i] = y;
      this.zs[i] = p.z;
      const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    });
  }

  get size(): number {
    return this.zs.length;
  }

  /** 보간 표고. 반경 안에 점이 없으면 undefined. 0.5 m 안에 점이 있으면 그 값. */
  at(p: LngLat): { z: number; nearest: number } | undefined {
    const x = (p[0] - this.origin[0]) * this.kx;
    const y = (p[1] - this.origin[1]) * M_PER_DEG_LAT;
    const r = Math.ceil(this.radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const near: { d: number; z: number }[] = [];
    for (let i = cx - r; i <= cx + r; i++) {
      for (let j = cy - r; j <= cy + r; j++) {
        for (const idx of this.cells.get(`${i},${j}`) ?? []) {
          const d = Math.hypot(this.xs[idx] - x, this.ys[idx] - y);
          if (d <= this.radius) near.push({ d, z: this.zs[idx] });
        }
      }
    }
    if (near.length === 0) return undefined;
    near.sort((a, b) => a.d - b.d);
    if (near[0].d < 0.5) return { z: near[0].z, nearest: near[0].d };
    let num = 0;
    let den = 0;
    for (const { d, z } of near.slice(0, this.k)) {
      const w = 1 / (d * d);
      num += w * z;
      den += w;
    }
    return { z: num / den, nearest: near[0].d };
  }
}

/** 표고 속성 이름 후보 (소문자). 국토지리정보원 수치지형도: 등고선 CONT, 표고점 NUME 등. */
const Z_FIELDS = ['cont', 'nume', 'elev', 'elevation', 'height', 'hgt', 'z', 'alt', '표고', '높이', '등고수치', '수치'];

/** 속성에서 표고 값을 찾는다. 없으면 undefined. */
export function elevationFromProperties(properties: Record<string, unknown> | null | undefined): number | undefined {
  if (!properties) return undefined;
  for (const key of Object.keys(properties)) {
    if (!Z_FIELDS.includes(key.toLowerCase())) continue;
    const v = Number(properties[key]);
    if (Number.isFinite(v) && v > -500 && v < 9000) return v;
  }
  return undefined;
}

/** 선(등고선) 꼭짓점 사이를 간격 m 로 채운 점들. 등고선 위에서는 표고가 같으므로 모두 같은 z. */
export function densify(line: LngLat[], spacing: number): LngLat[] {
  const out: LngLat[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const kx = M_PER_DEG_LNG_EQ * Math.cos((ay * Math.PI) / 180);
    const len = Math.hypot((bx - ax) * kx, (by - ay) * M_PER_DEG_LAT);
    const n = Math.max(1, Math.ceil(len / spacing - 1e-6));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  if (line.length > 0) out.push(line[line.length - 1]);
  return out;
}
