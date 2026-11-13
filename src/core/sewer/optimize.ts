/**
 * 설계 → SWMM 해석 → 관경 확대 반복 (SewerStudio workflow.py 호환, SPEC §5).
 * 해석은 simulate 콜백으로 주입한다 (브라우저는 Worker, 테스트는 고정 결과).
 */
import { designSewer, type DesignMode, type DesignResult } from './design';
import type { SimulationSummary } from './report';
import type { SewerProject } from './types';

export interface IterationRecord {
  iteration: number;
  critical_links: string[];
  velocity_violations: string[];
  design_issues: string[];
  quality_ok: boolean;
  converged: boolean;
  /** 이 회차 설계 호출에 쓰인 관경 하한 (추적용) */
  floors: Record<string, number>;
}

export interface OptimizeOutcome {
  /** 마지막으로 실제 해석한 설계. */
  design: DesignResult;
  simulation: SimulationSummary;
  history: IterationRecord[];
  converged: boolean;
  stop_reason: string;
  /** 회차별 설계·해석 (화면에서 회차를 넘겨 볼 때 사용). */
  iterations: { design: DesignResult; simulation: SimulationSummary }[];
}

export type SimulateFn = (design: DesignResult, iteration: number) => Promise<SimulationSummary>;

export async function optimizeSewer(
  project: SewerProject,
  simulate: SimulateFn,
  onProgress?: (message: string) => void,
  mode: DesignMode = 'compat',
): Promise<OptimizeOutcome> {
  const cst = project.constraints;
  let floors: Record<string, number> = {};
  const history: IterationRecord[] = [];
  const iterations: OptimizeOutcome['iterations'] = [];
  let outcome: OptimizeOutcome | null = null;

  for (let iteration = 1; iteration <= cst.max_iterations; iteration++) {
    const floorsUsed = { ...floors };
    // 항상 최초 입력 project 에서 다시 설계하고 floors 만 누적한다 (이전 회차 표고를 이어받지 않음)
    const design = designSewer(project, floors, mode);
    onProgress?.(`${iteration}회차 SWMM 해석 중…`);
    const sim = await simulate(design, iteration);
    iterations.push({ design, simulation: sim });

    const floodNodes = new Set(Object.entries(sim.node_summary).filter(([, x]) => x.flood_hours > 0 || x.surcharged).map(([id]) => id));
    const critical = new Set(
      design.project.conduits
        .filter((c) => sim.link_summary[c.id].max_depth_ratio > cst.max_depth_ratio + 0.005 || floodNodes.has(c.upstream) || floodNodes.has(c.downstream))
        .map((c) => c.id),
    );
    const velocities = Object.entries(sim.link_summary).filter(([, x]) => x.max_velocity > cst.max_velocity + 0.005).map(([id]) => id);
    const converged = critical.size === 0 && velocities.length === 0 && design.issues.length === 0 && sim.quality_ok;
    history.push({
      iteration,
      critical_links: [...critical].sort(),
      velocity_violations: [...velocities].sort(),
      design_issues: design.issues,
      quality_ok: sim.quality_ok,
      converged,
      floors: floorsUsed,
    });
    outcome = { design, simulation: sim, history, converged, stop_reason: converged ? '모든 검토 조건 만족' : '반복 횟수 도달', iterations };
    if (converged) break;
    if (!sim.quality_ok) {
      outcome.stop_reason = '연속성 오차 또는 SWMM 경고 검토 필요';
      break;
    }
    let changed = false;
    floors = {};
    for (const c of design.project.conduits) {
      floors[c.id] = c.diameter;
      if (critical.has(c.id)) {
        const bigger = cst.diameters.filter((x) => x > c.diameter + 1e-8);
        if (bigger.length > 0) {
          floors[c.id] = bigger[0];
          changed = true;
        }
      }
    }
    if (!changed) {
      outcome.stop_reason = '관경 증대로 해결할 수 없는 제약 또는 표준 관경 상한';
      break;
    }
  }
  return outcome!;
}
