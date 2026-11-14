# AGENTS.md — 물길(Mulgil) 인수인계 안내

> 2026-11-13 표시 이름을 OpenGISpipe → **물길(Mulgil)** 로 바꿨다. CLAUDE.md(최초 스펙)와 `.claude/launch.json` 설정 이름에는 옛 이름이 남아 있다.

이 파일은 어떤 AI 코딩 도구(Codex, Cursor, Gemini CLI, Copilot 등)로 이 폴더를 열어도 바로 이어서 개발할 수 있도록
현재 상태와 작업 규칙을 정리한 것이다. **제품 요구사항(스펙)은 `CLAUDE.md` 에 있으므로 반드시 함께 읽는다.**
이 파일은 "지금 코드가 실제로 어떻게 되어 있는가"를 다룬다.

## 1. 한눈에 보기

상수관망을 웹 브라우저에서 작도·검증·수리해석(EPANET)하고 지도 위에 시각화하는 React 앱이다.
서버는 없고, 해석 엔진(WASM)은 Web Worker 에서 돈다.

실제 설치된 주요 버전 (`package.json` 기준):

| 영역 | 패키지 |
|---|---|
| 빌드/언어 | Vite 8, TypeScript 6 (strict), React 19 |
| 상태 | zustand 5, immer 11 |
| 지도 | maplibre-gl **5.x 고정**, react-map-gl 8 (`react-map-gl/maplibre`), deck.gl 9 (`@deck.gl/mapbox` 의 `MapboxOverlay`, overlaid 모드) |
| 공간연산 | @turf/turf 7, proj4 |
| 엔진 | epanet-js 0.9 (OWA-EPANET 2.3 WASM 내장) |
| UI | Tailwind CSS 4 (`@tailwindcss/vite`), lucide-react 1.x, recharts 3 |
| 테스트/린트 | Vitest 5 (node 환경), ESLint 10 + typescript-eslint |

## 2. 실행·검증 명령

```bash
npm install
npm run dev        # http://localhost:5173 (포트 고정)
npm run typecheck
npm run lint
npm run test       # Vitest — 파서, 좌표 변환, 엔진(WASM), 검증·자동 보정
npm run build
```

- 코드를 고친 뒤에는 **typecheck → lint → test** 를 반드시 통과시킨다. UI 를 고쳤으면 dev 서버로 실제 동작도 확인한다.
- Windows 참고: Node 24 LTS 가 `C:\Program Files\nodejs` 에 설치되어 있다. 도구의 셸이 `node`/`npm` 을 찾지 못하면
  PowerShell 에서 명령 앞에 `$env:Path = "$env:ProgramFiles\nodejs;$env:APPDATA\npm;$env:Path";` 를 붙인다.
- 이 폴더는 아직 git 저장소가 아니다 (git 미설치). 버전 관리가 필요하면 git 설치 후 `git init` 부터 한다.

## 3. 현재 상태

CLAUDE.md 의 Phase 1~4 가 구현되어 있고, 아래 흐름은 브라우저에서 직접 확인했다.

- 4분할 워크스페이스(상단 툴바 / 좌측 레이어 / 중앙 지도 + 하단 도크 / 우측 속성), 배경지도 전환(OSM·위성·브이월드), 커서 경위도·EPSG:5186 좌표 표시
- 작도: 절점·수원지·배수지 추가, 관로·펌프·밸브 그리기(꺾임점, 절점 스냅, 더블클릭 완료, 이어 그리기), 관로 위 클릭으로 분할, 절점 끌어 이동(연장 자동 재계산)
- EPANET `.inp` 입출력(좌표계 자동 감지: WGS84 / EPSG:5186·5179 / 임의 평면), GeoJSON 입출력, 드래그 앤 드롭, 불러온 뒤 자동 줌
- 속성 편집, ID 변경, Undo/Redo (Ctrl+Z / Ctrl+Y)
- 수리해석: Worker 에서 EPANET 실행 → 시간 스텝별 수압·수두·수요량·유량·유속·손실수두, 색상 주제도와 범례, 유향 화살표, 시간 슬라이더·재생, 시계열 차트, 3D 수압 기둥
- 해석 오류·경고의 한국어 안내와 문제 절점 강조
- 관망 검증: 수원 없음, 단절 구역, 고립 절점, 자기 연결, 중복 관로, 미소 관로, 교차 미분할(X), T자 미연결 → 목록 클릭 시 지도 이동·강조, 일괄 자동 보정(Undo 한 단계),
  항목별 '선택'·'단절 구역 n곳 선택' → 다중 선택으로 넘겨 한 번에 삭제
- 수질 해석: 물질 농도(잔류염소 등)·수령·수원 추적. 수리·수질을 한 스텝씩 동시에 진행(`epanetRunner.ts`).
  해석 옵션 대화상자의 '수질 해석' 그룹(종류·물질·단위·전역 반응계수·수질 계산 간격), 절점별 초기 수질·유입원(우측 패널),
  수질 주제도(잔류염소는 0.1/0.2/1.0/4.0 mg/L 기준 색), 시계열 차트, 결과 표, 말단 잔류염소 0.1 mg/L 미만 경고 토스트
