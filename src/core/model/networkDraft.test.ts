import { describe, expect, it } from 'vitest';
import { guessMapping, parseCsv, readCustomers } from '../io/customerCsv';
import { parseSewerProject } from '../sewer/validate';
import { designSewer } from '../sewer/design';
import { generateInp } from '../sewer/inp';
import { runSwmm } from '../swmm/swmmRunner';
import { addDraftToWaterModel, DEFAULT_SEWER_DRAFT, DEFAULT_WATER_DRAFT, draftToSewerProject, draftToWaterModel, pickWaterDiameter } from './draftConvert';
import { addLink, addNode } from './networkEdit';
import { createEmptyModel } from './types';
import { buildDraft, defaultDraftOptions, nodeRoads, prepareRoads } from './networkDraft';
import { plane } from './roadSnap';
import type { LngLat } from './types';

const origin: LngLat = [127.0, 37.5];
const P = plane(origin);
const at = (x: number, y: number) => P.from([x, y]);

/** 100 m 간격 3×3 격자 도로 (0~200 m). */
function grid(): LngLat[][] {
  const roads: LngLat[][] = [];
  for (const k of [0, 100, 200]) {
    roads.push([at(0, k), at(200, k)]);
    roads.push([at(k, 0), at(k, 200)]);
  }
  return roads;
}

describe('customer CSV', () => {
  it('reads Korean headers, quotes and monthly usage', () => {
    const csv = '수용가번호,"주소",경도,위도,월사용량(m3)\nA1,"서울, 중구",127.001,37.501,30.4\nA2,x,127.002,37.502,60.8\nA3,x,,37.5,10\n';
    const table = parseCsv(new TextEncoder().encode(csv));
    const map = guessMapping(table.headers);
    expect(map).toMatchObject({ id: 0, x: 2, y: 3, demand: 4, demandUnit: 'm3/month' });
    const { records, skipped } = readCustomers(table, map);
    expect(records.map((r) => r.id)).toEqual(['A1', 'A2']);
    expect(records[0].demand).toBeCloseTo(1, 10);
    expect(skipped).toEqual([3]);
  });

  it('falls back to EUC-KR', () => {
    // "번호,x,y" in CP949 + one row
    const bytes = new Uint8Array([0xb9, 0xf8, 0xc8, 0xa3, 0x2c, 0x78, 0x2c, 0x79, 0x0a, 0x31, 0x2c, 0x31, 0x2c, 0x32, 0x0a]);
    const table = parseCsv(bytes);
    expect(table.encoding).toBe('euc-kr');
    expect(table.headers[0]).toBe('번호');
  });
});

