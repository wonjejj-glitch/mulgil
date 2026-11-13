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
  return `${blocks.map((b) => b.join('\n')).join('\n\n')}\n`;
}
