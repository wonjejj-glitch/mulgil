import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateInp, hms, pyFloat } from './inp';
import { optimizeSewer } from './optimize';
import { parseReport, summarizeSimulation, type SimulationSummary } from './report';
import { parseSewerProject } from './validate';

const FX = join(__dirname, 'fixtures');
const read = (p: string) => JSON.parse(readFileSync(join(FX, p), 'utf8'));
const text = (p: string) => readFileSync(join(FX, p), 'utf8');

function close(actual: number, expected: number, label: string) {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1e-12 + 1e-11 * Math.abs(expected));
}

describe('INP 생성 (바이트 단위 일치)', () => {
  for (const boundary of ['FREE', 'NORMAL', 'FIXED']) {
    it(`${boundary}: 1505분(24시간 초과) 모델의 INP 가 원본과 정확히 같다`, () => {
      const project = parseSewerProject(read(`inp/${boundary}/project.json`));
      expect(generateInp(project)).toBe(text(`inp/${boundary}/expected.inp`));
    });
  }
  it('보조 함수: hms · pyFloat', () => {
    expect(hms(60)).toBe('00:01:00');
    expect(hms(300)).toBe('00:05:00');
    expect(hms(3661)).toBe('01:01:01');
    expect(hms(90000)).toBe('25:00:00');
    expect(pyFloat(5)).toBe('5.0');
    expect(pyFloat(0.5)).toBe('0.5');
    expect(pyFloat(75)).toBe('75.0');
  });
  it('유역이 없으면 강우·유역 섹션을 모두 생략한다', () => {
    const project = parseSewerProject(read('inp/FREE/project.json'));
    project.catchments = [];
    const inp = generateInp(project);
    for (const s of ['[RAINGAGES]', '[SUBCATCHMENTS]', '[SUBAREAS]', '[INFILTRATION]', '[TIMESERIES]']) expect(inp).not.toContain(s);
    expect(inp).toContain('[DWF]');
    expect(inp.endsWith('\n') && !inp.endsWith('\n\n')).toBe(true);
  });
});

/** 반복 이력 폴더: optimize/<이름>/trace.json 과 iteration_XX */
const OPT = join(FX, 'optimize');

describe('RPT 파싱과 해석 요약 (실제 SWMM 5.2.4 보고서)', () => {
  for (const name of readdirSync(OPT)) {
    for (const it_ of readdirSync(join(OPT, name)).filter((d) => d.startsWith('iteration_'))) {
      it(`${name}/${it_}: parse_report 와 simulate 요약이 원본과 같다`, () => {
        const trace = read(`optimize/${name}/trace.json`);
        const idx = Number(it_.split('_')[1]) - 1;
        const designed = parseSewerProject(trace.history[idx].designed_project);
        const rpt = text(`optimize/${name}/${it_}/model.rpt`);
        const parsed = parseReport(rpt, designed);
        const expectedParsed = read(`optimize/${name}/${it_}/parsed_report.json`);
        expect(parsed.warnings).toEqual(expectedParsed.warnings);
        expect(Object.keys(parsed.nodes)).toEqual(Object.keys(expectedParsed.nodes));
        for (const [id, n] of Object.entries(expectedParsed.nodes as Record<string, Record<string, number>>)) {
          for (const [k, v] of Object.entries(n)) close((parsed.nodes[id] as Record<string, number>)[k], v, `${id}.${k}`);
          expect(Object.keys(parsed.nodes[id]).sort()).toEqual(Object.keys(n).sort());
        }
        for (const [id, l] of Object.entries(expectedParsed.links as Record<string, Record<string, number>>)) {
          for (const [k, v] of Object.entries(l)) close((parsed.links[id] as unknown as Record<string, number>)[k], v, `${id}.${k}`);
        }
        expect(parsed.continuity).toEqual(expectedParsed.continuity);

        // simulate() 후처리 (월류 0 채움, surcharged, quality_ok)
        const sim = summarizeSimulation(designed, parsed);
        const expectedSim = read(`optimize/${name}/${it_}/simulation.json`) as SimulationSummary;
        expect(sim.quality_ok).toBe(expectedSim.quality_ok);
        expect(sim.warnings).toEqual(expectedSim.warnings);
        for (const [id, n] of Object.entries(expectedSim.node_summary)) {
          expect(sim.node_summary[id].surcharged, `${id}.surcharged`).toBe(n.surcharged);
          expect(Object.keys(sim.node_summary[id]).sort(), `${id} 키`).toEqual(Object.keys(n).sort());
          for (const k of ['max_depth', 'max_hgl', 'flood_hours', 'max_flood', 'flood_volume_m3'] as const) {
            if (n[k] !== undefined) close(sim.node_summary[id][k] as number, n[k] as number, `${id}.${k}`);
          }
        }
        for (const [id, l] of Object.entries(expectedSim.link_summary)) {
          for (const k of ['max_flow', 'max_velocity', 'max_depth_ratio'] as const) close(sim.link_summary[id][k], l[k], `${id}.${k}`);
        }
      });
    }
  }

  for (const name of readdirSync(join(FX, 'report_errors'))) {
    it(`보고서 오류 ${name}: 원본과 같은 예외`, () => {
      const expected = read(`report_errors/${name}/expected.json`) as { error: { message: string } };
      const project = parseSewerProject(read(`report_errors/${name}/project.json`));
      expect(() => parseReport(text(`report_errors/${name}/input.rpt`), project)).toThrow(expected.error.message);
    });
  }
});

