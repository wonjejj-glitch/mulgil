/**
 * 좌표가 없는(전부 0 이거나 비어 있는) SWMM 파일을 위한 개략도 배치.
 * 연결 관계와 관거 연장으로 절점을 놓는다: 방류구에서 시작해 연장만큼 떨어진 곳에 하류→상류 방향으로 뻗어 나간다.
 * 실제 위치와는 무관하며, 지도에서 구조와 해석 결과를 보기 위한 용도다.
 */

export interface LayoutLink {
  from: string;
  to: string;
  /** 도면 단위(m 또는 ft). 0 이하이면 기본 간격을 쓴다. */
  length: number;
}

const DEFAULT_GAP = 30;
const MIN_GAP = 6;
const BRANCH_ANGLE = (50 * Math.PI) / 180;
const COMPONENT_GAP = 150;

export function schematicLayout(nodeIds: string[], links: LayoutLink[], preferredRoots: string[] = []): Map<string, [number, number]> {
  const adjacency = new Map<string, { id: string; length: number }[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const l of links) {
    if (l.from === l.to) continue;
    adjacency.get(l.from)?.push({ id: l.to, length: l.length });
    adjacency.get(l.to)?.push({ id: l.from, length: l.length });
  }

  const positions = new Map<string, [number, number]>();
  const preferred = new Set(preferredRoots);
  let yOffset = 0;

  for (const start of nodeIds) {
    if (positions.has(start)) continue;
    // 연결 요소를 모으고 방류구(없으면 첫 절점)를 뿌리로 삼는다.
    const component: string[] = [];
    const seen = new Set<string>([start]);
    for (const queue = [start]; queue.length > 0; ) {
      const id = queue.shift()!;
      component.push(id);
      for (const next of adjacency.get(id) ?? []) {
        if (!seen.has(next.id)) {
          seen.add(next.id);
          queue.push(next.id);
        }
      }
    }
    const root = component.find((id) => preferred.has(id)) ?? component[0];

    const local = new Map<string, [number, number]>([[root, [0, 0]]]);
    const heading = new Map<string, number>([[root, Math.PI]]); // 서쪽(−x)으로 뻗는다
    const visited = new Set<string>([root]);
    for (const queue = [root]; queue.length > 0; ) {
      const id = queue.shift()!;
      const [x, y] = local.get(id)!;
      const baseHeading = heading.get(id)!;
      let k = 0;
      for (const next of adjacency.get(id) ?? []) {
        if (visited.has(next.id)) continue;
        visited.add(next.id);
        // 첫 가지는 직진, 다음 가지는 좌우로 번갈아 벌린다
        const step = Math.ceil(k / 2);
        const theta = baseHeading + (k === 0 ? 0 : (k % 2 === 1 ? 1 : -1) * step * BRANCH_ANGLE);
        k++;
        const gap = next.length > 0 ? Math.max(next.length, MIN_GAP) : DEFAULT_GAP;
        local.set(next.id, [x + gap * Math.cos(theta), y + gap * Math.sin(theta)]);
        heading.set(next.id, theta);
        queue.push(next.id);
      }
    }

    // 요소 하나를 북쪽→남쪽 띠로 쌓는다 (서로 겹치지 않게).
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, [, y]] of local) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const shift = yOffset - maxY;
    for (const [id, [x, y]] of local) positions.set(id, [x, y + shift]);
    yOffset = yOffset - (maxY - minY) - COMPONENT_GAP;
  }
  return positions;
}