- 종단면도(하단 '종단면도' 탭, 도구 G): 경유 절점을 클릭하면 관로 연장 기준 최단 경로(Dijkstra)의 지반고·동수두선·시간대 수두 범위·최소 수압선
- 급수구역: 주제도 '급수구역'(절점·관로) — 현재 시각 유량 방향을 따라 수원별 기여율을 섞어(Kahn 위상 정렬) 주 공급 수원으로 색칠,
  80% 미만은 '혼합'. 선택 절점의 수원별 기여율 막대(우측 패널)
- 다중 선택: 구역 선택 도구(A, 다각형), Ctrl/Shift+클릭 토글, Ctrl+A 전체 → 우측 패널에서 표고·수요량·패턴·수요 배율·관경·조도·상태 일괄 편집, 일괄 삭제(Undo 한 단계)
- 데이터 메뉴: 펌프·배수지 곡선 편집(표+미리보기 차트, 형식 검사, 이름 변경 시 참조 갱신), 단순 제어 작성기 + [CONTROLS]/[RULES] 원문 편집과 참조 검사,
  수요 패턴 이름 변경·빈 패턴 추가(해석 옵션 대화상자)
- 결과 표(하단 '결과 표' 탭): 절점/링크, 정렬·ID 검색·기준 밖 값만 보기, 현재 시각 CSV / 전체 시계열 CSV(UTF-8 BOM, 엑셀 호환)
- Shapefile 가져오기: .shp+.dbf(+.prj/.cpg) 여러 개를 함께 선택하거나 .zip 하나로. 의존성 없는 자체 파서(`core/io/shapefile.ts`, `zip.ts`),
  .prj 로 EPSG:5179/5185~5188/5174·경위도 판별, .cpg 없으면 UTF-8→CP949 자동 판별, 선 레이어 = 관로, 점 레이어 = 절점(표고 속성)
- 객체 ID 변경 시 [CONTROLS]/[RULES]/[DEMANDS]/[REACTIONS] 등 원문 섹션 안의 참조와 추적 절점도 함께 바뀐다(`renameInSections`)
- 소화용수 분석(데이터 메뉴): 분석 시각(기본 최대 수요 시각)의 정상 상태에서 절점마다 소화 유량(기본 1 m³/분)을 하나씩 더해
  잔류 수압·관망 최저 수압을 계산(`core/engine/fireFlow.ts`, Worker 의 'fireflow' 요청). 배수지 수위는 기간 해석 결과의 그 시각 값. 미달 절점 지도 표시, CSV
- 우수·하수관망(SWMM 5.2.2) 보기·해석: SWMM .inp 를 열면(`looksLikeSwmm`) 우수·하수 모드로 전환 — 지도에 유역 다각형·절점·관거를 그리고
  `swmm.worker.ts` 에서 `@fileops/swmm-wasm-web`(5.2.2 Build) 으로 해석, 결과 .out 을 `outReader.ts` 로 읽어 수심 비율·충만도 색, 유향 화살표, 시계열·결과 표·엔진 보고서,
  월류·연속방정식 오차 경고를 보여 준다. **읽기 전용**: 원문 텍스트를 그대로 엔진에 넘기고 편집 기능은 없다. 우측 패널 ✕ 로 상수관망으로 돌아간다. 샘플 `public/samples/sample-sewer.inp`.
- 번들: 대화상자는 `App.tsx` 의 `ModalHost` 에서 `React.lazy` 로 처음 열 때 불러오고, 큰 라이브러리는 `vite.config.ts` 의 `manualChunks` 로 분리한다(앱 코드 약 175 KB).

검증 상태: `typecheck` 0건, `lint` 0건, `test` 55개 통과, `build` 성공.

아직 없는 것 (스펙에는 있거나 언급된 것):

- 우수·하수관망(SWMM) 엔진
- [ENERGY]/[EMITTERS]/[MIXING] 등은 원문 보존만 하고 편집 UI 가 없다.
- E2E(브라우저) 자동 테스트 — 개발 서버에서는 `window.__ogp`(스토어)·`window.__ogpMap`(MapLibre 지도)이 노출되어 있어 Playwright 등에서 바로 쓸 수 있다.

## 4. 코드 지도

