/**
 * 원형관 부분 충만 Manning 수리 함수 (SewerStudio design.py 와 동일한 연산 순서·반복 횟수).
 * SPEC §2 — 연산 순서를 바꾸면 끝자리가 달라질 수 있으므로 식을 단순화하지 말 것.
 */

/** 최대 유량 수심비 근사 (원형 단면). 정확한 출처는 원본에서도 미확인. */
export const MAX_FLOW_RATIO = 0.93818;

/** 원본(Python)이 ZeroDivisionError 를 내던 퇴화 입력(검증된 Project 에서는 나올 수 없음). */
export class SewerMathError extends Error {
  constructor(message = 'float division by zero') {
    super(message);
    this.name = 'SewerMathError';
  }
}

/** [단면적 A (m²), 동수반경 R (m)] — d: 관경(m), ratio: 수심/관경. ratio>1 은 만관으로 제한. */
export function section(diameter: number, ratio: number): [number, number] {
  if (ratio <= 0) return [0, 0];
  const theta = 2 * Math.acos(1 - 2 * Math.min(ratio, 1));
  const area = (diameter ** 2 / 8) * (theta - Math.sin(theta));
  const wetted = (diameter * theta) / 2;
  return [area, area / wetted];
}

/** Manning 유량 (m³/s). slope ≤ 0 이면 0. */
export function manning(diameter: number, slope: number, roughness: number, ratio = 1): number {
  if (slope <= 0) return 0;
  const [area, radius] = section(diameter, ratio);
  if (roughness === 0) throw new SewerMathError();
  return (area * radius ** (2 / 3) * Math.sqrt(slope)) / roughness;
}

/** 등류 수심비. q ≤ 0 → 0, 경사 ≤ 0 이거나 용량 초과 → 1 (압력류 해석이 아니라 표식). 이분법 55회. */
export function normalRatio(q: number, diameter: number, slope: number, roughness: number): number {
  if (q <= 0) return 0;
  if (slope <= 0 || q > manning(diameter, slope, roughness, MAX_FLOW_RATIO)) return 1;
  let lo = 0;
  let hi = MAX_FLOW_RATIO;
  for (let i = 0; i < 55; i++) {
    const mid = (lo + hi) / 2;
    if (manning(diameter, slope, roughness, mid) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 최대 충만율·최소 유속을 동시에 만족하는 데 필요한 경사 (m/m). 이분법 50회. */
export function requiredSlope(q: number, d: number, n: number, maxRatio: number, minVelocity: number): number {
  let ratio = maxRatio;
  if (q > 0 && minVelocity > 0 && section(d, ratio)[0] === 0) throw new SewerMathError();
  if (q > 0 && minVelocity > 0 && q / section(d, ratio)[0] < minVelocity) {
    let lo = 0;
    let hi = ratio;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (section(d, mid)[0] < q / minVelocity) lo = mid;
      else hi = mid;
    }
    ratio = (lo + hi) / 2;
  }
  const [a, r] = section(d, ratio);
  if (q && a * r ** (2 / 3) === 0) throw new SewerMathError();
  return q ? ((q * n) / (a * r ** (2 / 3))) ** 2 : 0;
}
