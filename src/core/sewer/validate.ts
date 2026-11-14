/**
 * Project 입력 검증: 스키마(필드·범위·형·기본값)와 교차 검증(SPEC §8). Pydantic 의 영문 포장 메시지는 재현하지 않고,
 * 사용자 메시지(한국어)와 오류 위치(loc)·종류를 보존한다.
 */
import {
  defaultConstraints,
  defaultOptions,
  type RainPoint,
  type SewerCatchment,
  type SewerConduit,
  type SewerConstraints,
  type SewerNode,
  type SewerOptions,
  type SewerProject,
} from './types';

export interface ValidationDetail {
  type: string;
  loc: (string | number)[];
  msg: string;
}

export class SewerValidationError extends Error {
  details: ValidationDetail[];
  constructor(details: ValidationDetail[]) {
    super(details.map((d) => (d.loc.length > 0 ? `${d.loc.join('.')}: ` : '') + d.msg).join('\n'));
    this.name = 'SewerValidationError';
    this.details = details;
  }
  /** 교차 검증이 던진 한국어 사용자 메시지(있으면). */
  get userMessages(): string[] {
    return this.details.filter((d) => d.type === 'value_error').map((d) => d.msg);
  }
}

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,30}$/;

type Raw = Record<string, unknown>;

class Collector {
  details: ValidationDetail[] = [];
  add(type: string, loc: (string | number)[], msg: string) {
    this.details.push({ type, loc, msg });
  }
}

interface NumSpec {
  min?: number;
  max?: number;
  exMin?: number;
  integer?: boolean;
  default?: number;
}

function num(c: Collector, obj: Raw, key: string, loc: (string | number)[], spec: NumSpec, required = false): number {
  const v = obj[key];
  if (v === undefined) {
    if (required || spec.default === undefined) {
      c.add('missing', [...loc, key], 'Field required');
      return NaN;
    }
    return spec.default;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    c.add('number_type', [...loc, key], '유한한 숫자여야 합니다.');
    return NaN;
  }
  if (spec.integer && !Number.isInteger(v)) c.add('int_type', [...loc, key], '정수여야 합니다.');
  if (spec.min !== undefined && v < spec.min) c.add('greater_than_equal', [...loc, key], `${spec.min} 이상이어야 합니다.`);
  if (spec.exMin !== undefined && v <= spec.exMin) c.add('greater_than', [...loc, key], `${spec.exMin} 보다 커야 합니다.`);
  if (spec.max !== undefined && v > spec.max) c.add('less_than_equal', [...loc, key], `${spec.max} 이하여야 합니다.`);
  return v;
}

function id(c: Collector, obj: Raw, key: string, loc: (string | number)[]): string {
  const v = obj[key];
  if (v === undefined) {
    c.add('missing', [...loc, key], 'Field required');
    return '';
  }
  if (typeof v !== 'string' || !ID_PATTERN.test(v)) {
    c.add('string_pattern_mismatch', [...loc, key], 'ID 는 영문으로 시작하고 영문·숫자·_·- 만 쓸 수 있습니다 (최대 31자).');
    return typeof v === 'string' ? v : '';
  }
  return v;
}

function enumOf<T extends string>(c: Collector, obj: Raw, key: string, loc: (string | number)[], values: readonly T[], fallback: T): T {
  const v = obj[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !values.includes(v as T)) {
    c.add('enum', [...loc, key], `${values.join(', ')} 중 하나여야 합니다.`);
    return fallback;
  }
  return v as T;
}

function extras(c: Collector, obj: Raw, allowed: string[], loc: (string | number)[]) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) c.add('extra_forbidden', [...loc, k], 'Extra inputs are not permitted');
}

