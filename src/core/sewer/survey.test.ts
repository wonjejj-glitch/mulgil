import { describe, expect, it } from 'vitest';
import { applySurveyLevels, asBuiltDesign, parseSurveyCsv } from './survey';
import { demoProject } from './types';

describe('맨홀 측량 성과 반영', () => {
  it('머리글 이름으로 열을 찾는다', () => {
    const { rows, columns } = parseSurveyCsv('﻿맨홀번호,관저고(m),지반고(m),비고\nMH1,102.1,104.05,\nMH2,,103.5,\nX9,1,2,');
    expect(columns).toEqual(['맨홀번호', '지반고(m)', '관저고(m)']);
    expect(rows).toEqual([
      { id: 'MH1', ground: 104.05, invert: 102.1 },
      { id: 'MH2', ground: 103.5 },
      { id: 'X9', ground: 2, invert: 1 },
    ]);
  });
  it('깊이만 있으면 지반고 − 깊이로 관저고를 넣고, 모르는 번호는 알려 준다', () => {
    const p = demoProject();
    const r = applySurveyLevels(p, [{ id: 'mh3', depth: 2 }, { id: 'MH1', ground: 104, invert: 104.5 }, { id: 'ZZ', ground: 1 }]);
    expect(r.matched).toBe(1);
    expect(r.unknown).toEqual(['ZZ']);
    expect(r.rejected).toEqual(['MH1']);
    expect(p.nodes.find((n) => n.id === 'MH3')!.invert).toBeCloseTo(102.2, 6);
  });
  it('현황 해석은 관저고를 바꾸지 않고 역경사를 잡아낸다', () => {
    const p = demoProject();
    p.nodes.find((n) => n.id === 'MH2')!.invert = 102.5; // MH1(102.2) 보다 높게 → P01 역경사
    const d = asBuiltDesign(p);
    expect(d.project.nodes.find((n) => n.id === 'MH2')!.invert).toBe(102.5);
    expect(d.rows.find((r) => r.id === 'P01')!.status).toContain('역경사');
    expect(d.feasible).toBe(false);
  });
});
