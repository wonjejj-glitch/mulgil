/**
 * epanet-js(OWA-EPANET WASM) 로 수리해석을 수행하는 순수 함수.
 * Web Worker 와 Node(단위 테스트) 양쪽에서 그대로 쓴다.
 */
import {
  CountType,
  InitHydOption,
  LinkProperty,
  LinkType,
  NodeProperty,
  Project,
  QualityType,
  TimeParameter,
  Workspace,
} from 'epanet-js';

export interface EngineWarning {
  code: number;
  /** 경고가 처음 발생한 모의 시각(초). */
  time: number;
  count: number;
}

export interface RawSimulationResult {
  /** 저장된 각 타임스텝의 모의 시각(초). */
  times: number[];
  nodeIds: string[];
  linkIds: string[];
  /** 이하 배열은 [step * count + index] 로 평탄화되어 있다. */
  pressure: Float32Array;
  head: Float32Array;
  demand: Float32Array;
  flow: Float32Array;
  velocity: Float32Array;
  headloss: Float32Array;
  /** 관로의 단위 손실수두(1000 길이 단위당). 펌프·밸브는 0. */
  unitHeadloss: Float32Array;
  /** 절점·관로 수질. 수질 해석을 하지 않으면 0 으로 채워진다. */
  nodeQuality: Float32Array;
  linkQuality: Float32Array;
  /** 수질 해석 종류와 단위. 해석하지 않았으면 null. */
  quality: QualityResultInfo | null;
  warnings: EngineWarning[];
  engineVersion: string;
}

export interface QualityResultInfo {
  mode: 'CHEMICAL' | 'AGE' | 'TRACE';
  /** 화면 표시용 이름 (예: Chlorine, 수령, 추적 비율). */
  name: string;
  /** mg/L, ug/L, hrs, % */
  units: string;
  traceNodeId: string;
}

export class EpanetRunError extends Error {
  code: number | null;
  report: string;

  constructor(message: string, code: number | null, report: string) {
    super(message);
    this.name = 'EpanetRunError';
    this.code = code;
    this.report = report;
  }
}

const INP_FILE = 'network.inp';
const RPT_FILE = 'report.rpt';
const OUT_FILE = 'out.bin';

function formatVersion(version: number): string {
  const major = Math.floor(version / 10000);
  const minor = Math.floor((version % 10000) / 100);
  const patch = version % 100;
  return `${major}.${minor}.${patch}`;
}

