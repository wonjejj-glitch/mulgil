/**
 * 공공데이터포털 '국토교통부_건축HUB_건축물대장정보' 표제부 조회 → 관로 주변 필지별 세대수.
 * 필지(위치·PNU)는 브이월드 연속지적도에서, 세대수는 건축물대장에서 받아 지번으로 잇는다.
 * 인증키는 배포 때 저장소 Secrets 의 VITE_DATA_GO_KR_KEY 로 넣는다 (모두 같이 쓰는 키, 하루 사용량 한도 있음).
 */
import { householdsByLot, parsePnu, type LotHouseholds, type RegisterCategory, type RegisterItem } from '../core/land/buildingRegister';
import type { LngLat } from '../core/model/types';
import { useUIStore } from '../store/useUIStore';
import { fetchParcelsAlong } from './vworldData';

export const DATA_GO_KR_KEY: string = (import.meta.env.VITE_DATA_GO_KR_KEY as string | undefined) ?? '';

const ENDPOINT = 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo';
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => Number(v) || 0;

async function fetchDongPage(key: string, sigungu: string, bjdong: string, page: number): Promise<{ items: RegisterItem[]; total: number }> {
  const url = `${ENDPOINT}?serviceKey=${encodeURIComponent(key)}&sigunguCd=${sigungu}&bjdongCd=${bjdong}&_type=json&numOfRows=100&pageNo=${page}`;
  const res = await fetch(url);
  const json = (await res.json().catch(() => null)) as {
    response?: { header?: { resultCode?: string; resultMsg?: string }; body?: { totalCount?: number | string; items?: { item?: Record<string, unknown> | Record<string, unknown>[] } | '' } };
    OpenAPI_ServiceResponse?: { cmmMsgHeader?: { returnAuthMsg?: string; errMsg?: string } };
  } | null;
  if (!json) throw new Error(`건축물대장 서버 응답을 읽지 못했습니다 (HTTP ${res.status}).`);
  if (json.OpenAPI_ServiceResponse) throw new Error(`건축물대장 조회 실패: ${json.OpenAPI_ServiceResponse.cmmMsgHeader?.returnAuthMsg ?? json.OpenAPI_ServiceResponse.cmmMsgHeader?.errMsg ?? '오류'}`);
  const header = json.response?.header;
  if (header?.resultCode && header.resultCode !== '00') throw new Error(`건축물대장 조회 실패: ${header.resultMsg ?? header.resultCode} (하루 사용량을 넘겼을 수 있습니다)`);
  const body = json.response?.body;
  const raw = body && body.items ? body.items.item : undefined;
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const items = list.map(
    (x): RegisterItem => ({
      sigunguCd: str(x.sigunguCd),
      bjdongCd: str(x.bjdongCd),
      platGbCd: str(x.platGbCd) || '0',
      bun: str(x.bun),
      ji: str(x.ji),
      mainAtchGbCd: str(x.mainAtchGbCd),
      mainPurpsCdNm: str(x.mainPurpsCdNm),
      bldNm: str(x.bldNm).trim(),
      dongNm: str(x.dongNm).trim(),
      hhldCnt: num(x.hhldCnt),
      fmlyCnt: num(x.fmlyCnt),
      hoCnt: num(x.hoCnt),
      grndFlrCnt: num(x.grndFlrCnt),
      totArea: num(x.totArea),
    }),
  );
  return { items, total: num(body?.totalCount) };
}

export interface RegisterSources {
  lots: LotHouseholds[];
  label: string;
  parcels: number;
  calls: number;
}

/** 관로 주변 필지의 건축물대장 세대수. onProgress 로 진행 문구를 알린다. */
export async function registerHouseholdsAlong(paths: LngLat[][], onProgress?: (text: string) => void): Promise<RegisterSources> {
  if (!DATA_GO_KR_KEY) throw new Error('건축물대장(공공데이터포털) 인증키가 이 사이트에 들어 있지 않습니다.');
  const parcels = await fetchParcelsAlong(useUIStore.getState().vworldKey, paths, (d, t) => onProgress?.(`지적도 받는 중… ${d}/${t}칸`));
  if (parcels.length === 0) throw new Error('관로 주변에서 필지를 찾지 못했습니다.');
  const dongs = new Set<string>();
  for (const p of parcels) {
    const k = parsePnu(p.pnu);
    if (k) dongs.add(`${k.sigungu}:${k.bjdong}`);
  }
  const items: RegisterItem[] = [];
  let calls = 0, done = 0;
  for (const d of dongs) {
    const [sg, bj] = d.split(':');
    let page = 1, pages = 1;
    do {
      onProgress?.(`건축물대장 받는 중… 법정동 ${done + 1}/${dongs.size} · ${page}/${pages}쪽`);
      const r = await fetchDongPage(DATA_GO_KR_KEY, sg, bj, page);
      calls++;
      items.push(...r.items);
      pages = Math.max(1, Math.ceil(r.total / 100));
      page++;
      if (calls > 600) throw new Error('건축물대장 조회가 너무 많습니다(600쪽 넘음). 관망 구역을 나눠서 하세요.');
    } while (page <= pages);
    done++;
  }
  const center = (ring: LngLat[]): [number, number] => {
    let x = 0, y = 0;
    for (const [a, b] of ring) {
      x += a;
      y += b;
    }
    return [x / ring.length, y / ring.length];
  };
  const r = householdsByLot(
    parcels.flatMap((p) => (p.polygons[0]?.[0] ? [{ pnu: p.pnu, center: center(p.polygons[0][0]) }] : [])),
    items,
  );
  const c = r.byCategory;
  const fmt = (k: RegisterCategory) => `${k} ${c[k].count.toLocaleString()}동 ${Math.round(c[k].households).toLocaleString()}세대`;
  return {
    lots: r.lots,
    parcels: parcels.length,
    calls,
    label: `건축물대장 — 필지 ${r.lots.length.toLocaleString()}곳 · ${fmt('공동주택')}, ${fmt('단독주택')}, ${fmt('비주거')}(세대 환산) · 법정동 ${dongs.size}곳 조회 ${calls}번`,
  };
}
