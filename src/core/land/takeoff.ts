/**
 * 용지(편입토지) 조서·용지도 계산 (순수 함수). 좌표는 평면 좌표(m, 예: EPSG:5187).
 *
 * 관로마다 '편입 폭'만큼의 띠(관로 중심선 ± 폭/2)를 만들고, 필지 다각형과 겹치는 면적을 필지별로 더한다.
 *  - 꺾이는 점에서는 두 띠를 각의 이등분선으로 잘라(마이터) 겹치거나 빈 곳이 없게 한다.
 *  - 띠 조각(볼록 사각형)으로 필지 다각형을 자르는 데 Sutherland–Hodgman 을 쓴다(필지가 오목해도 면적은 맞다).
 *  - 서로 다른 관로가 만나는 분기점의 아주 작은 겹침은 따로 빼지 않는다(개략 조서).
 * 지번 끝 글자가 지목이다(예: '1163도' → 도로). 소유자는 공개 자료에 없어 빈칸으로 둔다.
 */

export type XY = [number, number];

export interface Parcel {
  pnu: string;
  /** 지번 (지목 글자 포함, 예: '1163도', '45-2대') */
  jibun: string;
  addr: string;
  /** 공시지가 (원/m²), 모르면 0 */
  price: number;
  /** 공시 기준 연월 (예: '2025.01') */
  priceDate: string;
  /** 다각형들 (각각 [바깥 고리, 구멍…]) */
  polygons: XY[][][];
}

export interface Route {
  id: string;
  /** 중심선 꼭짓점 */
  path: XY[];
  /** 편입 폭 (m) */
  width: number;
}

/** 지목 약어 → 이름 (지번 끝 한 글자). */
const JIMOK: Record<string, string> = {
  전: '전', 답: '답', 과: '과수원', 목: '목장용지', 임: '임야', 광: '광천지', 염: '염전', 대: '대', 장: '공장용지', 학: '학교용지',
  차: '주차장', 주: '주유소용지', 창: '창고용지', 도: '도로', 철: '철도용지', 제: '제방', 천: '하천', 구: '구거', 유: '유지', 양: '양어장',
  수: '수도용지', 공: '공원', 체: '체육용지', 원: '유원지', 종: '종교용지', 사: '사적지', 묘: '묘지', 잡: '잡종지',
};

export function jimokOf(jibun: string): { code: string; name: string } {
  const last = jibun.trim().slice(-1);
  return JIMOK[last] ? { code: last, name: JIMOK[last] } : { code: '', name: '' };
}

/** 지목이 도로·하천·구거·제방·철도처럼 공공용지인지 (사유지 보상 대상과 구분하는 참고값). */
export function isPublicJimok(code: string): boolean {
  return ['도', '천', '구', '제', '철', '수', '유'].includes(code);
}

/* ------------------------------------------------------------------ 기하 */

export function ringArea(ring: XY[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

export function polygonArea(polygon: XY[][]): number {
  if (polygon.length === 0) return 0;
  let a = Math.abs(ringArea(polygon[0]));
  for (const hole of polygon.slice(1)) a -= Math.abs(ringArea(hole));
  return Math.max(0, a);
}

/** 볼록 다각형(clip, 반시계)으로 다각형(subject)을 자른다 — Sutherland–Hodgman. */
export function clipConvex(subject: XY[], clip: XY[]): XY[] {
  let out = subject;
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const inside = (p: XY) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const cross = (p: XY, q: XY): XY => {
      const x1 = p[0], y1 = p[1], x2 = q[0], y2 = q[1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const den = (x2 - x1) * dy - (y2 - y1) * dx;
      const t = den === 0 ? 0 : ((a[0] - x1) * dy - (a[1] - y1) * dx) / den;
      return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
    };
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k++) {
      const cur = input[k], prev = input[(k + input.length - 1) % input.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cross(prev, cur));
        out.push(cur);
      } else if (pi) out.push(cross(prev, cur));
    }
  }
  return out;
}