export async function runHydraulics(
  inp: string,
  onProgress?: (time: number, duration: number) => void,
): Promise<RawSimulationResult> {
  const ws = new Workspace();
  await ws.loadModule();
  const project = new Project(ws);
  ws.writeFile(INP_FILE, inp);

  // epanet-js 는 경고(코드 < 100)를 console.warn 으로만 알리므로 가로채서 모은다.
  const warningMap = new Map<number, EngineWarning>();
  let clock = 0;
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const match = /epanet-js \(Warning (\d+)\)/.exec(String(args[0] ?? ''));
    if (!match) {
      originalWarn(...args);
      return;
    }
    const code = Number(match[1]);
    const existing = warningMap.get(code);
    if (existing) existing.count++;
    else warningMap.set(code, { code, time: clock, count: 1 });
  };

  try {
    project.open(INP_FILE, RPT_FILE, OUT_FILE);

    const nodeCount = project.getCount(CountType.NodeCount);
    const linkCount = project.getCount(CountType.LinkCount);
    const nodeIds: string[] = new Array(nodeCount);
    const linkIds: string[] = new Array(linkCount);
    const linkLengths = new Float64Array(linkCount);
    for (let i = 0; i < nodeCount; i++) nodeIds[i] = project.getNodeId(i + 1);
    for (let i = 0; i < linkCount; i++) {
      linkIds[i] = project.getLinkId(i + 1);
      const type = project.getLinkType(i + 1);
      if (type === LinkType.Pipe || type === LinkType.CVPipe) {
        linkLengths[i] = project.getLinkValue(i + 1, LinkProperty.Length);
      }
    }

    let bulkRead = ws.version >= 20300;
    const readNodes = (property: NodeProperty, target: Float32Array) => {
      if (bulkRead) {
        try {
          target.set(project.getNodeValues(property));
          return;
        } catch {
          bulkRead = false;
        }
      }
      for (let i = 0; i < nodeCount; i++) target[i] = project.getNodeValue(i + 1, property);
    };
    const readLinks = (property: LinkProperty, target: Float32Array) => {
      if (bulkRead) {
        try {
          target.set(project.getLinkValues(property));
          return;
        } catch {
          bulkRead = false;
        }
      }
      for (let i = 0; i < linkCount; i++) target[i] = project.getLinkValue(i + 1, property);
    };

    const duration = project.getTimeParameter(TimeParameter.Duration);
    const hydStep = project.getTimeParameter(TimeParameter.HydStep);
    const reportStep = project.getTimeParameter(TimeParameter.ReportStep) || hydStep || 3600;
    const reportStart = project.getTimeParameter(TimeParameter.ReportStart);

    const qualityInfo = project.getQualityInfo();
    let quality: QualityResultInfo | null = null;
    if (qualityInfo.qualType === QualityType.Chem) {
      quality = { mode: 'CHEMICAL', name: qualityInfo.chemName || 'Chemical', units: qualityInfo.chemUnits || 'mg/L', traceNodeId: '' };
    } else if (qualityInfo.qualType === QualityType.Age) {
      quality = { mode: 'AGE', name: '수령', units: 'hrs', traceNodeId: '' };
    } else if (qualityInfo.qualType === QualityType.Trace) {
      const traceNodeId = qualityInfo.traceNode > 0 ? project.getNodeId(qualityInfo.traceNode) : '';
      quality = { mode: 'TRACE', name: `${traceNodeId} 기여율`, units: '%', traceNodeId };
    }

    const times: number[] = [];
    const steps: {
      pressure: Float32Array;
      head: Float32Array;
      demand: Float32Array;
      flow: Float32Array;
      velocity: Float32Array;
      headloss: Float32Array;
      unitHeadloss: Float32Array;
      nodeQuality: Float32Array;
      linkQuality: Float32Array;
    }[] = [];

    // 수질 해석이 있으면 수리·수질을 동시에 한 스텝씩 진행한다 (EPANET 툴킷의 동시 실행 방식).
    project.openH();
    project.initH(InitHydOption.NoSave);
    if (quality) {
      project.openQ();
      project.initQ(InitHydOption.NoSave);
    }
    let timeToNext = 0;
    do {
      const knownCodes = new Set(warningMap.keys());
      const time = project.runH();
      if (quality) project.runQ();
      clock = time;
      for (const [code, warning] of warningMap) {
        if (!knownCodes.has(code)) warning.time = time;
      }
      const isReportTime = time >= reportStart && (time - reportStart) % reportStep === 0;
      if (isReportTime || duration === 0) {
        const step = {
          pressure: new Float32Array(nodeCount),
          head: new Float32Array(nodeCount),
          demand: new Float32Array(nodeCount),
          flow: new Float32Array(linkCount),
          velocity: new Float32Array(linkCount),
          headloss: new Float32Array(linkCount),
          unitHeadloss: new Float32Array(linkCount),
          nodeQuality: new Float32Array(quality ? nodeCount : 0),
          linkQuality: new Float32Array(quality ? linkCount : 0),
        };
        if (quality) {
          readNodes(NodeProperty.Quality, step.nodeQuality);
          readLinks(LinkProperty.LinkQual, step.linkQuality);
        }
        readNodes(NodeProperty.Pressure, step.pressure);
        readNodes(NodeProperty.Head, step.head);
        readNodes(NodeProperty.Demand, step.demand);
        readLinks(LinkProperty.Flow, step.flow);
        readLinks(LinkProperty.Velocity, step.velocity);
        readLinks(LinkProperty.Headloss, step.headloss);
        for (let i = 0; i < linkCount; i++) {
          step.unitHeadloss[i] = linkLengths[i] > 0 ? (Math.abs(step.headloss[i]) / linkLengths[i]) * 1000 : 0;
        }
        times.push(time);
        steps.push(step);
      }
      onProgress?.(time, duration);
      timeToNext = project.nextH();
      if (quality) project.nextQ();
    } while (timeToNext > 0);
    if (quality) project.closeQ();
    project.closeH();
    project.close();

    const stepCount = steps.length;
    const flatten = (key: keyof (typeof steps)[number], count: number) => {
      const flat = new Float32Array(stepCount * count);
      for (let s = 0; s < stepCount; s++) flat.set(steps[s][key], s * count);
      return flat;
    };

    return {
      times,
      nodeIds,
      linkIds,
      pressure: flatten('pressure', nodeCount),
      head: flatten('head', nodeCount),
      demand: flatten('demand', nodeCount),
      flow: flatten('flow', linkCount),
      velocity: flatten('velocity', linkCount),
      headloss: flatten('headloss', linkCount),
      unitHeadloss: flatten('unitHeadloss', linkCount),
      nodeQuality: flatten('nodeQuality', quality ? nodeCount : 0),
      linkQuality: flatten('linkQuality', quality ? linkCount : 0),
      quality,
      warnings: [...warningMap.values()],
      engineVersion: formatVersion(ws.version),
    };
  } catch (error) {
    let report = '';
    try {
      report = ws.readFile(RPT_FILE);
    } catch {
      // 보고서 파일이 아직 없을 수 있다.
    }
    const message = error instanceof Error ? error.message : String(error);
    const match = /EPANET Error (\d+)/.exec(message);
    throw new EpanetRunError(message, match ? Number(match[1]) : null, report);
  } finally {
    console.warn = originalWarn;
  }
}
