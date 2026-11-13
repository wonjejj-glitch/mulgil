import { describe, expect, it } from 'vitest';
import { shiftLngLat } from '../model/roadAlign';
import type { LngLat } from '../model/types';
import { decodeTerrarium, densify, elevationFromProperties, IdwInterpolator, lngLatToTilePixel, sampleTerrarium } from './elevation';

describe('Terrarium 지형 타일', () => {
  it('RGB 를 표고로 디코딩한다', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    expect(decodeTerrarium(128, 100, 128)).toBeCloseTo(100.5, 6);
    expect(decodeTerrarium(127, 255, 0)).toBe(-1);
  });

  it('경위도를 타일·픽셀로 바꾼다 (z0 에서 (0,0) 은 타일 가운데)', () => {
    const t = lngLatToTilePixel([0, 0], 0);
    expect([t.tx, t.ty]).toEqual([0, 0]);
    expect(t.px).toBeCloseTo(128, 6);
    expect(t.py).toBeCloseTo(128, 6);
    const k = lngLatToTilePixel([126.5, 35.07], 13);
    expect(k.tx).toBe(Math.floor(((126.5 + 180) / 360) * 8192));
  });

  it('쌍선형 보간으로 픽셀 사이 값을 읽는다', () => {
    // 2×2 타일: 왼쪽 열 10 m, 오른쪽 열 20 m
    const rgba = new Uint8ClampedArray(2 * 2 * 4);
    const put = (x: number, y: number, z: number) => {
      const v = z + 32768;
      const i = (y * 2 + x) * 4;
      rgba[i] = Math.floor(v / 256);
      rgba[i + 1] = Math.floor(v % 256);
      rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    };
    put(0, 0, 10);
    put(0, 1, 10);
    put(1, 0, 20);
    put(1, 1, 20);
    expect(sampleTerrarium(rgba, 1.0, 1.0, 2)).toBeCloseTo(15, 6);
    expect(sampleTerrarium(rgba, 0.5, 0.5, 2)).toBeCloseTo(10, 6);
  });
});

describe('수치지형도 표고점 보간', () => {
  const O: LngLat = [126.5, 35.07];
  const at = (e: number, n: number) => shiftLngLat(O, e, n);

  it('평면(z = 0.1·동쪽거리) 위 표고점들로 가운데 값을 근사한다', () => {
    const pts = [];
    for (let e = -200; e <= 200; e += 50) for (let n = -200; n <= 200; n += 50) pts.push({ position: at(e, n), z: 20 + 0.1 * e });
    const idw = new IdwInterpolator(pts, 300, 8);
    expect(idw.at(at(25, 25))!.z).toBeCloseTo(22.5, 0);
    expect(idw.at(at(0, 0))!.z).toBeCloseTo(20, 6); // 표고점 바로 위
    expect(idw.at(at(5000, 0))).toBeUndefined(); // 반경 밖
  });

  it('속성에서 표고를 찾고, 등고선을 일정 간격 점으로 채운다', () => {
    expect(elevationFromProperties({ CONT: 35 })).toBe(35);
    expect(elevationFromProperties({ NUME: '12.4' })).toBe(12.4);
    expect(elevationFromProperties({ NAME: 'x' })).toBeUndefined();
    const pts = densify([at(0, 0), at(100, 0)], 10);
    expect(pts).toHaveLength(11);
  });
});
