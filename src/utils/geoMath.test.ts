import { describe, expect, it } from 'vitest';
import {
  detectCrs,
  distanceMeters,
  epsgToWgs84,
  fromWgs84,
  midpointOfPath,
  pathLengthMeters,
  projectOntoPath,
  toWgs84,
  wgs84ToEpsg,
} from './geoMath';

describe('구 중부원점(5174) 과 5186 구분', () => {
  it('같은 좌표라도 5174 와 5186 은 남북으로 약 100 km 어긋난다 (실제 관망 사례)', () => {
    const hp240: [number, number] = [152870.8, 176194.9];
    const old = toWgs84({ kind: 'epsg', code: 'EPSG:5174' }, hp240);
    const grs = toWgs84({ kind: 'epsg', code: 'EPSG:5186' }, hp240);
    // 전남 서부 부근: 동경 126.5°, 북위 35.05~35.15°
    expect(old[0]).toBeGreaterThan(126.4);
    expect(old[0]).toBeLessThan(126.6);
    expect(old[1]).toBeGreaterThan(35.0);
    expect(old[1]).toBeLessThan(35.15);
    expect(old[1] - grs[1]).toBeGreaterThan(0.85); // 5186 해석은 약 100 km 남쪽 (서해·남해 쪽)
    expect(distanceMeters(old, grs)).toBeGreaterThan(90000);
  });
});

describe('좌표 변환', () => {
  it('EPSG:5186 원점은 (127°E, 38°N) 이다', () => {
    const [lng, lat] = epsgToWgs84('EPSG:5186', [200000, 600000]);
    expect(lng).toBeCloseTo(127, 6);
    expect(lat).toBeCloseTo(38, 6);
  });

  it('EPSG:5179 원점은 (127.5°E, 38°N) 이다', () => {
    const [x, y] = wgs84ToEpsg('EPSG:5179', [127.5, 38]);
    expect(x).toBeCloseTo(1000000, 2);
    expect(y).toBeCloseTo(2000000, 2);
  });

  it('왕복 변환이 일치한다', () => {
    const crs = { kind: 'epsg', code: 'EPSG:5186' } as const;
    const xy: [number, number] = [234123.456, 417654.321];
    const back = fromWgs84(crs, toWgs84(crs, xy));
    expect(back[0]).toBeCloseTo(xy[0], 3);
    expect(back[1]).toBeCloseTo(xy[1], 3);

    const local = { kind: 'local', origin: [50, 50], anchor: [126.978, 37.5665], metersPerUnit: 160 } as const;
    const p: [number, number] = [20, 70];
    const q = fromWgs84({ ...local, origin: [50, 50], anchor: [126.978, 37.5665] }, toWgs84({ ...local, origin: [50, 50], anchor: [126.978, 37.5665] }, p));
    expect(q[0]).toBeCloseTo(20, 6);
    expect(q[1]).toBeCloseTo(70, 6);
  });
});

describe('detectCrs', () => {
  it('좌표 범위로 좌표계를 추정한다', () => {
    expect(detectCrs([[127.1, 37.5], [127.2, 37.6]])).toBe('wgs84');
    expect(detectCrs([[234000, 417000], [235000, 418000]])).toBe('EPSG:5186');
    expect(detectCrs([[953000, 1952000], [954000, 1953000]])).toBe('EPSG:5179');
    expect(detectCrs([[10, 10], [70, 90]])).toBe('local');
    expect(detectCrs([[5000, 3000], [9000, 7000]])).toBe('local');
  });
});

describe('거리·형상 계산', () => {
  it('위도 1분은 약 1852 m 이다', () => {
    expect(pathLengthMeters([[127, 37], [127, 37 + 1 / 60]])).toBeGreaterThan(1840);
    expect(pathLengthMeters([[127, 37], [127, 37 + 1 / 60]])).toBeLessThan(1860);
    expect(distanceMeters([127, 37], [127, 37 + 1 / 60])).toBeCloseTo(1842.3, 0);
  });

  it('경로 중간점과 진행 방향을 구한다', () => {
    const east = midpointOfPath([[127, 37], [127.002, 37]]);
    expect(east.position[0]).toBeCloseTo(127.001, 6);
    expect(east.angle).toBeCloseTo(0, 3);
    const north = midpointOfPath([[127, 37], [127, 37.002]]);
    expect(north.angle).toBeCloseTo(90, 3);
  });

  it('점을 경로 위로 투영한다', () => {
    const projection = projectOntoPath([[127, 37], [127.002, 37], [127.002, 37.002]], [127.001, 37.0001]);
    expect(projection.segmentIndex).toBe(0);
    expect(projection.point[1]).toBeCloseTo(37, 6);
    expect(projection.ratio).toBeGreaterThan(0.15);
    expect(projection.ratio).toBeLessThan(0.3);
  });
});
