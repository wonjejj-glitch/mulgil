/**
 * EPANET 표준 .inp 텍스트 → 내부 관망 모델(NetworkModel) 변환.
 */
import {
  CRS_DEFS,
  DEFAULT_ANCHOR,
  detectCrs,
  pathLengthMeters,
  toWgs84,
  type ImportCrsChoice,
} from '../../utils/geoMath';
import {
  createEmptyModel,
  type FlowUnits,
  type HeadlossFormula,
  type LngLat,
  type NetworkModel,
  type NetworkTimes,
  type PipeStatus,
  type QualityOptions,
  type QualitySource,
  type SourceCrs,
  type SourceType,
  type ValveType,
} from '../model/types';
import { FEET_PER_METER, isUsUnits, metersToModelLength } from '../model/units';

export interface ParseInpOptions {
  /** 좌표계 지정. 기본값 'auto' 는 좌표 범위로 추정한다. */
  crs?: ImportCrsChoice;
}

export interface ParseInpResult {
  model: NetworkModel;
  warnings: string[];
  /** 적용된 좌표계 설명 (사용자 안내용). */
  crsLabel: string;
}

const FLOW_UNITS: ReadonlySet<string> = new Set(['CFS', 'GPM', 'MGD', 'IMGD', 'AFD', 'LPS', 'LPM', 'MLD', 'CMH', 'CMD']);
const VALVE_TYPES: ReadonlySet<string> = new Set(['PRV', 'PSV', 'PBV', 'FCV', 'TCV', 'GPV']);
/** 엔진·내보내기에서 다시 만들어 쓰므로 원문을 보존하지 않는 섹션. */
const SKIPPED_SECTIONS: ReadonlySet<string> = new Set(['REPORT', 'END']);

const SECTION_NAMES = [
  'TITLE', 'JUNCTIONS', 'RESERVOIRS', 'TANKS', 'PIPES', 'PUMPS', 'VALVES', 'CONTROLS', 'RULES', 'DEMANDS',
  'SOURCES', 'EMITTERS', 'PATTERNS', 'CURVES', 'QUALITY', 'STATUS', 'ROUGHNESS', 'ENERGY', 'REACTIONS', 'MIXING',
  'REPORT', 'TIMES', 'OPTIONS', 'COORDINATES', 'VERTICES', 'LABELS', 'BACKDROP', 'TAGS', 'LEAKAGE',
];

/**
 * 섹션 이름을 표준 이름으로 맞춘다. EPANET 은 앞 4글자만 비교하므로
 * "[JUNCTION]", "[COORDS]" 같은 변형도 같은 섹션으로 읽는다.
 */
function normalizeSection(raw: string): string {
  const upper = raw.trim().toUpperCase();
  if (upper.startsWith('END')) return 'END';
  if (upper.length < 4) return upper;
  const prefix = upper.slice(0, 4);
  return SECTION_NAMES.find((name) => name.startsWith(prefix)) ?? upper;
}

const PIPE_STATUS_KEYWORD = /^(OPEN|CLOSED|CV)$/i;
const SOURCE_TYPES: ReadonlySet<string> = new Set(['CONCEN', 'MASS', 'FLOWPACED', 'SETPOINT']);

/** "Quality Chlorine mg/L", "Quality Age", "Quality Trace N1", "Quality None". */
function parseQualityOption(tok: string[], quality: QualityOptions): void {
  const kind = (tok[1] ?? 'NONE').toUpperCase();
  if (kind === 'NONE') {
    quality.mode = 'NONE';
  } else if (kind === 'AGE') {
    quality.mode = 'AGE';
  } else if (kind === 'TRACE') {
    quality.mode = 'TRACE';
    quality.traceNode = tok[2] ?? '';
  } else {
    quality.mode = 'CHEMICAL';
    quality.chemName = kind === 'CHEMICAL' ? 'Chemical' : tok[1];
    const units = (tok[2] ?? 'mg/L').toUpperCase();
    quality.chemUnits = units === 'UG/L' ? 'ug/L' : 'mg/L';
  }
}

