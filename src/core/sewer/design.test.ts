import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { designSewer } from './design';
import { manning, normalRatio, requiredSlope, section } from './hydraulics';
import { accumulatedFlows, buildNetwork } from './topology';
import { parseSewerProject, SewerValidationError } from './validate';

const FX = join(__dirname, 'fixtures');
type NumericCase = { function: string; input: Record<string, number>; output?: number | number[]; error?: { type: string; message: string } };
const read = (p: string) => JSON.parse(readFileSync(join(FX, p), 'utf8'));

/** 매끄러운 수치 비교: abs 1e-12 + rel 1e-11 (PORTING/README). */
function close(actual: number, expected: number, label: string) {
  const tol = 1e-12 + 1e-11 * Math.abs(expected);
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
}

describe('수리 함수 (PORTING numeric.json 1,312쌍)', () => {
  const cases = read('numeric.json') as NumericCase[];
  it('section · manning · normal_ratio · required_slope 가 원본과 같다', () => {
    const counts: Record<string, number> = {};
    for (const [i, c] of cases.entries()) {
      counts[c.function] = (counts[c.function] ?? 0) + 1;
      const label = `${c.function}#${i}`;
      const x = c.input;
      if (c.error) {
        // 원본이 ZeroDivisionError 를 낸 퇴화 입력 — 같은 입력에서 예외가 나야 한다
        const call = () => (c.function === 'manning' ? manning(x.diameter, x.slope, x.roughness, x.ratio) : requiredSlope(x.q, x.d, x.n, x.max_ratio, x.min_velocity));
        expect(call, label).toThrow(c.error.message);
        continue;
      }
      if (c.function === 'section') {
        const [a, r] = section(x.diameter, x.ratio);
        const out = c.output as number[];
        close(a, out[0], `${label}.A`);
        close(r, out[1], `${label}.R`);
      } else if (c.function === 'manning') {
        close(manning(x.diameter, x.slope, x.roughness, x.ratio), c.output as number, label);
      } else if (c.function === 'normal_ratio') {
        close(normalRatio(x.q, x.diameter, x.slope, x.roughness), c.output as number, label);
      } else if (c.function === 'required_slope') {
        close(requiredSlope(x.q, x.d, x.n, x.max_ratio, x.min_velocity), c.output as number, label);
      } else {
        throw new Error(`알 수 없는 함수 ${c.function}`);
      }
    }
    expect(counts).toEqual({ section: 100, manning: 401, normal_ratio: 270, required_slope: 541 });
  });
});

type ExpectedProject = { nodes: { id: string; invert: number; ground: number }[]; conduits: { id: string; diameter: number; inlet_offset: number; outlet_offset: number }[] };
type Expected = { error?: { type: string; message: string; details?: { msg: string }[] }; rows?: Record<string, unknown>[]; issues?: string[]; project?: ExpectedProject };

/** 원본 예외와 같은 종류인지: 위상·설계 오류는 메시지가 같아야 하고, 검증 오류는 사용자 메시지가 같아야 한다. */
function expectError(error: unknown, expected: NonNullable<Expected['error']>) {
  if (expected.type === 'ValidationError') {
    expect(error).toBeInstanceOf(SewerValidationError);
    const wanted = (expected.details ?? []).map((d) => d.msg.replace(/^Value error, /, ''));
    const got = (error as SewerValidationError).userMessages;
    for (const w of wanted) expect(got.join('\n')).toContain(w);
  } else {
    expect((error as Error).message).toBe(expected.message);
  }
}

describe('design() 시나리오 18개', () => {
  const names = readdirSync(join(FX, 'design'));
  it('시나리오 목록', () => expect(names.length).toBe(18));

  for (const name of names) {
    it(`${name}: 설계 결과(관경·관저고·옵셋·rows·issues) 또는 예외가 원본과 같다`, () => {
      const projectJson = read(`design/${name}/project.json`);
      const floors = read(`design/${name}/floors.json`) as Record<string, number> | null;
      const expected = read(`design/${name}/expected.json`) as Expected;
      const run = () => designSewer(parseSewerProject(projectJson), floors ?? {});
      if (expected.error) {
        let thrown: unknown;
        try {
          run();
        } catch (e) {
          thrown = e;
        }
        expect(thrown, '예외가 나야 하는 시나리오').toBeDefined();
        expectError(thrown, expected.error);
        return;
      }
      const result = run();
      expect(result.issues).toEqual(expected.issues);
      expect(result.rows).toHaveLength(expected.rows!.length);
      expected.rows!.forEach((er, i) => {
        const row = result.rows[i] as unknown as Record<string, number | string>;
        expect(row.id).toBe(er.id);
        expect(row.status).toBe(er.status);
        for (const key of ['diameter', 'flow', 'slope', 'velocity', 'depth_ratio', 'cover']) close(row[key] as number, er[key] as number, `${name}.${er.id}.${key}`);
      });
      // 절점 관저고와 관로 관경·옵셋
      const ep = expected.project!;
      result.project.nodes.forEach((n, i) => {
        expect(n.id).toBe(ep.nodes[i].id);
        close(n.invert, ep.nodes[i].invert, `${name}.${n.id}.invert`);
        close(n.ground, ep.nodes[i].ground, `${name}.${n.id}.ground`);
      });
      result.project.conduits.forEach((c, i) => {
        const ec = ep.conduits[i];
        expect(c.id).toBe(ec.id);
        close(c.diameter, ec.diameter, `${name}.${c.id}.diameter`);
        close(c.inlet_offset, ec.inlet_offset, `${name}.${c.id}.inlet_offset`);
        close(c.outlet_offset, ec.outlet_offset, `${name}.${c.id}.outlet_offset`);
      });
      expect(result.feasible).toBe(expected.issues!.length === 0);
    });
  }

  it('설계는 입력을 바꾸지 않는다', () => {
    const raw = read('design/demo/project.json');
    const project = parseSewerProject(raw);
    const snapshot = JSON.stringify(project);
    designSewer(project);
    expect(JSON.stringify(project)).toBe(snapshot);
  });
});

describe('유량 누적과 위상 순서', () => {
  for (const name of readdirSync(join(FX, 'design'))) {
    it(`${name}: accumulated_flows · topological_order`, () => {
      const expected = read(`design/${name}/accumulated_flows.json`) as {
        output?: Record<string, number>;
        topological_order?: string[];
        error?: { type: string; message: string; details?: { msg: string }[] };
      };
      const run = () => {
        const project = parseSewerProject(read(`design/${name}/project.json`));
        const graph = buildNetwork(project);
        return { flows: accumulatedFlows(project, graph), order: graph.order };
      };
      if (expected.error) {
        let thrown: unknown;
        try {
          run();
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeDefined();
        expectError(thrown, expected.error);
        return;
      }
      const { flows, order } = run();
      expect(order).toEqual(expected.topological_order);
      expect(Object.keys(flows)).toEqual(Object.keys(expected.output!)); // 순회 순서까지 같다
      for (const [id, q] of Object.entries(expected.output!)) close(flows[id], q, `${name}.${id}`);
    });
  }
});