```text
src/
├── App.tsx, main.tsx, index.css, config.ts   # 레이아웃 조립, 전역 단축키, 드래그 앤 드롭, 앱 이름(APP_NAME)
├── app/actions.ts                # 여러 스토어에 걸친 동작: 파일 열기/저장, 해석 실행, 검증, 자동 보정
├── core/
│   ├── model/
│   │   ├── types.ts              # NetworkModel, 절점/링크 타입, 수질 옵션(QualityOptions/ReactionOptions), createEmptyModel
│   │   ├── units.ts              # 단위 라벨, SI/US 판별, 시간 포맷, 수질 라벨
│   │   ├── networkEdit.ts        # 편집 기본 연산(추가·삭제·이동·분할·병합·ID 변경·원문 섹션 참조 갱신) — 순수 함수
│   │   ├── networkGraph.ts       # 인접 리스트 그래프, BFS, 연결 요소
│   │   ├── profile.ts            # 종단면도 최단 경로(Dijkstra), 경유점 경로
│   │   ├── selection.ts          # 다각형 구역 선택, 다중 선택 집합 연산
│   │   └── curvesControls.ts     # 곡선·패턴 이름 변경/삭제(참조 갱신), 곡선 형식 검사, 제어 규칙 작성·검사
│   ├── sewer/                    # 하수관 자동 설계 (SewerStudio 호환 이식) + fixtures/ 정답 벡터, 지도 편집(mapFrame·edit·fromSwmmInp)
│   ├── swmm/
│   │   ├── inpReader.ts          # SWMM .inp → 지도용 형상(절점·링크·유역·강우계), 좌표계 감지
│   │   ├── swmmRunner.ts         # WASM 실행 (Worker·테스트 공용; window/document 최소 shim 후 동적 import)
│   │   ├── outReader.ts          # SWMM 이진 결과(.out) 파서 — 변수 인덱스 상수 NODE_VAR/LINK_VAR/SUB_VAR
│   │   └── swmm.worker.ts, swmmManager.ts
│   ├── io/
│   │   ├── inpParser.ts / inpWriter.ts   # EPANET .inp ↔ NetworkModel ([QUALITY]/[SOURCES]/[REACTIONS] 전역계수는 구조화)
│   │   ├── shapefileImporter.ts          # GeoJSON(객체/문자열) → 관망, GeoJSON 내보내기, 속성 별칭(국가 상수도 GIS 필드 포함)
│   │   ├── shapefile.ts / zip.ts         # .shp/.dbf/.prj/.cpg 파서, 최소 ZIP 읽기 (DecompressionStream)
│   │   └── loadShapefiles.ts             # 여러 파일·zip 을 레이어별로 묶어 하나의 GeoJSON 으로
│   ├── engine/
│   │   ├── epanetRunner.ts       # epanet-js 실행 순수 함수 (Worker·테스트 공용, 수질 동시 해석 포함)
│   │   ├── epanet.worker.ts      # 해석 전용 Worker
│   │   ├── simulationManager.ts  # Worker 래퍼, 결과 조회 함수
│   │   ├── supplyZones.ts        # 급수구역(수원별 기여율) 계산
│   │   ├── fireFlow.ts           # 소화용수 분석 (Worker·테스트 공용)
│   │   ├── resultsExport.ts      # 결과 표 열 정의, CSV 내보내기
│   │   └── errorMessages.ts      # EPANET 오류·경고 코드 한국어 설명
│   └── validation/
│       ├── orphanNodes / duplicateLinks / connectivityCheck / crossingPipes .ts
│       ├── autoFix.ts            # 일괄 보정
│       ├── index.ts, types.ts    # runValidation, 이슈 타입
│       └── validation.worker.ts, validationRunner.ts
├── store/                        # useNetworkStore(모델+Undo), useUIStore(도구·선택·다중 선택·종단 경유점), useSimulationStore, useValidationStore
├── app/useProfilePath.ts         # 종단면도 경로 공유 계산(지도 레이어·패널이 같은 결과를 씀)
├── app/draftActions.ts           # 수용가 초안·분담유량·관망 정리·백업 복원 동작
├── app/autoBackup.ts             # IndexedDB 자동 백업
├── components/
│   ├── layout/                   # TopToolbar, LeftLayerPanel, RightPropertyPanel, MultiSelectionPanel, BottomTimelineDock,
│   │                             # TimeSeriesPanel, ProfilePanel, ResultsTablePanel
│   ├── map/                      # GisMapCanvas(이벤트·카메라·도구별 클릭), networkLayers(deck 레이어), thematic(주제도),
│   │                             # DrawingOverlay(작도·구역 다각형), ColorRampLegend, basemaps, iconAtlas
│   ├── modals/                   # ValidationModal, SimulationOptions(수질·패턴 포함), DataEditorModal(곡선·제어 규칙), FireFlowModal
│   └── ui/                       # fields(입력 컨트롤), Modal, Toaster
└── utils/                        # geoMath(좌표계·거리·투영), colorScales, files
public/samples/                   # sample-district.inp(정상), sample-errors.inp(검증 오류 포함) — 테스트가 ?raw 로 읽는다
```

## 5. 지켜야 할 설계 규칙

1. **좌표**: 내부 좌표는 항상 WGS84 `[lng, lat]`. 원본 좌표계는 `model.crs` 에 보관하고 내보낼 때만 되돌린다.
2. **단위**: 모델 값은 파일의 단위계(EPANET 규약)를 그대로 둔다. SI(LPS·CMD 등)면 m·mm, US(GPM 등)면 ft·in·psi.
   라벨과 기준값은 `units.ts` 의 `unitLabels` / `isUsUnits` 로 정한다.
3. **모델 변경은 한 곳으로**: `useNetworkStore.getState().commit(recipe, mergeKey?)` 만 쓴다(immer). 변경마다 Undo 스냅샷과
   `revision` 이 갱신된다. 편집 로직 자체는 `networkEdit.ts` 의 순수 함수에 두고 스토어·컴포넌트에서 직접 객체를 고치지 않는다.
