/**
 * 엔진 검증: 물길의 해석 경로와 공식 엔진 결과 비교 (.github/workflows/verify-engines.yml 에서만 돈다).
 *
 *  VERIFY_STAGE=prepare — 물길이 만든 입력을 VERIFY_DIR 에 쓴다
 *    · exported/<망>.inp : 상수 .inp 를 물길로 읽어 다시 내보낸 파일 (다른 프로그램에서 열 때 같은 답이 나오는지)
 *    · swmm/mulgil-design.inp : 물길 하수 자동 설계(예제)가 만든 SWMM 입력
 *  VERIFY_STAGE=compare — 공식 엔진 결과(ref/*.json, verify/ref_*.py 가 만든 것)와 물길 결과를 비교해 compare.json 을 쓴다
 *    · 상수: parseInp → writeInp(forEngine) → runHydraulics → toSimulationResults (앱의 '해석 실행'과 같은 경로)
 *    · 하수: runSwmm(원문) → .out 읽기 (앱의 SWMM 파일 해석과 같은 경로)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { runHydraulics } from '../core/engine/epanetRunner';
import { linkValueAt, nodeValueAt, toSimulationResults } from '../core/engine/simulationManager';
import { parseInp } from '../core/io/inpParser';
import { writeInp } from '../core/io/inpWriter';
import { designSewer } from '../core/sewer/design';
import { generateExportInp } from '../core/sewer/inp';
import { demoProject } from '../core/sewer/types';
import { linkSeriesOf, nodeSeriesOf } from '../core/swmm/outReader';
import { runSwmm } from '../core/swmm/swmmRunner';

const DIR = process.env.VERIFY_DIR ?? '';
const STAGE = process.env.VERIFY_STAGE ?? '';

interface Stat {
  n: number;
  maxAbs: number;
  sumAbs: number;
  maxRel: number;
  worst: string;
}
const stat = (): Stat => ({ n: 0, maxAbs: 0, sumAbs: 0, maxRel: 0, worst: '' });
function add(st: Stat, mine: number | undefined, theirs: number, where: string, floor: number) {
  if (mine === undefined || !Number.isFinite(mine) || !Number.isFinite(theirs)) return;
  const d = Math.abs(mine - theirs);
  st.n++;
  st.sumAbs += d;
  if (d > st.maxAbs) {
    st.maxAbs = d;
    st.worst = `${where}: 물길 ${mine.toFixed(4)} / 공식 ${theirs.toFixed(4)}`;
  }
  // 상대 차이는 값이 아주 작은 곳(floor 미만)은 빼고 본다
  if (Math.abs(theirs) >= floor) st.maxRel = Math.max(st.maxRel, d / Math.abs(theirs));
}
const summary = (s: Record<string, Stat>) =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { n: v.n, maxAbs: v.maxAbs, meanAbs: v.n ? v.sumAbs / v.n : 0, maxRel: v.maxRel, worst: v.worst }]));

const waterNets = () => readdirSync(join(DIR, 'nets')).filter((f) => f.endsWith('.inp')).map((f) => f.replace(/\.inp$/, ''));
const sewerNets = () => readdirSync(join(DIR, 'swmm')).filter((f) => f.endsWith('.inp')).map((f) => f.replace(/\.inp$/, ''));

describe.skipIf(!DIR || STAGE !== 'prepare')('엔진 검증 — 물길 입력 만들기', () => {
  it('상수 .inp 다시 내보내기 · 하수 자동 설계 입력', () => {
    mkdirSync(join(DIR, 'exported'), { recursive: true });
    for (const net of waterNets()) {
      const model = parseInp(readFileSync(join(DIR, 'nets', `${net}.inp`), 'utf8')).model;
      writeFileSync(join(DIR, 'exported', `${net}.inp`), writeInp(model));
    }
    writeFileSync(join(DIR, 'swmm', 'mulgil-design.inp'), generateExportInp(designSewer(demoProject(), {}, 'practical').project));
  });
});

describe.skipIf(!DIR || STAGE !== 'compare')('엔진 검증 — 비교', () => {
  it('상수(EPANET)·하수(SWMM)', { timeout: 900000 }, async () => {
    const report: Record<string, unknown>[] = [];

    for (const net of waterNets()) {
      const parsed = parseInp(readFileSync(join(DIR, 'nets', `${net}.inp`), 'utf8'));
      const raw = await runHydraulics(writeInp(parsed.model, { forEngine: true }));
      const res = toSimulationResults(raw, 0);
      for (const ref of ['owa', 'epa22', 'owa-exported']) {
        const file = join(DIR, 'ref', `${net}.${ref}.json`);
        if (!existsSync(file)) continue;
        const r = JSON.parse(readFileSync(file, 'utf8')) as {
          engine: number;
          nodeIds: string[];
          linkIds: string[];
          steps: { t: number; pressure: number[]; head: number[]; demand: number[]; flow: number[]; velocity: number[] }[];
        };
        const s = { pressure: stat(), head: stat(), demand: stat(), flow: stat(), velocity: stat() };
        let missing = 0;
        for (const step of r.steps) {
          const k = res.times.indexOf(step.t);
          if (k < 0) {
            missing++;
            continue;
          }
          const at = `@${step.t / 3600}h`;
          r.nodeIds.forEach((id, i) => {
            add(s.pressure, nodeValueAt(res, 'pressure', k, id), step.pressure[i], `${id} ${at}`, 1);
            add(s.head, nodeValueAt(res, 'head', k, id), step.head[i], `${id} ${at}`, 1);
            add(s.demand, nodeValueAt(res, 'demand', k, id), step.demand[i], `${id} ${at}`, 0.01);
          });
          r.linkIds.forEach((id, i) => {
            add(s.flow, linkValueAt(res, 'flow', k, id), step.flow[i], `${id} ${at}`, 0.01);
            add(s.velocity, linkValueAt(res, 'velocity', k, id), step.velocity[i], `${id} ${at}`, 0.01);
          });
        }
        report.push({
          kind: 'water',
          net,
          ref,
          refEngine: String(r.engine),
          mulgilEngine: raw.engineVersion,
          units: parsed.model.options.flowUnits,
          nodes: r.nodeIds.length,
          links: r.linkIds.length,
          steps: r.steps.length,
          missingSteps: missing,
          unmatchedIds: r.nodeIds.filter((id) => !res.nodeIndex.has(id)).length + r.linkIds.filter((id) => !res.linkIndex.has(id)).length,
          stats: summary(s),
        });
      }
    }

    for (const net of sewerNets()) {
      const file = join(DIR, 'ref', `${net}.swmm.json`);
      if (!existsSync(file)) continue;
      const r = JSON.parse(readFileSync(file, 'utf8')) as {
        engine: number;
        periods: number;
        nodeIds: string[];
        linkIds: string[];
        depth: number[][];
        head: number[][];
        flow: number[][];
        velocity: number[][];
        continuity: Record<string, number>;
      };
      let run: Awaited<ReturnType<typeof runSwmm>>;
      try {
        run = await runSwmm(readFileSync(join(DIR, 'swmm', `${net}.inp`), 'utf8'));
      } catch (error) {
        report.push({ kind: 'sewer', net, ref: 'swmm', refEngine: String(r.engine), error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const out = run.output;
      const s = { depth: stat(), head: stat(), flow: stat(), velocity: stat() };
      const nIndex = new Map(out.nodeIds.map((id, i) => [id, i]));
      const lIndex = new Map(out.linkIds.map((id, i) => [id, i]));
      r.nodeIds.forEach((id, i) => {
        const k = nIndex.get(id);
        if (k === undefined) return;
        const depth = nodeSeriesOf(out, 'depth', k), head = nodeSeriesOf(out, 'head', k);
        for (let p = 0; p < Math.min(r.periods, out.periods); p++) {
          add(s.depth, depth[p], r.depth[i][p], `${id} #${p}`, 0.01);
          add(s.head, head[p], r.head[i][p], `${id} #${p}`, 0.01);
        }
      });
      r.linkIds.forEach((id, i) => {
        const k = lIndex.get(id);
        if (k === undefined) return;
        const flow = linkSeriesOf(out, 'flow', k), vel = linkSeriesOf(out, 'velocity', k);
        for (let p = 0; p < Math.min(r.periods, out.periods); p++) {
          add(s.flow, flow[p], r.flow[i][p], `${id} #${p}`, 0.001);
          add(s.velocity, vel[p], r.velocity[i][p], `${id} #${p}`, 0.01);
        }
      });
      const mine: Record<string, number> = {};
      for (const m of run.report.matchAll(/\*+\s*\n\s*(Runoff Quantity|Flow Routing|Groundwater|Runoff Quality|Quality Routing) Continuity[\s\S]*?Continuity Error \(%\) \.+\s*(-?[\d.]+)/g)) mine[m[1]] = Number(m[2]);
      report.push({
        kind: 'sewer',
        net,
        ref: 'swmm',
        refEngine: String(r.engine),
        mulgilEngine: run.engineVersion,
        units: out.flowUnits,
        nodes: r.nodeIds.length,
        links: r.linkIds.length,
        steps: r.periods,
        mulgilSteps: out.periods,
        unmatchedIds: r.nodeIds.filter((id) => !nIndex.has(id)).length + r.linkIds.filter((id) => !lIndex.has(id)).length,
        continuity: { official: r.continuity, mulgil: mine },
        stats: summary(s),
      });
    }
    writeFileSync(join(DIR, 'compare.json'), JSON.stringify(report, null, 1));
  });
});
