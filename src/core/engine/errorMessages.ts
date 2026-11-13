/** EPANET 오류·경고 코드의 한국어 설명과 조치 안내. */

export interface EngineMessage {
  title: string;
  hint: string;
}

const ERRORS: Record<number, EngineMessage> = {
  101: { title: '메모리가 부족합니다', hint: '관망 규모를 줄이거나 브라우저를 다시 시작한 뒤 시도하세요.' },
  102: { title: '해석할 관망 데이터가 없습니다', hint: '절점과 관로를 먼저 작성하세요.' },
  110: {
    title: '관망 수리방정식을 풀 수 없습니다 (System Unbalanced)',
    hint: '수원과 연결되지 않은 구역, 닫힌 관로·밸브로 고립된 수요 절점, 비현실적인 관경·조도 값을 확인하세요. 관망 검증을 먼저 실행하면 원인을 찾기 쉽습니다.',
  },
  200: { title: '입력 데이터에 오류가 있습니다', hint: '아래 상세 내용을 확인해 해당 객체의 속성을 수정하세요.' },
  201: { title: '입력 구문 오류', hint: '속성 값의 형식이 올바른지 확인하세요.' },
  202: { title: '잘못된 숫자 값', hint: '음수이거나 허용 범위를 벗어난 값이 있습니다.' },
  203: { title: '정의되지 않은 절점을 참조합니다', hint: '제어 규칙 등이 삭제된 절점을 참조하고 있는지 확인하세요.' },
  204: { title: '정의되지 않은 관로를 참조합니다', hint: '제어 규칙·상태 설정이 삭제된 관로를 참조하고 있는지 확인하세요.' },
  205: { title: '정의되지 않은 시간 패턴을 참조합니다', hint: '절점의 수요 패턴 ID 가 [PATTERNS] 에 있는지 확인하세요.' },
  206: { title: '정의되지 않은 곡선을 참조합니다', hint: '펌프 양정 곡선 또는 탱크 체적 곡선 ID 를 확인하세요.' },
  207: { title: '체크밸브를 제어하려는 설정이 있습니다', hint: 'CV 관로에는 상태 제어를 걸 수 없습니다.' },
  208: { title: '허용 범위를 벗어난 값', hint: '속성 값의 범위를 확인하세요.' },
  209: { title: '잘못된 절점 속성 값', hint: '표고·수위·직경 등의 값을 확인하세요.' },
  211: { title: '잘못된 링크 속성 값', hint: '관경·연장·조도계수는 0 보다 커야 합니다.' },
  212: { title: '정의되지 않은 추적 절점', hint: '수질 추적 절점 ID 를 확인하세요.' },
  213: { title: '잘못된 해석 옵션 값', hint: '해석 옵션(단위, 공식, 시간 간격)을 확인하세요.' },
  214: { title: '입력 줄이 너무 깁니다', hint: '한 줄의 글자 수를 줄이세요.' },
  215: { title: 'ID 가 중복되었습니다', hint: '같은 ID 를 가진 절점 또는 관로가 있습니다.' },
  216: { title: '정의되지 않은 펌프에 에너지 데이터가 지정되었습니다', hint: '[ENERGY] 섹션을 확인하세요.' },
  217: { title: '잘못된 펌프 에너지 데이터', hint: '[ENERGY] 섹션을 확인하세요.' },
  219: { title: '밸브가 수원지/배수지에 직접 연결되어 있습니다', hint: 'PRV·PSV·FCV 는 수원지/배수지에 바로 연결할 수 없습니다. 사이에 절점과 짧은 관로를 추가하세요.' },
  220: { title: '밸브끼리 잘못 연결되어 있습니다', hint: '두 제어 밸브가 같은 절점을 공유하는 배치를 확인하세요.' },
  221: { title: '규칙 기반 제어 구문 오류', hint: '[RULES] 섹션을 확인하세요.' },
  222: { title: '시점과 종점이 같은 링크가 있습니다', hint: '관망 검증에서 자기 연결 관로를 찾아 삭제하세요.' },
  223: { title: '절점 수가 부족합니다', hint: '해석하려면 절점이 2개 이상 필요합니다.' },
  224: { title: '수원지 또는 배수지가 없습니다', hint: '수원지(Reservoir)나 배수지(Tank)를 1개 이상 추가하세요.' },
  225: { title: '배수지 수위 범위가 잘못되었습니다', hint: '최저수위 ≤ 초기수위 ≤ 최고수위 인지 확인하세요.' },
  226: { title: '펌프 곡선 또는 동력이 지정되지 않았습니다', hint: '펌프에 양정 곡선(HEAD)이나 동력(POWER)을 지정하세요.' },
  227: { title: '잘못된 펌프 양정 곡선', hint: '유량이 증가할수록 양정이 감소하는 곡선이어야 합니다.' },
  230: { title: '곡선의 X 값이 증가하지 않습니다', hint: '곡선 점을 X 값 오름차순으로 입력하세요.' },
  233: { title: '어떤 관로와도 연결되지 않은 절점이 있습니다', hint: '관망 검증의 고립 절점 항목을 확인해 삭제하거나 관로를 연결하세요.' },
  302: { title: '입력 파일을 열 수 없습니다', hint: '다시 시도하세요.' },
  303: { title: '보고서 파일을 열 수 없습니다', hint: '다시 시도하세요.' },
};