function parseNode(c: Collector, raw: unknown, index: number): SewerNode {
  const loc = ['nodes', index];
  if (typeof raw !== 'object' || raw === null) {
    c.add('model_type', loc, '객체여야 합니다.');
    return { id: '', x: 0, y: 0, ground: 0, invert: 0, kind: 'JUNCTION', base_flow: 0, boundary: 'FREE', stage: null };
  }
  const o = raw as Raw;
  extras(c, o, ['id', 'x', 'y', 'ground', 'invert', 'kind', 'base_flow', 'boundary', 'stage'], loc);
  let stage: number | null = null;
  if (o.stage !== undefined && o.stage !== null) {
    stage = typeof o.stage === 'number' && Number.isFinite(o.stage) ? o.stage : null;
    if (stage === null) c.add('number_type', [...loc, 'stage'], '유한한 숫자 또는 null 이어야 합니다.');
  }
  return {
    id: id(c, o, 'id', loc),
    x: num(c, o, 'x', loc, {}, true),
    y: num(c, o, 'y', loc, {}, true),
    ground: num(c, o, 'ground', loc, {}, true),
    invert: num(c, o, 'invert', loc, {}, true),
    kind: enumOf(c, o, 'kind', loc, ['JUNCTION', 'OUTFALL'], 'JUNCTION'),
    base_flow: num(c, o, 'base_flow', loc, { min: 0, default: 0 }),
    boundary: enumOf(c, o, 'boundary', loc, ['FREE', 'NORMAL', 'FIXED'], 'FREE'),
    stage,
  };
}

function parseConduit(c: Collector, raw: unknown, index: number): SewerConduit {
  const loc = ['conduits', index];
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Raw;
  if (typeof raw !== 'object' || raw === null) c.add('model_type', loc, '객체여야 합니다.');
  extras(c, o, ['id', 'upstream', 'downstream', 'length', 'diameter', 'roughness', 'inlet_offset', 'outlet_offset'], loc);
  return {
    id: id(c, o, 'id', loc),
    upstream: id(c, o, 'upstream', loc),
    downstream: id(c, o, 'downstream', loc),
    length: num(c, o, 'length', loc, { exMin: 0 }, true),
    diameter: num(c, o, 'diameter', loc, { exMin: 0, default: 0.25 }),
    roughness: num(c, o, 'roughness', loc, { exMin: 0, max: 0.1, default: 0.013 }),
    inlet_offset: num(c, o, 'inlet_offset', loc, { min: 0, default: 0 }),
    outlet_offset: num(c, o, 'outlet_offset', loc, { min: 0, default: 0 }),
  };
}

function parseCatchment(c: Collector, raw: unknown, index: number): SewerCatchment {
  const loc = ['catchments', index];
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Raw;
  if (typeof raw !== 'object' || raw === null) c.add('model_type', loc, '객체여야 합니다.');
  extras(c, o, ['id', 'outlet', 'area', 'impervious', 'width', 'slope', 'runoff_coefficient', 'horton_max', 'horton_min', 'horton_decay', 'polygon'], loc);
  const catchment: SewerCatchment = {
    id: id(c, o, 'id', loc),
    outlet: id(c, o, 'outlet', loc),
    area: num(c, o, 'area', loc, { exMin: 0 }, true),
    impervious: num(c, o, 'impervious', loc, { min: 0, max: 100, default: 60 }),
    width: num(c, o, 'width', loc, { exMin: 0, default: 100 }),
    slope: num(c, o, 'slope', loc, { exMin: 0, max: 100, default: 1 }),
    runoff_coefficient: num(c, o, 'runoff_coefficient', loc, { min: 0, max: 1, default: 0.65 }),
    horton_max: num(c, o, 'horton_max', loc, { min: 0, default: 75 }),
    horton_min: num(c, o, 'horton_min', loc, { min: 0, default: 5 }),
    horton_decay: num(c, o, 'horton_decay', loc, { exMin: 0, default: 4 }),
  };
  if (catchment.horton_min > catchment.horton_max) c.add('value_error', loc, 'Horton 최소 침투율이 최대 침투율보다 큽니다.');
  if (o.polygon !== undefined) {
    const ring = o.polygon;
    const ok = Array.isArray(ring) && ring.length >= 3 && ring.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every((v) => typeof v === 'number' && Number.isFinite(v)));
    if (ok) catchment.polygon = (ring as [number, number][]).map(([x, y]) => [x, y]);
    else c.add('value_error', [...loc, 'polygon'], '유역 경계는 [x, y] 꼭짓점 3개 이상이어야 합니다.');
  }
  return catchment;
}

