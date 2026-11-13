/**
 * SWMM .inp 에서 지도에 그릴 형상(절점·관거·유역·강우계)과 기본 속성만 읽는다.
 * 해석은 원문을 그대로 엔진에 넘기므로(편집 기능 없음) 어떤 섹션도 잃지 않는다.
 */
import { DEFAULT_ANCHOR, detectCrs, CRS_DEFS, toWgs84 } from '../../utils/geoMath';
import { schematicLayout } from './schematicLayout';
import type { LngLat, SourceCrs } from '../model/types';

export type SwmmNodeKind = 'junction' | 'outfall' | 'storage' | 'divider';
export type SwmmLinkKind = 'conduit' | 'pump' | 'orifice' | 'weir' | 'outlet';

export interface SwmmNodeDef {
  id: string;
  kind: SwmmNodeKind;
  position: LngLat;
  invert: number;
  maxDepth: number;
}

export interface SwmmLinkDef {
  id: string;
  kind: SwmmLinkKind;
  from: string;
  to: string;
  vertices: LngLat[];
  length: number;
  /** 관거 단면 (예: CIRCULAR 0.6). */
  shape: string;
  geom1: number;
}

export interface SwmmSubcatchDef {
  id: string;
  gage: string;
  outlet: string;
  area: number;
  imperv: number;
  polygon: LngLat[];
}

export interface SwmmProject {
  title: string;
  /** 엔진에 그대로 넘기는 원문. */
  text: string;
  flowUnits: string;
  /** 미국 단위계(CFS/GPM/MGD)이면 길이는 ft. */
  us: boolean;
  nodes: SwmmNodeDef[];
  links: SwmmLinkDef[];
  subcatchments: SwmmSubcatchDef[];
  gages: { id: string; position: LngLat }[];
  crsLabel: string;
  warnings: string[];
}

const US_UNITS = new Set(['CFS', 'GPM', 'MGD']);
const NODE_SECTIONS: Record<string, SwmmNodeKind> = { JUNCTIONS: 'junction', OUTFALLS: 'outfall', STORAGE: 'storage', DIVIDERS: 'divider' };
const LINK_SECTIONS: Record<string, SwmmLinkKind> = { CONDUITS: 'conduit', PUMPS: 'pump', ORIFICES: 'orifice', WEIRS: 'weir', OUTLETS: 'outlet' };

/** SWMM 파일인지 판별: EPANET 에는 없는 SWMM 전용 섹션이 있는지 본다. */
export function looksLikeSwmm(text: string): boolean {
  return /^\s*\[(CONDUITS|SUBCATCHMENTS|RAINGAGES|OUTFALLS|XSECTIONS)\]/im.test(text) && !/^\s*\[(PIPES|RESERVOIRS|TANKS)\]/im.test(text);
}

export type RoutingChoice = 'original' | 'STEADY' | 'KINWAVE' | 'DYNWAVE';

/** 원문의 FLOW_ROUTING 값을 읽는다 (없으면 SWMM 기본값 KINWAVE). */
export function routingOf(text: string): string {
  return /^\s*FLOW_ROUTING\s+(\S+)/im.exec(text)?.[1]?.toUpperCase() ?? 'KINWAVE';
}

/** 해석 직전에만 FLOW_ROUTING 을 바꾼 사본을 만든다. 원문(project.text)은 건드리지 않는다. */
export function withRouting(text: string, choice: RoutingChoice): string {
  if (choice === 'original') return text;
  if (/^\s*FLOW_ROUTING\s+\S+/im.test(text)) return text.replace(/^(\s*FLOW_ROUTING\s+)\S+/im, `$1${choice}`);
  return text.replace(/^(\s*\[OPTIONS\][^\n]*\n)/im, `$1FLOW_ROUTING ${choice}\n`);
}

