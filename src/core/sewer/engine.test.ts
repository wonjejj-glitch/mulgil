import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSwmm } from '../swmm/swmmRunner';
import { designSewer } from './design';
import { generateInp } from './inp';
import { optimizeSewer } from './optimize';
import { parseReport, summarizeSimulation, type SimulationSummary } from './report';
import { demoProject } from './types';
import { parseSewerProject } from './validate';

const FX = join(__dirname, 'fixtures');
const read = (p: string) => JSON.parse(readFileSync(join(FX, p), 'utf8'));

/** 우리 앱의 SWMM WASM(5.2.2)으로 해석한 요약 — 원본 SewerStudio 의 공식 5.2.4 결과와 비교한다. */
async function simulateWasm(design: ReturnType<typeof designSewer>): Promise<SimulationSummary> {
  const { report } = await runSwmm(generateInp(design.project));
  return summarizeSimulation(design.project, parseReport(report, design.project));
}

describe('실제 SWMM WASM 으로 설계→해석→반복 (SewerStudio 의 공식 엔진 5.2.4 결과와 대조)', () => {
  it('기본 예제: 설계한 관망이 월류 없이 해석되고 연속성 오차가 작다', async () => {
    const design = designSewer(demoProject());
    expect(design.feasible).toBe(true);
    const sim = await simulateWasm(design);
    const expected = read('optimize/demo/iteration_01/simulation.json') as SimulationSummary;
    expect(sim.quality_ok).toBe(true);
    expect(Object.values(sim.node_summary).every((n) => n.flood_hours === 0 && !n.surcharged)).toBe(true);
    // 5.2.2(WASM) 와 5.2.4(원본) 의 연속성 오차는 같은 자릿수여야 한다
    expect(Math.abs(sim.continuity['Flow Routing Continuity'])).toBeLessThan(1);
    expect(Math.abs(sim.continuity['Flow Routing Continuity'] - expected.continuity['Flow Routing Continuity'])).toBeLessThan(0.2);
    // 관로별 최대 유량·유속·충만도가 원본 엔진 결과와 가깝다
    for (const [id, l] of Object.entries(expected.link_summary)) {
      const mine = sim.link_summary[id];
      expect(Math.abs(mine.max_flow - l.max_flow), `${id} 유량`).toBeLessThanOrEqual(0.02 + 0.05 * l.max_flow);
      expect(Math.abs(mine.max_velocity - l.max_velocity), `${id} 유속`).toBeLessThanOrEqual(0.15);
      expect(Math.abs(mine.max_depth_ratio - l.max_depth_ratio), `${id} d/D`).toBeLessThanOrEqual(0.06);
    }
  }, 60000);

  it('용량 부족 예제(설계 15 mm/h, 실제 55 mm/h): 원본과 같이 관경을 키워 가며 수렴한다', async () => {
    const project = parseSewerProject(read('optimize/stress/project.json'));
    const outcome = await optimizeSewer(project, (design) => simulateWasm(design));
    const trace = read('optimize/stress/trace.json') as { history: { critical_links: string[] }[]; converged: boolean };
    expect(outcome.converged).toBe(true);
    expect(outcome.history.length).toBeLessThanOrEqual(trace.history.length + 1);
    // 1회차에는 용량 부족 관로가 많고, 마지막에는 0
    expect(outcome.history[0].critical_links.length).toBeGreaterThan(3);
    expect(outcome.history[outcome.history.length - 1].critical_links).toEqual([]);
    // 관경은 단조롭게 커진다
    const first = outcome.iterations[0].design.project.conduits;
    const last = outcome.iterations[outcome.iterations.length - 1].design.project.conduits;
    last.forEach((c, i) => expect(c.diameter).toBeGreaterThanOrEqual(first[i].diameter));
    expect(last.some((c, i) => c.diameter > first[i].diameter)).toBe(true);
  }, 120000);
});
