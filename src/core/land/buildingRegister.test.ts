import { describe, expect, it } from 'vitest';
import { estimateBuildings, type MapBuilding } from '../model/buildingEstimate';
import { householdsByLot, householdsOf, lotKey, parsePnu, registerOverBuildings, type RegisterItem } from './buildingRegister';

const item = (p: Partial<RegisterItem>): RegisterItem => ({
  sigunguCd: '48250', bjdongCd: '10800', platGbCd: '0', bun: '0121', ji: '0002', mainAtchGbCd: '0', mainPurpsCdNm: '공동주택', bldNm: '', dongNm: '', hhldCnt: 0, fmlyCnt: 0, hoCnt: 0, grndFlrCnt: 0, totArea: 0, ...p,
});

describe('건축물대장 세대수', () => {
  it('PNU 풀기', () => {
    expect(parsePnu('4825010800101210002')).toEqual({ sigungu: '48250', bjdong: '10800', plat: '0', bun: '0121', ji: '0002' });
    expect(parsePnu('4825010800201210002')!.plat).toBe('1');
    expect(parsePnu('123')).toBeNull();
    expect(lotKey('48250', '10800', '0', '121', '2')).toBe('4825010800001210002');
  });

  it('용도별 세대수', () => {
    expect(householdsOf(item({ hhldCnt: 134 }))).toEqual({ households: 134, category: '공동주택' });
    expect(householdsOf(item({ mainPurpsCdNm: '단독주택', fmlyCnt: 5 })).households).toBe(5);
    expect(householdsOf(item({ mainPurpsCdNm: '단독주택' })).households).toBe(1);
    expect(householdsOf(item({ mainPurpsCdNm: '제1종근린생활시설', totArea: 600 }))).toEqual({ households: 2, category: '비주거' });
  });

  it('필지로 모으고 부속건물·다른 필지는 뺀다', () => {
    const parcels = [{ pnu: '4825010800101210002', center: [128.87, 35.24] as [number, number] }];
    const r = householdsByLot(parcels, [
      item({ hhldCnt: 134, bldNm: '연지공원푸르지오', dongNm: '102동' }),
      item({ hhldCnt: 122, bldNm: '연지공원푸르지오', dongNm: '104동' }),
      item({ hhldCnt: 50, mainAtchGbCd: '1' }),
      item({ ji: '0009', hhldCnt: 70 }),
    ]);
    expect(r.lots).toHaveLength(1);
    expect(r.lots[0]).toMatchObject({ households: 256, buildings: 2, names: ['연지공원푸르지오 102동', '연지공원푸르지오 104동'] });
    expect(r.matched).toBe(2);
    expect(r.unmatched).toBe(1);
    expect(r.byCategory.공동주택.households).toBe(256);
  });

  it('공장·창고는 세대에서 뺀다', () => {
    expect(householdsOf(item({ mainPurpsCdNm: '공장', totArea: 3000 }))).toEqual({ households: 0, category: '공장·창고' });
    expect(householdsOf(item({ mainPurpsCdNm: '창고시설', totArea: 900 })).households).toBe(0);
    expect(householdsOf(item({ mainPurpsCdNm: '위험물저장및처리시설' })).category).toBe('공장·창고');
    expect(householdsOf(item({ mainPurpsCdNm: '업무시설', totArea: 900 }))).toEqual({ households: 3, category: '비주거' });
  });

  it('지도 건물에 필지의 대장 세대수를 연면적 비율로 나누고, 공장만 있는 필지는 뺀다', () => {
    // 위도 35.24° 부근 약 20 m × 20 m
    const sq = (x: number): [number, number][] => [[x, 35.24], [x + 0.00022, 35.24], [x + 0.00022, 35.2402], [x, 35.2402], [x, 35.24]];
    const b = (id: string, pnu: string, x: number, levels: number): MapBuilding => ({ id, ring: sq(x), tags: { building: 'yes', 'building:levels': String(levels), 'ref:pnu': pnu } });
    const apt = '4825010800101210002', factory = '4825010800100500001', none = '4825010800109990001';
    const r = registerOverBuildings(
      [b('A1', apt, 128.87, 20), b('A2', apt, 128.871, 10), b('F1', factory, 128.872, 2), b('X1', none, 128.873, 3)],
      [
        item({ hhldCnt: 134, dongNm: '102동' }),
        item({ hhldCnt: 122, dongNm: '104동' }),
        item({ bun: '0050', ji: '0001', mainPurpsCdNm: '공장', totArea: 5000 }),
        item({ bun: '0050', ji: '0001', mainPurpsCdNm: '창고시설', totArea: 800 }),
      ],
    );
    expect(r).toMatchObject({ matched: 2, excluded: 1, unmatched: 1 });
    expect(r.buildings.map((x) => x.id).sort()).toEqual(['A1', 'A2', 'X1']);
    const share = (id: string) => Number(r.buildings.find((x) => x.id === id)!.tags['register:households']);
    // 256 세대를 20층 : 10층 = 2 : 1 로
    expect(share('A1')).toBeCloseTo((256 * 2) / 3, 1);
    expect(share('A2')).toBeCloseTo(256 / 3, 1);
    const est = estimateBuildings(r.buildings);
    expect(est.byCategory.공동주택.count).toBe(2);
    expect(est.byCategory.공동주택.households).toBeCloseTo(256, 6);
    // 대장에 없는 건물은 예전처럼 층수·면적으로 짐작
    expect(est.byCategory['용도 미상'].count).toBe(1);
  });
});