4. **위상 무결성**: 링크는 항상 존재하는 `startNodeId`/`endNodeId` 를 가리킨다. 절점 이동 시 `isCustomLength` 가 아닌 관로의 연장을 다시 계산한다.
5. **무거운 계산은 Worker**: 수리해석과 관망 검증(교차 검사)은 Worker 에서 돈다. 메인 스레드에 O(n²) 연산을 넣지 않는다.
6. **해석 결과 형식**: 변수별 `Float32Array` 하나에 `[step * count + index]` 로 평탄화되어 있다(`simulationManager.ts`).
   결과가 최신인지는 `useSimulationStore.resultsRevision` 과 `useNetworkStore.revision` 을 비교한다.
7. **지도 렌더링**: deck 레이어 색·크기 접근자는 `styleKey` 를 `updateTriggers` 로 받는다(`networkLayers.ts`).
   접근자가 새 상태에 의존하게 만들면 `styleKey` 에도 반영한다. 지도 클릭 처리는 `GisMapCanvas.tsx` 한 곳에서
   픽킹 → 도구별 분기로 한다.
8. **셀렉터**: zustand 셀렉터가 매번 새 객체·배열을 돌려주지 않게 한다(원시값이나 스토어에 있는 참조만).
9. **UI 문구는 한국어**, 색은 `index.css` 의 테마 토큰(`bg-panel`, `text-ink` 등)을 쓴다.
10. **오류 처리**: 엔진 오류·경고는 콘솔이 아니라 한국어 토스트 + 문제 객체 강조로 알린다(`errorMessages.ts`, `actions.ts`).

## 6. 알아둘 함정

- **lucide-react 1.x** 는 아이콘 이름이 바뀌었다: `TriangleAlert` → `TriangleExclamationPoint`, `CircleAlert` → `CircleExclamationPoint`,
  `Trash2` → `Trash`, `FileJson` → `FileBraces`, `Waves` → `WavesHorizontal`. 없는 이름은 타입체크에서 걸린다.
- **maplibre-gl 은 5.x 로 고정**했다. 6.x 는 워커 파일을 따로 불러와 Vite 설정이 더 필요하다.
- **epanet-js** 는 경고(코드 100 미만)를 `console.warn` 으로만 알린다. `epanetRunner.ts` 가 이를 가로채 모은다.
  오류는 `EPANET Error <코드>: ...` 형태의 예외로 온다.
- **.inp 파서**: EPANET 처럼 섹션 이름은 앞 4글자로 맞추고, `[PIPES]` 의 7번째 토큰은 부차손실 또는 상태 키워드일 수 있다.
  국내 파일의 EUC-KR 인코딩은 `utils/files.ts` 의 `decodeText` 가 처리한다.
- **브이월드 배경지도**는 사용자가 입력한 오픈API 키가 있어야 표시된다(브라우저 localStorage 에만 저장).
- 이 폴더는 **OneDrive 동기화 폴더** 안에 있다. `node_modules` 동기화가 부담되면 프로젝트를 OneDrive 밖으로 옮기는 편이 좋다.
  Vite 파일 감시가 가끔 수정을 놓친다(화면에 `X is not defined` 처럼 옛 코드가 남음). 그 파일을 다시 저장하면 해결된다.
- 개발 서버 포트: 5173(기본). 다른 세션이 이미 쓰고 있으면 `.claude/launch.json` 의 `opengispipe-dev-alt`(5174)를 쓴다.
- **SWMM WASM 패키지**(`@fileops/swmm-wasm-web` 0.0.4, 2023, 개인 관리)는 'web' 환경 전용 Emscripten 빌드다. 모듈 Worker·Node 에는 window/document 가 없어
  `swmmRunner.ts` 가 최소 shim 을 넣고 불러온다. 타입 정의가 없어 `src/types/swmm-wasm.d.ts` 로 선언했다. WASM 은 JS 안에 내장(≈730 KB, 처음 해석할 때만 로드).
  .out 의 노드·링크 '유형' 코드는 float 가 아니라 **int32** 로 저장된다. SWMM .inp 에는 `[END]` 섹션이 없다(넣으면 오류 205).
  첫 보고 시각은 시작 + 보고 간격이다(기간 수 = 총 시간 / 보고 간격).
- 수질 결과 배열(`node.quality`/`link.quality`)은 수질 해석을 안 하면 **길이 0** 이다. 쓰기 전에 `results.quality !== null` 을 확인한다.
- 범례(`ColorRampLegend`)는 수치 스케일을 높은 값이 위로 뒤집어 보인다. 범주형 스케일은 `categorical: true` 를 준다.
- 표시 이름 `물길` 은 `src/config.ts` 의 `APP_NAME` 한 줄이고, 브라우저 탭 제목은 `index.html` 이다. 설정 저장 키는 `mulgil.ui`(옛 `opengispipe.ui` 도 읽는다).
- **도로 기준 자동 위치 보정**(좌측 '위치 보정'): OpenStreetMap 도로(Overpass API, 서버 3곳 순차 시도)를 받아
  ① 좌표 범위가 겹치는 좌표계 후보(지금 위치에서 3 km 이내로 옮겨지는 것: 5174·5181·2097 등)를 다시 읽어 도로 일치도로 고르고
  ② 남은 평행 밀림을 격자 탐색(`core/model/roadAlign.ts`)으로 찾아 `crs.shift`(m)에 저장한다. `toWgs84/fromWgs84` 가 shift 를 더하고 빼므로 .inp 내보내기는 원본 좌표 그대로다.
  실제 사업 관망(전남 군 단위)은 5174 로 열면 도로까지 평균 37 m(24% 일치)였고, 보정이 EPSG:5181(GRS80, 가산 500000)을 골라 11 m(79%)가 됐다.
  국내 TM 좌표계 정의는 `utils/geoMath.ts` 의 `CRS_DEFS`(5186/5185/5187/5188/5181/5180/5183/2097/5179/5174).
