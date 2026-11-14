/**
 * SWMM .inp → 편집 가능한 하수 프로젝트(SewerProject).
 *
 * 하수 설계 모델은 원형관·중력식·가지형만 다루므로 그대로 옮길 수 없는 것은 경고 목록으로 돌려준다.
 * - 절점 [JUNCTIONS] → 맨홀 (지반고 = 관저고 + 최대 수심), [OUTFALLS] → 방류구, [STORAGE]/[DIVIDERS] → 맨홀(경고)
 * - [CONDUITS] + [XSECTIONS] CIRCULAR → 관거. 원형이 아니면 높이(Geom1)를 관경으로 쓰고 경고
 * - [PUMPS]/[ORIFICES]/[WEIRS]/[OUTLETS] 는 옮기지 않는다(경고)
 * - [SUBCATCHMENTS] 는 출구가 맨홀일 때만 유역으로 옮긴다
 * - 좌표는 inpReader 가 판별한 좌표계 → WGS84 → EPSG:5186 (m)
 * - 단위는 m·m³/s·ha 로 환산한다 (미국 단위계 파일은 ft·acre·cfs 등에서)
 */
import type { LngLat } from '../model/types';
import { wgs84ToEpsg } from '../../utils/geoMath';
import { readSwmmInp } from '../swmm/inpReader';
import { SEWER_CRS } from './mapFrame';
import { defaultConstraints, defaultOptions, type SewerBoundary, type SewerCatchment, type SewerConduit, type SewerNode, type SewerProject } from './types';
import { parseSewerProject, SewerValidationError } from './validate';

export interface SwmmImport {
  project: SewerProject;
  warnings: string[];
  /** 스키마 검증(parseSewerProject)을 통과했는지. 통과하지 못해도 편집해 고칠 수 있게 프로젝트는 돌려준다. */
  valid: boolean;
  crsLabel: string;
}

/** 유량 단위 → m³/s 환산 계수 */
const FLOW_TO_CMS: Record<string, number> = { CMS: 1, LPS: 0.001, MLD: 1000 / 86400, CFS: 0.028316846592, GPM: 6.30901964e-5, MGD: 0.0438126364 };
const FT = 0.3048;
const ACRE_TO_HA = 0.40468564224;
/** 최대 수심이 0 인 절점·방류구에 쓰는 임시 깊이 (m) */
const FALLBACK_DEPTH = 2;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,30}$/;

function sectionsOf(text: string): Map<string, string[][]> {
  const sections = new Map<string, string[][]>();
  let current = '';
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      const end = trimmed.indexOf(']');
      if (end > 0) {
        current = trimmed.slice(1, end).toUpperCase();
        continue;
      }
    }
    const content = (raw.indexOf(';') >= 0 ? raw.slice(0, raw.indexOf(';')) : raw).trim();
    if (!content || !current || current === 'TITLE') continue;
    const rows = sections.get(current) ?? [];
    rows.push(content.split(/\s+/));
    sections.set(current, rows);
  }
  return sections;
}

