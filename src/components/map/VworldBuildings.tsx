import { useEffect, useRef, useState } from 'react';
import { Layer, Source, useMap } from 'react-map-gl/maplibre';
import { fetchBuildingsBox } from '../../app/vworldData';
import { buildingsGeoJson, cellBox, cellsOf, type BuildingFeatureCollection, type BuildingShape } from '../../core/model/buildingCells';

/** 건물을 받기 시작하는 줌 — 이보다 멀면 칸이 너무 많아진다. */
const MIN_ZOOM = 14.5;
/** 한 화면에서 받는 칸 상한 (지도를 크게 기울여 먼 곳까지 보일 때) */
const MAX_CELLS_PER_VIEW = 24;
/** 기억해 두는 칸 상한 */
const MAX_CACHED_CELLS = 120;

const EMPTY: BuildingFeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * 브이월드 건물(층수 포함)을 화면 범위만큼 받아 세워 그린다. 지도가 멈출 때마다 새로 보이는 칸만 받는다.
 * 한 번도 받지 못한 채 조회가 실패하면(키 미등록 사이트 등) onFail 로 알려 OpenStreetMap 건물로 넘어가게 한다.
 */
export function VworldBuildings({ vworldKey, onFail }: { vworldKey: string; onFail: () => void }) {
  const { current: mapRef } = useMap();
  const [data, setData] = useState<BuildingFeatureCollection>(EMPTY);
  const cache = useRef(new Map<string, BuildingShape[]>());
  const loading = useRef(new Set<string>());
  const everLoaded = useRef(false);
  const failRef = useRef(onFail);
  useEffect(() => {
    failRef.current = onFail;
  }, [onFail]);

  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;
    let alive = true;
    const store = cache.current;
    const busy = loading.current;
    const publish = (cells: string[]) => {
      if (alive) setData(buildingsGeoJson(cells.map((c) => store.get(c) ?? [])));
    };
    const refresh = () => {
      if (map.getZoom() < MIN_ZOOM) return;
      const b = map.getBounds();
      const center = map.getCenter();
      // 화면 가운데에서 가까운 칸부터
      const cells = cellsOf([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()])
        .map((c) => {
          const [w, s, e, n] = cellBox(c);
          return { c, d: Math.hypot((w + e) / 2 - center.lng, (s + n) / 2 - center.lat) };
        })
        .sort((p, q) => p.d - q.d)
        .slice(0, MAX_CELLS_PER_VIEW)
        .map((x) => x.c);
      publish(cells);
      const queue = cells.filter((c) => !store.has(c) && !busy.has(c));
      for (const c of queue) busy.add(c);
      const worker = async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          try {
            const list = await fetchBuildingsBox(vworldKey, cellBox(c));
            everLoaded.current = true;
            store.set(c, list);
            // 오래된 칸부터 버린다 (Map 은 넣은 순서를 기억한다)
            while (store.size > MAX_CACHED_CELLS) store.delete(store.keys().next().value as string);
            publish(cells);
          } catch {
            if (!everLoaded.current && alive) failRef.current();
          } finally {
            busy.delete(c);
          }
        }
      };
      void Promise.all([worker(), worker(), worker()]);
    };
    refresh();
    map.on('moveend', refresh);
    return () => {
      alive = false;
      map.off('moveend', refresh);
    };
  }, [mapRef, vworldKey]);

  return (
    <Source id="vworld-buildings" type="geojson" data={data} attribution="건물 © VWorld 국토교통부">
      <Layer
        id="vworld-buildings-3d"
        type="fill-extrusion"
        minzoom={MIN_ZOOM}
        paint={{
          'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'height'], 0, '#5d6673', 30, '#8b95a3', 100, '#b9c2cf'],
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-opacity': 0.8,
        }}
      />
    </Source>
  );
}
