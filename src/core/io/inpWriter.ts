/**
 * 내부 관망 모델 → EPANET 표준 .inp 텍스트 직렬화.
 * 파일 내보내기와 해석 엔진 입력에 같은 직렬화를 사용한다.
 */
import { fromWgs84 } from '../../utils/geoMath';
import type { NetworkModel, NetworkTimes } from '../model/types';
import { formatClock } from '../model/units';

export interface WriteInpOptions {
  /** 엔진 실행용: 화면 전용 섹션을 빼고 보고서 출력을 최소화한다. */
  forEngine?: boolean;
}

/** 첫 토큰이 절점/링크 ID 인 원문 보존 섹션 — 삭제된 객체를 참조하는 줄은 내보내지 않는다. */
const NODE_KEYED_SECTIONS = ['DEMANDS', 'EMITTERS', 'QUALITY', 'SOURCES', 'MIXING'];
const LINK_KEYED_SECTIONS = ['STATUS', 'LEAKAGE'];
const PASSTHROUGH_ORDER = [
  'TAGS',
  'DEMANDS',
  'STATUS',
  'LEAKAGE',
  'CONTROLS',
  'RULES',
  'ENERGY',
  'EMITTERS',
  'QUALITY',
  'SOURCES',
  'REACTIONS',
  'MIXING',
];
const DISPLAY_ONLY_SECTIONS = ['LABELS', 'BACKDROP', 'TAGS'];

function fmt(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Number(value.toFixed(6)));
}

function pad(text: string, width = 16): string {
  return text.length >= width ? `${text} ` : text.padEnd(width);
}

function row(...cells: (string | number)[]): string {
  return ` ${cells.map((c) => pad(typeof c === 'number' ? fmt(c) : c)).join('').trimEnd()}`;
}

function timesSection(times: NetworkTimes): string[] {
  return [
    row('Duration', '', formatClock(times.duration)),
    row('Hydraulic Timestep', '', formatClock(times.hydraulicStep)),
    row('Quality Timestep', '', formatClock(times.qualityStep)),
    row('Rule Timestep', '', formatClock(times.ruleStep)),
    row('Pattern Timestep', '', formatClock(times.patternStep)),
    row('Pattern Start', '', formatClock(times.patternStart)),
    row('Report Timestep', '', formatClock(times.reportStep)),
    row('Report Start', '', formatClock(times.reportStart)),
    row('Start ClockTime', '', formatClock(times.startClockTime)),
    row('Statistic', '', times.statistic || 'NONE'),
  ];
}

function qualityOptionRow(model: NetworkModel): string {
  const q = model.options.quality;
  if (q.mode === 'AGE') return row('Quality', '', 'Age');
  if (q.mode === 'TRACE' && q.traceNode in model.nodes) return row('Quality', '', 'Trace', q.traceNode);
  if (q.mode === 'CHEMICAL') return row('Quality', '', (q.chemName || 'Chemical').replace(/\s+/g, '_'), q.chemUnits || 'mg/L');
  return row('Quality', '', 'None');
}

