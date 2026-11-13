/**
 * 관망 편집 기본 연산. 모두 전달받은 model 을 직접 변경하므로
 * immer draft 또는 새로 만든 객체에 대해서만 호출한다.
 */
import { distanceMeters, pathLengthMeters, projectOntoPath } from '../../utils/geoMath';
import type {
  LinkType,
  LngLat,
  NetworkLink,
  NetworkModel,
  NetworkNode,
  NodeType,
  Pipe,
} from './types';
import { defaultRoughness, isUsUnits, metersToModelLength } from './units';

const ID_PREFIX: Record<NodeType | LinkType, string> = {
  junction: 'J',
  reservoir: 'R',
  tank: 'T',
  pipe: 'P',
  pump: 'PU',
  valve: 'V',
};

export function nextId(prefix: string, taken: Record<string, unknown>): string {
  // 대부분의 경우 기존 개수 + 1 근처에서 바로 찾는다.
  let count = 0;
  for (const key in taken) if (key.startsWith(prefix)) count++;
  let n = count + 1;
  while (`${prefix}${n}` in taken) n++;
  return `${prefix}${n}`;
}

export function linkPath(model: Pick<NetworkModel, 'nodes'>, link: NetworkLink): LngLat[] {
  const path: LngLat[] = [];
  const a = model.nodes[link.startNodeId];
  const b = model.nodes[link.endNodeId];
  if (a) path.push(a.position);
  for (const v of link.vertices) path.push(v);
  if (b) path.push(b.position);
  return path;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 관로 형상으로부터 모델 단위(m 또는 ft)의 연장을 계산한다. */
export function computeLinkLength(model: NetworkModel, link: NetworkLink): number {
  const meters = pathLengthMeters(linkPath(model, link));
  return round2(metersToModelLength(meters, model.options.flowUnits));
}

export function createNode(model: NetworkModel, type: NodeType, position: LngLat, id?: string): NetworkNode {
  const nodeId = id ?? nextId(ID_PREFIX[type], model.nodes);
  const us = isUsUnits(model.options.flowUnits);
  switch (type) {
    case 'junction':
      return { id: nodeId, type, position, elevation: 0, demand: 0, pattern: '' };
    case 'reservoir':
      return { id: nodeId, type, position, elevation: us ? 160 : 50, pattern: '' };
    case 'tank':
      return {
        id: nodeId,
        type,
        position,
        elevation: us ? 100 : 30,
        initLevel: us ? 10 : 3,
        minLevel: us ? 1 : 0.5,
        maxLevel: us ? 16 : 5,
        diameter: us ? 33 : 10,
        minVolume: 0,
        volumeCurve: '',
        overflow: false,
      };
  }
}

export function addNode(model: NetworkModel, type: NodeType, position: LngLat, id?: string): NetworkNode {
  const node = createNode(model, type, position, id);
  model.nodes[node.id] = node;
  return node;
}

export function addLink(
  model: NetworkModel,
  type: LinkType,
  startNodeId: string,
  endNodeId: string,
  vertices: LngLat[] = [],
  id?: string,
): NetworkLink | null {
  if (!model.nodes[startNodeId] || !model.nodes[endNodeId] || startNodeId === endNodeId) return null;
  const linkId = id ?? nextId(ID_PREFIX[type], model.links);
  const us = isUsUnits(model.options.flowUnits);
  let link: NetworkLink;
  if (type === 'pipe') {
    link = {
      id: linkId,
      type,
      startNodeId,
      endNodeId,
      vertices,
      length: 0,
      isCustomLength: false,
      diameter: us ? 6 : 150,
      roughness: defaultRoughness(model.options.headloss),
      minorLoss: 0,
      status: 'Open',
    };
    link.length = computeLinkLength(model, link);
  } else if (type === 'pump') {
    link = { id: linkId, type, startNodeId, endNodeId, vertices, headCurve: '', power: us ? 15 : 10, speed: 1, pattern: '' };
  } else {
    link = {
      id: linkId,
      type,
      startNodeId,
      endNodeId,
      vertices,
      diameter: us ? 6 : 150,
      valveType: 'PRV',
      setting: us ? '45' : '30',
      minorLoss: 0,
    };
  }
  model.links[linkId] = link;
  return link;
}

export function deleteLink(model: NetworkModel, id: string): void {
  delete model.links[id];
}

/** 절점과 그 절점에 연결된 모든 링크를 삭제한다. */
export function deleteNodes(model: NetworkModel, ids: Iterable<string>): void {
  const doomed = new Set(ids);
  if (doomed.size === 0) return;
  for (const linkId in model.links) {
    const link = model.links[linkId];
    if (doomed.has(link.startNodeId) || doomed.has(link.endNodeId)) delete model.links[linkId];
  }
  for (const id of doomed) delete model.nodes[id];
}

/** 절점에 연결된 관로 중 수동 연장 고정이 아닌 것의 연장을 다시 계산한다. */
export function recalcLengthsAt(model: NetworkModel, nodeId: string): void {
  for (const linkId in model.links) {
    const link = model.links[linkId];
    if (link.type !== 'pipe' || link.isCustomLength) continue;
    if (link.startNodeId === nodeId || link.endNodeId === nodeId) {
      link.length = computeLinkLength(model, link);
    }
  }
}

export function moveNode(model: NetworkModel, id: string, position: LngLat): void {
  const node = model.nodes[id];
  if (!node) return;
  node.position = position;
  recalcLengthsAt(model, id);
}

export function isValidId(id: string): boolean {
  return id.length > 0 && id.length <= 31 && !/[\s;"]/.test(id);
}

const NODE_KEYWORDS: ReadonlySet<string> = new Set(['NODE', 'JUNCTION', 'RESERVOIR', 'TANK']);
const LINK_KEYWORDS: ReadonlySet<string> = new Set(['LINK', 'PIPE', 'PUMP', 'VALVE']);
/** 첫 토큰이 객체 ID 인 원문 섹션. */
const FIRST_TOKEN_SECTIONS: Record<'node' | 'link', ReadonlySet<string>> = {
  node: new Set(['DEMANDS', 'EMITTERS', 'QUALITY', 'SOURCES', 'MIXING']),
  link: new Set(['STATUS', 'LEAKAGE']),
};

/**
 * 원문 보존 섹션([CONTROLS], [RULES], [ENERGY], [DEMANDS] 등) 안의 ID 참조를 바꾼다.
 * 제어 규칙은 "LINK P1", "TANK T1" 처럼 앞의 객체 종류 키워드로 절점/링크를 구분한다.
 */
export function renameInSections(model: NetworkModel, kind: 'node' | 'link', oldId: string, newId: string): void {
  const keywords = kind === 'node' ? NODE_KEYWORDS : LINK_KEYWORDS;
  for (const name in model.extraSections) {
    const lines = model.extraSections[name];
    for (let i = 0; i < lines.length; i++) {
      const tokens = lines[i].trim().split(/\s+/);
      let changed = false;
      if (FIRST_TOKEN_SECTIONS[kind].has(name) && tokens[0] === oldId) {
        tokens[0] = newId;
        changed = true;
      }
      // [QUALITY] 범위 형식 "시작절점 끝절점 값"
      if (kind === 'node' && name === 'QUALITY' && tokens.length === 3 && tokens[1] === oldId) {
        tokens[1] = newId;
        changed = true;
      }
      // [REACTIONS] "Bulk P1 -0.5", "Wall P1 -1"
      if (kind === 'link' && name === 'REACTIONS' && /^(BULK|WALL)$/i.test(tokens[0]) && tokens[1] === oldId) {
        tokens[1] = newId;
        changed = true;
      }
      for (let t = 1; t < tokens.length; t++) {
        if (tokens[t] === oldId && keywords.has(tokens[t - 1].toUpperCase())) {
          tokens[t] = newId;
          changed = true;
        }
      }
      if (changed) lines[i] = tokens.join(' ');
    }
  }
}

export function renameNode(model: NetworkModel, oldId: string, newId: string): boolean {
  if (oldId === newId) return true;
  const node = model.nodes[oldId];
  if (!node || !isValidId(newId) || model.nodes[newId]) return false;
  delete model.nodes[oldId];
  node.id = newId;
  model.nodes[newId] = node;
  for (const linkId in model.links) {
    const link = model.links[linkId];
    if (link.startNodeId === oldId) link.startNodeId = newId;
    if (link.endNodeId === oldId) link.endNodeId = newId;
  }
  if (model.options.quality.traceNode === oldId) model.options.quality.traceNode = newId;
  renameInSections(model, 'node', oldId, newId);
  return true;
}

export function renameLink(model: NetworkModel, oldId: string, newId: string): boolean {
  if (oldId === newId) return true;
  const link = model.links[oldId];
  if (!link || !isValidId(newId) || model.links[newId]) return false;
  delete model.links[oldId];
  link.id = newId;
  model.links[newId] = link;
  renameInSections(model, 'link', oldId, newId);
  return true;
}

export function reverseLink(model: NetworkModel, id: string): void {
  const link = model.links[id];
  if (!link) return;
  const start = link.startNodeId;
  link.startNodeId = link.endNodeId;
  link.endNodeId = start;
  link.vertices = [...link.vertices].reverse();
}

function interpolatedElevation(model: NetworkModel, pipe: Pipe, ratio: number): number {
  const a = model.nodes[pipe.startNodeId];
  const b = model.nodes[pipe.endNodeId];
  // 수원지의 elevation 은 총수두이므로 지반고 보간에 쓰지 않는다.
  const ea = a && a.type !== 'reservoir' ? a.elevation : undefined;
  const eb = b && b.type !== 'reservoir' ? b.elevation : undefined;
  if (ea !== undefined && eb !== undefined) return round2(ea + (eb - ea) * ratio);
  return ea ?? eb ?? 0;
}

export interface SplitResult {
  nodeId: string;
  newPipeId: string;
}

/**
 * 관로를 지정한 점에서 둘로 나눈다.
 * existingNodeId 가 있으면 그 절점을 분할점으로 쓰고, 없으면 새 절점을 만든다.
 * 원래 관로는 시점 쪽 구간으로 남고, 종점 쪽 구간은 같은 속성의 새 관로가 된다.
 */
export function splitPipe(
  model: NetworkModel,
  pipeId: string,
  point: LngLat,
  existingNodeId?: string,
): SplitResult | null {
  const pipe = model.links[pipeId];
  if (!pipe || pipe.type !== 'pipe') return null;
  if (existingNodeId && (existingNodeId === pipe.startNodeId || existingNodeId === pipe.endNodeId)) return null;
  const path = linkPath(model, pipe);
  if (path.length < 2) return null;
  const projection = projectOntoPath(path, point);

  let nodeId = existingNodeId;
  if (nodeId) {
    if (!model.nodes[nodeId]) return null;
  } else {
    const node = addNode(model, 'junction', projection.point);
    node.elevation = interpolatedElevation(model, pipe, projection.ratio);
    nodeId = node.id;
  }

  const k = projection.segmentIndex;
  const leftVertices = pipe.vertices.slice(0, k);
  const rightVertices = pipe.vertices.slice(k);
  const originalLength = pipe.length;
  const originalEnd = pipe.endNodeId;

  const newPipeId = nextId(ID_PREFIX.pipe, model.links);
  const right: Pipe = {
    ...pipe,
    id: newPipeId,
    startNodeId: nodeId,
    endNodeId: originalEnd,
    vertices: rightVertices,
  };
  pipe.endNodeId = nodeId;
  pipe.vertices = leftVertices;
  model.links[newPipeId] = right;

  if (pipe.isCustomLength) {
    pipe.length = round2(originalLength * projection.ratio);
    right.length = round2(originalLength - pipe.length);
  } else {
    pipe.length = computeLinkLength(model, pipe);
    right.length = computeLinkLength(model, right);
  }
  return { nodeId, newPipeId };
}

/**
 * removeId 절점을 keepId 절점으로 합친다. removeId 에 연결된 링크는 keepId 로 옮기고,
 * 그 결과 시점=종점이 된 링크는 삭제한다.
 */
export function mergeNodes(model: NetworkModel, keepId: string, removeId: string): void {
  if (keepId === removeId || !model.nodes[keepId] || !model.nodes[removeId]) return;
  for (const linkId in model.links) {
    const link = model.links[linkId];
    if (link.startNodeId === removeId) link.startNodeId = keepId;
    if (link.endNodeId === removeId) link.endNodeId = keepId;
    if (link.startNodeId === link.endNodeId) delete model.links[linkId];
  }
  delete model.nodes[removeId];
  // 제어 규칙·[DEMANDS]·수질 등 원문 섹션에서 지운 절점을 가리키던 참조도 남는 절점으로 옮긴다
  renameInSections(model, 'node', removeId, keepId);
  if (model.options?.quality.traceNode === removeId) model.options.quality.traceNode = keepId;
  recalcLengthsAt(model, keepId);
}

/** 화면 표시·스냅용: 주어진 위치에서 가장 가까운 절점. */
export function nearestNode(
  model: Pick<NetworkModel, 'nodes'>,
  position: LngLat,
  maxMeters: number,
): NetworkNode | null {
  let best: NetworkNode | null = null;
  let bestDistance = maxMeters;
  for (const id in model.nodes) {
    const node = model.nodes[id];
    const d = distanceMeters(node.position, position);
    if (d <= bestDistance) {
      best = node;
      bestDistance = d;
    }
  }
  return best;
}
