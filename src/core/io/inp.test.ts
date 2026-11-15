import { describe, expect, it } from 'vitest';
import sampleInp from '../../../public/samples/sample-district.inp?raw';
import { distanceMeters, fromWgs84, toWgs84 } from '../../utils/geoMath';
import { parseInp, parseTimeValue } from './inpParser';
import { writeInp } from './inpWriter';

describe('parseTimeValue', () => {
  it('여러 시간 표기를 초로 변환한다', () => {
    expect(parseTimeValue(['24:00'])).toBe(86400);
    expect(parseTimeValue(['1:30:15'])).toBe(5415);
    expect(parseTimeValue(['24'])).toBe(86400);
    expect(parseTimeValue(['30', 'MINUTES'])).toBe(1800);
    expect(parseTimeValue(['2', 'DAYS'])).toBe(172800);
    expect(parseTimeValue(['12', 'am'])).toBe(0);
    expect(parseTimeValue(['6', 'PM'])).toBe(64800);
    expect(parseTimeValue(['abc'])).toBeNull();
  });
});

describe('parseInp', () => {
  const { model, crsLabel } = parseInp(sampleInp);
  const nodes = Object.values(model.nodes);
  const links = Object.values(model.links);

  it('섹션별 객체를 모두 읽는다', () => {
    expect(nodes.filter((n) => n.type === 'junction')).toHaveLength(35);
    expect(nodes.filter((n) => n.type === 'reservoir')).toHaveLength(1);
    expect(nodes.filter((n) => n.type === 'tank')).toHaveLength(1);
    expect(links.length).toBeGreaterThan(40);
    expect(links.every((l) => l.type === 'pipe')).toBe(true);
    expect(model.patterns.DAY).toHaveLength(24);
    expect(model.title[0]).toContain('샘플');
  });

  it('옵션과 시간 설정을 읽는다', () => {
    expect(model.options.flowUnits).toBe('LPS');
    expect(model.options.headloss).toBe('H-W');
    expect(model.times.duration).toBe(86400);
    expect(model.times.hydraulicStep).toBe(3600);
    expect(model.times.startClockTime).toBe(0);
    expect(model.options.extra.some((l) => /^Unbalanced/i.test(l))).toBe(true);
  });

  it('EPSG:5186 좌표를 자동 감지해 WGS84 로 변환한다', () => {
    expect(model.crs).toEqual({ kind: 'epsg', code: 'EPSG:5186' });
    expect(crsLabel).toContain('5186');
    for (const node of nodes) {
      // 샘플은 김해 부근 (가상 관망)
      expect(node.position[0]).toBeGreaterThan(128.8);
      expect(node.position[0]).toBeLessThan(128.95);
      expect(node.position[1]).toBeGreaterThan(35.2);
      expect(node.position[1]).toBeLessThan(35.3);
    }
  });

  it('꺾임점을 읽고 형상 연장과 같은 관로는 자동 연장으로 표시한다', () => {
    const feeder = links.find((l) => l.startNodeId === 'R1');
    expect(feeder?.vertices).toHaveLength(2);
    const pipes = links.filter((l) => l.type === 'pipe');
    expect(pipes.every((p) => p.type === 'pipe' && !p.isCustomLength)).toBe(true);
  });

  it('정의되지 않은 절점을 참조하는 관로는 제외한다', () => {
    const broken = parseInp('[JUNCTIONS]\n A 0 0\n[PIPES]\n P1 A B 100 150 110 0 Open\n[COORDINATES]\n A 127 37\n[END]');
    expect(Object.keys(broken.model.links)).toHaveLength(0);
    expect(broken.warnings.length).toBeGreaterThan(0);
  });

  it('7번째 토큰이 상태 키워드인 관로 줄과 앞 4글자만 맞는 섹션 이름을 읽는다', () => {
    const text = [
      '[JUNCTION]', ' A 0 0', ' B 0 0', ' C 0 0',
      '[PIPE]',
      ' P1 A B 100 150 110 Closed',
      ' P2 B C 100 150 110 CV',
      ' P3 A C 100 150 110 0.5 Closed',
      ' P4 A C 100 150 110 2',
      '[COORDS]', ' A 127 37', ' B 127.001 37', ' C 127.002 37',
      '[END]',
    ].join('\n');
    const { model: parsed } = parseInp(text);
    expect(Object.keys(parsed.nodes)).toHaveLength(3);
    expect(parsed.links.P1).toMatchObject({ status: 'Closed', minorLoss: 0 });
    expect(parsed.links.P2).toMatchObject({ status: 'CV', minorLoss: 0 });
    expect(parsed.links.P3).toMatchObject({ status: 'Closed', minorLoss: 0.5 });
    expect(parsed.links.P4).toMatchObject({ status: 'Open', minorLoss: 2 });
    expect(parsed.nodes.B.position[0]).toBeCloseTo(127.001, 6);
  });

  it('임의 평면 좌표는 관로 연장으로 축척을 추정해 배치한다', () => {
    const local = parseInp(
      '[JUNCTIONS]\n A 0 0\n B 0 0\n[PIPES]\n P1 A B 500 150 110 0 Open\n[COORDINATES]\n A 1000 5000\n B 1050 5000\n[END]',
    );
    expect(local.model.crs.kind).toBe('local');
    const a = local.model.nodes.A.position;
    const b = local.model.nodes.B.position;
    expect(distanceMeters(a, b)).toBeCloseTo(500, 0);
  });
});

