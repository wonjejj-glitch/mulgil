/**
 * SWMM 5.x 이진 결과 파일(.out) 읽기.
 * 파일 끝의 6개 int32(ID 위치, 입력 위치, 결과 위치, 기간 수, 오류 코드, 매직 넘버)로 구역을 찾는다.
 * 결과는 [기간][항목][변수] 순서의 float32 하나로 평탄화해 보관한다.
 */

const MAGIC = 516114522;

export const NODE_VAR = { depth: 0, head: 1, volume: 2, lateralInflow: 3, totalInflow: 4, flooding: 5 } as const;
export const LINK_VAR = { flow: 0, depth: 1, velocity: 2, volume: 3, capacity: 4 } as const;
export const SUB_VAR = { rainfall: 0, snowDepth: 1, evaporation: 2, infiltration: 3, runoff: 4, gwFlow: 5, gwElevation: 6, soilMoisture: 7 } as const;

export type NodeVar = keyof typeof NODE_VAR;
export type LinkVar = keyof typeof LINK_VAR;
export type SubVar = keyof typeof SUB_VAR;

/** 0 CFS, 1 GPM, 2 MGD, 3 CMS, 4 LPS, 5 MLD */
export const FLOW_UNIT_NAMES = ['CFS', 'GPM', 'MGD', 'CMS', 'LPS', 'MLD'] as const;

export interface SwmmOutput {
  version: number;
  flowUnits: (typeof FLOW_UNIT_NAMES)[number];
  subcatchIds: string[];
  nodeIds: string[];
  linkIds: string[];
  /** 0 절점, 1 방류구, 2 저류조, 3 분류기 */
  nodeTypes: Uint8Array;
  nodeInvert: Float32Array;
  nodeMaxDepth: Float32Array;
  /** 0 관거, 1 펌프, 2 오리피스, 3 위어, 4 배출구 */
  linkTypes: Uint8Array;
  periods: number;
  /** 각 기간의 시각 (1899-12-30 기준 일 수). */
  days: Float64Array;
  reportStepSec: number;
  subVars: number;
  nodeVars: number;
  linkVars: number;
  sysVars: number;
  sub: Float32Array;
  node: Float32Array;
  link: Float32Array;
  system: Float32Array;
}

export class SwmmOutputError extends Error {}

function readIds(view: DataView, bytes: Uint8Array, at: number, count: number): { ids: string[]; next: number } {
  const ids: string[] = [];
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    const length = view.getInt32(at, true);
    at += 4;
    ids.push(decoder.decode(bytes.subarray(at, at + length)));
    at += length;
  }
  return { ids, next: at };
}

