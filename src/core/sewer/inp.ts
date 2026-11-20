/**
 * SewerStudio 호환 SWMM INP 생성 (SPEC §6). 바이트 단위로 원본과 같은 출력을 목표로 한다.
 * 단위는 CMS·m. 시작 날짜는 2026-01-01 00:00:00 으로 고정(원본의 예제값).
 */
import { buildNetwork } from './topology';
import type { SewerProject } from './types';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 원본 hms(): 정수로 0 방향 절삭 후 HH:MM:SS (시는 100 이상도 2자리 이상으로). */
export function hms(seconds: number): string {
  const s = Math.trunc(seconds);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** Python str(float): 정수 값은 '5.0' 처럼 소수점을 붙인다. */
export function pyFloat(x: number): string {
  const s = String(x);
  return /[.eE]/.test(s) || !Number.isFinite(x) ? s : `${s}.0`;
}

const START = Date.UTC(2026, 0, 1, 0, 0, 0);

function stamp(minutes: number): { date: string; time: string } {
  const d = new Date(START + minutes * 60000);
  return { date: `${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}/${d.getUTCFullYear()}`, time: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` };
}

const f8 = (x: number) => x.toFixed(8);
const f10 = (x: number) => x.toFixed(10);
const f6 = (x: number) => x.toFixed(6);

export function generateInp(p: SewerProject): string {
  buildNetwork(p); // 위상 오류는 그대로 전달한다
  const o = p.options;
  const end = stamp(o.duration_minutes);
  const endTime = `${end.time}:00`;
  const blocks: string[][] = [];
  const add = (...lines: string[]) => blocks.push(lines);

  add('[TITLE]', 'SewerStudio independent gravity-network model');
  add(
    '[OPTIONS]',
    'FLOW_UNITS CMS',
    `FLOW_ROUTING ${o.routing}`,
    'INFILTRATION HORTON',
    'LINK_OFFSETS DEPTH',
    'START_DATE 01/01/2026',
    'START_TIME 00:00:00',
    'REPORT_START_DATE 01/01/2026',
    'REPORT_START_TIME 00:00:00',
    `END_DATE ${end.date}`,
    `END_TIME ${endTime}`,
    `REPORT_STEP ${hms(o.report_seconds)}`,
    `ROUTING_STEP ${pyFloat(o.routing_seconds)}`,
    `WET_STEP ${hms(60)}`,
    `DRY_STEP ${hms(300)}`,
    'INERTIAL_DAMPING PARTIAL',
    'VARIABLE_STEP 0.75',
    'NORMAL_FLOW_LIMITED BOTH',
    'ALLOW_PONDING NO',
    'MIN_SURFAREA 1.167',
    'MAX_TRIALS 20',
    'HEAD_TOLERANCE 0.0015',
  );
  add('[EVAPORATION]', 'CONSTANT 0');
  add('[JUNCTIONS]', ...p.nodes.filter((n) => n.kind === 'JUNCTION').map((n) => `${n.id} ${f8(n.invert)} ${f8(n.ground - n.invert)} 0 0 0`));
  add(
    '[OUTFALLS]',
    ...p.nodes
      .filter((n) => n.kind === 'OUTFALL')
      .map((n) => `${n.id} ${f8(n.invert)} ${n.boundary}${n.boundary === 'FIXED' ? ` ${f8(n.stage as number)}` : ''} NO`),
  );
  add('[CONDUITS]', ...p.conduits.map((c) => `${c.id} ${c.upstream} ${c.downstream} ${f8(c.length)} ${f8(c.roughness)} ${f8(c.inlet_offset)} ${f8(c.outlet_offset)} 0 0`));
  add('[XSECTIONS]', ...p.conduits.map((c) => `${c.id} CIRCULAR ${f8(c.diameter)} 0 0 0 1`));
  add('[DWF]', ...p.nodes.filter((n) => n.base_flow !== 0).map((n) => `${n.id} FLOW ${f10(n.base_flow)}`));

  if (p.catchments.length > 0) {
    add('[RAINGAGES]', `RG1 INTENSITY ${hms(o.rain_interval_minutes * 60)} 1.0 TIMESERIES RAIN`);
    add('[SUBCATCHMENTS]', ...p.catchments.map((s) => `${s.id} RG1 ${s.outlet} ${f8(s.area)} ${f8(s.impervious)} ${f8(s.width)} ${f8(s.slope)} 0`));
    add('[SUBAREAS]', ...p.catchments.map((s) => `${s.id} 0.013 0.15 1.5 5.0 25 OUTLET 100`));
    add('[INFILTRATION]', ...p.catchments.map((s) => `${s.id} ${pyFloat(s.horton_max)} ${pyFloat(s.horton_min)} ${pyFloat(s.horton_decay)} 7 0`));
    const rows: string[] = [];
    const dt = o.rain_interval_minutes;
    let idx = 0;
    for (let minute = 0; minute < o.duration_minutes + dt; minute += dt) {
      while (idx + 1 < o.rainfall.length && o.rainfall[idx + 1].minute <= minute) idx++;
      const intensity = minute < o.duration_minutes ? o.rainfall[idx].intensity : 0;
      const t = stamp(minute);
      rows.push(`RAIN ${t.date} ${t.time} ${f8(intensity)}`);
    }
    add('[TIMESERIES]', ...rows);
  }

  add('[REPORT]', 'INPUT NO', 'CONTINUITY YES', 'FLOWSTATS YES', 'SUBCATCHMENTS ALL', 'NODES ALL', 'LINKS ALL', 'AVERAGES NO');
  add('[COORDINATES]', ...p.nodes.map((n) => `${n.id} ${f6(n.x)} ${f6(n.y)}`));
  // 지도에서 그린 유역 경계 (원본 호환 출력에는 경계가 없어 이 블록이 생기지 않는다)
  const drawn = p.catchments.filter((s) => s.polygon && s.polygon.length >= 3);
  if (drawn.length > 0) add('[POLYGONS]', ...drawn.flatMap((s) => s.polygon!.map(([x, y]) => `${s.id} ${f6(x)} ${f6(y)}`)));
  return `${blocks.map((b) => b.join('\n')).join('\n\n')}\n`;
}

/* ------------------------------------------------------------------ 물길 설계 설정 (내보내기용) */

/** inp 주석 줄 머리말. SWMM 은 ';' 로 시작하는 줄을 무시하므로 다른 프로그램에는 영향이 없다. */
export const META_PREFIX = ';;MULGIL ';
/** SWMM 은 한 줄을 1024자까지만 읽으므로 주석도 짧게 끊는다. */
const META_CHUNK = 180;

/** SWMM inp 에 담기지 않는 설계 설정 — 다시 열 때 복원한다. */
export interface SewerInpMeta {
  v: 1;
  name: string;
  options: SewerProject['options'];
  constraints: SewerProject['constraints'];
  /** 유역 ID → 합리식 유출계수 C */
  runoff: Record<string, number>;
  /** 방류구 ID → 지반고 (inp 에는 방류구 깊이가 없다) */
  outfall_ground: Record<string, number>;
}

export function inpMeta(p: SewerProject): SewerInpMeta {
  return {
    v: 1,
    name: p.name,
    options: p.options,
    constraints: p.constraints,
    runoff: Object.fromEntries(p.catchments.map((s) => [s.id, s.runoff_coefficient])),
    outfall_ground: Object.fromEntries(p.nodes.filter((n) => n.kind === 'OUTFALL').map((n) => [n.id, n.ground])),
  };
}

/**
 * 파일로 내보내는 inp: 해석용 inp(generateInp) 뒤에 물길 설계 설정을 주석으로 붙인다.
 * 한글 등 비 ASCII 문자는 \uXXXX 로 적어, 편집기·인코딩이 바뀌어도 깨지지 않게 한다.
 */
export function generateExportInp(p: SewerProject): string {
  const json = JSON.stringify(inpMeta(p)).replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const lines = [';; 아래는 물길(Mulgil) 설계 설정입니다 (유출계수·강우·설계 제약). 다른 프로그램은 이 줄을 무시합니다.'];
  for (let i = 0; i < json.length; i += META_CHUNK) lines.push(`${META_PREFIX}${json.slice(i, i + META_CHUNK)}`);
  return `${generateInp(p)}\n${lines.join('\n')}\n`;
}

/** inp 본문에서 물길 설계 설정 주석을 찾아 돌려준다. 없거나 깨졌으면 null. */
export function readInpMeta(text: string): SewerInpMeta | null {
  const chunks = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith(META_PREFIX))
    .map((line) => line.slice(META_PREFIX.length).trim());
  if (chunks.length === 0) return null;
  try {
    const meta = JSON.parse(chunks.join('')) as Partial<SewerInpMeta>;
    if (meta.v !== 1 || typeof meta.options !== 'object' || typeof meta.constraints !== 'object' || !meta.options || !meta.constraints) return null;
    return { v: 1, name: typeof meta.name === 'string' ? meta.name : '', options: meta.options, constraints: meta.constraints, runoff: meta.runoff ?? {}, outfall_ground: meta.outfall_ground ?? {} };
  } catch {
    return null;
  }
}