function num(token: string | undefined, fallback = 0): number {
  const value = Number(token);
  return token !== undefined && Number.isFinite(value) ? value : fallback;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** 하수 프로젝트 ID 규칙(영문 시작, 영문·숫자·_·-, 31자)에 맞게 고치고 중복을 피한다. */
function makeIdMapper(prefix: string) {
  const used = new Set<string>();
  const map = new Map<string, string>();
  let renamed = 0;
  return {
    get: (original: string): string | undefined => map.get(original),
    add: (original: string): string => {
      let id = original.replace(/[^A-Za-z0-9_-]/g, '_');
      if (!/^[A-Za-z]/.test(id)) id = `${prefix}${id}`;
      id = id.slice(0, 31);
      if (!ID_PATTERN.test(id)) id = prefix;
      let candidate = id;
      for (let k = 2; used.has(candidate); k++) candidate = `${id.slice(0, 31 - String(k).length - 1)}_${k}`;
      if (candidate !== original) renamed++;
      used.add(candidate);
      map.set(original, candidate);
      return candidate;
    },
    renamed: () => renamed,
  };
}

function list(ids: string[], max = 8): string {
  return ids.length <= max ? ids.join(', ') : `${ids.slice(0, max).join(', ')} 외 ${ids.length - max}개`;
}

/** SWMM [POLYGONS] 경계(경위도)를 하수 좌표(EPSG:5186)로. 닫는 점은 뺀다. */
function polygonOf(ring: LngLat[] | undefined): { polygon?: [number, number][] } {
  if (!ring || ring.length < 3) return {};
  const pts = ring.map((p) => wgs84ToEpsg(SEWER_CRS, p)).map(([x, y]) => [r3(x), r3(y)] as [number, number]);
  const [a, b] = [pts[0], pts[pts.length - 1]];
  if (a[0] === b[0] && a[1] === b[1]) pts.pop();
  return pts.length >= 3 ? { polygon: pts } : {};
}

export function sewerProjectFromSwmm(text: string, name?: string): SwmmImport {
  const swmm = readSwmmInp(text);
  const warnings: string[] = [...swmm.warnings];
  const sections = sectionsOf(swmm.text);
  const rows = (key: string) => sections.get(key) ?? [];

  const option = (key: string): string | undefined => rows('OPTIONS').find((t) => t[0]?.toUpperCase() === key)?.[1]?.toUpperCase();
  const len = swmm.us ? FT : 1;
  const flowFactor = FLOW_TO_CMS[swmm.flowUnits] ?? 1;
  if (swmm.us) warnings.push(`미국 단위계(${swmm.flowUnits}) 파일입니다. 길이·표고는 ft → m, 면적은 acre → ha, 유량은 m³/s 로 환산했습니다.`);
  else if (swmm.flowUnits !== 'CMS') warnings.push(`유량 단위 ${swmm.flowUnits} 를 m³/s 로 환산했습니다.`);
  const elevationOffsets = option('LINK_OFFSETS') === 'ELEVATION';

  /* ---------------------------------------------------------------- 절점 */
  const nodeIds = makeIdMapper('N');
  const outfallRows = new Map(rows('OUTFALLS').map((t) => [t[0], t]));
  const nodes: SewerNode[] = [];
  const invertOf = new Map<string, number>();
  const noDepth: string[] = [];
  const asManhole: string[] = [];
  const boundaryChanged: string[] = [];
  for (const n of swmm.nodes) {
    const id = nodeIds.add(n.id);
    const [x, y] = wgs84ToEpsg(SEWER_CRS, n.position);
    const invert = r3(n.invert * len);
    invertOf.set(n.id, invert);
    let depth = n.maxDepth * len;
    if (n.kind === 'outfall' || !(depth > 0)) {
      if (n.kind !== 'outfall') noDepth.push(n.id);
      depth = FALLBACK_DEPTH;
    }
    let boundary: SewerBoundary = 'FREE';
    let stage: number | null = null;
    if (n.kind === 'outfall') {
      const t = outfallRows.get(n.id);
      const type = t?.[2]?.toUpperCase() ?? 'FREE';
      if (type === 'NORMAL') boundary = 'NORMAL';
      else if (type === 'FIXED') {
        boundary = 'FIXED';
        stage = Math.max(invert, r3(num(t?.[3], n.invert) * len));
      } else if (type !== 'FREE') boundaryChanged.push(n.id);
    } else if (n.kind !== 'junction') asManhole.push(n.id);
    nodes.push({ id, x: r3(x), y: r3(y), ground: r3(invert + depth), invert, kind: n.kind === 'outfall' ? 'OUTFALL' : 'JUNCTION', base_flow: 0, boundary, stage });
  }
  if (noDepth.length > 0) warnings.push(`최대 수심이 0 인 절점 ${noDepth.length}개는 지반고를 관저고 + ${FALLBACK_DEPTH} m 로 두었습니다: ${list(noDepth)}. ‘지반고 보정’으로 고치세요.`);
  if (swmm.nodes.some((n) => n.kind === 'outfall')) warnings.push(`방류구 지반고는 파일에 없어 관저고 + ${FALLBACK_DEPTH} m 로 두었습니다.`);
  if (asManhole.length > 0) warnings.push(`저류조·분류기 ${asManhole.length}개는 맨홀로 바꿨습니다(저류 용량·분류 규칙은 옮기지 않음): ${list(asManhole)}`);
  if (boundaryChanged.length > 0) warnings.push(`방류구 경계(TIDAL·TIMESERIES)는 FREE 로 바꿨습니다: ${list(boundaryChanged)}`);
  const nodeByNewId = new Map(nodes.map((n) => [n.id, n]));

  /* ---------------------------------------------------------------- 유입 */
  let dwfOther = 0;
  for (const t of rows('DWF')) {
    const id = nodeIds.get(t[0]);
    const node = id ? nodeByNewId.get(id) : undefined;
    if (!node || t[1]?.toUpperCase() !== 'FLOW') {
      dwfOther++;
      continue;
    }
    const flow = num(t[2]) * flowFactor;
    if (node.kind === 'OUTFALL') dwfOther++;
    else node.base_flow = Math.max(0, node.base_flow + flow);
  }
  if (dwfOther > 0) warnings.push(`[DWF] ${dwfOther}줄은 옮기지 못했습니다(유량이 아니거나 방류구·없는 절점).`);
  if (rows('INFLOWS').length > 0) warnings.push(`[INFLOWS] 직접 유입 ${rows('INFLOWS').length}줄은 옮기지 않았습니다. 맨홀의 ‘오수 유입’에 직접 넣으세요.`);
  if (rows('PATTERNS').length > 0) warnings.push('유입 시간 패턴([PATTERNS])은 옮기지 않았습니다. 상시 유입은 일정한 값으로 봅니다.');

  /* ---------------------------------------------------------------- 관거 */
  const conduitIds = makeIdMapper('C');
  const xsections = new Map(rows('XSECTIONS').map((t) => [t[0], t]));
  const conduitRows = new Map(rows('CONDUITS').map((t) => [t[0], t]));
  const conduits: SewerConduit[] = [];
  const nonCircular: string[] = [];
  const skippedLinks: string[] = [];
  const badConduits: string[] = [];
  for (const link of swmm.links) {
    if (link.kind !== 'conduit') {
      skippedLinks.push(`${link.id}(${link.kind})`);
      continue;
    }
    const t = conduitRows.get(link.id);
    const xs = xsections.get(link.id);
    const upstream = nodeIds.get(link.from);
    const downstream = nodeIds.get(link.to);
    const diameter = num(xs?.[2]) * len;
    const length = num(t?.[3]) * len;
    if (!upstream || !downstream || !(diameter > 0) || !(length > 0)) {
      badConduits.push(link.id);
      continue;
    }
    if ((xs?.[1] ?? '').toUpperCase() !== 'CIRCULAR') nonCircular.push(`${link.id}(${xs?.[1] ?? '?'})`);
    const offset = (token: string | undefined, nodeId: string): number => {
      if (token === undefined || token === '*') return 0;
      const value = num(token) * len;
      return Math.max(0, r3(elevationOffsets ? value - (invertOf.get(nodeId) ?? value) : value));
    };
    conduits.push({
      id: conduitIds.add(link.id),
      upstream,
      downstream,
      length: r3(length),
      diameter: r3(diameter),
      roughness: Math.min(0.1, num(t?.[4], 0.013) > 0 ? num(t?.[4], 0.013) : 0.013),
      inlet_offset: offset(t?.[5], link.from),
      outlet_offset: offset(t?.[6], link.to),
    });
  }
  if (nonCircular.length > 0) warnings.push(`원형이 아닌 단면 ${nonCircular.length}개는 높이(Geom1)를 관경으로 하는 원형관으로 바꿨습니다: ${list(nonCircular)}`);
  if (skippedLinks.length > 0) warnings.push(`펌프·오리피스·위어·배출구 ${skippedLinks.length}개는 옮기지 않았습니다(중력식 원형관만 지원): ${list(skippedLinks)}`);
  if (badConduits.length > 0) warnings.push(`연장·관경이 0 이거나 단면 정보가 없는 관거 ${badConduits.length}개는 옮기지 않았습니다: ${list(badConduits)}`);

  /* ---------------------------------------------------------------- 유역 */
  const catchmentIds = makeIdMapper('S');
  const horton = /HORTON/.test(option('INFILTRATION') ?? 'HORTON');
  const infiltration = new Map(rows('INFILTRATION').map((t) => [t[0], t]));
  const catchments: SewerCatchment[] = [];
  const skippedSubs: string[] = [];
  const ringOf = new Map(swmm.subcatchments.map((sc) => [sc.id, sc.polygon]));
  for (const t of rows('SUBCATCHMENTS')) {
    const outletId = nodeIds.get(t[2] ?? '');
    const outlet = outletId ? nodeByNewId.get(outletId) : undefined;
    const area = num(t[3]) * (swmm.us ? ACRE_TO_HA : 1);
    if (!outlet || outlet.kind !== 'JUNCTION' || !(area > 0)) {
      skippedSubs.push(t[0]);
      continue;
    }
    const inf = horton ? infiltration.get(t[0]) : undefined;
    // Horton 침투율: SI 는 mm/h, 미국 단위계는 in/h
    const rate = swmm.us ? 25.4 : 1;
    const hMax = inf ? Math.max(0, num(inf[1], 75) * rate) : 75;
    const hMin = inf ? Math.max(0, num(inf[2], 5) * rate) : 5;
    catchments.push({
      id: catchmentIds.add(t[0]),
      outlet: outlet.id,
      area: r3(area),
      impervious: Math.min(100, Math.max(0, num(t[4], 60))),
      width: num(t[5]) > 0 ? r3(num(t[5]) * len) : 100,
      slope: num(t[6]) > 0 ? Math.min(100, num(t[6])) : 1,
      runoff_coefficient: 0.65,
      horton_max: Math.max(hMax, hMin),
      horton_min: Math.min(hMax, hMin),
      horton_decay: inf && num(inf[3]) > 0 ? num(inf[3]) : 4,
      ...polygonOf(ringOf.get(t[0])),
    });
  }
  if (skippedSubs.length > 0) warnings.push(`출구가 맨홀이 아닌(다른 유역·방류구·없는 절점) 유역 ${skippedSubs.length}개는 옮기지 않았습니다: ${list(skippedSubs)}`);
  if (catchments.length > 0) {
    warnings.push('유역의 합리식 유출계수 C 는 파일에 없어 0.65 로 두었습니다. 설계 조건·일괄 표 편집에서 고치세요.');
    if (!horton) warnings.push('침투 모형이 Horton 이 아니어서 침투 값은 기본값(75/5 mm/h, 감쇠 4)으로 두었습니다.');
  }

  /* ---------------------------------------------------------------- 옵션·이름 변경·위상 */
  const options = defaultOptions();
  const routing = option('FLOW_ROUTING');
  if (routing === 'KINWAVE' || routing === 'DYNWAVE') options.routing = routing;
  warnings.push('강우 곡선·해석 시간·설계 제약은 기본값입니다(파일의 강우 시계열·제어 규칙·LID 등은 옮기지 않음).');
  const renamed = nodeIds.renamed() + conduitIds.renamed() + catchmentIds.renamed();
  if (renamed > 0) warnings.push(`ID ${renamed}개를 하수 설계 규칙(영문으로 시작, 영문·숫자·_·-)에 맞게 바꿨습니다 (예: 1 → N1).`);

  const outDegree = new Map<string, number>();
  for (const c of conduits) outDegree.set(c.upstream, (outDegree.get(c.upstream) ?? 0) + 1);
  const branching = nodes.filter((n) => n.kind === 'JUNCTION' && (outDegree.get(n.id) ?? 0) !== 1).map((n) => n.id);
  if (branching.length > 0) warnings.push(`하류 관거가 1개가 아닌 맨홀 ${branching.length}개: ${list(branching)}. 자동 설계는 가지형(맨홀마다 하류 관거 1개)만 됩니다 — 지도에서 고치세요.`);
  if (!nodes.some((n) => n.kind === 'OUTFALL')) warnings.push('방류구가 없습니다. 방류구 도구로 하류 끝에 추가하세요.');

  const project: SewerProject = {
    schema_version: 1,
    name: (name ?? swmm.title ?? '').slice(0, 60) || 'SWMM 가져오기',
    nodes,
    conduits,
    catchments,
    options,
    constraints: defaultConstraints(),
  };
  let valid = true;
  try {
    parseSewerProject(JSON.parse(JSON.stringify(project)));
  } catch (error) {
    valid = false;
    const detail = error instanceof SewerValidationError ? error.details.slice(0, 3).map((d) => (d.loc.length ? `${d.loc.join('.')}: ` : '') + d.msg).join(' / ') : String(error);
    warnings.push(`그대로는 설계할 수 없습니다: ${detail}`);
  }
  return { project, warnings, valid, crsLabel: swmm.crsLabel };
}