function num(token: string | undefined, fallback = 0): number {
  if (token === undefined) return fallback;
  const value = Number(token);
  return Number.isFinite(value) ? value : fallback;
}

/** "24:00", "1:30:00", "24", "30 MIN", "12 AM" 등을 초로 변환. */
export function parseTimeValue(tokens: string[]): number | null {
  const value = tokens[0];
  if (value === undefined) return null;
  const unit = (tokens[1] ?? '').toUpperCase();
  let hours: number;
  if (value.includes(':')) {
    const parts = value.split(':').map(Number);
    if (parts.some((p) => !Number.isFinite(p))) return null;
    hours = parts[0] + (parts[1] ?? 0) / 60 + (parts[2] ?? 0) / 3600;
  } else {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (unit.startsWith('SEC')) hours = n / 3600;
    else if (unit.startsWith('MIN')) hours = n / 60;
    else if (unit.startsWith('DAY')) hours = n * 24;
    else hours = n;
  }
  if (unit === 'AM' && hours >= 12) hours -= 12;
  if (unit === 'PM' && hours < 12) hours += 12;
  return Math.round(hours * 3600);
}

function parseTimesLine(tokens: string[], times: NetworkTimes): void {
  const upper = tokens.map((t) => t.toUpperCase());
  const assign = (key: keyof Omit<NetworkTimes, 'statistic'>, valueStart: number) => {
    const seconds = parseTimeValue(tokens.slice(valueStart));
    if (seconds !== null) times[key] = seconds;
  };
  const [a, b] = upper;
  if (a === 'DURATION') assign('duration', 1);
  else if (a === 'HYDRAULIC') assign('hydraulicStep', 2);
  else if (a === 'QUALITY') assign('qualityStep', 2);
  else if (a === 'RULE') assign('ruleStep', 2);
  else if (a === 'PATTERN' && b === 'START') assign('patternStart', 2);
  else if (a === 'PATTERN') assign('patternStep', 2);
  else if (a === 'REPORT' && b === 'START') assign('reportStart', 2);
  else if (a === 'REPORT') assign('reportStep', 2);
  else if (a === 'START') assign('startClockTime', 2);
  else if (a === 'STATISTIC' && b) times.statistic = b;
}

function normalizeHeadloss(token: string): HeadlossFormula | null {
  const t = token.toUpperCase();
  if (t === 'H-W' || t === 'D-W' || t === 'C-M') return t;
  return null;
}

