/**
 * 도로 중심선 가져오기 (관망 초안·도로 기준 위치 보정). 보내는 정보는 영역 경계 좌표뿐이다.
 *  1) 사용자가 넣은 도로 파일
 *  2) 브이월드 수치지도(1:5,000) 도로중심선 — 인증키가 있을 때 (골목까지 있어 한국에서는 이것이 기본)
 *  3) OpenStreetMap (Overpass API) — 키가 없거나 브이월드에 연결하지 못할 때. 서버 5곳을 차례로 시도한다.
 * 같은 영역을 다시 요청하면 마지막 결과를 재사용하고, 브라우저 저장소에 30일 남긴다.
 */
import { cellBox, cellsOf } from '../core/model/buildingCells';
import type { LngLat } from '../core/model/types';
import { useUIStore } from '../store/useUIStore';
import { fetchRoadsBox } from './vworldData';

export type RoadSource = 'user' | 'vworld' | 'osm';
export const ROAD_SOURCE_LABEL: Record<RoadSource, string> = {
  user: '넣은 도로 파일',
  vworld: '브이월드 수치지도 도로중심선',
  osm: 'OpenStreetMap 도로',
};
let lastSource: RoadSource | null = null;
/** 마지막으로 받은 도로 자료의 출처 (안내 문구용) */
export function lastRoadSource(): RoadSource | null {
  return lastSource;
}

const ROAD_TYPES =
  'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|road|track';

export const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** [남, 서, 북, 동] */
type Box = [number, number, number, number];
let cache: { box: Box; roads: LngLat[][]; source: RoadSource } | null = null;

const inside = (inner: Box, outer: Box) => inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];

/* 브라우저 저장소(IndexedDB) 캐시: 새로고침해도 같은 영역은 서버에 다시 묻지 않는다 (공개 서버가 자주 바쁨). 30일, 최근 6개 영역. */
// 출처를 함께 남기는 새 저장소 (예전 OpenStreetMap 캐시를 브이월드 대신 쓰지 않게)
const DB = 'mulgil-roads-2';
const MAX_AGE = 30 * 24 * 3600 * 1000;
interface Stored {
  box: Box;
  roads: LngLat[][];
  at: number;
  source: RoadSource;
}

function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('areas');
      open.onerror = () => resolve(undefined);
      open.onsuccess = () => {
        const db = open.result;
        const req = run(db.transaction('areas', mode).objectStore('areas'));
        req.onsuccess = () => {
          resolve(req.result);
          db.close();
        };
        req.onerror = () => {
          resolve(undefined);
          db.close();
        };
      };
    } catch {
      resolve(undefined);
    }
  });
}

async function readStored(box: Box, source: RoadSource): Promise<LngLat[][] | null> {
  const list = (await withStore<Stored[]>('readonly', (s) => s.get('recent'))) ?? [];
  const hit = list.find((e) => e.source === source && Date.now() - e.at < MAX_AGE && inside(box, e.box));
  return hit?.roads ?? null;
}

async function writeStored(entry: Stored): Promise<void> {
  const list = (await withStore<Stored[]>('readonly', (s) => s.get('recent'))) ?? [];
  const next = [entry, ...list.filter((e) => Date.now() - e.at < MAX_AGE && !inside(e.box, entry.box))].slice(0, 6);
  await withStore('readwrite', (s) => s.put(next, 'recent'));
}

/* 사용자가 넣은 도로 중심선(도로명주소 전자지도·수치지도 도로 레이어 등). 있으면 공개 서버 대신 이것을 쓴다. */
let userRoads: { roads: LngLat[][]; name: string } | null = null;

export function setUserRoads(roads: LngLat[][] | null, name = ''): void {
  userRoads = roads ? { roads, name } : null;
}

export function userRoadsInfo(): { name: string; count: number } | null {
  return userRoads ? { name: userRoads.name, count: userRoads.roads.length } : null;
}

