import { describe, expect, it } from 'vitest';
import sampleInp from '../../../public/samples/sample-district.inp?raw';
import sewerInp from '../../../public/samples/sample-sewer.inp?raw';
import { readSwmmInp } from '../swmm/inpReader';
import { anonymizeInp, PRESENT_TITLE } from './inpAnonymize';
import { parseInp } from './inpParser';
import { writeInp } from './inpWriter';
import { runHydraulics } from '../engine/epanetRunner';
import { toSimulationResults } from '../engine/simulationManager';

/** 샘플의 패턴 이름·첫 절점 이름을 한글 지명처럼 바꾸고 주석·태그·지도 글씨를 붙인 판 */
function withPlaceNames(): string {
  const firstJunction = parseInp(sampleInp).model.nodes;
  const jid = Object.values(firstJunction).find((n) => n.type === 'junction')!.id;
  const re = new RegExp(`(^|\\s)${jid}(?=\\s)`, 'gm');
  return (
    sampleInp.replace(/\bDAY\b/g, '가나배수지패턴').replace(re, `$1다라동절점`).replace('[JUNCTIONS]', '[JUNCTIONS]\n;마바가압장 계통') +
    '\n[TAGS]\nLINK P1 마바로_관로\n\n[LABELS]\n 127.4 36.8 "가나읍"\n'
  );
}

describe('발표용 보기 — .inp 이름 지우기', () => {
  it('한글 이름·주석·제목·태그·지도 글씨가 남지 않는다', () => {
    const r = anonymizeInp(withPlaceNames());
    expect(/[가-힣]/.test(r.text.replace(PRESENT_TITLE, ''))).toBe(false);
    expect(r.text).toContain('PAT1');
    expect(r.text).toContain('N1');
    expect(r.text).not.toContain('[TAGS]');
    expect(r.text).not.toContain('[LABELS]');
    expect(r.renamed).toBe(2);
    const m = parseInp(r.text).model;
    expect(m.title).toEqual([PRESENT_TITLE]);
    expect(Object.keys(m.patterns)).toEqual(['PAT1']);
    expect(m.nodes.N1).toBeDefined();
  });

  it('이름만 바뀌고 해석 결과(수압·유량)는 원본과 같다', async () => {
    const orig = parseInp(withPlaceNames()).model;
    const anon = parseInp(anonymizeInp(withPlaceNames()).text).model;
    const a = toSimulationResults(await runHydraulics(writeInp(orig, { forEngine: true })), 0);
    const b = toSimulationResults(await runHydraulics(writeInp(anon, { forEngine: true })), 0);
    expect(b.stepCount).toBe(a.stepCount);
    expect(Array.from(b.node.pressure)).toEqual(Array.from(a.node.pressure));
    expect(Array.from(b.link.flow)).toEqual(Array.from(a.link.flow));
  });

  it('숫자·영문 ID 는 그대로 둔다', () => {
    const r = anonymizeInp(sampleInp);
    const a = parseInp(sampleInp).model;
    const b = parseInp(r.text).model;
    expect(Object.keys(b.nodes)).toEqual(Object.keys(a.nodes));
    expect(Object.keys(b.links)).toEqual(Object.keys(a.links));
    expect(r.renamed).toBe(0);
  });

  it('하수(SWMM) .inp 도 이름만 바뀌고 절점·관거·유역은 같다', () => {
    const named = sewerInp.replace(/\bJ1\b/g, '가나맨홀').replace(/\bS1\b/g, '다라유역').replace('[JUNCTIONS]', '[JUNCTIONS]\n;마바동 계통');
    const r = anonymizeInp(named);
    expect(/[가-힣]/.test(r.text.replace(PRESENT_TITLE, ''))).toBe(false);
    const a = readSwmmInp(named);
    const b = readSwmmInp(r.text);
    expect(b.title).toBe(PRESENT_TITLE);
    expect(b.nodes.map((n) => [n.kind, n.invert, n.position])).toEqual(a.nodes.map((n) => [n.kind, n.invert, n.position]));
    expect(b.links.map((l) => [l.shape, l.geom1, l.length])).toEqual(a.links.map((l) => [l.shape, l.geom1, l.length]));
    expect(b.subcatchments.map((x) => x.polygon)).toEqual(a.subcatchments.map((x) => x.polygon));
    expect(b.warnings).toEqual(a.warnings);
  });
});
