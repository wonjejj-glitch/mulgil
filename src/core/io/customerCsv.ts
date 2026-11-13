/**
 * 수용가(고객) 목록 CSV 읽기 — 관망 초안 생성의 입력.
 * 요금·급수 대장에서 내려받은 표를 그대로 넣을 수 있게
 *   - 인코딩: UTF-8(BOM 포함)을 먼저 시도하고, 깨지면 CP949(EUC-KR)로 다시 읽는다.
 *   - 구분자: 쉼표·탭·세미콜론 자동 감지, 큰따옴표로 감싼 칸 지원.
 *   - 열 이름으로 ID·X·Y·사용량 열을 추정한다 (화면에서 다시 고를 수 있다).
 */
import type { LngLat } from '../model/types';

export interface CsvTable {
  headers: string[];
  rows: string[][];
  encoding: 'utf-8' | 'euc-kr';
  delimiter: string;
}

export function decodeText(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'euc-kr' } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('euc-kr').decode(bytes), encoding: 'euc-kr' };
  }
}

function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

export function parseCsv(bytes: Uint8Array): CsvTable {
  const { text, encoding } = decodeText(bytes);
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('표에 머리글과 자료 줄이 있어야 합니다.');
  const head = lines[0];
  const delimiter = ['\t', ';', ','].reduce((best, d) => (head.split(d).length > head.split(best).length ? d : best), ',');
  const headers = splitLine(head, delimiter);
  const rows = lines.slice(1).map((l) => splitLine(l, delimiter));
  return { headers, rows, encoding, delimiter };
}

export type DemandUnit = 'm3/month' | 'm3/day' | 'L/s';

export interface ColumnMapping {
  id: number;
  x: number;
  y: number;
  /** -1 이면 사용량 없음(모두 같은 값으로 본다). */
  demand: number;
  demandUnit: DemandUnit;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_()[\]·.-]/g, '');

function findColumn(headers: string[], names: string[]): number {
  const h = headers.map(norm);
  for (const name of names) {
    const i = h.indexOf(norm(name));
    if (i >= 0) return i;
  }
  for (const name of names) {
    const i = h.findIndex((x) => x.includes(norm(name)));
    if (i >= 0) return i;
  }
  return -1;
}

/** 열 이름으로 열을 추정한다. 못 찾은 열은 -1. */
export function guessMapping(headers: string[]): ColumnMapping {
  const id = findColumn(headers, ['id', '수용가번호', '고객번호', '관리번호', '전번', '번호', '수용가', 'name', '이름', '상호']);
  const x = findColumn(headers, ['x', 'lon', 'lng', 'longitude', '경도', 'x좌표', 'tmx', 'pointx']);
  const y = findColumn(headers, ['y', 'lat', 'latitude', '위도', 'y좌표', 'tmy', 'pointy']);
  const demand = findColumn(headers, ['demand', '월사용량', '일사용량', '사용량', '급수량', '수요량', '수요', 'usage', '사용수량']);
  const dh = demand >= 0 ? headers[demand] : '';
  const demandUnit: DemandUnit = /l\/?s|lps|ℓ/i.test(dh) ? 'L/s' : /일|day|cmd/i.test(dh) ? 'm3/day' : 'm3/month';
  return { id, x, y, demand, demandUnit };
}

export interface CustomerRecord {
  id: string;
  /** 파일의 좌표 그대로 (경위도 또는 평면 좌표 m). */
  xy: [number, number];
  /** 일평균 사용량 m³/일. */
  demand: number;
}

export interface CustomerReadResult {
  records: CustomerRecord[];
  /** 좌표·사용량을 읽지 못해 건너뛴 줄 (1부터, 머리글 제외). */
  skipped: number[];
}

const toNumber = (s: string | undefined) => {
  if (s === undefined) return NaN;
  const v = Number(s.replace(/,/g, '').trim());
  return s.trim() === '' ? NaN : v;
};

/** 표 → 수용가 목록. 사용량은 m³/일로 바꾼다 (월 사용량은 30.4일로 나눔). */
export function readCustomers(table: CsvTable, map: ColumnMapping): CustomerReadResult {
  if (map.x < 0 || map.y < 0) throw new Error('X(경도)·Y(위도) 열을 골라 주세요.');
  const factor = map.demandUnit === 'm3/month' ? 1 / 30.4 : map.demandUnit === 'L/s' ? 86.4 : 1;
  const records: CustomerRecord[] = [];
  const skipped: number[] = [];
  const used = new Set<string>();
  table.rows.forEach((row, i) => {
    const x = toNumber(row[map.x]);
    const y = toNumber(row[map.y]);
    const raw = map.demand >= 0 ? toNumber(row[map.demand]) : 1;
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0) || !Number.isFinite(raw) || raw < 0) {
      skipped.push(i + 1);
      return;
    }
    let id = (map.id >= 0 ? row[map.id] : '') || `C${i + 1}`;
    if (used.has(id)) id = `${id}_${i + 1}`;
    used.add(id);
    records.push({ id, xy: [x, y], demand: raw * factor });
  });
  return { records, skipped };
}

export interface Customer {
  id: string;
  position: LngLat;
  /** m³/일 */
  demand: number;
}
