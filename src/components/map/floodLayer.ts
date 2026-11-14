/** 침수 수심 격자를 지도에 그리는 deck.gl BitmapLayer (수심 구간별 파란 색조). */
import { BitmapLayer } from '@deck.gl/layers';
import type { GridFrame } from '../../core/flood/prepare';
import type { SewerFrame } from '../../core/sewer/mapFrame';
import { xyToLngLat } from '../../core/sewer/mapFrame';

/** 범례와 같은 구간 (m): [하한, RGBA] */
export const FLOOD_COLORS: [number, [number, number, number, number]][] = [
  [0.01, [198, 225, 245, 110]],
  [0.05, [140, 195, 235, 170]],
  [0.2, [66, 146, 214, 200]],
  [0.5, [33, 92, 180, 215]],
  [1.0, [10, 40, 120, 230]],
];

export const FLOOD_LAYER_ID = 'flood-depth';

/** values: 수심 (scale 을 곱하면 m). */
export function floodCanvas(frame: GridFrame, values: ArrayLike<number>, scale = 1): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = frame.nx;
  canvas.height = frame.ny;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(frame.nx, frame.ny);
  for (let k = 0; k < values.length; k++) {
    const d = values[k] * scale;
    if (d < FLOOD_COLORS[0][0]) continue;
    let c = FLOOD_COLORS[0][1];
    for (const [min, rgba] of FLOOD_COLORS) if (d >= min) c = rgba;
    img.data.set(c, k * 4);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function buildFloodLayer(frame: GridFrame, geo: SewerFrame, image: HTMLCanvasElement, key: string): BitmapLayer {
  const left = frame.xmin;
  const right = frame.xmin + frame.nx * frame.cell;
  const top = frame.ymax;
  const bottom = frame.ymax - frame.ny * frame.cell;
  const c = (x: number, y: number) => xyToLngLat(geo, x, y) as [number, number];
  return new BitmapLayer({
    id: FLOOD_LAYER_ID,
    image,
    // 왼쪽 아래, 왼쪽 위, 오른쪽 위, 오른쪽 아래
    bounds: [c(left, bottom), c(left, top), c(right, top), c(right, bottom)],
    textureParameters: { minFilter: 'nearest', magFilter: 'nearest' },
    updateTriggers: { image: key },
  });
}
