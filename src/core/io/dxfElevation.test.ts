import { describe, expect, it } from 'vitest';
import { parseDxfElevations } from './dxfElevation';

const dxf = (entities: string[]) => ['0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF'].join('\n');

describe('수치지형도 DXF 표고 읽기', () => {
  it('등고선·표고점 레이어만 쓴다', () => {
    const text = dxf([
      '0', 'LWPOLYLINE', '8', 'F0017111', '38', '25.0', '10', '200000', '20', '550000', '10', '200010', '20', '550000',
      '0', 'POINT', '8', 'F0017217', '10', '200005', '20', '550005', '30', '27.4',
      '0', 'TEXT', '8', 'F0017217', '10', '200006', '20', '550006', '30', '0', '1', '28.1',
      '0', 'LWPOLYLINE', '8', 'B0014110', '38', '12.0', '10', '200001', '20', '550001', '10', '200002', '20', '550002',
      '0', 'POLYLINE', '8', 'F0017114', '66', '1', '0', 'VERTEX', '8', 'F0017114', '10', '200100', '20', '550100', '30', '30.0', '0', 'SEQEND',
    ]);
    const r = parseDxfElevations(text);
    expect(r.usedTerrainLayers).toBe(true);
    expect(r.points.map((p) => p.z).sort()).toEqual([25, 25, 27.4, 28.1, 30]);
    expect(r.points.filter((p) => p.line >= 0 && p.z === 25)).toHaveLength(2);
  });
  it('코드 레이어가 없으면 Z 가 있는 객체를 모두 쓴다', () => {
    const r = parseDxfElevations(dxf(['0', 'POINT', '8', 'SURVEY', '10', '1', '20', '2', '30', '5.5']));
    expect(r.usedTerrainLayers).toBe(false);
    expect(r.points).toEqual([{ xy: [1, 2], z: 5.5, layer: 'SURVEY', line: -1 }]);
  });
});
