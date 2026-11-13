/**
 * 관망 정리 도구 (기존 상수관망 프로그램의 '절점 병합', '링크 자동 병합', '개체 ID 입력'을 일괄 처리로 옮김).
 * 전달받은 model 을 직접 바꾼다 (immer draft 에서 호출). 결과 개수를 돌려준다.
 */
import { makeLocalProjector } from '../../utils/geoMath';
import { computeLinkLength, isValidId, mergeNodes, renameLink, renameNode } from './networkEdit';
import type { NetworkModel, Pipe } from './types';

/**
 * 거리 tol(m) 안에 있는 절점끼리 합친다. 수원지·배수지가 섞이면 그 쪽을 남기고, 수요량은 더한다.
 * 둘 사이에 펌프·밸브가 있으면 합치지 않는다(기존 프로그램과 같은 제약). 수원지끼리도 합치지 않는다.
 */
export function mergeNearbyNodes(model: NetworkModel, tol: number, scope?: string[]): number {
  const ids = (scope ?? Object.keys(model.nodes)).filter((id) => model.nodes[id]);
  if (ids.length < 2 || tol <= 0) return 0;
  const proj = makeLocalProjector(model.nodes[ids[0]].position[1]);
  const cell = new Map<string, string[]>();
  const key = (x: number, y: number) => `${Math.floor(x / tol)},${Math.floor(y / tol)}`;
  const xy = new Map(ids.map((id) => [id, proj.forward(model.nodes[id].position)]));
  for (const id of ids) {
    const [x, y] = xy.get(id)!;
    const k = key(x, y);
    cell.set(k, [...(cell.get(k) ?? []), id]);
  }
  const blocked = new Set<string>();
  for (const l of Object.values(model.links)) {
    if (l.type !== 'pipe') {
      blocked.add(`${l.startNodeId}|${l.endNodeId}`);
      blocked.add(`${l.endNodeId}|${l.startNodeId}`);
    }
  }
  let merged = 0;
  for (const id of ids) {
    const node = model.nodes[id];
    if (!node) continue;
    const [x, y] = xy.get(id)!;
    const cx = Math.floor(x / tol);
    const cy = Math.floor(y / tol);
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (const other of cell.get(`${i},${j}`) ?? []) {
          if (other === id || !model.nodes[other] || !model.nodes[id]) continue;
          const [ox, oy] = xy.get(other)!;
          if (Math.hypot(ox - x, oy - y) > tol || blocked.has(`${id}|${other}`)) continue;
          const a = model.nodes[id];
          const b = model.nodes[other];
          if (a.type !== 'junction' && b.type !== 'junction') continue;
          // 수원지·배수지가 있으면 그것을 남긴다
          const [keep, drop] = a.type === 'junction' && b.type !== 'junction' ? [b, a] : [a, b];
          if (keep.type === 'junction' && drop.type === 'junction') keep.demand += drop.demand;
          // 다른 링크의 펌프·밸브 제약도 남은 절점 쪽으로 옮긴다
          for (const l of Object.values(model.links)) {
            if (l.type === 'pipe') continue;
            for (const [s, e] of [[l.startNodeId, l.endNodeId], [l.endNodeId, l.startNodeId]]) if (s === drop.id) blocked.add(`${keep.id}|${e}`);
          }
          mergeNodes(model, keep.id, drop.id);
          merged++;
        }
      }
    }
  }
  return merged;
}

const samePipe = (a: Pipe, b: Pipe) => a.diameter === b.diameter && a.roughness === b.roughness && a.minorLoss === b.minorLoss && a.status === b.status;

/**
 * 수요가 없는 절점에 같은 제원의 관 두 개만 이어져 있으면 하나로 합친다 (연장 외 속성이 모두 같을 때).
 * 제어 규칙·원문 섹션에서 이름이 쓰인 절점·관은 건드리지 않는다.
 */
export function mergeSeriesPipes(model: NetworkModel, scope?: string[]): number {
  const referenced = new Set(Object.values(model.extraSections).flatMap((lines) => lines.flatMap((l) => l.trim().split(/\s+/))));
  if (model.options.quality.traceNode) referenced.add(model.options.quality.traceNode);
  let merged = 0;
  let changed = true;
  while (changed) {
    changed = false;
    const incident = new Map<string, string[]>();
    for (const l of Object.values(model.links)) {
      incident.set(l.startNodeId, [...(incident.get(l.startNodeId) ?? []), l.id]);
      incident.set(l.endNodeId, [...(incident.get(l.endNodeId) ?? []), l.id]);
    }
    for (const id of scope ?? Object.keys(model.nodes)) {
      const node = model.nodes[id];
      if (!node || node.type !== 'junction' || node.demand !== 0 || node.source || referenced.has(id)) continue;
      const links = incident.get(id) ?? [];
      if (links.length !== 2) continue;
      const a = model.links[links[0]];
      const b = model.links[links[1]];
      if (!a || !b || a.type !== 'pipe' || b.type !== 'pipe' || !samePipe(a, b) || referenced.has(b.id)) continue;
      // a 를 (… → id), b 를 (id → …) 방향으로 맞춘다
      const aPath = a.endNodeId === id ? a.vertices : [...a.vertices].reverse();
      const aFrom = a.endNodeId === id ? a.startNodeId : a.endNodeId;
      const bPath = b.startNodeId === id ? b.vertices : [...b.vertices].reverse();
      const bTo = b.startNodeId === id ? b.endNodeId : b.startNodeId;
      if (aFrom === bTo) continue; // 둘을 합치면 고리(자기 자신)가 된다
      const custom = a.isCustomLength || b.isCustomLength;
      const total = a.length + b.length;
      a.startNodeId = aFrom;
      a.endNodeId = bTo;
      a.vertices = [...aPath, node.position, ...bPath];
      a.isCustomLength = custom;
      a.length = custom ? Math.round(total * 100) / 100 : computeLinkLength(model, a);
      delete model.links[b.id];
      delete model.nodes[id];
      merged++;
      changed = true;
      break;
    }
  }
  return merged;
}

export interface RenumberOptions {
  prefix: string;
  digits: number;
  start: number;
  step: number;
}

/** 대상 객체의 ID 를 접두어 + 일련번호로 다시 붙인다 (지금 순서대로). 실패한 개수는 -1 로 알린다. */
export function renumber(model: NetworkModel, kind: 'node' | 'link', ids: string[], o: RenumberOptions): number {
  const targets = ids.filter((id) => (kind === 'node' ? model.nodes[id] : model.links[id]));
  const names = targets.map((_, i) => `${o.prefix}${String(o.start + i * o.step).padStart(o.digits, '0')}`);
  if (names.some((n) => !isValidId(n)) || new Set(names).size !== names.length) return -1;
  const pool = kind === 'node' ? model.nodes : model.links;
  const targetSet = new Set(targets);
  if (names.some((n) => pool[n] && !targetSet.has(n))) return -1; // 대상이 아닌 객체와 이름이 겹친다
  const rename = kind === 'node' ? renameNode : renameLink;
  // 두 단계: 임시 이름 → 새 이름 (서로 이름을 맞바꾸는 경우 충돌 방지)
  const temp = targets.map((id, i) => {
    const t = `~tmp${i}`;
    rename(model, id, t);
    return t;
  });
  temp.forEach((t, i) => rename(model, t, names[i]));
  return targets.length;
}
