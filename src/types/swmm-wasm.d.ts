/** @fileops/swmm-wasm-web 은 타입 정의가 없다. 실제 사용 형태는 core/swmm/swmmRunner.ts 에서 좁혀 쓴다. */
declare module '@fileops/swmm-wasm-web' {
  const createModule: (options?: Record<string, unknown>) => Promise<unknown>;
  export default createModule;
}