const sub = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]];
const add = (a: XY, b: XY): XY => [a[0] + b[0], a[1] + b[1]];
const mul = (a: XY, k: number): XY => [a[0] * k, a[1] * k];
const len = (a: XY) => Math.hypot(a[0], a[1]);
const unit = (a: XY): XY => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l] : [0, 0];
};
const left = (d: XY): XY => [-d[1], d[0]];

/**
 * 관로 띠를 조각(볼록 사각형, 반시계)으로 나눈다. 꺾이는 점은 이등분선으로 잘라 겹침·틈이 없다.
 * 아주 급하게 꺾이면(마이터가 폭의 4배 넘게 길어지면) 그 점에서 띠를 끊는다.
 */
export function corridorPieces(path: XY[], width: number): XY[][] {
  const pts = path.filter((p, i) => i === 0 || len(sub(p, path[i - 1])) > 1e-6);
  if (pts.length < 2 || width <= 0) return [];
  const h = width / 2;
  const dirs = pts.slice(1).map((p, i) => unit(sub(p, pts[i])));
  // 각 꼭짓점의 좌우 오프셋 점
  const offs = pts.map((p, i): { l: XY; r: XY } => {
    if (i === 0 || i === pts.length - 1) {
      const n = left(dirs[Math.min(i, dirs.length - 1)]);
      return { l: add(p, mul(n, h)), r: sub(p, mul(n, h)) };
    }
    const n1 = left(dirs[i - 1]), n2 = left(dirs[i]);
    const m = unit(add(n1, n2));
    const cos = m[0] * n1[0] + m[1] * n1[1];
    if (cos < 0.25) {
      // 너무 급한 꺾임: 앞 조각 기준으로 끊는다
      return { l: add(p, mul(n1, h)), r: sub(p, mul(n1, h)) };
    }
    const k = h / cos;
    return { l: add(p, mul(m, k)), r: sub(p, mul(m, k)) };
  });
  const pieces: XY[][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    // 반시계: 시작 오른쪽 → 끝 오른쪽 → 끝 왼쪽 → 시작 왼쪽
    const quad: XY[] = [offs[i].r, offs[i + 1].r, offs[i + 1].l, offs[i].l];
    if (ringArea(quad) > 1e-9) pieces.push(quad);
  }
  return pieces;
}

/* ------------------------------------------------------------------ 조서 */

export interface TakeoffRow {
  pnu: string;
  addr: string;
  jibun: string;
  jimok: string;
  /** 도로·하천 등 공공용지 지목인지 */
  isPublic: boolean;
  parcelArea: number;
  takenArea: number;
  price: number;
  priceDate: string;
  /** 개략 보상비 = 편입 면적 × 공시지가 × 배율 (원) */
  cost: number;
  /** 이 필지를 지나는 관로 ID */
  routes: string[];
  /** 잘린 조각 (용지도용) */
  pieces: XY[][];
}

export interface TakeoffResult {
  rows: TakeoffRow[];
  totalTaken: number;
  publicTaken: number;
  privateTaken: number;
  totalCost: number;
  /** 필지 밖(지적 자료가 없는 곳)으로 나간 띠 면적 */
  uncovered: number;
  corridorArea: number;
}

