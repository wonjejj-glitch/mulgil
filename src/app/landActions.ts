/**
 * 용지 조서·용지도: 지금 관망(상수 또는 하수)의 관로 → 브이월드 연속지적도 → 필지별 편입 면적·개략 보상비 → CSV·DXF.
 * 계산은 core/land/takeoff.ts, 지적도는 app/vworldData.ts.
 */
import { landTakeoff, takeoffCsv, type Parcel, type Route, type XY } from '../core/land/takeoff';
import { linkPath } from '../core/model/networkEdit';
import type { LngLat } from '../core/model/types';
import { isUsUnits } from '../core/model/units';
import { Dxf } from '../core/sewer/drawings';
import { nodePositions } from '../core/sewer/mapFrame';
import { useLandStore } from '../store/useLandStore';
import { useNetworkStore } from '../store/useNetworkStore';
import { useSewerStore } from '../store/useSewerStore';
import { useUIStore } from '../store/useUIStore';
import { downloadText } from '../utils/files';
import { wgs84ToEpsg } from '../utils/geoMath';
import { fetchParcelsAlong } from './vworldData';

/** 관경(m) → 개략 터파기 폭(m): max(0.8, D × 1.2 + 0.6) — 하수 수량 산출과 같은 예시 기준. */
export const autoWidth = (d: number) => Math.max(0.8, d * 1.2 + 0.6);

interface LngLatRoute {
  id: string;
  path: LngLat[];
  /** 관경 m */
  diameter: number;
}

function currentRoutes(): { domain: 'water' | 'sewer'; routes: LngLatRoute[]; name: string } {
  const domain = useUIStore.getState().domain;
  if (domain === 'sewer') {
    const project = useSewerStore.getState().project;
    const pos = nodePositions(project);
    return {
      domain,
      name: project.name || '하수 관망',
      routes: project.conduits.flatMap((c) => {
        const a = pos.get(c.upstream), b = pos.get(c.downstream);
        return a && b ? [{ id: c.id, path: [a, b], diameter: c.diameter }] : [];
      }),
    };
  }
  const model = useNetworkStore.getState().model;
  const us = isUsUnits(model.options.flowUnits);
  return {
    domain,
    name: model.title?.[0] || '상수 관망',
    routes: Object.values(model.links).flatMap((l) => (l.type === 'pipe' ? [{ id: l.id, path: linkPath(model, l), diameter: us ? l.diameter * 0.0254 : l.diameter / 1000 }] : [])),
  };
}

/** 관망 가운데 경도에 맞는 TM 원점 (면적 왜곡을 줄인다). */
function planeFor(paths: LngLat[][]): string {
  let sum = 0, n = 0;
  for (const p of paths) for (const [x] of p) {
    sum += x;
    n++;
  }
  const lon = n ? sum / n : 127;
  return lon < 126 ? 'EPSG:5185' : lon < 128 ? 'EPSG:5186' : lon < 130 ? 'EPSG:5187' : 'EPSG:5188';
}

export async function runLandTakeoff(refetch = false): Promise<void> {
  const land = useLandStore.getState();
  if (land.busy) return;
  const { domain, routes } = currentRoutes();
  if (routes.length === 0) {
    land.set({ error: '관로가 없습니다. 관망을 먼저 여세요.' });
    return;
  }
  land.set({ busy: '지적도 받는 중…', error: null });
  try {
    let parcels = land.parcels;
    if (refetch || parcels.length === 0 || land.domain !== domain) {
      parcels = await fetchParcelsAlong(useUIStore.getState().vworldKey, routes.map((r) => r.path), (d, t) => useLandStore.getState().set({ busy: `지적도 받는 중… ${d}/${t}칸` }));
      if (parcels.length === 0) throw new Error('관로 주변에서 필지를 찾지 못했습니다. 관망 위치(좌표계)를 확인하세요.');
    }
    useLandStore.getState().set({ busy: '편입 면적 계산 중…', parcels });
    await new Promise((r) => setTimeout(r, 0));
    const plane = planeFor(routes.map((r) => r.path));
    const to = (p: LngLat): XY => wgs84ToEpsg(plane, p) as XY;
    const s = useLandStore.getState().settings;
    const planeRoutes: Route[] = routes.map((r) => ({ id: r.id, path: r.path.map(to), width: s.widthMode === 'auto' ? autoWidth(r.diameter) : s.width }));
    const planeParcels: Parcel[] = parcels.map((p) => ({ ...p, polygons: p.polygons.map((poly) => poly.map((ring) => ring.map(to))) }));
    const result = landTakeoff(planeParcels, planeRoutes, s.factor);
    useLandStore.getState().set({ result, plane, domain, show: true });
    useUIStore.getState().pushToast({
      level: 'success',
      title: `편입토지 ${result.rows.length.toLocaleString()}필지 · ${Math.round(result.totalTaken).toLocaleString()} m²`,
      message: `사유지 등 ${Math.round(result.privateTaken).toLocaleString()} m² · 개략 보상비 ${Math.round(result.totalCost / 10000).toLocaleString()}만 원 (공시지가 × ${s.factor}). 지도에 편입 필지가 표시됩니다.`,
    });
  } catch (e) {
    useLandStore.getState().set({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    useLandStore.getState().set({ busy: null });
  }
}

const safe = (s: string) => s.replace(/[/\\:*?"<>|\s]+/g, '_').slice(0, 40) || 'network';

export function exportTakeoffCsv(): void {
  const { result } = useLandStore.getState();
  if (!result) return;
  const { name } = currentRoutes();
  downloadText(`${safe(name)}_편입토지조서.csv`, takeoffCsv(result, name), 'text/csv;charset=utf-8');
}

/** 용지도 DXF: 필지 경계·지번, 관로 중심선, 편입 부분(조각), 편입 필지 번호. 좌표는 계산에 쓴 TM 좌표(m). */
export function exportLandDxf(): void {
  const { result, parcels, plane } = useLandStore.getState();
  if (!result) return;
  const { name, routes } = currentRoutes();
  const to = (p: LngLat): XY => wgs84ToEpsg(plane, p) as XY;
  const dxf = new Dxf([
    ['지적', 8],
    ['지번', 7],
    ['관로', 1],
    ['편입', 3],
    ['조서번호', 2],
  ]);
  const taken = new Map(result.rows.map((r, i) => [r.pnu, i + 1]));
  for (const p of parcels) {
    let cx = 0, cy = 0, n = 0;
    for (const poly of p.polygons) for (const ring of poly) {
      const pts = ring.map(to);
      dxf.poly('지적', pts, true);
      if (poly[0] === ring) for (const [x, y] of pts) {
        cx += x;
        cy += y;
        n++;
      }
    }
    if (n) {
      dxf.text('지번', [cx / n, cy / n], 0.8, p.jibun, 0, 1);
      const no = taken.get(p.pnu);
      if (no) dxf.text('조서번호', [cx / n, cy / n - 1.2], 0.8, `(${no})`, 0, 1);
    }
  }
  for (const r of routes) dxf.poly('관로', r.path.map(to));
  for (const row of result.rows) for (const piece of row.pieces) dxf.poly('편입', piece, true);
  downloadText(`${safe(name)}_용지도_${plane.replace(':', '')}.dxf`, dxf.toString(), 'application/dxf');
}

export function clearLand(): void {
  useLandStore.getState().set({ parcels: [], result: null, domain: null, error: null });
}