- **도로 따라 관로 형상 보정**(좌측 ② 또는 데이터 메뉴 → `CorrectionModal`): `core/model/roadSnap.ts` — 절점을 25 m 안 도로 중심선(12 m 안 교차로 우선)으로 옮기고,
  양 끝이 도로 위인 관로는 도로 그래프 최단 경로로 꺾임점을 다시 만든다(Douglas–Peucker 1 m 단순화). 도로 경로가 min(도면 길이, .inp 연장)·1.5+30 m 보다 길면 따르지 않는다.
  수원지·배수지는 옮기지 않고, 관로 연장은 기본으로 .inp 값 유지(체크하면 새 형상으로 재계산). 분석 → 지도 강조 미리 보기 → 적용(Undo 한 단계).
  도로 자료는 `app/osmRoads.ts`(Overpass 3개 서버, 같은 영역 재요청은 캐시). 실제 사업 관망: 절점 613/767 이동(평균 7.4 m), 관로 670개 재경로.
- **절점 표고 보정**(같은 대화상자): `core/terrain/elevation.ts` + `app/terrainFetch.ts`.
  ① 온라인 지형 타일(AWS Terrain Tiles Terrarium, z13, 국내 SRTM 30 m 급 — 수 m 오차) ② 수치지형도 Shapefile(표고점·등고선; 속성 CONT·NUME·ELEV·표고 또는 Z, 등고선은 10 m 간격으로 채움)을
  IDW(반경 300 m, 8점) 보간. 매설 깊이 차감, 최소 변경폭, '의심' 상한(기본 30 m 초과는 바꾸지 않음) 옵션. 실제 사업 관망: 767개 중 평균 |차이| 5.4 m, 의심 13개(DD 지선 — 도면 길이가
  .inp 연장의 2~2.5배로 과장되어 위치 자체가 틀린 구간).
- **하수관 자동 설계**(데이터 메뉴 → `SewerDesignModal`): SewerStudio(Codex 가 만든 Python 프로그램)의 설계 알고리즘을 `src/core/sewer/` 로 TypeScript 이식했다.
  가지형(수지상) 중력 하수관 — 맨홀·관로·유역을 표로 입력하고 ① 자동 설계(부분 충만 Manning 관경·경사, 합리식 Q=CIA/360, 공통 관정, 토피·굴착깊이·유속·d/D 검토)
  ② SWMM 해석(월류·만관 초과·연속성) ③ 반복 검토(용량 부족 관로 관경을 한 규격씩 키우며 수렴할 때까지) → 지도의 우수·하수 보기로 열기.
  - 호환 계약은 SewerStudio `PORTING/SPEC.md`(소스 SHA-256 은 PORTING/VERSION.md)이고, **정답 벡터는 `src/core/sewer/fixtures/`** (수리 함수 1,312쌍, 설계 18개 시나리오, INP 3종 바이트 일치, RPT 파싱, 반복 이력).
    알고리즘을 바꾸면 벡터와 달라지므로, 개선할 때는 호환 구현과 개선 구현을 구분해서 둘 것(SPEC 머리말).
  - 파일: `hydraulics.ts`(section·manning·normalRatio·requiredSlope), `topology.ts`(검증·networkx 와 같은 세대별 위상 순서·유량 누적), `design.ts`, `inp.ts`(INP 생성), `report.ts`(RPT 파싱 + simulate 요약),
    `optimize.ts`(해석 함수를 주입받는 반복), `validate.ts`(스키마·교차 검증, 한국어 메시지), `types.ts`(예제 포함). 화면은 `app/sewerActions.ts` + `store/useSewerStore.ts`.
  - **기본 제약값(최소 토피 1 m, 유속 0.6~3.0 m/s, d/D 0.8, 관경 목록 등)은 전부 예제값이다. 한국 하수도시설기준으로 검증된 값이 아니다.** 화면에도 그렇게 표시한다.
  - 한계(원본과 같음): 탐욕적 휴리스틱(비용 최적화 아님), 수지상만, 설계 유량(합리식)과 SWMM 유역 유출은 다른 계산, 월류 절점 양쪽 관로 확대는 원인 진단 없음, 경고 한 줄이면 quality_ok=false.
  - 엔진 대조(`engine.test.ts`): 우리 WASM 5.2.2 로 기본 예제는 월류 0·연속성 오차 작음, 용량 부족 예제는 반복해서 수렴 — 원본의 공식 5.2.4 결과와 같은 자릿수. 5.2.2 와 5.2.4 의 수치 동일성은 보장하지 않는다.
  - `designSewer(project, floors, mode)`: mode 'compat'(기본, 정답 벡터) / 'practical'(앱 기본 — 최소 유속을 어떤 경사로도 못 내는 소유량 관에 가장 큰 관 대신
    최소 관경·최소 경사를 쓰고 '유속 범위' 위반으로 남김). 정답 벡터 테스트는 compat 로만 돈다. 앱 설정은 `useSewerStore.designMode`(설계 조건 탭).
  - **검토 목록**(`review.ts`, 설계 대화상자 5번째 탭): 기존 하수 설계 프로그램의 검토 목록 판정 체계 — Overflow·최소/최대 유속(0.6/3.0)·동수위(GL+0, SWMM 결과 필요)·역경사,
    GOOD/NG/-, 다음 NG, CSV.
  - 지도에서 맨홀·관로를 찍어 입력, SWMM .inp → 설계 모델 변환은 아래 ‘하수 모드’ 참고.
