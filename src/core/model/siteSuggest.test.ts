import { describe, expect, it } from 'vitest';
import { edgeAround, gridAround, suggestOutfallSites, suggestReservoirSites, type GroundPoint } from './siteSuggest';
import type { LngLat } from './types';

// 동쪽으로 갈수록 높아지는 땅: 지반고 = 10 + (경도 차 × 1 km 당 20 m)
const groundAt = ([lng]: LngLat) => 10 + ((lng - 128.88) * 111320 * Math.cos((35.24 * Math.PI) / 180)) / 1000 * 20;
const pt = (lng: number, lat: number): GroundPoint => ({ position: [lng, lat], ground: groundAt([lng, lat]) });

describe('배수지·방류구 후보', () => {
  const customers = Array.from({ length: 20 }, (_, i) => ({ ...pt(128.88 + (i % 5) * 0.002, 35.24 + Math.floor(i / 5) * 0.002), demand: 10 }));
  const box: [number, number, number, number] = [128.88, 35.24, 128.888, 35.246];

  it('자연유하로 모든 수용가에 최소 수압을 줄 수 있는 높은 땅을 고르고 용량을 계산한다', () => {
    const grid = gridAround(box, 2000, 900).map((p) => ({ position: p, ground: groundAt(p) }));
    const r = suggestReservoirSites(customers, grid);
    expect(r.sites.length).toBeGreaterThan(0);
    for (const s of r.sites) {
      expect(s.hwl).toBeGreaterThanOrEqual(s.requiredHwl - 0.05);
      // 필요 수위 ≥ 가장 높은 수용가 + 최소 수압
      expect(s.requiredHwl).toBeGreaterThanOrEqual(r.maxGround + 15.3 - 0.05);
      // 땅이 동쪽으로 높아지므로 후보는 수용가보다 동쪽
      expect(s.position[0]).toBeGreaterThan(128.888);
    }
    expect(r.dailyAverage).toBeCloseTo(200, 6);
    expect(r.dailyMax).toBeCloseTo(260, 6);
    expect(r.volume).toBeCloseTo(130, 6);
  });

  it('주변이 모두 낮으면 가압 양정을 낸다', () => {
    const flat = gridAround(box, 500, 200).map((p) => ({ position: p, ground: 5 }));
    const r = suggestReservoirSites(customers, flat);
    expect(r.sites).toHaveLength(0);
    expect(r.booster!.head).toBeGreaterThan(15);
  });

  it('방류구는 가장 낮은 곳부터 서로 떨어진 3곳', () => {
    const edge = edgeAround(box, 200).map((p) => ({ position: p, ground: groundAt(p), kind: 'edge' as const }));
    const out = suggestOutfallSites([...edge, ...customers.map((c) => ({ ...c, kind: 'customer' as const }))]);
    expect(out).toHaveLength(3);
    expect(out[0].ground).toBeLessThanOrEqual(out[1].ground);
    // 가장 낮은 곳은 서쪽 가장자리
    expect(out[0].position[0]).toBeLessThan(128.88);
  });
});
