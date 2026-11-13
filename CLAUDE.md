# CLAUDE.md — OpenGISpipe (GISpipe Web Clean-Room Implementation)

## 1. 프로젝트 개요 (Project Overview)
본 프로젝트는 상하수도 통합 관망해석 소프트웨어인 [GISpipe](https://gispipe.com/ko/)의 핵심 워크플로우와 기능을 웹 브라우저 환경(React + WebAssembly)에서 구동되도록 재설계(Clean-room Reverse Engineering)한 상하수도 엔지니어링 웹 애플리케이션이다.

- **핵심 목표**: 별도의 CAD나 ArcGIS 설치 없이 웹 브라우저에서 상수관망([EPANET 2.2](https://github.com/epanet-js/epanet-js-toolkit)) 및 우수·하수관망([US EPA SWMM 5.2](https://www.epa.gov/water-research/storm-water-management-model-swmm)) 모델을 구축·검증·해석하고 2D/3D GIS 지도 위에 시각화한다.
- **벤치마크 및 오픈소스 레퍼런스**:
  - 기능 레퍼런스: [GISpipe 공식 기능 명세](https://gispipe.com/) 및 [GISpipe 사용자 매뉴얼](https://gispipe.com/downloads/en_gispipe_manual.pdf)
  - 코드 아키텍처 레퍼런스: [epanet-js 웹 애플리케이션](https://github.com/epanet-js/epanet-js) 및 [epanet-js-toolkit (OWA-EPANET WASM 포트)](https://toolkit.epanetjs.com/)

---

## 2. 기술 스택 (Tech Stack)
Claude Code는 모든 패키지 설치 및 코드 작성 시 아래 기술 스택과 버전을 기준으로 삼는다.

- **Core Framework**: Vite + React 18+ + TypeScript (Strict Mode)
- **State Management**: `zustand` + `immer` (관망 토폴로지 상태, Undo/Redo 히스토리 스택, 시뮬레이션 결과 상태 분리)
- **GIS & Spatial Rendering**:
  - `maplibre-gl` + `react-map-gl`: 기본 배경지도(위성지도, 오픈스트리트맵, 한국 브이월드 WMTS 연동) 및 벡터 레이어 렌더링
  - `@deck.gl/core`, `@deck.gl/layers`, `@deck.gl/mapbox`: 대규모 절점(Nodes), 관로(Links), 유향 화살표(Flow Arrows), 3D 수두/수압 기둥 렌더링
  - `@turf/turf`: 관로 연장 자동 계산, 교차점 탐색, 공간 스냅(Snapping), 구역(Polygon) 포함 여부 연산
- **Hydraulic Simulation Engine**:
  - 상수관망(Water Distribution): `epanet-js` ([epanet-js-toolkit](https://github.com/epanet-js/epanet-js-toolkit)) — Web Worker 내부에서 비동기 실행하여 UI 블로킹 방지
  - 우수·하수관망(Storm & Sewer): `@model-create/swmm-wasm` 또는 표준 SWMM `.inp` 파서/시뮬레이터 워커 모듈 (인터페이스 추상화)
- **UI & Charting**:
  - `tailwindcss` + `lucide-react`: 다크모드 기반 CAD/GIS 엔지니어링 워크스페이스 UI
  - `recharts`: 절점 시간대별 수압·수위 변화 곡선, 관로 유량·유속 시계열 그래프, 종단면도(Profile Plot) 렌더링

---

## 3. 개발 및 실행 명령어 (Commands)
```bash
# 의존성 설치
npm install

# 개발 서버 실행 (포트 5173)
npm run dev

# 타입 체크 및 린트 검사 (코드 수정 후 반드시 실행)
npm run typecheck
npm run lint

# 단위 테스트 실행 (Vitest - 파서, 수리계산, 관망 검증 로직 테스트)
npm run test

# 프로덕션 빌드
npm run build
```

---

## 4. 디렉터리 아키텍처 (Directory Structure)
```text
src/
├── components/
│   ├── layout/
│   │   ├── TopToolbar.tsx         # 파일 입출력(.inp/.geojson), 편집 도구 선택, 해석 실행 버튼
│   │   ├── LeftLayerPanel.tsx     # GIS 레이어 트리, 배경지도 선택, 범례(Legend) 및 색상 스케일 설정
│   │   ├── RightPropertyPanel.tsx # 선택된 절점/관로 속성(표고, 관경, 조도계수 등) 실시간 편집 폼
│   │   └── BottomTimelineDock.tsx # 시계열 슬라이더(0~24h+), 시계열 차트, 관망 검증 오류 리스트 탭
│   ├── map/
│   │   ├── GisMapCanvas.tsx       # MapLibre + Deck.gl 통합 캔버스 및 마우스 이벤트 핸들러
│   │   ├── DrawingOverlay.tsx     # 신규 절점/관로 작도 시 스냅 가이드라인 및 임시 형상 표시
│   │   └── ColorRampLegend.tsx    # 수압(m/psi), 유속(m/s), 유량(LPS/CMD) 단계별 색상 범례
│   └── modals/
│       ├── ValidationModal.tsx    # 관망 오류 자동 검출 및 일괄 보정(Auto-fix) 대화상자
│       └── SimulationOptions.tsx  # 수리해석 공식(Hazen-Williams, Darcy-Weisbach), 총 모의시간 설정
├── core/
│   ├── model/
│   │   ├── types.ts               # Node(Junction, Reservoir, Tank), Link(Pipe, Pump, Valve) 타입 정의
│   │   └── networkGraph.ts        # 인접 리스트(Adjacency List) 기반 위상(Topology) 그래프 구조
│   ├── io/
│   │   ├── inpParser.ts           # EPANET/SWMM 표준 .inp 텍스트 파일 -> 내부 GeoJSON/Graph 변환
│   │   ├── inpWriter.ts           # 내부 관망 모델 -> 표준 .inp 포맷 직렬화 및 내보내기
│   │   └── shapefileImporter.ts   # GIS Shapefile/GeoJSON 임포트 및 속성 매핑
│   ├── validation/
│   │   ├── orphanNodes.ts         # 미연결 고립 절점(Orphan Node) 검출
│   │   ├── duplicateLinks.ts      # 동일 시·종점 중복 관로 및 미소 길이(Short Pipe) 검출
│   │   └── connectivityCheck.ts   # 수원지(Reservoir/Tank)로부터 연결되지 않은 단절 구역(Isolated Sub-network) 탐색(BFS/DFS)
│   └── engine/
│       ├── epanet.worker.ts       # epanet-js-toolkit 구동 전용 Web Worker
│       └── simulationManager.ts   # Worker 통신 래퍼 및 시간대별 결과 캐싱
├── store/
│   ├── useNetworkStore.ts         # 관망 객체 CRUD 및 Undo/Redo 히스토리 관리
│   ├── useUIStore.ts              # 활성 도구(Select, AddJunction, AddPipe 등), 선택된 객체 ID 관리
│   └── useSimulationStore.ts      # 해석 진행 상태, 시간 스텝별 Node/Link 결과 데이터 저장
└── utils/
    ├── geoMath.ts                 # 좌표 변환(WGS84 <-> EPSG:5186/5179), 관로 연장 계산
    └── colorScales.ts             # 수치 범위별 RGB 보간(Interpolation) 함수
```

---

## 5. 핵심 도메인 데이터 모델 규칙 (Domain Model Specification)
1. **단위계 기본값 (Metric System Default)**:
   - 한국 상하수도 설계기준에 맞춰 기본 유량 단위는 `CMD`(m³/day) 또는 `LPS`(L/sec), 관경은 `mm`, 관로 연장은 `m`, 수압은 `mH2O`(수두), 조도계수는 `Hazen-Williams C` (기본값 100~130)를 사용한다.
2. **좌표계 및 투영 (CRS Handling)**:
   - MapLibre 렌더링을 위해 내부 저장 좌표는 `WGS84 (EPSG:4326, [lng, lat])`를 기본으로 하되, 국내 평면직각좌표계(`EPSG:5186` 중부원점 등)로 작성된 `.inp` 파일 임포트 시 `proj4`를 통해 자동 변환한다.
3. **관망 위상 무결성 (Topological Integrity)**:
   - 모든 `Pipe`는 반드시 유효한 `startNodeId`와 `endNodeId`를 참조해야 한다.
   - 절점(Node) 이동 시 연결된 모든 관로(Link)의 끝점 좌표와 연장(`length`)이 자동 재계산되어야 한다(사용자 수동 입력 고정 옵션 `isCustomLength` 지원).

---

## 6. 단계별 구현 로드맵 (Step-by-Step Implementation Plan for Claude Code)
Claude Code는 작업을 수행할 때 한 번에 모든 기능을 작성하지 말고, 반드시 아래 **Phase 1 ~ Phase 4** 순서에 따라 단계별로 구현하고 각 단계 완료 시 `npm run typecheck`로 검증한다.

### Phase 1: 워크스페이스 레이아웃 및 GIS 지도 캔버스 구축
1. Vite + React + TypeScript 프로젝트 초기화 및 필수 패키지 설치.
2. 4분할 CAD/GIS 엔지니어링 레이아웃(`TopToolbar`, `LeftLayerPanel`, `RightPropertyPanel`, `BottomTimelineDock`, 중앙 `GisMapCanvas`) 구성.
3. `MapLibre GL` 지도를 연결하고, 위성지도/일반지도 전환 기능 및 마우스 커서 위치의 경위도 좌표 실시간 표시줄 구현.
4. `useNetworkStore`를 생성하여 지도 클릭 시 `Junction`, `Reservoir`, `Tank`를 추가하고, 두 절점을 클릭하여 `Pipe`를 연결하는 작도 도구(Drawing Mode) 및 `Turf.js` 기반 관로 연장 자동 계산 구현.

### Phase 2: EPANET `.inp` 입출력 파서 및 속성 편집기 구현
1. `src/core/io/inpParser.ts` 및 `inpWriter.ts` 작성:
   - `[TITLE]`, `[JUNCTIONS]`, `[RESERVOIRS]`, `[TANKS]`, `[PIPES]`, `[PUMPS]`, `[VALVES]`, `[TIMES]`, `[COORDINATES]`, `[VERTICES]` 섹션을 정확히 파싱하고 직렬화.
2. 샘플 `.inp` 파일을 드래그 앤 드롭하거나 불러왔을 때 지도에 전체 관망이 렌더링되고 해당 영역으로 자동 줌(`fitBounds`)되도록 구현.
3. 지도에서 절점 또는 관로를 클릭하면 `RightPropertyPanel`에 상세 속성(표고, 수요량, 관경, 연장, 조도계수 C)이 표시되고 수정 시 스토어에 즉시 반영되도록 바인딩.
4. `Undo / Redo` 단축키(`Ctrl+Z`, `Ctrl+Y`) 지원.

### Phase 3: WebAssembly 수리해석 엔진(`epanet-js`) 연동 및 시각화
1. `src/core/engine/epanet.worker.ts`에 `epanet-js` ([epanet-js-toolkit](https://toolkit.epanetjs.com/)) 연동:
   - 현재 메모리의 관망 데이터를 `.inp` 문자열로 변환하여 Worker에 전달.
   - `ENopen`, `ENsolveH`, `ENsolveQ` 실행 후 각 타임스텝(Time step)별 절점 수압(`EN_PRESSURE`), 수두(`EN_HEAD`), 관로 유량(`EN_FLOW`), 유속(`EN_VELOCITY`), 손실수두(`EN_HEADLOSS`) 추출.
2. 해석 결과를 기반으로 지도 위 절점과 관로의 색상을 동적으로 변경하는 Color Ramp 렌더러 구현(예: 수압 15m 미만 적색 경고, 15~40m 녹색 정상, 70m 초과 고수압 표시).
3. 관로 위 유량 방향에 맞춘 화살표(Flow Direction Arrow) 렌더링 및 하단 `BottomTimelineDock`의 타임 슬라이더 조작에 따른 시간대별 애니메이션 구현.

### Phase 4: GISpipe 핵심 차별화 기능 — 관망 검증(Validation) 및 급수구역 분석
1. [GISpipe 데이터 검증 기능](https://gispipe.com/)을 벤치마킹한 `src/core/validation/` 모듈 구현:
   - **고립 절점(Orphan Nodes)**: 어떤 관로와도 연결되지 않은 절점 탐색.
   - **중복 관로(Duplicate Pipes)**: 동일한 두 절점을 잇는 중복 관로 탐색.
   - **미소 관로(Micro Pipes)**: 연장 1.0m 미만의 오류성 단관 탐색.
   - **단절 관망(Disconnected Sub-networks)**: 수원지(`Reservoir`/`Tank`)와 그래프 탐색(BFS)으로 연결되지 않아 물이 공급될 수 없는 고립 블록 검출.
   - **관로 교차 미분할(Crossing Pipes without Junction)**: 두 관로가 지도상에서 교차하나 교차점에 절점이 없는 지점 검출 및 자동 분할(Auto-split) 기능.
2. 하단 패널의 '관망 검증 결과' 탭에서 오류 항목을 클릭하면 지도 카메라가 해당 객체로 즉시 이동(`flyTo`)하고 하이라이트 표시.

---

## 7. 코딩 컨벤션 및 주의사항 (Coding Guidelines & Guardrails)
- **Web Worker 격리**: 관망 절점이 10,000개 이상일 때 수리해석이나 공간 교차 검증을 메인 스레드에서 실행하면 브라우저가 멈춘다. 무거운 계산은 반드시 Web Worker로 분리하라.
- **불변성 및 렌더링 최적화**: 지도 드래그나 마우스 호버 시 전체 React 트리가 리렌더링되지 않도록 `zustand` 셀렉터를 세분화하고, Deck.gl 레이어의 `updateTriggers`를 명확히 지정하라.
- **에러 핸들링**: EPANET 해석 중 음압(Negative Pressure) 발생이나 수리적 불안정(System Unbalanced) 에러 코드 발생 시 콘솔에만 찍지 말고 엔지니어가 원인을 파악할 수 있도록 한국어 경고 토스트와 문제 절점 하이라이트를 제공하라.