describe('반복 설계 (고정된 실제 해석 결과로 재생)', () => {
  for (const name of readdirSync(OPT)) {
    it(`${name}: 회차별 floors·위반 목록·수렴·종료 이유가 원본 trace 와 같다`, async () => {
      const trace = read(`optimize/${name}/trace.json`) as {
        history: { iteration: number; floors: Record<string, number>; designed_project: { conduits: { diameter: number }[]; nodes: { invert: number }[] }; critical_links: string[]; velocity_violations: string[]; design_issues: string[]; quality_ok: boolean; converged: boolean; stop_reason: string | null }[];
        converged: boolean;
        stop_reason: string;
      };
      const project = parseSewerProject(read(`optimize/${name}/project.json`));
      const frozen = (iteration: number) => read(`optimize/${name}/iteration_${String(iteration).padStart(2, '0')}/simulation.json`) as SimulationSummary;
      const outcome = await optimizeSewer(project, async (_design, iteration) => frozen(iteration));

      expect(outcome.history).toHaveLength(trace.history.length);
      trace.history.forEach((h, i) => {
        const mine = outcome.history[i];
        expect(mine.iteration).toBe(h.iteration);
        expect(mine.floors).toEqual(h.floors);
        expect(mine.critical_links).toEqual(h.critical_links);
        expect(mine.velocity_violations).toEqual(h.velocity_violations);
        expect(mine.design_issues).toEqual(h.design_issues);
        expect(mine.quality_ok).toBe(h.quality_ok);
        expect(mine.converged).toBe(h.converged);
        // 그 회차에 설계된 관경·관저고도 같아야 한다
        const designed = outcome.iterations[i].design.project;
        designed.conduits.forEach((c, k) => close(c.diameter, h.designed_project.conduits[k].diameter, `iter${h.iteration}.${c.id}.diameter`));
        designed.nodes.forEach((n, k) => close(n.invert, h.designed_project.nodes[k].invert, `iter${h.iteration}.${n.id}.invert`));
      });
      expect(outcome.converged).toBe(trace.converged);
      expect(outcome.stop_reason).toBe(trace.stop_reason);
    });
  }

  it('연속성 오차가 크면 수렴으로 표시하지 않고 이유를 남긴다', async () => {
    const project = parseSewerProject(read('optimize/stress/project.json'));
    const outcome = await optimizeSewer(project, async (_d, i) => ({ ...(read(`optimize/stress/iteration_0${i}/simulation.json`) as SimulationSummary), quality_ok: false }));
    expect(outcome.converged).toBe(false);
    expect(outcome.stop_reason).toBe('연속성 오차 또는 SWMM 경고 검토 필요');
    expect(outcome.history).toHaveLength(1);
  });
});