function normalizeStatus(token: string | undefined): PipeStatus {
  const t = (token ?? 'OPEN').toUpperCase();
  if (t === 'CLOSED') return 'Closed';
  if (t === 'CV') return 'CV';
  return 'Open';
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface DemandEntry {
  demand: number;
  pattern: string;
  line: string;
}

export function parseInp(text: string, options: ParseInpOptions = {}): ParseInpResult {
  const model = createEmptyModel();
  model.title = [];
  const warnings: string[] = [];
  /** 원본 파일에서의 절점·링크 순서 (내보낼 때 되살린다) */
  let seq = 0;
  const coords = new Map<string, [number, number]>();
  const vertexMap = new Map<string, [number, number][]>();
  const demandMap = new Map<string, DemandEntry[]>();
  const qualityMap = new Map<string, number>();
  const sourceMap = new Map<string, QualitySource>();
  let section = '';

  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('[')) {
      const end = trimmed.indexOf(']');
      if (end > 0) {
        section = normalizeSection(trimmed.slice(1, end));
        if (section === 'END') break;
        continue;
      }
    }
    if (section === 'TITLE') {
      if (trimmed && !trimmed.startsWith(';') && model.title.length < 3) model.title.push(trimmed);
      continue;
    }
    const commentAt = rawLine.indexOf(';');
    const content = (commentAt >= 0 ? rawLine.slice(0, commentAt) : rawLine).trim();
    if (!content) continue;
    const tok = content.split(/\s+/);

    switch (section) {
      case 'JUNCTIONS':
        model.nodes[tok[0]] = {
          id: tok[0],
          seq: seq++,
          type: 'junction',
          position: [NaN, NaN],
          elevation: num(tok[1]),
          demand: num(tok[2]),
          pattern: tok[3] ?? '',
        };
        break;
      case 'RESERVOIRS':
        model.nodes[tok[0]] = {
          id: tok[0],
          seq: seq++,
          type: 'reservoir',
          position: [NaN, NaN],
          elevation: num(tok[1]),
          pattern: tok[2] ?? '',
        };
        break;
      case 'TANKS':
        model.nodes[tok[0]] = {
          id: tok[0],
          seq: seq++,
          type: 'tank',
          position: [NaN, NaN],
          elevation: num(tok[1]),
          initLevel: num(tok[2]),
          minLevel: num(tok[3]),
          maxLevel: num(tok[4]),
          diameter: num(tok[5]),
          minVolume: num(tok[6]),
          volumeCurve: tok[7] && tok[7] !== '*' ? tok[7] : '',
          overflow: (tok[8] ?? '').toUpperCase() === 'YES',
        };
        break;
      case 'PIPES': {
        if (tok.length < 3) break;
        // 7번째 토큰은 부차손실계수일 수도, 상태 키워드(Open/Closed/CV)일 수도 있다.
        const statusInSeventh = tok[6] !== undefined && PIPE_STATUS_KEYWORD.test(tok[6]);
        model.links[tok[0]] = {
          id: tok[0],
          seq: seq++,
          type: 'pipe',
          startNodeId: tok[1],
          endNodeId: tok[2],
          vertices: [],
          length: num(tok[3]),
          isCustomLength: true,
          diameter: num(tok[4]),
          roughness: num(tok[5], 100),
          minorLoss: statusInSeventh ? 0 : num(tok[6]),
          status: normalizeStatus(statusInSeventh ? tok[6] : tok[7]),
        };
        break;
      }
      case 'PUMPS': {
        if (tok.length < 3) break;
        let headCurve = '';
        let power = 0;
        let speed = 1;
        let pattern = '';
        for (let i = 3; i + 1 < tok.length; i += 2) {
          const keyword = tok[i].toUpperCase();
          const value = tok[i + 1];
          if (keyword === 'HEAD') headCurve = value;
          else if (keyword === 'POWER') power = num(value);
          else if (keyword === 'SPEED') speed = num(value, 1);
          else if (keyword === 'PATTERN') pattern = value;
        }
        model.links[tok[0]] = {
          id: tok[0],
          seq: seq++,
          type: 'pump',
          startNodeId: tok[1],
          endNodeId: tok[2],
          vertices: [],
          headCurve,
          power,
          speed,
          pattern,
        };
        break;
      }
      case 'VALVES': {
        if (tok.length < 3) break;
        const valveType = (tok[4] ?? 'PRV').toUpperCase();
        model.links[tok[0]] = {
          id: tok[0],
          seq: seq++,
          type: 'valve',
          startNodeId: tok[1],
          endNodeId: tok[2],
          vertices: [],
          diameter: num(tok[3]),
          valveType: (VALVE_TYPES.has(valveType) ? valveType : 'PRV') as ValveType,
          setting: tok[5] ?? '0',
          minorLoss: num(tok[6]),
        };
        break;
      }
      case 'PATTERNS': {
        const list = (model.patterns[tok[0]] ??= []);
        for (let i = 1; i < tok.length; i++) {
          const value = Number(tok[i]);
          if (Number.isFinite(value)) list.push(value);
        }
        break;
      }
      case 'CURVES': {
        const list = (model.curves[tok[0]] ??= []);
        if (tok.length >= 3) list.push([num(tok[1]), num(tok[2])]);
        break;
      }
      case 'COORDINATES':
        if (tok.length >= 3) coords.set(tok[0], [num(tok[1]), num(tok[2])]);
        break;
      case 'VERTICES':
        if (tok.length >= 3) {
          const list = vertexMap.get(tok[0]) ?? [];
          list.push([num(tok[1]), num(tok[2])]);
          vertexMap.set(tok[0], list);
        }
        break;
      case 'TIMES':
        parseTimesLine(tok, model.times);
        break;
      case 'OPTIONS': {
        const key = tok[0].toUpperCase();
        if (key === 'UNITS') {
          const units = (tok[1] ?? '').toUpperCase();
          if (FLOW_UNITS.has(units)) model.options.flowUnits = units as FlowUnits;
          else warnings.push(`알 수 없는 유량 단위 '${tok[1]}' — LPS 로 처리합니다.`);
        } else if (key === 'HEADLOSS') {
          const formula = normalizeHeadloss(tok[1] ?? '');
          if (formula) model.options.headloss = formula;
        } else if (key === 'QUALITY') {
          parseQualityOption(tok, model.options.quality);
        } else if (key === 'MAP' || key === 'HYDRAULICS') {
          // 외부 파일 참조는 브라우저에서 쓸 수 없으므로 버린다.
        } else {
          model.options.extra.push(content);
        }
        break;
      }
      case 'DEMANDS': {
        const list = demandMap.get(tok[0]) ?? [];
        list.push({ demand: num(tok[1]), pattern: tok[2] ?? '', line: content });
        demandMap.set(tok[0], list);
        break;
      }
      case 'QUALITY':
        // "절점 값" 형식만 구조화한다. "시작절점 끝절점 값" 범위 형식은 원문 보존.
        if (tok.length === 2 && Number.isFinite(Number(tok[1]))) qualityMap.set(tok[0], Number(tok[1]));
        else (model.extraSections.QUALITY ??= []).push(content);
        break;
      case 'SOURCES': {
        const type = (tok[1] ?? '').toUpperCase();
        if (tok.length >= 3 && SOURCE_TYPES.has(type)) {
          sourceMap.set(tok[0], { type: type as SourceType, strength: num(tok[2]), pattern: tok[3] ?? '' });
        } else {
          (model.extraSections.SOURCES ??= []).push(content);
        }
        break;
      }
      case 'REACTIONS': {
        const a = tok[0].toUpperCase();
        const b = (tok[1] ?? '').toUpperCase();
        if (a === 'GLOBAL' && b === 'BULK' && tok.length >= 3) model.options.reactions.globalBulk = num(tok[2]);
        else if (a === 'GLOBAL' && b === 'WALL' && tok.length >= 3) model.options.reactions.globalWall = num(tok[2]);
        else (model.extraSections.REACTIONS ??= []).push(content);
        break;
      }
      default:
        if (section && !SKIPPED_SECTIONS.has(section)) {
          (model.extraSections[section] ??= []).push(content);
        }
    }
  }

  for (const [nodeId, value] of qualityMap) {
    const node = model.nodes[nodeId];
    if (node) node.initQuality = value;
    else (model.extraSections.QUALITY ??= []).push(`${nodeId} ${value}`);
  }
  for (const [nodeId, source] of sourceMap) {
    const node = model.nodes[nodeId];
    if (node) node.source = source;
  }

  // [DEMANDS] 가 한 줄뿐인 절점은 기본 수요량으로 접어 넣는다 (EPANET 은 [DEMANDS] 를 우선한다).
  const keptDemandLines: string[] = [];
  for (const [nodeId, entries] of demandMap) {
    const node = model.nodes[nodeId];
    if (node?.type === 'junction' && entries.length === 1) {
      node.demand = entries[0].demand;
      node.pattern = entries[0].pattern;
    } else {
      for (const entry of entries) keptDemandLines.push(entry.line);
    }
  }
  if (keptDemandLines.length > 0) {
    model.extraSections.DEMANDS = keptDemandLines;
    warnings.push('수요 범주가 여러 개인 절점이 있습니다. 해당 절점의 수요량은 [DEMANDS] 원문 값이 우선 적용됩니다.');
  }

  // 위상 무결성: 정의되지 않은 절점을 참조하는 링크 제거
  let droppedLinks = 0;
  for (const linkId in model.links) {
    const link = model.links[linkId];
    if (!model.nodes[link.startNodeId] || !model.nodes[link.endNodeId]) {
      delete model.links[linkId];
      droppedLinks++;
    }
  }
  if (droppedLinks > 0) warnings.push(`정의되지 않은 절점을 참조하는 링크 ${droppedLinks}개를 제외했습니다.`);

  // 좌표계 결정
  const allPoints: [number, number][] = [...coords.values()];
  for (const list of vertexMap.values()) allPoints.push(...list);
  const choice = options.crs ?? 'auto';
  const resolved = choice === 'auto' ? detectCrs(allPoints) : choice;
  let crs: SourceCrs;
  let crsLabel: string;
  if (resolved === 'wgs84') {
    crs = { kind: 'wgs84' };
    crsLabel = 'WGS84 경위도';
  } else if (resolved === 'local') {
    crs = buildLocalCrs(model, coords, vertexMap, allPoints);
    crsLabel = '임의 평면 좌표 (기준 위치에 배치)';
  } else {
    crs = { kind: 'epsg', code: resolved };
    crsLabel = CRS_DEFS[resolved]?.label ?? resolved;
  }
  if (choice === 'auto') crsLabel += ' — 자동 감지';
  model.crs = crs;

  // 좌표 적용
  const converted: LngLat[] = [];
  for (const id in model.nodes) {
    const xy = coords.get(id);
    if (xy) {
      const p = toWgs84(crs, xy);
      model.nodes[id].position = p;
      converted.push(p);
    }
  }
  let fallback: LngLat = DEFAULT_ANCHOR;
  if (converted.length > 0) {
    let sx = 0;
    let sy = 0;
    for (const p of converted) {
      sx += p[0];
      sy += p[1];
    }
    fallback = [sx / converted.length, sy / converted.length];
  }
  let missing = 0;
  for (const id in model.nodes) {
    if (!coords.has(id)) {
      model.nodes[id].position = [fallback[0], fallback[1]];
      missing++;
    }
  }
  if (missing > 0) warnings.push(`좌표가 없는 절점 ${missing}개를 관망 중심에 배치했습니다.`);

  for (const [linkId, list] of vertexMap) {
    const link = model.links[linkId];
    if (link) link.vertices = list.map((xy) => toWgs84(crs, xy));
  }

  // 파일 연장과 형상 연장이 사실상 같으면 '자동 계산' 관로로 본다.
  if (crs.kind !== 'local') {
    for (const linkId in model.links) {
      const link = model.links[linkId];
      if (link.type !== 'pipe') continue;
      const a = model.nodes[link.startNodeId].position;
      const b = model.nodes[link.endNodeId].position;
      const geometric = metersToModelLength(pathLengthMeters([a, ...link.vertices, b]), model.options.flowUnits);
      if (geometric > 0 && Math.abs(link.length - geometric) / geometric < 0.02) link.isCustomLength = false;
    }
  }

  return { model, warnings, crsLabel };
}