function parseOptions(c: Collector, raw: unknown): SewerOptions {
  const loc = ['options'];
  const d = defaultOptions();
  const o = (raw === undefined ? {} : typeof raw === 'object' && raw !== null ? raw : (c.add('model_type', loc, '객체여야 합니다.'), {})) as Raw;
  extras(c, o, ['duration_minutes', 'report_seconds', 'routing_seconds', 'rain_interval_minutes', 'routing', 'design_intensity', 'rainfall'], loc);
  let rainfall: RainPoint[] = d.rainfall;
  if (o.rainfall !== undefined) {
    if (!Array.isArray(o.rainfall)) {
      c.add('list_type', [...loc, 'rainfall'], '배열이어야 합니다.');
    } else {
      rainfall = o.rainfall.map((p, i): RainPoint => {
        const pl = [...loc, 'rainfall', i];
        const po = (typeof p === 'object' && p !== null ? p : {}) as Raw;
        extras(c, po, ['minute', 'intensity'], pl);
        return {
          minute: num(c, po, 'minute', pl, { min: 0, integer: true }, true),
          intensity: num(c, po, 'intensity', pl, { min: 0 }, true),
        };
      });
    }
  }
  const options: SewerOptions = {
    duration_minutes: num(c, o, 'duration_minutes', loc, { min: 10, max: 10080, integer: true, default: d.duration_minutes }),
    report_seconds: num(c, o, 'report_seconds', loc, { min: 1, max: 900, integer: true, default: d.report_seconds }),
    routing_seconds: num(c, o, 'routing_seconds', loc, { exMin: 0, max: 30, default: d.routing_seconds }),
    rain_interval_minutes: num(c, o, 'rain_interval_minutes', loc, { min: 1, max: 60, integer: true, default: d.rain_interval_minutes }),
    routing: enumOf(c, o, 'routing', loc, ['DYNWAVE', 'KINWAVE'], d.routing),
    design_intensity: num(c, o, 'design_intensity', loc, { min: 0, default: d.design_intensity }),
    rainfall,
  };
  const t = rainfall.map((p) => p.minute);
  if (t.length === 0 || t[0] !== 0 || t.some((v, i) => i > 0 && v <= t[i - 1])) {
    c.add('value_error', loc, '강우 시각은 0부터 시작하는 중복 없는 오름차순이어야 합니다.');
  } else if (t[t.length - 1] >= options.duration_minutes) {
    c.add('value_error', loc, '마지막 강우 변화 시각은 해석 종료보다 앞서야 합니다.');
  } else if (t.some((v) => v % options.rain_interval_minutes !== 0)) {
    c.add('value_error', loc, '강우 변화 시각은 강우 간격의 배수여야 합니다.');
  } else if (options.routing_seconds > options.report_seconds) {
    c.add('value_error', loc, '계산 간격은 출력 간격 이하여야 합니다.');
  }
  return options;
}

function parseConstraints(c: Collector, raw: unknown): SewerConstraints {
  const loc = ['constraints'];
  const d = defaultConstraints();
  const o = (raw === undefined ? {} : typeof raw === 'object' && raw !== null ? raw : (c.add('model_type', loc, '객체여야 합니다.'), {})) as Raw;
  extras(c, o, ['diameters', 'min_cover', 'max_depth', 'min_slope', 'max_slope', 'min_velocity', 'max_velocity', 'max_depth_ratio', 'max_iterations', 'continuity_tolerance'], loc);
  let diameters = d.diameters;
  if (o.diameters !== undefined) {
    if (!Array.isArray(o.diameters) || o.diameters.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      c.add('list_type', [...loc, 'diameters'], '숫자 배열이어야 합니다.');
    } else {
      diameters = o.diameters as number[];
    }
  }
  const k: SewerConstraints = {
    diameters,
    min_cover: num(c, o, 'min_cover', loc, { min: 0, default: d.min_cover }),
    max_depth: num(c, o, 'max_depth', loc, { exMin: 0, default: d.max_depth }),
    min_slope: num(c, o, 'min_slope', loc, { exMin: 0, default: d.min_slope }),
    max_slope: num(c, o, 'max_slope', loc, { exMin: 0, max: 1, default: d.max_slope }),
    min_velocity: num(c, o, 'min_velocity', loc, { min: 0, default: d.min_velocity }),
    max_velocity: num(c, o, 'max_velocity', loc, { exMin: 0, default: d.max_velocity }),
    max_depth_ratio: num(c, o, 'max_depth_ratio', loc, { exMin: 0, max: 0.9, default: d.max_depth_ratio }),
    max_iterations: num(c, o, 'max_iterations', loc, { min: 1, max: 15, integer: true, default: d.max_iterations }),
    continuity_tolerance: num(c, o, 'continuity_tolerance', loc, { exMin: 0, default: d.continuity_tolerance }),
  };
  const sorted = k.diameters.every((v, i) => i === 0 || v > k.diameters[i - 1]);
  if (k.diameters.length === 0 || !sorted || Math.min(...k.diameters) <= 0) {
    c.add('value_error', loc, '표준 관경은 양수, 중복 없는 오름차순이어야 합니다.');
  } else if (k.min_slope > k.max_slope || k.min_velocity > k.max_velocity || k.min_cover >= k.max_depth) {
    c.add('value_error', loc, '설계 제약의 최소/최대 범위를 확인하세요.');
  }
  return k;
}