describe('network draft', () => {
  const customers = [
    { id: 'C1', position: at(205, 195), demand: 10 },
    { id: 'C2', position: at(95, 210), demand: 20 },
    { id: 'C3', position: at(150, 5), demand: 5 },
    { id: 'FAR', position: at(500, 500), demand: 99 },
  ];

  it('builds a tree along roads from the source to every reachable customer', () => {
    const opts = defaultDraftOptions('water', at(0, 0));
    const prepared = prepareRoads(grid(), origin, opts.spacing);
    const draft = buildDraft(prepared, customers, opts);
    expect(draft.unserved.map((u) => u.id)).toEqual(['FAR']);
    expect(draft.nodes.filter((n) => n.isSource)).toHaveLength(1);
    // 나무: 링크 수 = 절점 수 - 1, 절점 번호는 0..n-1
    expect(draft.links).toHaveLength(draft.nodes.length - 1);
    expect(draft.nodes.map((n) => n.key)).toEqual(draft.nodes.map((_, i) => i));
    // 5 m 미만 관은 수원 쪽 관을 빼고 없다
    for (const l of draft.links) if (!draft.nodes[l.from].isSource) expect(l.length).toBeGreaterThanOrEqual(5);
    // 수용가는 하나도 잃지 않는다
    expect(draft.nodes.flatMap((n) => n.customers).sort()).toEqual(['C1', 'C2', 'C3']);
    // 수원으로 들어가는 관은 모든 공급량을 나른다
    const intoSource = draft.links.filter((l) => draft.nodes[l.to].isSource);
    expect(intoSource.reduce((s, l) => s + l.carried, 0)).toBeCloseTo(35, 9);
    // 총연장: 수원(0,0) → C1(200,200) 400 m, C2 (100,200) 은 같은 경로 위, C3 (150,0) 은 바닥 도로 위 — 최단 나무 400~500 m
    expect(draft.stats.totalLength).toBeGreaterThan(390);
    expect(draft.stats.totalLength).toBeLessThan(560);
  });

  it('splits long pipes at the maximum length', () => {
    const opts = { ...defaultDraftOptions('sewer', at(0, 0)), maxPipeLength: 50 };
    const draft = buildDraft(prepareRoads(grid(), origin, opts.spacing), customers.slice(0, 1), opts);
    for (const l of draft.links) expect(l.length).toBeLessThanOrEqual(50 + opts.spacing);
    expect(draft.links.length).toBeGreaterThanOrEqual(8);
  });

  it('prefers downhill routes for sewers when ground is given', () => {
    // 방류구 (0,0), 수용가 (200,200). 왼쪽 길(x=0)을 높게, 아래쪽 길(y=0)을 낮게 → 아래로 돌아가야 한다
    const opts = defaultDraftOptions('sewer', at(0, 0));
    const prepared = prepareRoads(grid(), origin, opts.spacing);
    const ground = prepared.vertices.map((p) => {
      const [x, y] = P.to(p);
      return 10 + (x < 1 && y > 1 ? 30 : 0) + (x + y) * 0.01;
    });
    const draft = buildDraft(prepared, [{ id: 'C', position: at(200, 200), demand: 1 }], opts, ground);
    const xs = draft.links.flatMap((l) => l.path.map((p) => P.to(p)));
    expect(xs.some(([x, y]) => x > 150 && y < 1)).toBe(true);
    expect(xs.every(([x, y]) => !(x < 1 && y > 50))).toBe(true);
  });

  it('converts to an EPANET model and a valid, designable sewer project', () => {
    const opts = defaultDraftOptions('sewer', at(0, 0));
    const prepared = prepareRoads(grid(), origin, opts.spacing);
    const ground = prepared.vertices.map((p) => 50 + P.to(p)[0] * 0.01 + P.to(p)[1] * 0.01);
    const draft = buildDraft(prepared, customers.slice(0, 3), opts, ground);

    const water = draftToWaterModel(draft, DEFAULT_WATER_DRAFT, 't');
    expect(Object.values(water.nodes).filter((n) => n.type === 'reservoir')).toHaveLength(1);
    const totalLps = Object.values(water.nodes).reduce((s, n) => s + (n.type === 'junction' ? n.demand : 0), 0);
    expect(totalLps).toBeCloseTo(35 / 86.4, 3);
    for (const l of Object.values(water.links)) expect(water.nodes[l.startNodeId]).toBeDefined();

    const sewer = parseSewerProject(JSON.parse(JSON.stringify(draftToSewerProject(draft, DEFAULT_SEWER_DRAFT, 'draft'))));
    expect(sewer.nodes.filter((n) => n.kind === 'OUTFALL')).toHaveLength(1);
    const design = designSewer(sewer);
    expect(design.rows).toHaveLength(sewer.conduits.length);
    // 수용가 오수량은 아주 작다: 원본 호환은 최소 유속을 못 맞춰 큰 관을 넣고, 실무 모드는 최소 관경을 쓴다
    const practical = designSewer(sewer, {}, 'practical');
    expect(Math.max(...practical.project.conduits.map((c) => c.diameter))).toBe(sewer.constraints.diameters[0]);
    expect(Math.max(...design.project.conduits.map((c) => c.diameter))).toBeGreaterThan(sewer.constraints.diameters[0]);
    expect(practical.rows.every((r) => r.status.startsWith('적합') || r.status.includes('유속'))).toBe(true);
  });

  it('gives a mid-network outfall a single inlet so SWMM accepts it', async () => {
    // 방류구를 격자 한가운데(100,100)에 두면 여러 가지가 모인다 → 집수 맨홀 + 방류 관 하나
    const opts = defaultDraftOptions('sewer', at(100, 100));
    const prepared = prepareRoads(grid(), origin, opts.spacing);
    const ground = prepared.vertices.map((p) => 50 + Math.hypot(P.to(p)[0] - 100, P.to(p)[1] - 100) * 0.02);
    const corners = [at(0, 0), at(200, 0), at(0, 200), at(200, 200)].map((position, i) => ({ id: `C${i}`, position, demand: 5 }));
    const draft = buildDraft(prepared, corners, opts, ground);
    expect(draft.links.filter((l) => draft.nodes[l.to].isSource).length).toBeGreaterThan(1);
    const project = parseSewerProject(JSON.parse(JSON.stringify(draftToSewerProject(draft, DEFAULT_SEWER_DRAFT, 'mid'))));
    const outfall = project.nodes.find((n) => n.kind === 'OUTFALL')!;
    expect(project.conduits.filter((c) => c.downstream === outfall.id)).toHaveLength(1);
    const design = designSewer(project, {}, 'practical');
    const run = await runSwmm(generateInp(design.project));
    expect(run.report).not.toMatch(/ERROR \d+/);
  });

  it('gap-fill: grows from existing nodes and adds only new pipes to the current model', () => {
    // 기존 관망: 아래 도로(y=0)를 따라 R1-E1-E2
    const m = createEmptyModel();
    addNode(m, 'reservoir', at(0, 0), 'R1');
    addNode(m, 'junction', at(100, 0), 'E1');
    addNode(m, 'junction', at(200, 0), 'E2');
    addLink(m, 'pipe', 'R1', 'E1', [], 'EP1');
    addLink(m, 'pipe', 'E1', 'E2', [], 'EP2');
    const seeds = Object.values(m.nodes).map((n) => ({ id: n.id, position: n.position }));
    const opts = { ...defaultDraftOptions('water', at(0, 0)), seeds };
    const draft = buildDraft(prepareRoads(grid(), origin, opts.spacing), [{ id: 'N1', position: at(195, 205), demand: 8.64 }, { id: 'N2', position: at(105, 195), demand: 8.64 }], opts);
    expect(draft.unserved).toHaveLength(0);
    expect(draft.nodes.filter((n) => n.existingId).length).toBeGreaterThan(0);
    // 새 관은 기존 절점끼리 잇지 않는다
    for (const l of draft.links) expect(draft.nodes[l.from].existingId && draft.nodes[l.to].existingId).toBeFalsy();
    // 가장 가까운 기존 절점(E1·E2, 수직 도로 x=100·200)에서 올라간다 → 총연장 약 300 m (0,0 에서 출발하면 400 m 이상)
    expect(draft.stats.totalLength).toBeLessThan(330);

    const before = { nodes: Object.keys(m.nodes).length, links: Object.keys(m.links).length };
    const rep = addDraftToWaterModel(m, draft, DEFAULT_WATER_DRAFT);
    expect(Object.keys(m.nodes).length).toBe(before.nodes + rep.junctions);
    expect(Object.keys(m.links).length).toBe(before.links + rep.pipes);
    expect(m.links.EP1.startNodeId).toBe('R1'); // 기존 관은 그대로
    expect(rep.connectedTo.every((id) => id === 'E1' || id === 'E2' || id === 'R1')).toBe(true);
    // 수요: 8.64 m³/일 × 2 = 0.2 L/s 가 어딘가(새 절점 또는 접속 절점)에 들어간다
    const total = Object.values(m.nodes).reduce((s, n) => s + (n.type === 'junction' ? n.demand : 0), 0);
    expect(total).toBeCloseTo(0.2, 3);
  });

  it('nodes crossing road lines so a user road file forms one connected network', () => {
    // 교차점에 공통 점이 없는 격자 (선마다 끝점만 있음)
    const raw = grid();
    const before = buildDraft(prepareRoads(raw, origin, 15), [{ id: 'C', position: at(200, 205), demand: 1 }], defaultDraftOptions('water', at(0, 100)));
    expect(before.stats.totalLength).toBeGreaterThan(0); // 원래 격자는 끝점이 겹쳐 일부는 이어져 있다
    const crossOnly: LngLat[][] = [[at(0, 50), at(200, 50)], [at(103, -37), at(103, 150)]]; // 가운데서 X 자로만 만남
    expect(() => buildDraft(prepareRoads(crossOnly, origin, 15), [{ id: 'C', position: at(103, 145), demand: 1 }], defaultDraftOptions('water', at(5, 50)))).toThrow();
    const noded = nodeRoads(crossOnly);
    expect(noded[0]).toHaveLength(3);
    expect(noded[1]).toHaveLength(3);
    const d = buildDraft(prepareRoads(noded, origin, 15), [{ id: 'C', position: at(103, 145), demand: 1 }], defaultDraftOptions('water', at(5, 50)));
    expect(d.unserved).toHaveLength(0);
    expect(d.stats.totalLength).toBeGreaterThan(180);
    expect(d.stats.totalLength).toBeLessThan(220);
  });

  it('picks standard water diameters by velocity', () => {
    expect(pickWaterDiameter(0.001, 1, 80)).toBe(80);
    expect(pickWaterDiameter(0.05, 1, 80)).toBe(300); // 252 mm → 300
  });
});
