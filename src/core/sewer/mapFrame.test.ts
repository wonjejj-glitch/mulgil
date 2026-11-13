import { describe, expect, it } from 'vitest';
import { DEFAULT_ANCHOR, distanceMeters } from '../../utils/geoMath';
import { georeference, lngLatToXy, nodeLngLat, nodePositions, sewerFrame, xyToLngLat } from './mapFrame';
import { demoProject } from './types';

describe('하수 좌표 ↔ 지도', () => {
  it('EPSG:5186 좌표는 그대로 왕복한다', () => {
    const frame = sewerFrame({ nodes: [{ ...demoProject().nodes[0], x: 234000, y: 417000 }] });
    expect(frame.kind).toBe('epsg');
    const lngLat = xyToLngLat(frame, 234000, 417000);
    expect(lngLat[0]).toBeGreaterThan(127);
    expect(lngLat[0]).toBeLessThan(128);
    expect(lngLat[1]).toBeGreaterThan(36);
    const [x, y] = lngLatToXy(frame, lngLat);
    expect(x).toBeCloseTo(234000, 3);
    expect(y).toBeCloseTo(417000, 3);
  });

  it('절점이 없으면 5186 으로 본다', () => {
    expect(sewerFrame({ nodes: [] }).kind).toBe('epsg');
  });

  it('도면 좌표(예제)는 기준 위치에 임의 평면으로 놓고 왕복한다', () => {
    const project = demoProject();
    const frame = sewerFrame(project);
    expect(frame.kind).toBe('local');
    const positions = nodePositions(project, frame);
    // 좌표 범위의 중심이 기준 위치
    const center = xyToLngLat(frame, 305, 100);
    expect(center[0]).toBeCloseTo(DEFAULT_ANCHOR[0], 7);
    expect(center[1]).toBeCloseTo(DEFAULT_ANCHOR[1], 7);
    for (const n of project.nodes) {
      const [x, y] = lngLatToXy(frame, positions.get(n.id)!);
      expect(x).toBeCloseTo(n.x, 4);
      expect(y).toBeCloseTo(n.y, 4);
    }
    // 지도 위 거리 ≈ 도면 거리 (MH1–MH2 = 125 m)
    expect(Math.abs(distanceMeters(positions.get('MH1')!, positions.get('MH2')!) - 125)).toBeLessThan(1);
  });

  it('georeference: 보이는 위치를 유지한 채 5186 으로 옮긴다', () => {
    const project = demoProject();
    const before = nodePositions(project);
    expect(georeference(project)).toBe(true);
    expect(sewerFrame(project).kind).toBe('epsg');
    const frame = sewerFrame(project);
    for (const n of project.nodes) expect(distanceMeters(before.get(n.id)!, nodeLngLat(frame, n))).toBeLessThan(0.01);
    // 절점 사이 평면 거리도 그대로 (중부원점 근처 축척 ≈ 1)
    const a = project.nodes[0];
    const b = project.nodes[1];
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(125, 3);
    expect(georeference(project)).toBe(false);
  });
});