/** 원시 JSON → 검증된 SewerProject. 입력 객체는 바꾸지 않는다. 실패하면 SewerValidationError. */
export function parseSewerProject(raw: unknown): SewerProject {
  const c = new Collector();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SewerValidationError([{ type: 'model_type', loc: [], msg: '프로젝트는 객체여야 합니다.' }]);
  }
  const o = raw as Raw;
  extras(c, o, ['schema_version', 'name', 'nodes', 'conduits', 'catchments', 'options', 'constraints'], []);
  if (o.schema_version !== undefined && o.schema_version !== 1) c.add('literal_error', ['schema_version'], 'schema_version 은 1 이어야 합니다.');
  if (o.name !== undefined && typeof o.name !== 'string') c.add('string_type', ['name'], '문자열이어야 합니다.');
  const list = (key: string, min: number) => {
    const v = o[key];
    if (v === undefined) {
      if (min > 0) c.add('missing', [key], 'Field required');
      return [];
    }
    if (!Array.isArray(v)) {
      c.add('list_type', [key], '배열이어야 합니다.');
      return [];
    }
    if (v.length < min) c.add('too_short', [key], `${min}개 이상 있어야 합니다.`);
    return v;
  };
  const nodes = list('nodes', 2).map((n, i) => parseNode(c, n, i));
  const conduits = list('conduits', 1).map((n, i) => parseConduit(c, n, i));
  const catchments = list('catchments', 0).map((n, i) => parseCatchment(c, n, i));
  const options = parseOptions(c, o.options);
  const constraints = parseConstraints(c, o.constraints);

  // 노드 교차 검증 (Node.after validator) — 항목별 첫 오류만
  nodes.forEach((n, i) => {
    if (!(n.ground > n.invert)) c.add('value_error', ['nodes', i], `${n.id}: 지반고는 관저고보다 높아야 합니다.`);
    else if (n.kind === 'OUTFALL' && n.base_flow) c.add('value_error', ['nodes', i], '방류구에 직접 유입을 지정할 수 없습니다.');
    else if (n.boundary === 'FIXED' && (n.stage === null || n.stage < n.invert)) c.add('value_error', ['nodes', i], '고정 수위는 방류구 관저고 이상이어야 합니다.');
  });
  if (c.details.length === 0) {
    // 프로젝트 교차 검증 (Project.after validator) — 첫 오류에서 중단
    const ids = nodes.map((n) => n.id);
    const sets: [string[], string][] = [[ids, '절점'], [conduits.map((x) => x.id), '관로'], [catchments.map((x) => x.id), '유역']];
    for (const [values, label] of sets) {
      if (values.length !== new Set(values).size) {
        throw new SewerValidationError([{ type: 'value_error', loc: [], msg: `${label} ID가 중복되었습니다.` }]);
      }
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const x of conduits) {
      if (!byId.has(x.upstream) || !byId.has(x.downstream) || x.upstream === x.downstream) {
        throw new SewerValidationError([{ type: 'value_error', loc: [], msg: `${x.id}: 연결 절점이 없거나 자기 자신에 연결되었습니다.` }]);
      }
    }
    for (const s of catchments) {
      const out = byId.get(s.outlet);
      if (!out || out.kind !== 'JUNCTION') throw new SewerValidationError([{ type: 'value_error', loc: [], msg: `${s.id}: 유역 출구는 맨홀이어야 합니다.` }]);
    }
  }
  if (c.details.length > 0) throw new SewerValidationError(c.details);
  return {
    schema_version: 1,
    name: typeof o.name === 'string' ? o.name : '새 관망',
    nodes,
    conduits,
    catchments,
    options,
    constraints,
  };
}

/** 설계 결과 프로젝트의 재검증 (SPEC §4.C 마지막 줄: 큰 관경 탓에 ground≤invert 가 되면 예외). */
export function revalidate(project: SewerProject): SewerProject {
  return parseSewerProject(JSON.parse(JSON.stringify(project)));
}
