import { describe, expect, it } from 'vitest';
import { allocateDemand, allocationCsv, m3dToFlowUnits } from './landUse';
import { plane } from './roadSnap';
import type { LngLat, NetworkModel } from './types';

const P = plane([127, 37.5]);
const at = (x: number, y: number): LngLat => P.from([x, y]);
const square = (x0: number, y0: number, s: number): LngLat[] => [at(x0, y0), at(x0 + s, y0), at(x0 + s, y0 + s), at(x0, y0 + s), at(x0, y0)];
const junction = (id: string, x: number, y: number) => ({ id, type: 'junction' as const, position: at(x, y), elevation: 0, demand: 0, pattern: '' });

const model: Pick<NetworkModel, 'nodes'> = {
  nodes: {
    J1: junction('J1', 50, 50),
    J2: junction('J2', 60, 60),
    J3: junction('J3', 400, 50),
    R1: { id: 'R1', type: 'reservoir', position: at(55, 55), elevation: 50, pattern: '' },
  },
};

describe('land-use allocated demand', () => {
  it('shares area × rate among junctions inside, or the nearest one outside', () => {
    const parcels = [
      { id: 'A', use: '주거', rings: [square(0, 0, 100)] }, // 1 ha, J1·J2 안
      { id: 'B', use: '업무', rings: [square(200, 0, 100)] }, // 1 ha, 안에 절점 없음 → 중심(250,50)에서 J3 150 m
      { id: 'C', use: '미정', rings: [square(0, 300, 50)] },
    ];
    const result = allocateDemand(model, parcels, { 주거: 20, 업무: 40 }, { maxConnectDistance: 200 });
    expect(result.perNode.J1).toBeCloseTo(10, 1);
    expect(result.perNode.J2).toBeCloseTo(10, 1);
    expect(result.perNode.J3).toBeCloseTo(40, 1);
    expect(result.perNode.R1).toBeUndefined();
    expect(result.skipped.map((s) => s.parcel)).toEqual(['C']);
    expect(result.rows.find((r) => r.parcel === 'B')!.method).toBe('연결관(최근접)');
    expect(allocationCsv(result, 'LPS')).toContain('합계,60.0');
  });

  it('subtracts holes and respects the connect distance', () => {
    const parcels = [{ id: 'H', use: '주거', rings: [square(0, 0, 100), square(40, 40, 30)] }];
    const r = allocateDemand(model, parcels, { 주거: 10 }, { maxConnectDistance: 10 });
    // J1(50,50)·J2(60,60) 은 구멍 안 → 구역 안 절점 없음, 중심(50,50)에서 10 m 안: J1
    expect(r.totalArea).toBeCloseTo(0.91, 2);
    expect(Object.keys(r.perNode)).toEqual(['J1']);
  });

  it('converts m³/day to model units', () => {
    expect(m3dToFlowUnits(86.4, 'LPS')).toBeCloseTo(1, 9);
    expect(m3dToFlowUnits(100, 'CMD')).toBeCloseTo(100, 9);
  });
});