/** 자주 만나는 SWMM 오류 코드의 한국어 안내. */
export function swmmErrorHint(code: number | null): string | null {
  switch (code) {
    case 115:
      return '정상류(STEADY)·운동파(KINWAVE) 해석은 관거 경사가 하류 쪽으로 내려가야 합니다. 역경사 관거의 관저고를 확인하거나, 우측 패널 ‘흐름 계산 방식’을 동적파(DYNWAVE)로 바꿔 다시 실행하세요.';
    case 205:
      return '알 수 없는 키워드가 있습니다. 보고서에 표시된 줄을 확인하세요 (SWMM 입력 파일에는 [END] 섹션이 없습니다).';
    case 200:
    case 201:
    case 203:
    case 209:
    case 211:
      return '입력 파일 형식 오류입니다. 보고서에 표시된 줄을 확인하세요.';
    default:
      return null;
  }
}

function num(token: string | undefined, fallback = 0): number {
  const value = Number(token);
  return token !== undefined && Number.isFinite(value) ? value : fallback;
}

export function readSwmmInp(text: string): SwmmProject {
  const warnings: string[] = [];
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const sections = new Map<string, string[][]>();
  const title: string[] = [];
  let current = '';
  for (const raw of clean.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      const end = trimmed.indexOf(']');
      if (end > 0) {
        current = trimmed.slice(1, end).toUpperCase();
        continue;
      }
    }
    if (current === 'TITLE') {
      if (trimmed && !trimmed.startsWith(';')) title.push(trimmed);
      continue;
    }
    const content = (raw.indexOf(';') >= 0 ? raw.slice(0, raw.indexOf(';')) : raw).trim();
    if (!content || !current) continue;
    const rows = sections.get(current) ?? [];
    rows.push(content.split(/\s+/));
    sections.set(current, rows);
  }
  const rows = (name: string) => sections.get(name) ?? [];

  let flowUnits = 'CFS';
  for (const t of rows('OPTIONS')) if (t[0]?.toUpperCase() === 'FLOW_UNITS' && t[1]) flowUnits = t[1].toUpperCase();
  const us = US_UNITS.has(flowUnits);

  // 좌표가 없는 파일(전부 같은 값이거나 대부분 비어 있음, 예: 좌표 없이 만든 PipeTools 파일)은 연결 관계로 개략도를 만든다.
  const nodeIdList = Object.keys(NODE_SECTIONS).flatMap((s) => rows(s).map((t) => t[0]));
  const coordRows = rows('COORDINATES').filter((t) => t.length >= 3);
  let spanX = 0;
  let spanY = 0;
  if (coordRows.length > 0) {
    const xs = coordRows.map((t) => num(t[1]));
    const ys = coordRows.map((t) => num(t[2]));
    spanX = Math.max(...xs) - Math.min(...xs);
    spanY = Math.max(...ys) - Math.min(...ys);
  }
  const noCoords = nodeIdList.length > 1 && (coordRows.length < nodeIdList.length * 0.5 || (coordRows.length >= 2 && spanX < 1e-6 && spanY < 1e-6));
  const rawCoords = new Map<string, [number, number]>();
  if (noCoords) {
    const layoutLinks = Object.keys(LINK_SECTIONS).flatMap((s) =>
      rows(s)
        .filter((t) => t.length >= 3)
        .map((t) => ({ from: t[1], to: t[2], length: s === 'CONDUITS' ? num(t[3]) : 0 })),
    );
    const outfalls = rows('OUTFALLS').map((t) => t[0]);
    for (const [id, p] of schematicLayout(nodeIdList, layoutLinks, outfalls)) rawCoords.set(id, p);
    warnings.push('이 파일에는 절점 좌표가 없어(모두 0) 관거 연장으로 개략도를 그렸습니다. 실제 위치와는 무관합니다. 위치가 필요하면 EPA SWMM 등에서 좌표를 넣어 다시 저장하세요.');
  } else {
    for (const t of coordRows) rawCoords.set(t[0], [num(t[1]), num(t[2])]);
  }

  // 좌표계: 모든 좌표로 추정
  const rawPoints: [number, number][] = [...rawCoords.values()];
  if (!noCoords) {
    for (const t of [...rows('VERTICES'), ...rows('POLYGONS'), ...rows('SYMBOLS')]) {
      if (t.length >= 3) rawPoints.push([num(t[1]), num(t[2])]);
    }
  }
  const detected = noCoords ? 'local' : detectCrs(rawPoints);
  let crs: SourceCrs;
  let crsLabel: string;
  if (detected === 'wgs84') {
    crs = { kind: 'wgs84' };
    crsLabel = 'WGS84 경위도';
  } else if (detected === 'local') {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of rawPoints) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    crs = {
      kind: 'local',
      origin: Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : [0, 0],
      anchor: DEFAULT_ANCHOR,
      metersPerUnit: us ? 0.3048 : 1,
    };
    crsLabel = noCoords ? '좌표 없음 — 연장 기준 개략 배치' : '임의 평면 좌표 (기준 위치에 배치)';
  } else {
    crs = { kind: 'epsg', code: detected };
    crsLabel = CRS_DEFS[detected]?.label ?? detected;
  }
  const convert = (x: number, y: number): LngLat => toWgs84(crs, [x, y]);

  const coords = new Map<string, LngLat>();
  for (const [id, [x, y]] of rawCoords) coords.set(id, convert(x, y));

  const nodes: SwmmNodeDef[] = [];
  for (const [section, kind] of Object.entries(NODE_SECTIONS)) {
    for (const t of rows(section)) {
      const position = coords.get(t[0]);
      if (!position) {
        warnings.push(`${kind} ${t[0]} 의 좌표가 없어 지도에 그리지 않습니다.`);
        continue;
      }
      // JUNCTIONS: 이름 고도 최대수심 …, OUTFALLS: 이름 고도 유형 …, STORAGE: 이름 고도 최대수심 …
      nodes.push({ id: t[0], kind, position, invert: num(t[1]), maxDepth: kind === 'outfall' ? 0 : num(t[2]) });
    }
  }
  const nodeIds = new Set(nodes.map((n) => n.id));

  const xs = new Map<string, { shape: string; geom1: number }>();
  for (const t of rows('XSECTIONS')) xs.set(t[0], { shape: t[1] ?? '', geom1: num(t[2]) });
  const vertices = new Map<string, LngLat[]>();
  for (const t of rows('VERTICES')) {
    if (t.length < 3 || noCoords) continue;
    const list = vertices.get(t[0]) ?? [];
    list.push(convert(num(t[1]), num(t[2])));
    vertices.set(t[0], list);
  }

  const links: SwmmLinkDef[] = [];
  let dropped = 0;
  for (const [section, kind] of Object.entries(LINK_SECTIONS)) {
    for (const t of rows(section)) {
      if (t.length < 3) continue;
      if (!nodeIds.has(t[1]) || !nodeIds.has(t[2])) {
        dropped++;
        continue;
      }
      const x = xs.get(t[0]);
      links.push({
        id: t[0],
        kind,
        from: t[1],
        to: t[2],
        vertices: vertices.get(t[0]) ?? [],
        length: kind === 'conduit' ? num(t[3]) : 0,
        shape: x?.shape ?? '',
        geom1: x?.geom1 ?? 0,
      });
    }
  }
  if (dropped > 0) warnings.push(`좌표가 없는 절점에 연결된 링크 ${dropped}개는 지도에 그리지 않습니다.`);

  const polygons = new Map<string, LngLat[]>();
  for (const t of rows('POLYGONS')) {
    if (t.length < 3 || noCoords) continue;
    const list = polygons.get(t[0]) ?? [];
    list.push(convert(num(t[1]), num(t[2])));
    polygons.set(t[0], list);
  }
  const subcatchments: SwmmSubcatchDef[] = rows('SUBCATCHMENTS').map((t) => ({
    id: t[0],
    gage: t[1] ?? '',
    outlet: t[2] ?? '',
    area: num(t[3]),
    imperv: num(t[4]),
    polygon: polygons.get(t[0]) ?? [],
  }));
  const gages = rows('SYMBOLS')
    .filter((t) => t.length >= 3 && !noCoords)
    .map((t) => ({ id: t[0], position: convert(num(t[1]), num(t[2])) }));

  if (nodes.length === 0) warnings.push('좌표가 있는 절점이 없습니다. [COORDINATES] 섹션을 확인하세요.');
  return { title: title[0] ?? '', text: clean, flowUnits, us, nodes, links, subcatchments, gages, crsLabel, warnings };
}