- **수용가 CSV → 관망 초안**(데이터 메뉴, `NetworkBuildModals.tsx` + `app/draftActions.ts`):
  `core/io/customerCsv.ts`(UTF-8/CP949 자동, 열 추정, 월→일 환산) → `core/model/networkDraft.ts`(도로 15 m 분할 그래프, 수용가 최근접 접속,
  Takahashi–Matsuyama 탐욕 스타이너 나무, 하수는 오르막 벌점, 5 m 미만 관 병합) → `draftConvert.ts`(상수 NetworkModel: 유속 기준 표준 관경 / 하수 SewerProject: EPSG:5186 좌표).
  도로는 `osmRoads.ts`, 지반고는 `terrainFetch.ts`. 수원 미지정 시 상수=가장 높은, 하수=가장 낮은 수용가. 지도 위치 찍기는 `useUIStore.pointPick`(대화상자를 닫고 클릭 한 번 → 복귀).
  미리보기 레이어 `components/map/draftLayers.ts`. 첨두계수·전환율 등 기본값은 예시값.
- **용도지역 분담유량**(`core/model/landUse.ts`): 기존 상수관망 프로그램의 분담유량 = Σ(면적×원단위). 연결관을 자동화 — 구역 안 절점 균등 배분, 없으면 중심 최근접(최대 거리).
  원단위 m³/일/ha, 반영은 commit(실행 취소 가능), 산출표 CSV.
- **관망 정리**(`core/model/networkTools.ts`): 가까운 절점 병합(펌프·밸브 사이 금지, 수원 우선, 수요 합산), 직렬 관로 병합(수요 0·동일 제원·원문 섹션 미참조), ID 일괄 재부여(임시 이름 2단계).
- **자동 백업**(`app/autoBackup.ts`): revision 변경 3초 뒤 IndexedDB('mulgil'/'backup'), 빈 관망은 저장 안 함. 시작 화면 '지난 작업 복원'. 하수 관망은 `startSewerBackup`(키 'sewer')이 저장하고 앱을 열 때 자동으로 불러온다(예제 대신).
- **사용 설명서**: `public/manual.html`(정적, 툴바 📖 버튼이 BASE_URL 기준으로 새 탭). 기능을 바꾸면 설명서도 고칠 것. 끝에 기존 데스크톱 프로그램 대응표가 있다.
- **기존 데스크톱 관망 프로그램**(상수·하수 각 1종, 매뉴얼은 저장소 밖)에서 가져온 것: 분담유량·산출표, 검토 목록, 절점/링크 병합, ID 재부여, 자동 백업. 남은 후보: 종단 편집 단축키·접합 명령,
  강우강도식(일반식/다항식)·누가면적별 첨두계수, 유역→관 면적 자동 배분, 맨홀 라이브러리, 처리 구역, 지하매설물·보링 종단 표시.
- **검증 교차 분류**(`crossingPipes.ts`): 관로 쌍마다 한 건. 2곳 이상 넘나들면 `overlap`(참고, 보정 불가), 관경비 ≥ 2.5 면 `overpass`(참고, 일괄 보정 기본 제외),
  나머지 `crossing`. severity 'info' = 참고. 하단 검증 탭은 유형 필터(기본 '확인 필요'). `mergeNodes` 는 원문 섹션의 절점 참조도 옮긴다.
- **설계기준 검토**(`core/engine/criteria.ts` + `CriteriaPanel`): 수압 15.3/71.4 m, 유속 0.3~3.0 m/s 기본(US 는 환산), 수원별 물수지(급수구역은 최대 수요 시각 기준).
- **내보내기**(`core/io/gisExport.ts`): STORE zip(CRC32), Shapefile(점·폴리라인, dbf UTF-8 + .cpg, prj 는 WGS84·5186 WKT), DXF R12. 우리 Shapefile 리더로 왕복 테스트.
- **하수 설계기준 프리셋**(`core/sewer/standards.ts`): 부산 2026 오수관로. `designSewer(…, mode, rules)` 의 PracticalRules(minFlow·dropPipeAt·maxDrop)는 practical 모드에서만.
  원문 추출본은 세션 스크래치(저장소 밖). 우수·합류식 값은 그 문서에 없다.
- **관망 초안 보완 모드**: `DraftOptions.seeds`(기존 절점들)를 주면 여러 뿌리에서 동시에 탐욕 스타이너 나무를 키운다(DraftNode.existingId).
  `addDraftToWaterModel` 은 새 절점·관만 지금 모델에 추가(commit, 실행 취소 가능). 기존 관로 servedDistance 안 수용가는 draftActions 에서 뺀다. 상수만.
