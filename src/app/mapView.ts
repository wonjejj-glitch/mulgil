/** 지금 지도 화면 범위 (경위도 [서, 남, 동, 북]). 지도가 움직일 때 GisMapCanvas 가 갱신한다 — 렌더링과 무관한 값이라 스토어에 두지 않는다. */
let view: [number, number, number, number] | null = null;
/** 살아 있는 지도에서 범위를 바로 읽는 함수 (지도가 아직 그려지지 않아 이동 이벤트가 없어도 동작). */
let reader: (() => [number, number, number, number] | null) | null = null;

export function setViewReader(fn: (() => [number, number, number, number] | null) | null): void {
  reader = fn;
}

export function setViewBounds(b: [number, number, number, number]): void {
  view = b;
}

export function getViewBounds(): [number, number, number, number] | null {
  try {
    return reader?.() ?? view;
  } catch {
    return view;
  }
}