/** 브이월드 도로: 0.01° 칸으로 나눠(범위 밖은 잘라서) 세 칸씩 받는다. 한 칸도 못 받으면 예외. */
async function fetchVworldRoads(key: string, box: Box): Promise<LngLat[][]> {
  const [south, west, north, east] = box;
  const pieces = cellsOf([west, south, east, north]).map((c): [number, number, number, number] => {
    const [cw, cs, ce, cn] = cellBox(c);
    return [Math.max(west, cw), Math.max(south, cs), Math.min(east, ce), Math.min(north, cn)];
  });
  if (pieces.length > 400) throw new Error(`도로를 받을 범위가 너무 넓습니다(${pieces.length}칸).`);
  const roads: LngLat[][] = [];
  const queue = [...pieces];
  let ok = 0;
  let lastError: unknown = null;
  const worker = async () => {
    for (let piece = queue.shift(); piece; piece = queue.shift()) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          roads.push(...(await fetchRoadsBox(key, piece)));
          ok++;
          break;
        } catch (error) {
          lastError = error;
        }
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (ok === 0) throw lastError instanceof Error ? lastError : new Error('브이월드 도로를 받지 못했습니다.');
  if (ok < pieces.length) throw new Error(`브이월드 도로 ${pieces.length}칸 중 ${pieces.length - ok}칸을 받지 못했습니다.`);
  return roads;
}

/** 도로 중심선 [남, 서, 북, 동] 범위. 넣은 파일 → 브이월드 → OpenStreetMap 순서. */
export async function fetchRoads(south: number, west: number, north: number, east: number): Promise<LngLat[][]> {
  const box: Box = [south, west, north, east];
  if (userRoads) {
    lastSource = 'user';
    return userRoads.roads;
  }
  const key = useUIStore.getState().vworldKey;
  const preferred: RoadSource = key ? 'vworld' : 'osm';
  if (cache && cache.source === preferred && inside(box, cache.box)) {
    lastSource = cache.source;
    return cache.roads;
  }
  const stored = typeof indexedDB === 'undefined' ? null : await readStored(box, preferred);
  if (stored) {
    cache = { box, roads: stored, source: preferred };
    lastSource = preferred;
    return stored;
  }
  if (key) {
    try {
      const roads = await fetchVworldRoads(key, box);
      cache = { box, roads, source: 'vworld' };
      lastSource = 'vworld';
      if (typeof indexedDB !== 'undefined') void writeStored({ box, roads, at: Date.now(), source: 'vworld' });
      return roads;
    } catch {
      // 키를 등록하지 않은 사이트(개발 PC 등)이거나 서버 문제 — OpenStreetMap 으로 넘어간다
    }
  }
  return fetchOsmOnly(box);
}

/** 예전 이름 (호출 쪽 호환) */
export const fetchOsmRoads = fetchRoads;

async function fetchOsmOnly(box: Box): Promise<LngLat[][]> {
  const [south, west, north, east] = box;
  if (cache && cache.source === 'osm' && inside(box, cache.box)) {
    lastSource = 'osm';
    return cache.roads;
  }
  const stored = typeof indexedDB === 'undefined' ? null : await readStored(box, 'osm');
  if (stored) {
    cache = { box, roads: stored, source: 'osm' };
    lastSource = 'osm';
    return stored;
  }
  const query = `[out:json][timeout:90];way["highway"~"^(${ROAD_TYPES})$"](${south},${west},${north},${east});out geom;`;
  const errors: string[] = [];
  for (const url of OVERPASS_SERVERS) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 40000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      if (!response.ok) {
        errors.push(`${new URL(url).host} HTTP ${response.status}`);
        continue;
      }
      const json = (await response.json()) as { elements?: { type: string; geometry?: { lat: number; lon: number }[] }[] };
      const roads = (json.elements ?? [])
        .filter((e) => e.type === 'way' && e.geometry && e.geometry.length >= 2)
        .map((e) => e.geometry!.map((g): LngLat => [g.lon, g.lat]));
      cache = { box, roads, source: 'osm' };
      lastSource = 'osm';
      if (typeof indexedDB !== 'undefined') void writeStored({ box, roads, at: Date.now(), source: 'osm' });
      return roads;
    } catch (error) {
      errors.push(`${new URL(url).host} ${error instanceof DOMException && error.name === 'AbortError' ? '시간 초과' : '연결 실패'}`);
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw new Error(`도로 데이터 서버에 연결하지 못했습니다 (${errors.join(', ')}). 잠시 뒤 다시 시도하세요.`);
}
