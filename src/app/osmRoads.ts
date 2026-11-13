/**
 * OpenStreetMap 도로 중심선 가져오기 (Overpass API). 보내는 정보는 영역 경계 좌표뿐이다.
 * 공개 서버가 자주 바쁘므로 서버 5곳을 차례로 시도하고, 같은 영역을 다시 요청하면 마지막 결과를 재사용한다.
 */
import type { LngLat } from '../core/model/types';

const ROAD_TYPES =
  'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|road|track';

const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** [남, 서, 북, 동] */
type Box = [number, number, number, number];
let cache: { box: Box; roads: LngLat[][] } | null = null;

const inside = (inner: Box, outer: Box) => inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];

/* 브라우저 저장소(IndexedDB) 캐시: 새로고침해도 같은 영역은 서버에 다시 묻지 않는다 (공개 서버가 자주 바쁨). 30일, 최근 6개 영역. */
const DB = 'mulgil-roads';
const MAX_AGE = 30 * 24 * 3600 * 1000;
interface Stored {
  box: Box;
  roads: LngLat[][];
  at: number;
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

async function readStored(box: Box): Promise<LngLat[][] | null> {
  const list = (await withStore<Stored[]>('readonly', (s) => s.get('recent'))) ?? [];
  const hit = list.find((e) => Date.now() - e.at < MAX_AGE && inside(box, e.box));
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

export async function fetchOsmRoads(south: number, west: number, north: number, east: number): Promise<LngLat[][]> {
  const box: Box = [south, west, north, east];
  if (userRoads) return userRoads.roads;
  if (cache && inside(box, cache.box)) return cache.roads;
  const stored = typeof indexedDB === 'undefined' ? null : await readStored(box);
  if (stored) {
    cache = { box, roads: stored };
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
      cache = { box, roads };
      if (typeof indexedDB !== 'undefined') void writeStored({ box, roads, at: Date.now() });
      return roads;
    } catch (error) {
      errors.push(`${new URL(url).host} ${error instanceof DOMException && error.name === 'AbortError' ? '시간 초과' : '연결 실패'}`);
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw new Error(`도로 데이터 서버에 연결하지 못했습니다 (${errors.join(', ')}). 잠시 뒤 다시 시도하세요.`);
}