function buildLocalCrs(
  model: NetworkModel,
  coords: Map<string, [number, number]>,
  vertexMap: Map<string, [number, number][]>,
  allPoints: [number, number][],
): SourceCrs {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of allPoints) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const origin: [number, number] = Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : [0, 0];

  // 관로 연장(실거리)과 도면상 거리의 비로 축척을 추정한다.
  const lengthToMeters = isUsUnits(model.options.flowUnits) ? 1 / FEET_PER_METER : 1;
  const ratios: number[] = [];
  for (const linkId in model.links) {
    const link = model.links[linkId];
    if (link.type !== 'pipe' || !(link.length > 0)) continue;
    const a = coords.get(link.startNodeId);
    const b = coords.get(link.endNodeId);
    if (!a || !b) continue;
    const path = [a, ...(vertexMap.get(linkId) ?? []), b];
    let drawn = 0;
    for (let i = 0; i < path.length - 1; i++) {
      drawn += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
    }
    if (drawn > 0) ratios.push((link.length * lengthToMeters) / drawn);
  }
  const metersPerUnit = ratios.length > 0 ? Math.min(1e6, Math.max(1e-6, median(ratios))) : 1;
  return { kind: 'local', origin, anchor: DEFAULT_ANCHOR, metersPerUnit };
}
