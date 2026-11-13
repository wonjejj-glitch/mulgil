import { pathThrough, type ProfilePath } from '../core/model/profile';
import type { NetworkModel } from '../core/model/types';
import { useNetworkStore } from '../store/useNetworkStore';
import { useUIStore } from '../store/useUIStore';

/** 지도 레이어와 종단면도 패널이 같은 경로를 두 번 계산하지 않도록 마지막 결과를 보관한다. */
let cache: { model: NetworkModel; waypoints: string[]; path: ProfilePath | null } | null = null;

export function computeProfilePath(model: NetworkModel, waypoints: string[]): ProfilePath | null {
  if (cache && cache.model === model && cache.waypoints === waypoints) return cache.path;
  const valid = waypoints.filter((id) => id in model.nodes);
  const path = valid.length >= 2 ? pathThrough(model, valid) : null;
  cache = { model, waypoints, path };
  return path;
}

/** 현재 종단면도 경로 (경유 절점이 2개 미만이거나 끊겨 있으면 null). */
export function useProfilePath(): ProfilePath | null {
  const model = useNetworkStore((s) => s.model);
  const waypoints = useUIStore((s) => s.profileWaypoints);
  return computeProfilePath(model, waypoints);
}