- **도로 자료**: `osmRoads.ts` Overpass 5개 서버(각 40초) + IndexedDB 30일 캐시 + `setUserRoads`(사용자 도로 중심선 파일).
  사용자 파일은 `nodeRoads`(교차점·T자 접속점 삽입)로 이은 뒤 쓴다. 2026-11 중 Overpass 공개 서버가 자주 전부 실패했다(406/502/504/시간 초과).
- **SWMM 하수 검토**(`core/swmm/review.ts`, SWMM 도크 '하수 검토' 탭): 월류·지표 도달·만관·최대/최소 유속(전 시간 최대, 흐름 없는 관 제외).
- **배포·SWMM 5.2.4**: 저장소 https://github.com/wonjejj-glitch/mulgil (공개), 사이트 https://wonjejj-glitch.github.io/mulgil/ .
  main 에 push 하면 `.github/workflows/deploy.yml` 이 ① emscripten/emsdk 컨테이너에서 USEPA 공식 v5.2.4 소스를 `swmm5.mjs`(SINGLE_FILE ES 모듈)로 컴파일
  ② `src/core/swmm/engine/` 에 넣고 lint·test(엔진 테스트가 5.2.4 로 돔)·build(BASE_PATH=/mulgil/) ③ Pages 배포. 배포본 보고서 머리글 "VERSION 5.2 (Build 5.2.4)" 확인.
  `swmmRunner.loadFactory` 는 `import.meta.glob('./engine/swmm5.mjs')` 가 있으면 그것, 없으면(로컬 PC — 앱 제어 정책이 clang 을 막아 로컬 빌드 불가) 5.2.2 패키지.
  저장소에서 빼는 것(.gitignore): `sewer_rehab/`(실제 사업 자료가 있는 별도 프로젝트), `.claude/`. 회사·사업지 이름을 코드·문서에 넣지 말 것(공개 저장소).
- **테스트 하네스 주의**: 개발 서버 실행 중 고친 모듈은 `?t=` 붙은 별도 인스턴스로 로드된다. 브라우저 콘솔에서 `import('/src/...')` 로 스토어를 만지면
  앱과 다른 인스턴스일 수 있다 — performance 리소스 목록에서 최신 `?t=` URL 을 골라 import 할 것.
- **관망이 사라지고 배경지도만 보일 때**: 관망 레이어(deck.gl)는 별도 WebGL 캔버스다. 탭을 오래 켜 두거나 새로고침·핫리로드를 반복하면 브라우저가 컨텍스트를 끊는다.
  `GisMapCanvas` 가 `webglcontextlost` 를 받으면 오버레이(`key={deckEpoch}`)와 레이어 인스턴스(`deckLayers` 의존성)를 함께 새로 만든다 — 레이어 인스턴스를 재사용하면 새 오버레이에서 그려지지 않는다.
