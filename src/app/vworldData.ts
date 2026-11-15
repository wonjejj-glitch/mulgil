/**
 * 브이월드 2D 데이터 API (연속지적도 LP_PA_CBND_BUBUN) 읽기.
 * 브이월드 데이터 API 는 다른 사이트에서의 fetch(CORS)를 허용하지 않아, 브이월드가 지원하는 JSONP(callback)로 받는다.
 * 보내는 정보: 인증키·사이트 주소·조회 범위(경위도 사각형)뿐이다.
 */
import type { LngLat } from '../core/model/types';

export interface CadastralParcel {
  pnu: string;
  jibun: string;
  addr: string;
  /** 공시지가 (원/m²) */
  price: number;
  priceDate: string;
  /** 경위도 다각형들 ([바깥, 구멍…]) */
  polygons: LngLat[][][];
}

let seq = 0;

function jsonp<T>(url: string, timeoutMs = 20000): Promise<T> {
  return new Promise((resolve, reject) => {
    const name = `__vworld_cb_${Date.now()}_${seq++}`;
    const script = document.createElement('script');
    const w = window as unknown as Record<string, unknown>;
    const done = () => {
      window.clearTimeout(timer);
      delete w[name];
      script.remove();
    };
    const timer = window.setTimeout(() => {
      done();
      reject(new Error('브이월드 응답이 없습니다 (시간 초과).'));
    }, timeoutMs);
    w[name] = (data: T) => {
      done();
      resolve(data);
    };
    script.onerror = () => {
      done();
      reject(new Error('브이월드에 연결하지 못했습니다.'));
    };
    script.src = `${url}&callback=${name}`;
    document.head.appendChild(script);
  });
}

interface VworldResponse {
  response: {
    status: string;
    error?: { text?: string; code?: string };
    page?: { total: string; current: string };
    result?: {
      featureCollection?: {
        features: {
          geometry: { type: string; coordinates: number[][][][] | number[][][] };
          properties: Record<string, string>;
        }[];
      };
    };
  };
}

async function fetchBox(key: string, box: [number, number, number, number], page: number): Promise<{ parcels: CadastralParcel[]; pages: number }> {
  const [w, s, e, n] = box.map((v) => v.toFixed(6));
  const url =
    'https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&format=json&crs=EPSG:4326&geometry=true&attribute=true&size=1000' +
    `&page=${page}&geomFilter=BOX(${w},${s},${e},${n})&key=${encodeURIComponent(key)}&domain=${encodeURIComponent(location.origin)}`;
  const data = await jsonp<VworldResponse>(url);
  const r = data.response;
  if (r.status === 'NOT_FOUND') return { parcels: [], pages: 0 };
  if (r.status !== 'OK') throw new Error(`브이월드 지적도 조회 실패: ${r.error?.text ?? r.status}. 인증키(2D데이터 API 사용)와 사이트 주소 등록을 확인하세요.`);
  const parcels = (r.result?.featureCollection?.features ?? []).map((f): CadastralParcel => {
    const p = f.properties;
    const coords = f.geometry.type === 'MultiPolygon' ? (f.geometry.coordinates as number[][][][]) : [f.geometry.coordinates as number[][][]];
    const year = p.gosi_year ?? '', month = p.gosi_month ?? '';
    return {
      pnu: p.pnu ?? '',
      jibun: p.jibun ?? '',
      addr: p.addr ?? '',
      price: Number(p.jiga) || 0,
      priceDate: year ? `${year}.${month}` : '',
      polygons: coords.map((poly) => poly.map((ring) => ring.map((c): LngLat => [c[0], c[1]]))),
    };
  });
  return { parcels, pages: Number(r.page?.total ?? 1) || 1 };
}

/**
 * 관로가 지나는 칸(약 300 m)들만 골라 그 안의 필지를 받는다. 같은 필지(PNU)는 한 번만.
 * onProgress(받은 칸, 전체 칸)
 */
export async function fetchParcelsAlong(key: string, paths: LngLat[][], onProgress?: (done: number, total: number) => void): Promise<CadastralParcel[]> {
  if (!key) throw new Error('브이월드 인증키가 없습니다. 왼쪽 패널 배경지도의 브이월드 키 칸을 확인하세요.');
  const size = 0.003;
  const cells = new Set<string>();
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const a = path[i], b = path[Math.min(i + 1, path.length - 1)];
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (size / 3)));
      for (let k = 0; k <= steps; k++) {
        const x = a[0] + ((b[0] - a[0]) * k) / steps, y = a[1] + ((b[1] - a[1]) * k) / steps;
        // 칸 경계에 걸친 필지도 잡히게 바로 옆 칸까지
        for (const dx of [-0.0003, 0, 0.0003]) for (const dy of [-0.0003, 0, 0.0003]) cells.add(`${Math.floor((x + dx) / size)},${Math.floor((y + dy) / size)}`);
      }
    }
  }
  if (cells.size > 400) throw new Error(`관망이 넓어 지적도 칸이 ${cells.size}개입니다. 구역을 나눠서(일부 관망만) 하세요.`);
  const list = [...cells].map((c) => c.split(',').map(Number));
  const byPnu = new Map<string, CadastralParcel>();
  let done = 0;
  const queue = [...list];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const box: [number, number, number, number] = [item[0] * size, item[1] * size, (item[0] + 1) * size, (item[1] + 1) * size];
      let page = 1;
      let pages: number;
      do {
        const r = await fetchBox(key, box, page);
        for (const p of r.parcels) if (p.pnu && !byPnu.has(p.pnu)) byPnu.set(p.pnu, p);
        pages = r.pages;
        page++;
      } while (page <= pages && page <= 10);
      onProgress?.(++done, list.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return [...byPnu.values()];
}
