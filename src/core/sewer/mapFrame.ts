/**
 * 하수 프로젝트 좌표(x, y: m) ↔ 지도 경위도.
 *
 * 규칙 (AGENTS.md '하수 모드' 참고):
 * - 절점 x, y 는 EPSG:5186(중부원점, m)으로 저장한다. 수용가 초안·SWMM 가져오기·지도 작도가 모두 이 좌표를 쓴다.
 * - 좌표가 5186 범위가 아닌 프로젝트(예제처럼 x≈0~600 인 도면 좌표)는 '임의 평면'으로 보고,
 *   좌표 범위의 중심을 기준 위치(DEFAULT_ANCHOR)의 5186 좌표로 평행 이동해 그린다. 스키마에는 아무것도 더하지 않는다.
 * - 임의 평면 프로젝트를 지도에서 편집(추가·이동)하면 먼저 전체 절점을 5186 으로 옮긴다(georeference).
 *   화면 위치와 절점 사이 거리는 그대로이고, 그 뒤로는 좌표가 고정된 좌표계에 놓인다.
 */
import { DEFAULT_ANCHOR, epsgToWgs84, wgs84ToEpsg } from '../../utils/geoMath';
import type { LngLat } from '../model/types';
import type { SewerNode, SewerProject } from './types';

export const SEWER_CRS = 'EPSG:5186';

/** local: 도면 좌표 origin 을 EPSG:5186 의 base 로 평행 이동해 놓는다 (회전·축척 없음 → 거리가 그대로 유지된다). */
export type SewerFrame = { kind: 'epsg' } | { kind: 'local'; origin: [number, number]; base: [number, number] };

/** EPSG:5186 로 볼 수 있는 좌표 범위 (utils/geoMath detectCrs 와 같은 범위). */
function in5186(x: number, y: number): boolean {
  return x >= 60000 && x <= 420000 && y >= 50000 && y <= 1050000;
}

/** 프로젝트 좌표를 어떻게 지도에 놓을지 정한다. 절점이 없으면 5186. */
export function sewerFrame(project: Pick<SewerProject, 'nodes'>, anchor: LngLat = DEFAULT_ANCHOR): SewerFrame {
  if (project.nodes.length === 0 || project.nodes.every((n) => in5186(n.x, n.y))) return { kind: 'epsg' };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of project.nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  }
  return { kind: 'local', origin: [(minX + maxX) / 2, (minY + maxY) / 2], base: wgs84ToEpsg(SEWER_CRS, anchor) };
}

export function isGeoreferenced(project: Pick<SewerProject, 'nodes'>): boolean {
  return sewerFrame(project).kind === 'epsg';
}

export function xyToLngLat(frame: SewerFrame, x: number, y: number): LngLat {
  if (frame.kind === 'epsg') return epsgToWgs84(SEWER_CRS, [x, y]);
  return epsgToWgs84(SEWER_CRS, [frame.base[0] + x - frame.origin[0], frame.base[1] + y - frame.origin[1]]);
}

export function lngLatToXy(frame: SewerFrame, p: LngLat): [number, number] {
  const [x, y] = wgs84ToEpsg(SEWER_CRS, p);
  if (frame.kind === 'epsg') return [x, y];
  return [frame.origin[0] + x - frame.base[0], frame.origin[1] + y - frame.base[1]];
}

export function nodeLngLat(frame: SewerFrame, node: Pick<SewerNode, 'x' | 'y'>): LngLat {
  return xyToLngLat(frame, node.x, node.y);
}

/** 절점 ID → 경위도. */
export function nodePositions(project: Pick<SewerProject, 'nodes'>, frame: SewerFrame = sewerFrame(project)): Map<string, LngLat> {
  return new Map(project.nodes.map((n) => [n.id, nodeLngLat(frame, n)]));
}

const mm = (v: number) => Math.round(v * 1000) / 1000;

/**
 * 임의 평면 좌표를 지금 보이는 위치 그대로 EPSG:5186 으로 옮긴다 (제자리 변경). 이미 5186 이면 아무것도 하지 않는다.
 * 돌려주는 값: 좌표를 바꿨으면 true.
 */
export function georeference(project: SewerProject, anchor: LngLat = DEFAULT_ANCHOR): boolean {
  const frame = sewerFrame(project, anchor);
  if (frame.kind === 'epsg') return false;
  for (const n of project.nodes) {
    n.x = mm(frame.base[0] + n.x - frame.origin[0]);
    n.y = mm(frame.base[1] + n.y - frame.origin[1]);
  }
  for (const c of project.catchments ?? []) {
    if (c.polygon) c.polygon = c.polygon.map(([x, y]) => [mm(frame.base[0] + x - frame.origin[0]), mm(frame.base[1] + y - frame.origin[1])]);
  }
  return true;
}