describe('writeInp', () => {
  it('파싱 → 직렬화 → 재파싱 결과가 같다 (왕복 보존)', () => {
    const first = parseInp(sampleInp).model;
    const second = parseInp(writeInp(first)).model;
    expect(Object.keys(second.nodes)).toEqual(Object.keys(first.nodes));
    expect(Object.keys(second.links)).toEqual(Object.keys(first.links));
    expect(second.options).toEqual(first.options);
    expect(second.times).toEqual(first.times);
    expect(second.patterns).toEqual(first.patterns);
    for (const id in first.nodes) {
      const a = first.nodes[id];
      const b = second.nodes[id];
      expect(b.type).toBe(a.type);
      expect(b.elevation).toBeCloseTo(a.elevation, 6);
      // 좌표는 원본 좌표계(mm 단위 반올림)를 거치므로 1cm 이내로 일치하면 된다.
      expect(distanceMeters(a.position, b.position)).toBeLessThan(0.01);
    }
    for (const id in first.links) {
      const a = first.links[id];
      const b = second.links[id];
      expect(b.startNodeId).toBe(a.startNodeId);
      expect(b.endNodeId).toBe(a.endNodeId);
      expect(b.vertices).toHaveLength(a.vertices.length);
      if (a.type === 'pipe' && b.type === 'pipe') {
        expect(b.length).toBeCloseTo(a.length, 4);
        expect(b.diameter).toBe(a.diameter);
        expect(b.roughness).toBe(a.roughness);
      }
    }
  });

  it('도로 기준 보정 이동량(crs.shift)이 있어도 내보내면 원본 좌표가 그대로 나간다', () => {
    const model = parseInp(sampleInp).model;
    const before = model.nodes.J1.position;
    // 보정 적용: 화면 위치를 서쪽 263 m 옮기고 이동량을 좌표계에 기록
    model.crs.shift = [-263, 0];
    for (const id in model.nodes) model.nodes[id].position = toWgs84(model.crs, fromWgs84({ ...model.crs, shift: undefined }, model.nodes[id].position));
    expect(distanceMeters(before, model.nodes.J1.position)).toBeCloseTo(263, 0);
    const out = writeInp(model);
    expect(out).toMatch(/J1\s+369794\.033\s+295103\.109/); // 원본 [COORDINATES] 값
    const again = parseInp(out).model;
    expect(distanceMeters(again.nodes.J1.position, before)).toBeLessThan(0.01);
  });

  it('펌프·밸브·탱크 속성을 직렬화한다', () => {
    const text = [
      '[JUNCTIONS]', ' A 10 1', ' B 10 1',
      '[RESERVOIRS]', ' R 50',
      '[TANKS]', ' T 60 3 0 5 10 0',
      '[PIPES]', ' P1 A B 100 150 110 0 CV',
      '[PUMPS]', ' PU1 R A HEAD C1 SPEED 1.2',
      '[VALVES]', ' V1 B T 150 PRV 30 0',
      '[CURVES]', ' C1 10 40',
      '[COORDINATES]', ' A 127.0 37.0', ' B 127.001 37.0', ' R 126.999 37.0', ' T 127.002 37.0',
      '[END]',
    ].join('\n');
    const reparsed = parseInp(writeInp(parseInp(text).model)).model;
    expect(reparsed.links.PU1).toMatchObject({ type: 'pump', headCurve: 'C1', speed: 1.2 });
    expect(reparsed.links.V1).toMatchObject({ type: 'valve', valveType: 'PRV', setting: '30' });
    expect(reparsed.links.P1).toMatchObject({ type: 'pipe', status: 'CV' });
    expect(reparsed.nodes.T).toMatchObject({ type: 'tank', maxLevel: 5, diameter: 10 });
    expect(reparsed.curves.C1).toEqual([[10, 40]]);
  });

  it('수질 옵션·초기 수질·유입원·반응계수를 왕복 보존한다', () => {
    const text = [
      '[JUNCTIONS]', ' A 10 1', ' B 10 1',
      '[RESERVOIRS]', ' R 50',
      '[PIPES]', ' P1 R A 100 150 110 0 Open', ' P2 A B 100 150 110 0 Open',
      '[QUALITY]', ' R 1.2', ' A 0.3', ' A B 0.1',
      '[SOURCES]', ' R SETPOINT 1.5 PAT1',
      '[REACTIONS]', ' Order Bulk 1', ' Global Bulk -0.8', ' Global Wall -0.1', ' Bulk P1 -1.2',
      '[OPTIONS]', ' Units LPS', ' Quality Chlorine mg/L',
      '[COORDINATES]', ' A 127.0 37.0', ' B 127.001 37.0', ' R 126.999 37.0',
      '[END]',
    ].join('\n');
    const first = parseInp(text).model;
    expect(first.options.quality).toMatchObject({ mode: 'CHEMICAL', chemName: 'Chlorine', chemUnits: 'mg/L' });
    expect(first.options.reactions).toEqual({ globalBulk: -0.8, globalWall: -0.1 });
    expect(first.nodes.R.initQuality).toBe(1.2);
    expect(first.nodes.R.source).toEqual({ type: 'SETPOINT', strength: 1.5, pattern: 'PAT1' });
    expect(first.extraSections.QUALITY).toEqual(['A B 0.1']);
    expect(first.extraSections.REACTIONS).toEqual(['Order Bulk 1', 'Bulk P1 -1.2']);
    expect(first.options.extra.some((l) => /quality/i.test(l))).toBe(false);

    const second = parseInp(writeInp(first)).model;
    expect(second.options.quality).toEqual(first.options.quality);
    expect(second.options.reactions).toEqual(first.options.reactions);
    expect(second.nodes.A.initQuality).toBe(0.3);
    expect(second.nodes.R.source).toEqual(first.nodes.R.source);
    expect(second.extraSections.REACTIONS).toEqual(first.extraSections.REACTIONS);

    const age = parseInp('[OPTIONS]\n Quality Age\n[END]').model.options.quality;
    expect(age.mode).toBe('AGE');
    const trace = parseInp('[OPTIONS]\n Quality Trace R1\n[END]').model.options.quality;
    expect(trace).toMatchObject({ mode: 'TRACE', traceNode: 'R1' });
  });
});
