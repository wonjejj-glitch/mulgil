/**
 * SWMM 5.2 WebAssembly 실행 (패키지 @fileops/swmm-wasm-web, Worker·Node 테스트 공용).
 *
 * 이 패키지는 'web' 환경용 Emscripten 빌드라서 window/document 가 있어야 로드된다.
 * 모듈 Worker 에는 둘 다 없으므로 최소한의 값만 채워 둔 뒤 동적으로 불러온다. WASM 은 JS 안에 내장되어 있다.
 */
import { parseSwmmOut, type SwmmOutput } from './outReader';

interface SwmmModule {
  FS: {
    writeFile(path: string, data: string | Uint8Array): void;
    readFile(path: string, options?: { encoding?: 'utf8' }): Uint8Array & string;
    unlink(path: string): void;
  };
  ccall(name: string, returnType: string, argTypes: string[], args: unknown[]): number;
}

type CreateModule = (options?: Record<string, unknown>) => Promise<SwmmModule>;

export interface SwmmRunResult {
  output: SwmmOutput;
  /** 엔진이 만든 보고서(.rpt) 전문 — 연속방정식 오차·월류 요약 등. */
  report: string;
  /** 엔진 이름과 버전 (보고서 머리글에서 읽음). */
  engineVersion: string;
}

export class SwmmRunError extends Error {
  code: number;
  report: string;
  constructor(message: string, code: number, report: string) {
    super(message);
    this.name = 'SwmmRunError';
    this.code = code;
    this.report = report;
  }
}

let modulePromise: Promise<CreateModule> | null = null;

/**
 * 직접 빌드한 EPA SWMM 5.2.4 (GitHub Actions 가 공식 소스를 Emscripten 으로 컴파일해 engine/swmm5.mjs 로 넣는다).
 * 파일이 없으면(로컬 개발 PC 등) 빈 객체라 아래 패키지(5.2.2)로 대신한다.
 */
const builtEngine = import.meta.glob<{ default: CreateModule }>('./engine/swmm5.mjs');

async function loadFactory(): Promise<CreateModule> {
  const built = Object.values(builtEngine)[0];
  if (built) return (await built()).default;
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  g.window ??= globalThis;
  g.document ??= { currentScript: { src: '' } };
  const imported = (await import('@fileops/swmm-wasm-web')) as unknown as { default?: unknown };
  const factory = (imported.default ?? imported) as CreateModule;
  if (typeof factory !== 'function') throw new Error('SWMM WASM 모듈을 불러오지 못했습니다.');
  return factory;
}

export async function runSwmm(inp: string): Promise<SwmmRunResult> {
  modulePromise ??= loadFactory();
  const factory = await modulePromise;
  // 모듈 인스턴스는 한 번 쓰고 버린다 (파일 시스템과 전역 상태를 깨끗하게 유지).
  const swmm = await factory();
  swmm.FS.writeFile('model.inp', inp);
  const code = swmm.ccall('swmm_run', 'number', ['string', 'string', 'string'], ['model.inp', 'model.rpt', 'model.out']);
  let report = '';
  try {
    report = swmm.FS.readFile('model.rpt', { encoding: 'utf8' });
  } catch {
    // 보고서가 아직 없을 수 있다.
  }
  if (code !== 0) {
    // 0 이 아니면 오류다 (200번대 입력 오류, 300번대 파일 오류 등). 경고는 보고서에만 남는다.
    const line = /ERROR\s+\d+[^\n]*(?:\n[^\n]*)?/.exec(report)?.[0]?.replace(/\s+/g, ' ').trim();
    throw new SwmmRunError(line ?? `SWMM 해석 실패 (오류 ${code})`, code, report);
  }
  const output = parseSwmmOut(swmm.FS.readFile('model.out'));
  const engineVersion = /VERSION\s+([\d.]+)\s*(\(Build [\d.]+\))?/i.exec(report);
  return { output, report, engineVersion: engineVersion ? `${engineVersion[1]} ${engineVersion[2] ?? ''}`.trim() : '5.x' };
}