const WARNINGS: Record<number, EngineMessage> = {
  1: {
    title: '수리적 불평형 (System Unbalanced)',
    hint: '허용 반복 횟수 안에 수렴하지 못했습니다. 결과가 부정확할 수 있으니 닫힌 밸브·펌프 조건과 관망 연결을 확인하세요.',
  },
  2: { title: '수리적으로 불안정할 수 있습니다', hint: '밸브·펌프 상태가 반복해서 바뀌고 있습니다. 제어 조건을 확인하세요.' },
  3: { title: '관망이 단절되었습니다', hint: '일부 절점에 물을 공급할 수 없습니다. 닫힌 관로·밸브와 단절 구역을 확인하세요.' },
  4: { title: '펌프가 필요한 유량·양정을 내지 못합니다', hint: '펌프 곡선 범위를 벗어났습니다. 펌프 용량과 운전점을 확인하세요.' },
  5: { title: '밸브가 설정 유량을 공급하지 못합니다', hint: 'FCV 설정값과 상류 수압을 확인하세요.' },
  6: {
    title: '음압(Negative Pressure) 발생',
    hint: '수요가 있는 절점에서 수압이 0 미만입니다. 수원 수두, 관경, 표고 입력을 확인하세요.',
  },
};

export function describeEngineError(code: number | null): EngineMessage {
  if (code !== null && ERRORS[code]) return ERRORS[code];
  return {
    title: code !== null ? `EPANET 오류 ${code}` : '수리해석 중 오류가 발생했습니다',
    hint: '해석 로그의 상세 내용을 확인하세요.',
  };
}

export function describeEngineWarning(code: number): EngineMessage {
  return WARNINGS[code] ?? { title: `EPANET 경고 ${code}`, hint: '해석 로그를 확인하세요.' };
}

/** 보고서 파일에서 오류 줄과 그 대상 줄을 뽑아낸다. */
export function extractReportErrors(report: string, limit = 20): string[] {
  const lines = report.split(/\r?\n/);
  const found: string[] = [];
  for (let i = 0; i < lines.length && found.length < limit; i++) {
    const line = lines[i].trim();
    if (!/error\s+\d+/i.test(line)) continue;
    const next = (lines[i + 1] ?? '').trim();
    // "Input Error 203: ... in [PIPES] section:" 다음 줄에 문제의 원문이 온다.
    found.push(line.endsWith(':') && next ? `${line} ${next}` : line);
  }
  return found;
}

/** 보고서의 오류 줄에서 문제 객체로 추정되는 ID 를 찾는다. */
export function extractObjectIds(reportErrors: string[]): string[] {
  const ids = new Set<string>();
  for (const line of reportErrors) {
    const match = /(?:node|link|pipe|pump|valve|junction|tank|reservoir)\s+(\S+?)(?=[\s,.:]|$)/gi;
    for (const m of line.matchAll(match)) {
      if (!/^(in|is|has|to|a|an|the)$/i.test(m[1])) ids.add(m[1]);
    }
  }
  return [...ids];
}
