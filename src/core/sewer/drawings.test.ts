import { describe, expect, it } from 'vitest';
import { designSewer } from './design';
import { planDxf, profileDxf, profileStations, quantityCsv, quantityTakeoff, trenchWidth } from './drawings';
import { demoProject } from './types';

describe('하수 성과품', () => {
  const p = demoProject();
  const design = designSewer(p, {}, 'practical');

  it('종단 측점은 가장 먼 상류에서 방류구까지 이어진다', () => {
    const st = profileStations(design.project);
    expect(st[st.length - 1].id).toBe('OF1');
    expect(st[st.length - 1].next).toBeUndefined();
    expect(st.every((s, i) => i === 0 || s.distance > st[i - 1].distance)).toBe(true);
  });

  it('종단면도 DXF 는 기입란·횡단면을 담고 한글을 U+ 이스케이프로 쓴다', () => {
    const text = profileDxf(design.project, profileStations(design.project, 'MH1'));
    expect(text.startsWith('0\r\nSECTION')).toBe(true);
    expect(text.trimEnd().endsWith('EOF')).toBe(true);
    expect(text).toContain('SW_TABLE');
    expect(text).toContain(String.raw`\U+CE21`); // 측
    expect(text).not.toMatch(/[ㄱ-힣]/);
    expect(text).toContain('MH1');
  });

  it('평면도 DXF 에 관거 라벨이 있다', () => {
    expect(planDxf(design.project)).toContain('P01 D');
  });

  it('수량: 관 연장 합계와 맨홀 개수가 관망과 맞다', () => {
    const q = quantityTakeoff(p, design);
    expect(q.totalLength).toBeCloseTo(p.conduits.reduce((s, c) => s + c.length, 0), 6);
    expect(q.manholes.reduce((s, m) => s + m.total, 0)).toBe(8);
    expect(q.outfalls).toBe(1);
    expect(q.earth.excavation).toBeGreaterThan(q.earth.backfill);
    expect(trenchWidth(0.25)).toBe(0.9);
    expect(quantityCsv(q, '예제')).toContain('[맨홀]');
  });
});