export function parseSwmmOut(buffer: ArrayBuffer | Uint8Array): SwmmOutput {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 28 + 24 || view.getInt32(0, true) !== MAGIC) throw new SwmmOutputError('SWMM 결과 파일(.out) 형식이 아닙니다.');
  const end = bytes.length;
  if (view.getInt32(end - 4, true) !== MAGIC) throw new SwmmOutputError('SWMM 결과 파일이 끝까지 쓰이지 않았습니다.');
  const idPos = view.getInt32(end - 24, true);
  const inputPos = view.getInt32(end - 20, true);
  const outPos = view.getInt32(end - 16, true);
  const periods = view.getInt32(end - 12, true);
  const errorCode = view.getInt32(end - 8, true);
  if (errorCode !== 0) throw new SwmmOutputError(`SWMM 해석이 오류 ${errorCode} 로 끝났습니다.`);

  const version = view.getInt32(4, true);
  const flowUnitCode = view.getInt32(8, true);
  const nSub = view.getInt32(12, true);
  const nNode = view.getInt32(16, true);
  const nLink = view.getInt32(20, true);

  let at = idPos;
  const subs = readIds(view, bytes, at, nSub);
  const nodes = readIds(view, bytes, subs.next, nNode);
  const links = readIds(view, bytes, nodes.next, nLink);

  // 입력 데이터: 구역마다 [속성 수, 속성 코드…, 항목별 float32…]
  at = inputPos;
  const readBlock = (count: number) => {
    const nProps = view.getInt32(at, true);
    at += 4;
    const codes: number[] = [];
    for (let p = 0; p < nProps; p++) {
      codes.push(view.getInt32(at, true));
      at += 4;
    }
    const values = new Float32Array(count * nProps);
    // 유형 코드(속성 코드 0)는 float 가 아니라 int32 로 저장되어 있다.
    const types = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      for (let q = 0; q < nProps; q++) {
        if (codes[q] === 0) types[i] = view.getInt32(at, true);
        else values[i * nProps + q] = view.getFloat32(at, true);
        at += 4;
      }
    }
    return { codes, nProps, values, types };
  };
  readBlock(nSub);
  const nodeInput = readBlock(nNode);
  const linkInput = readBlock(nLink);
  const column = (block: ReturnType<typeof readBlock>, code: number, count: number) => {
    const p = block.codes.indexOf(code);
    const out = new Float32Array(count);
    if (p >= 0) for (let i = 0; i < count; i++) out[i] = block.values[i * block.nProps + p];
    return out;
  };
  const nodeTypeF = nodeInput.types;
  const linkTypeF = linkInput.types;

  // 출력 변수: 구역마다 [변수 수, 변수 코드…]
  const readVars = () => {
    const n = view.getInt32(at, true);
    at += 4 + n * 4;
    return n;
  };
  const subVars = readVars();
  const nodeVars = readVars();
  const linkVars = readVars();
  const sysVars = readVars();
  const stepSec = (() => {
    // 시작 날짜(float64) 다음 보고 간격(int32)
    return view.getInt32(at + 8, true);
  })();

  const perPeriod = nSub * subVars + nNode * nodeVars + nLink * linkVars + sysVars;
  const days = new Float64Array(periods);
  const sub = new Float32Array(periods * nSub * subVars);
  const node = new Float32Array(periods * nNode * nodeVars);
  const link = new Float32Array(periods * nLink * linkVars);
  const system = new Float32Array(periods * sysVars);
  if (outPos + periods * (8 + perPeriod * 4) > bytes.length) throw new SwmmOutputError('SWMM 결과 파일이 잘렸습니다.');
  let p = outPos;
  const copy = (target: Float32Array, offset: number, count: number) => {
    for (let i = 0; i < count; i++) target[offset + i] = view.getFloat32(p + i * 4, true);
    p += count * 4;
  };
  for (let t = 0; t < periods; t++) {
    days[t] = view.getFloat64(p, true);
    p += 8;
    copy(sub, t * nSub * subVars, nSub * subVars);
    copy(node, t * nNode * nodeVars, nNode * nodeVars);
    copy(link, t * nLink * linkVars, nLink * linkVars);
    copy(system, t * sysVars, sysVars);
  }

  return {
    version,
    flowUnits: FLOW_UNIT_NAMES[flowUnitCode] ?? 'CMS',
    subcatchIds: subs.ids,
    nodeIds: nodes.ids,
    linkIds: links.ids,
    nodeTypes: Uint8Array.from(nodeTypeF),
    nodeInvert: column(nodeInput, 2, nNode),
    nodeMaxDepth: column(nodeInput, 3, nNode),
    linkTypes: Uint8Array.from(linkTypeF),
    periods,
    days,
    reportStepSec: stepSec,
    subVars,
    nodeVars,
    linkVars,
    sysVars,
    sub,
    node,
    link,
    system,
  };
}

export function nodeValue(out: SwmmOutput, variable: NodeVar, period: number, index: number): number {
  return out.node[(period * out.nodeIds.length + index) * out.nodeVars + NODE_VAR[variable]];
}

export function linkValue(out: SwmmOutput, variable: LinkVar, period: number, index: number): number {
  return out.link[(period * out.linkIds.length + index) * out.linkVars + LINK_VAR[variable]];
}

export function subValue(out: SwmmOutput, variable: SubVar, period: number, index: number): number {
  return out.sub[(period * out.subcatchIds.length + index) * out.subVars + SUB_VAR[variable]];
}

export function nodeSeriesOf(out: SwmmOutput, variable: NodeVar, index: number): number[] {
  return Array.from({ length: out.periods }, (_, t) => nodeValue(out, variable, t, index));
}

export function linkSeriesOf(out: SwmmOutput, variable: LinkVar, index: number): number[] {
  return Array.from({ length: out.periods }, (_, t) => linkValue(out, variable, t, index));
}

/** 전체 기간에 걸친 [최소, 최대]. */
export function rangeOf(values: Float32Array, stride: number, offset: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = offset; i < values.length; i += stride) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? [min, max] : [0, 0];
}

const EPOCH_MS = Date.UTC(1899, 11, 30);

/** SWMM 일 수 → Date (UTC 기준, 모델의 벽시계 시각 그대로). */
export function daysToDate(days: number): Date {
  return new Date(EPOCH_MS + Math.round(days * 86400000));
}
