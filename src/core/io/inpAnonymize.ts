/**
 * 발표용 보기: EPANET .inp 원문에서 지명·사업명이 드러날 수 있는 글을 지운다.
 * - [TITLE] 은 '발표용 관망' 한 줄로, [TAGS]·[LABELS]·[BACKDROP] 은 통째로 뺀다.
 * - 모든 줄의 주석(; 뒤)을 지운다.
 * - 한글 등 ASCII 가 아닌 글자가 들어간 ID(패턴·곡선·절점·관로 등)는 PAT1·CUR1·N1·L1 처럼 바꾸고, 쓰이는 모든 곳을 같이 바꾼다.
 * 숫자·영문 ID 와 순서·값은 그대로라 해석 결과는 원본과 같다.
 */

const NON_ASCII = /[^\x20-\x7e\t]/;

const DROP = new Set(['TAGS', 'LABELS', 'BACKDROP']);

const PREFIX: Record<string, string> = {
  JUNCTIONS: 'N',
  RESERVOIRS: 'N',
  TANKS: 'N',
  PIPES: 'L',
  PUMPS: 'L',
  VALVES: 'L',
  PATTERNS: 'PAT',
  CURVES: 'CUR',
};

export const PRESENT_TITLE = '발표용 관망';

export interface AnonymizeResult {
  text: string;
  /** 이름을 바꾼 ID 수 */
  renamed: number;
  /** 지운 주석 줄·주석 조각 수 */
  comments: number;
}

function sectionOf(line: string): string | null {
  const m = /^\s*\[([^\]]+)\]/.exec(line);
  return m ? m[1].trim().toUpperCase() : null;
}

export function anonymizeInp(text: string): AnonymizeResult {
  const lines = text.split(/\r?\n/);
  const used = new Set<string>();
  const map = new Map<string, string>();
  const counters: Record<string, number> = {};
  let comments = 0;

  // 1) 쓰인 토큰과 정의된 ID 모으기
  let section = '';
  const body: { section: string; data: string }[] = [];
  for (const raw of lines) {
    const s = sectionOf(raw);
    if (s !== null) {
      section = s;
      body.push({ section, data: `[${s}]` });
      continue;
    }
    const cut = raw.indexOf(';');
    if (cut >= 0 && raw.slice(cut + 1).trim() !== '') comments++;
    const data = cut >= 0 ? raw.slice(0, cut) : raw;
    body.push({ section, data });
    for (const t of data.trim().split(/\s+/)) if (t) used.add(t);
  }
  const fresh = (prefix: string): string => {
    let name: string;
    do name = `${prefix}${(counters[prefix] = (counters[prefix] ?? 0) + 1)}`;
    while (used.has(name));
    used.add(name);
    return name;
  };
  for (const { section: sec, data } of body) {
    const prefix = PREFIX[sec];
    if (!prefix || sec === 'TITLE') continue;
    const id = data.trim().split(/\s+/)[0];
    if (id && !id.startsWith('[') && NON_ASCII.test(id) && !map.has(id)) map.set(id, fresh(prefix));
  }

  // 2) 다시 쓰기
  const out: string[] = [];
  let skipping = false;
  for (const { section: sec, data } of body) {
    if (data.startsWith('[') && sectionOf(data) !== null) {
      skipping = DROP.has(sec);
      if (skipping) continue;
      out.push(data);
      if (sec === 'TITLE') out.push(PRESENT_TITLE);
      continue;
    }
    if (skipping || sec === 'TITLE') continue;
    if (data.trim() === '') {
      out.push('');
      continue;
    }
    out.push(
      data
        .split(/(\s+)/)
        .map((t) => {
          if (!t || /^\s+$/.test(t) || !NON_ASCII.test(t)) return t;
          let v = map.get(t);
          if (!v) {
            v = fresh('X');
            map.set(t, v);
          }
          return v;
        })
        .join('')
        .replace(/\s+$/, ''),
    );
  }
  return { text: out.join('\n'), renamed: map.size, comments };
}
