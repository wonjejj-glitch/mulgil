import { makeLocalProjector } from '../../utils/geoMath';
import { linkPath } from '../model/networkEdit';
import type { NetworkModel } from '../model/types';
import type { ValidationIssue } from './types';

interface Segment {
  link: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

interface PipeGeom {
  id: string;
  startNodeId: string;
  endNodeId: string;
  sx: number;
  sy: number;
  ex: number;
  ey: number;
}

/**
 * 관로 교차 미분할 검출.
 * - crossing: 두 관로가 절점 없이 X자로 교차. linkIds = [관로 A, 관로 B], position = 교차점.
 * - tee: 절점이 다른 관로의 중간에 놓여 있으나 연결되지 않음. nodeIds = [절점], linkIds = [관로].
 * 격자 공간 색인으로 후보 쌍을 줄여 대규모 관망에서도 동작한다 (Web Worker 에서 호출).
 */
export function findCrossings(model: NetworkModel, toleranceMeters: number): ValidationIssue[] {
  const nodeIds = Object.keys(model.nodes);
  if (nodeIds.length === 0) return [];
  let latSum = 0;
  for (const id of nodeIds) latSum += model.nodes[id].position[1];
  const projector = makeLocalProjector(latSum / nodeIds.length);

  const pipes: PipeGeom[] = [];
  const segments: Segment[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let totalLength = 0;
  for (const id in model.links) {
    const link = model.links[id];
    if (link.type !== 'pipe' || link.startNodeId === link.endNodeId) continue;
    const pts = linkPath(model, link).map(projector.forward);
    if (pts.length < 2) continue;
    const index = pipes.length;
    const last = pts[pts.length - 1];
    pipes.push({
      id,
      startNodeId: link.startNodeId,
      endNodeId: link.endNodeId,
      sx: pts[0][0],
      sy: pts[0][1],
      ex: last[0],
      ey: last[1],
    });
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      segments.push({ link: index, ax, ay, bx, by });
      totalLength += Math.hypot(bx - ax, by - ay);
      minX = Math.min(minX, ax, bx);
      minY = Math.min(minY, ay, by);
      maxX = Math.max(maxX, ax, bx);
      maxY = Math.max(maxY, ay, by);
    }
  }
  if (segments.length === 0) return [];

  const diagonal = Math.hypot(maxX - minX, maxY - minY);
  const cell = Math.max(totalLength / segments.length, diagonal / 2000, 1);
  const cols = Math.floor((maxX - minX) / cell) + 3;
  const cellKey = (ix: number, iy: number) => iy * cols + ix;
  const cellX = (x: number) => Math.floor((x - minX) / cell) + 1;
  const cellY = (y: number) => Math.floor((y - minY) / cell) + 1;

  const grid = new Map<number, number[]>();
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const x0 = cellX(Math.min(seg.ax, seg.bx));
    const x1 = cellX(Math.max(seg.ax, seg.bx));
    const y0 = cellY(Math.min(seg.ay, seg.by));
    const y1 = cellY(Math.max(seg.ay, seg.by));
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const key = cellKey(ix, iy);
        const bucket = grid.get(key);
        if (bucket) bucket.push(s);
        else grid.set(key, [s]);
      }
    }
  }

  const nearEndpoint = (pipe: PipeGeom, x: number, y: number) =>
    Math.hypot(x - pipe.sx, y - pipe.sy) < toleranceMeters || Math.hypot(x - pipe.ex, y - pipe.ey) < toleranceMeters;

  const issues: ValidationIssue[] = [];

  // 1) X자 교차
  const testedPairs = new Set<number>();
  const reported = new Set<string>();
  const segmentCount = segments.length;
  for (const bucket of grid.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const s1 = Math.min(bucket[i], bucket[j]);
        const s2 = Math.max(bucket[i], bucket[j]);
        const a = segments[s1];
        const b = segments[s2];
        if (a.link === b.link) continue;
        const pairKey = s1 * segmentCount + s2;
        if (testedPairs.has(pairKey)) continue;
        testedPairs.add(pairKey);

        const rx = a.bx - a.ax;
        const ry = a.by - a.ay;
        const sx = b.bx - b.ax;
        const sy = b.by - b.ay;
        const denom = rx * sy - ry * sx;
        if (Math.abs(denom) < 1e-12) continue; // 평행
        const qx = b.ax - a.ax;
        const qy = b.ay - a.ay;
        const t = (qx * sy - qy * sx) / denom;
        const u = (qx * ry - qy * rx) / denom;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        const px = a.ax + rx * t;
        const py = a.ay + ry * t;
        const pipeA = pipes[a.link];
        const pipeB = pipes[b.link];
        // 교차점이 어느 한 관로의 끝 절점이면 X자 교차가 아니다 (공유 절점이거나 T자).
        if (nearEndpoint(pipeA, px, py) || nearEndpoint(pipeB, px, py)) continue;
        const first = pipeA.id < pipeB.id ? pipeA : pipeB;
        const second = first === pipeA ? pipeB : pipeA;
        const key = `${first.id}\u0000${second.id}\u0000${px.toFixed(2)}\u0000${py.toFixed(2)}`;
        if (reported.has(key)) continue;
        reported.add(key);
        issues.push({
          id: `crossing:${first.id}:${second.id}:${reported.size}`,
          type: 'crossing',
          severity: 'warning',
          message: `관로 ${first.id} 과(와) 관로 ${second.id} 이(가) 절점 없이 교차합니다.`,
          nodeIds: [],
          linkIds: [first.id, second.id],
          position: projector.inverse([px, py]),
          fixable: true,
        });
      }
    }
  }

  // 2) T자 미연결: 절점이 다른 관로의 중간 위에 놓여 있는 경우
  const teeReported = new Set<string>();
  for (const nodeId of nodeIds) {
    const node = model.nodes[nodeId];
    const [px, py] = projector.forward(node.position);
    if (px < minX - toleranceMeters || px > maxX + toleranceMeters) continue;
    if (py < minY - toleranceMeters || py > maxY + toleranceMeters) continue;
    const cx = cellX(px);
    const cy = cellY(py);
    for (let iy = cy - 1; iy <= cy + 1; iy++) {
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        const bucket = grid.get(cellKey(ix, iy));
        if (!bucket) continue;
        for (const s of bucket) {
          const seg = segments[s];
          const pipe = pipes[seg.link];
          if (pipe.startNodeId === nodeId || pipe.endNodeId === nodeId) continue;
          const dx = seg.bx - seg.ax;
          const dy = seg.by - seg.ay;
          const len2 = dx * dx + dy * dy;
          let t = len2 > 0 ? ((px - seg.ax) * dx + (py - seg.ay) * dy) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          const qx = seg.ax + dx * t;
          const qy = seg.ay + dy * t;
          if (Math.hypot(px - qx, py - qy) >= toleranceMeters) continue;
          // 관로 끝 절점과 겹친 경우는 미소 관로·중복 절점 문제이므로 여기서 다루지 않는다.
          if (nearEndpoint(pipe, qx, qy)) continue;
          const key = `${nodeId}\u0000${pipe.id}`;
          if (teeReported.has(key)) continue;
          teeReported.add(key);
          issues.push({
            id: `tee:${nodeId}:${pipe.id}`,
            type: 'tee',
            severity: 'warning',
            message: `절점 ${nodeId} 이(가) 관로 ${pipe.id} 위에 있으나 연결되어 있지 않습니다.`,
            nodeIds: [nodeId],
            linkIds: [pipe.id],
            position: node.position,
            fixable: true,
          });
        }
      }
    }
  }

  return issues;
}
