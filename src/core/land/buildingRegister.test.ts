import { describe, expect, it } from 'vitest';
import { householdsByLot, householdsOf, lotKey, parsePnu, type RegisterItem } from './buildingRegister';

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
});