function bbox(points: XY[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}
const overlaps = (a: number[], b: number[]) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** 관로 띠와 필지를 겹쳐 필지별 편입 면적·개략 보상비를 낸다. priceFactor: 공시지가에 곱할 배율(보상 개략용). */
export function landTakeoff(parcels: Parcel[], routes: Route[], priceFactor = 1): TakeoffResult {
  const pieces = routes.flatMap((r) => corridorPieces(r.path, r.width).map((q) => ({ q, id: r.id, box: bbox(q) })));
  const corridorArea = pieces.reduce((s, p) => s + Math.abs(ringArea(p.q)), 0);
  const rows: TakeoffRow[] = [];
  for (const parcel of parcels) {
    const pbox = bbox(parcel.polygons.flatMap((p) => p[0] ?? []));
    let taken = 0;
    const ids = new Set<string>();
    const cut: XY[][] = [];
    for (const piece of pieces) {
      if (!overlaps(pbox, piece.box)) continue;
      let a = 0;
      for (const poly of parcel.polygons) {
        if (poly.length === 0) continue;
        const outer = clipConvex(poly[0], piece.q);
        let pa = Math.abs(ringArea(outer));
        if (pa < 1e-6) continue;
        for (const hole of poly.slice(1)) pa -= Math.abs(ringArea(clipConvex(hole, piece.q)));
        if (pa > 1e-6) {
          a += pa;
          cut.push(outer);
        }
      }
      if (a > 1e-6) {
        taken += a;
        ids.add(piece.id);
      }
    }
    if (taken < 0.01) continue;
    const { code, name } = jimokOf(parcel.jibun);
    const parcelArea = parcel.polygons.reduce((s, p) => s + polygonArea(p), 0);
    rows.push({
      pnu: parcel.pnu,
      addr: parcel.addr,
      jibun: parcel.jibun,
      jimok: name || code,
      isPublic: isPublicJimok(code),
      parcelArea,
      takenArea: Math.min(taken, parcelArea),
      price: parcel.price,
      priceDate: parcel.priceDate,
      cost: Math.min(taken, parcelArea) * parcel.price * priceFactor,
      routes: [...ids],
      pieces: cut,
    });
  }
  rows.sort((a, b) => a.addr.localeCompare(b.addr, 'ko', { numeric: true }));
  const totalTaken = rows.reduce((s, r) => s + r.takenArea, 0);
  const publicTaken = rows.filter((r) => r.isPublic).reduce((s, r) => s + r.takenArea, 0);
  return {
    rows,
    totalTaken,
    publicTaken,
    privateTaken: totalTaken - publicTaken,
    totalCost: rows.filter((r) => !r.isPublic).reduce((s, r) => s + r.cost, 0),
    uncovered: Math.max(0, corridorArea - totalTaken),
    corridorArea,
  };
}

/** 편입토지조서 CSV (엑셀용 BOM). 소유자·비고는 빈칸으로 둔다. */
export function takeoffCsv(result: TakeoffResult, title: string): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [
    `${title} 편입토지조서 (개략),,,,,,,,,,,,`,
    '번호,소재지,지번,지목,공부면적(m²),편입면적(m²),편입비율(%),공시지가(원/m²),공시기준,개략보상비(원),구분,지나는 관로,소유자,비고',
  ];
  result.rows.forEach((r, i) => {
    lines.push(
      [
        String(i + 1),
        q(r.addr),
        q(r.jibun),
        r.jimok,
        r.parcelArea.toFixed(1),
        r.takenArea.toFixed(2),
        r.parcelArea > 0 ? ((r.takenArea / r.parcelArea) * 100).toFixed(1) : '',
        String(r.price || ''),
        r.priceDate,
        r.isPublic ? '' : String(Math.round(r.cost)),
        r.isPublic ? '공공용지(도로 등)' : '사유지 등',
        q(r.routes.slice(0, 8).join(' ') + (r.routes.length > 8 ? ' …' : '')),
        '',
        '',
      ].join(','),
    );
  });
  lines.push(
    '',
    `합계,,,,,${result.totalTaken.toFixed(2)},,,,${Math.round(result.totalCost)},,,,`,
    `공공용지 편입,,,,,${result.publicTaken.toFixed(2)},,,,,,,,`,
    `사유지 등 편입,,,,,${result.privateTaken.toFixed(2)},,,,,,,,`,
    '',
    '※ 개략 조서입니다. 면적은 연속지적도(브이월드) 기준이며 공부(토지대장) 면적과 다를 수 있습니다. 보상비는 공시지가 × 배율의 참고값이며 감정평가액이 아닙니다. 소유자는 토지대장으로 채우세요.',
  );
  return String.fromCharCode(0xfeff) + lines.join('\n') + '\n';
}