export function writeInp(model: NetworkModel, options: WriteInpOptions = {}): string {
  const out: string[] = [];
  const section = (name: string, header: string | null, lines: string[]) => {
    out.push(`[${name}]`);
    if (header) out.push(header);
    for (const line of lines) out.push(line);
    out.push('');
  };

  // 원본 파일 순서대로 (숫자 ID 는 객체에서 숫자순으로 바뀌므로). 순서가 없는(나중에 추가한) 것은 뒤에 둔다. sort 는 안정 정렬.
  const bySeq = <T extends { seq?: number }>(list: T[]) => list.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
  const nodes = bySeq(Object.values(model.nodes));
  const links = bySeq(Object.values(model.links));

  section('TITLE', null, model.title.slice(0, 3));

  section(
    'JUNCTIONS',
    ';ID              Elev            Demand          Pattern',
    nodes.filter((n) => n.type === 'junction').map((n) => row(n.id, n.elevation, n.demand, n.pattern)),
  );
  section(
    'RESERVOIRS',
    ';ID              Head            Pattern',
    nodes.filter((n) => n.type === 'reservoir').map((n) => row(n.id, n.elevation, n.pattern)),
  );
  section(
    'TANKS',
    ';ID              Elevation       InitLevel       MinLevel        MaxLevel        Diameter        MinVol          VolCurve        Overflow',
    nodes
      .filter((n) => n.type === 'tank')
      .map((n) => {
        const base = [n.id, n.elevation, n.initLevel, n.minLevel, n.maxLevel, n.diameter, n.minVolume];
        if (n.overflow) return row(...base, n.volumeCurve || '*', 'YES');
        return n.volumeCurve ? row(...base, n.volumeCurve) : row(...base);
      }),
  );
  section(
    'PIPES',
    ';ID              Node1           Node2           Length          Diameter        Roughness       MinorLoss       Status',
    links
      .filter((l) => l.type === 'pipe')
      .map((l) => row(l.id, l.startNodeId, l.endNodeId, l.length, l.diameter, l.roughness, l.minorLoss, l.status)),
  );
  section(
    'PUMPS',
    ';ID              Node1           Node2           Parameters',
    links
      .filter((l) => l.type === 'pump')
      .map((l) => {
        const params: (string | number)[] = [];
        if (l.headCurve) params.push('HEAD', l.headCurve);
        else params.push('POWER', l.power > 0 ? l.power : 1);
        if (l.speed !== 1) params.push('SPEED', l.speed);
        if (l.pattern) params.push('PATTERN', l.pattern);
        return row(l.id, l.startNodeId, l.endNodeId, ...params);
      }),
  );
  section(
    'VALVES',
    ';ID              Node1           Node2           Diameter        Type            Setting         MinorLoss',
    links
      .filter((l) => l.type === 'valve')
      .map((l) => row(l.id, l.startNodeId, l.endNodeId, l.diameter, l.valveType, l.setting, l.minorLoss)),
  );

  // 구조화된 수질 데이터 → 원문 줄 앞에 붙인다.
  const structured: Record<string, string[]> = {
    QUALITY: nodes.filter((n) => (n.initQuality ?? 0) !== 0).map((n) => row(n.id, n.initQuality ?? 0)),
    SOURCES: nodes
      .filter((n) => n.source)
      .map((n) => (n.source!.pattern ? row(n.id, n.source!.type, n.source!.strength, n.source!.pattern) : row(n.id, n.source!.type, n.source!.strength))),
    REACTIONS: [row('Global', 'Bulk', model.options.reactions.globalBulk), row('Global', 'Wall', model.options.reactions.globalWall)],
  };

  for (const name of PASSTHROUGH_ORDER) {
    const lines = model.extraSections[name] ?? [];
    const head = structured[name] ?? [];
    if (lines.length === 0 && head.length === 0) continue;
    if (options.forEngine && DISPLAY_ONLY_SECTIONS.includes(name)) continue;
    let kept = lines;
    if (NODE_KEYED_SECTIONS.includes(name)) kept = lines.filter((l) => l.trim().split(/\s+/)[0] in model.nodes);
    else if (LINK_KEYED_SECTIONS.includes(name)) kept = lines.filter((l) => l.trim().split(/\s+/)[0] in model.links);
    section(name, null, [...head, ...kept.map((l) => ` ${l}`)]);
  }

  const patternLines: string[] = [];
  for (const id in model.patterns) {
    const values = model.patterns[id];
    for (let i = 0; i < values.length; i += 6) {
      patternLines.push(row(id, ...values.slice(i, i + 6)));
    }
  }
  section('PATTERNS', ';ID              Multipliers', patternLines);

  const curveLines: string[] = [];
  for (const id in model.curves) {
    for (const [x, y] of model.curves[id]) curveLines.push(row(id, x, y));
  }
  section('CURVES', ';ID              X-Value         Y-Value', curveLines);

  section('TIMES', null, timesSection(model.times));

  section(
    'REPORT',
    null,
    options.forEngine ? [row('Status', '', 'No'), row('Summary', '', 'No'), row('Page', '', '0')] : [row('Status', '', 'No'), row('Summary', '', 'No')],
  );

  section('OPTIONS', null, [
    row('Units', '', model.options.flowUnits),
    row('Headloss', '', model.options.headloss),
    qualityOptionRow(model),
    ...model.options.extra.map((l) => ` ${l}`),
  ]);

  const coordDigits = model.crs.kind === 'epsg' ? 3 : 8;
  const xy = (p: [number, number]) => {
    const [x, y] = fromWgs84(model.crs, p);
    return [x.toFixed(coordDigits), y.toFixed(coordDigits)] as const;
  };
  section(
    'COORDINATES',
    ';Node            X-Coord         Y-Coord',
    nodes.map((n) => {
      const [x, y] = xy(n.position);
      return row(n.id, x, y);
    }),
  );
  const vertexLines: string[] = [];
  for (const link of links) {
    for (const v of link.vertices) {
      const [x, y] = xy(v);
      vertexLines.push(row(link.id, x, y));
    }
  }
  section('VERTICES', ';Link            X-Coord         Y-Coord', vertexLines);

  if (!options.forEngine) {
    for (const name of ['LABELS', 'BACKDROP']) {
      const lines = model.extraSections[name];
      if (lines && lines.length > 0) section(name, null, lines.map((l) => ` ${l}`));
    }
    // 위에서 다루지 않은 나머지 원문 섹션도 잃지 않도록 내보낸다.
    for (const name in model.extraSections) {
      if (PASSTHROUGH_ORDER.includes(name) || name === 'LABELS' || name === 'BACKDROP') continue;
      const lines = model.extraSections[name];
      if (lines.length > 0) section(name, null, lines.map((l) => ` ${l}`));
    }
  }

  out.push('[END]');
  return out.join('\n') + '\n';
}
