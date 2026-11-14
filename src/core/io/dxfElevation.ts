/**
 * 수치지형도 DXF 에서 표고 자료(표고점·등고선)를 읽는다.
 * - 표고점: POINT / INSERT / TEXT 의 Z 좌표(코드 30), 또는 Z 가 0 인 TEXT 의 문자열 숫자(표고 주기)
 * - 등고선: LWPOLYLINE 의 고도(코드 38), POLYLINE→VERTEX 의 Z, LINE 의 Z
 * 레이어 이름에 등고선·표고점 코드(7111 주곡선, 7114 계곡선, 7121·7217 표고점 등)가 있으면 그 레이어만 쓴다
 * (건물 높이 같은 다른 Z 값이 섞이지 않게). 그런 레이어가 없으면 Z 가 있는 모든 객체를 쓴다.
 */

export interface DxfElevation {
  xy: [number, number];
  z: number;
  layer: string;
  /** 등고선이면 같은 선의 순번 (선 위 보간용). 점이면 -1 */
  line: number;
}

const TERRAIN_LAYER = /(711[0-9]|712[0-9]|721[0-9]|7217|contour|등고|표고|elev)/i;

/** DXF 텍스트를 (코드, 값) 쌍으로 나눈다. */
function pairs(text: string): [number, string][] {
  const lines = text.split(/\r?\n/);
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isFinite(code)) {
      i -= 1; // 어긋난 줄은 한 줄 건너 다시 맞춘다
      continue;
    }
    out.push([code, lines[i + 1].trim()]);
  }
  return out;
}

export function parseDxfElevations(text: string): { points: DxfElevation[]; layers: string[]; usedTerrainLayers: boolean } {
  const p = pairs(text);
  // ENTITIES 구간만
  let start = p.findIndex(([c, v], i) => c === 2 && v.toUpperCase() === 'ENTITIES' && p[i - 1]?.[1].toUpperCase() === 'SECTION');
  if (start < 0) start = 0;
  const all: DxfElevation[] = [];
  let lineNo = 0;
  let i = start + 1;
  const num = (v: string) => Number(v);

  while (i < p.length) {
    const [code, value] = p[i];
    if (code !== 0) {
      i++;
      continue;
    }
    const type = value.toUpperCase();
    if (type === 'ENDSEC') break;
    // 엔티티 하나의 그룹 코드를 모은다
    let j = i + 1;
    const groups: [number, string][] = [];
    while (j < p.length && p[j][0] !== 0) groups.push(p[j++]);
    const layer = groups.find((g) => g[0] === 8)?.[1] ?? '0';
    const first = (c: number) => {
      const g = groups.find((x) => x[0] === c);
      return g ? num(g[1]) : NaN;
    };

    if (type === 'POINT' || type === 'INSERT' || type === 'TEXT' || type === 'MTEXT') {
      const x = first(10), y = first(20);
      let z = first(30);
      if ((!Number.isFinite(z) || z === 0) && (type === 'TEXT' || type === 'MTEXT')) {
        const t = groups.find((g) => g[0] === 1)?.[1].replace(/\\[A-Za-z][^;]*;|[{}]/g, '').trim() ?? '';
        z = /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
      }
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && z !== 0) all.push({ xy: [x, y], z, layer, line: -1 });
    } else if (type === 'LWPOLYLINE') {
      const z = first(38);
      if (Number.isFinite(z) && z !== 0) {
        const id = lineNo++;
        let x = NaN;
        for (const [c, v] of groups) {
          if (c === 10) x = num(v);
          else if (c === 20 && Number.isFinite(x)) {
            all.push({ xy: [x, num(v)], z, layer, line: id });
            x = NaN;
          }
        }
      }
    } else if (type === 'LINE') {
      const z1 = first(30), z2 = first(31);
      const id = lineNo++;
      if (Number.isFinite(z1) && z1 !== 0) all.push({ xy: [first(10), first(20)], z: z1, layer, line: id });
      if (Number.isFinite(z2) && z2 !== 0) all.push({ xy: [first(11), first(21)], z: z2, layer, line: id });
    } else if (type === 'POLYLINE') {
      // 뒤따르는 VERTEX 들을 SEQEND 까지 읽는다
      const id = lineNo++;
      const elev = first(30);
      while (j < p.length && p[j][0] === 0 && p[j][1].toUpperCase() === 'VERTEX') {
        let k = j + 1;
        const vg: [number, string][] = [];
        while (k < p.length && p[k][0] !== 0) vg.push(p[k++]);
        const get = (c: number) => {
          const g = vg.find((x) => x[0] === c);
          return g ? num(g[1]) : NaN;
        };
        const z = Number.isFinite(get(30)) && get(30) !== 0 ? get(30) : elev;
        if (Number.isFinite(get(10)) && Number.isFinite(get(20)) && Number.isFinite(z) && z !== 0) all.push({ xy: [get(10), get(20)], z, layer, line: id });
        j = k;
      }
    }
    i = j;
  }

  const layers = [...new Set(all.map((e) => e.layer))];
  const terrain = all.filter((e) => TERRAIN_LAYER.test(e.layer));
  const usedTerrainLayers = terrain.length > 0;
  const points = (usedTerrainLayers ? terrain : all).filter((e) => Number.isFinite(e.xy[0]) && Number.isFinite(e.xy[1]));
  return { points, layers: usedTerrainLayers ? [...new Set(terrain.map((e) => e.layer))] : layers, usedTerrainLayers };
}