- **하수 모드 (1단계, 2026-11-14)**: `useUIStore.domain: 'water' | 'sewer'` — 툴바 [상수 | 하수] 토글(`TopToolbar` `DomainToggle`, 전환은 `app/sewerMapActions.ts` `switchDomain`).
  하수 모드에서는 지도·우측 패널·하단 도크·툴바 도구·데이터/파일 메뉴·Undo/Redo·Delete·F·F5 가 전부 `useSewerStore.project`(SewerProject)에 작용한다. 상수 모델은 그대로 남는다.
  읽기 전용 SWMM 보기(`useSwmmStore.project`)는 두 모드 위에 뜨는 별도 화면이고(열려 있으면 우선), 닫으면 원래 모드로 돌아간다.
  - **좌표 결정**: SewerProject 스키마는 그대로(절점 x, y 만 있음). x, y 는 **EPSG:5186(m)** 로 저장한다(초안·SWMM 가져오기·지도 작도 모두). `core/sewer/mapFrame.ts` `sewerFrame()` 이
    전 절점이 5186 범위면 `epsg`, 아니면(예제 x≈0~600) `local` — 좌표 범위 중심을 `DEFAULT_ANCHOR` 의 5186 좌표로 **평행 이동**해 그린다(회전·축척 없음 → 거리 유지).
    local 프로젝트를 지도에서 편집(절점 추가·이동)하면 그 순간 `georeference()` 가 전 절점을 5186 으로 옮긴다(보이는 위치 그대로, 실행 취소 한 단계에 포함).
    관거 연장은 5186 평면 거리(`planarLength`) — 경위도 거리가 아니다. 저장 형식에 좌표계 표시는 없다(범위로 판별).
  - 파일: `core/sewer/mapFrame.ts`(좌표), `edit.ts`(ID 생성 MH001/OF1/P001, 맨홀·관거 추가, 이동 시 연장 재계산, 삭제, ID 변경, 지반고 반영 — 전부 순수 함수, 스토어 `edit(recipe)` 안에서 호출),
    `fromSwmmInp.ts`(SWMM .inp → SewerProject + 경고 목록; 위치는 `readSwmmInp` 의 WGS84 → 5186, 단위 환산, ID 규칙 보정), `components/map/sewerLayers.ts`(deck 레이어, 픽킹 ID `sewer-nodes`/`sewer-conduits`),
    `components/sewer/`(`SewerPropertyPanel`, `SewerDock`, `SewerShared` = 설계 대화상자와 함께 쓰는 종단도·검토 목록·해석 요약), `app/sewerMapActions.ts`(전환·삭제·맞춤·설계/해석 실행·가져오기·지반고 보정).
    지도 클릭·드래그 분기는 `GisMapCanvas.tsx` 의 `ui.domain === 'sewer'` 블록 한 곳.
  - `useSewerStore`: `selection`(지도 선택), `edit(recipe, mergeKey?)` + `sealHistory()`(절점 끌기를 Undo 한 단계로). 입력이 바뀌면 설계·해석 결과는 지워진다(기존 동작).
  - '설계·해석 실행'(F5) = `runSewerFromMap` → `runSewerSimulation`(설계 없으면 자동 설계 → SWMM). 반복 검토(관경 자동 확대)는 우측 패널 단추. 오류는 토스트 + 우측 패널.
  - 색: 관거 = 설계 행 status('적합' 여부), 맨홀 = 해석 요약(월류/만관 초과). 설계 전에는 중립색. 굵기 = 관경.
  - **compat 설계 모드·`core/sewer/fixtures/`·`validate.ts` 스키마는 건드리지 않았다.** 빈 프로젝트(`emptySewerProject`)는 스키마 검증(절점 2개·관로 1개 이상)을 통과하지 못하는 편집 중 상태다.
  - **2단계 (2026-11-14)**:
    - 유역 작도: `SewerCatchment.polygon?`(5186 m, 닫지 않은 꼭짓점; validate 허용, `generateInp` 는 경계가 있을 때만 [POLYGONS] — 정답 벡터 영향 없음,
      `georeference` 가 경계도 옮김, SWMM 가져오기는 [POLYGONS] 를 옮김). 도구 'catchment'(A) — `areaDraft` 를 재사용해 `GisMapCanvas` 하수 블록에서 그리고 `finishArea` 가 `addSewerCatchment` 호출.
      출구 = 경계 안 최저 관저 맨홀/가장 가까운 맨홀(`pickCatchmentOutlet`). 출구 맨홀 삭제·방류구 전환 시 경계 있는 유역은 가까운 맨홀로 옮김(`reassignCatchments`). 선택 kind 'catchment', 레이어 `sewer-catchments`.
    - 보정·현황: `core/sewer/survey.ts` — `parseSurveyCsv`(머리글 이름으로 맨홀번호·지반고·관저고·깊이), `applySurveyLevels`, `asBuiltDesign`(관경·관저고 그대로 행 계산, `DesignResult.asBuilt=true`).
      `runSewerSimulation` 은 asBuilt 결과를 재사용하지 않고 새로 설계한다. 수치지형도 DXF: `core/io/dxfElevation.ts` + `terrainFetch.interpolatorFromFiles`(xyz/dxf/shp 분기, 상수 표고 보정 대화상자도 같이 씀).
    - 성과품: `core/sewer/drawings.ts` — `profileStations`, `profileDxf`(세로 10배, 기입란, 관경별 터파기 단면, 한글은 U+XXXX 이스케이프), `planDxf`, `quantityTakeoff`/`quantityCsv`
      (터파기 폭 관경×1.2+0.6 m·맨홀 1~5호 규격은 예시값). 하수 도크 '수량 산출' 탭, 종단도 탭의 DXF 단추.
    - 상수 시간최대계수: `core/engine/peakFactor.ts`(OPTIONS 'Demand Multiplier' 읽기·쓰기, 시나리오 요약) + `app/peakActions.ts`(별도 SimulationManager 로 순차 비교 해석) + 하단 '시간최대계수' 탭.
  - 아직 없는 것: 압송관·펌프장, 박스관(비원형), 다중·구역 선택, 관거 꺾임점, 하수 Shapefile 내보내기,
    왼쪽 패널의 하수용 레이어·주제도(지금은 상수용 그대로 보임), 사용자 지정 기준 위치(local 프로젝트는 항상 서울 기준점).
- 기능은 공개 문서와 오픈소스 엔진(EPANET)만으로 다시 설계한 것이다. 상용 프로그램의 실행 파일·코드·화면 자산을 가져다 쓰지 않는다.

## 7. 다음 작업 후보

1. SWMM 편집: 지금은 읽기 전용 보기. 작도·속성 편집·.inp 내보내기를 하려면 관거·맨홀·소유역·강우 데이터 모델이 새로 필요하다.
   패키지가 방치 상태이므로 SWMM 5.2.x 를 직접 WASM 으로 빌드해 교체하는 안도 검토할 것.
2. Playwright 기반 E2E 테스트(`window.__ogp` 활용), git 저장소 초기화와 CI
3. Shapefile 내보내기, 관재질(PIP_MOP) 코드 → 조도계수 매핑표
4. [ENERGY]·[EMITTERS] 편집 UI, 다중 수요 범주([DEMANDS] 여러 줄) 편집
5. 소화용수 분석의 '가용 소화 유량'(잔류 수압 기준을 만족하는 최대 유량) 이분 탐색
