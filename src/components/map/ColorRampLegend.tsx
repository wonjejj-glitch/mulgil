import { toCss, type ThematicScale } from '../../utils/colorScales';
import { useThematic } from './thematic';

function ScaleBlock({ scale, shape }: { scale: ThematicScale; shape: 'node' | 'link' }) {
  // 수치 스케일은 높은 값이 위에 오도록 뒤집고, 범주(급수구역 등)는 정의 순서대로 보여 준다.
  const rows = scale.labels.map((label, index) => ({ label, color: scale.colors[index] }));
  if (!scale.categorical) rows.reverse();
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-1.5 text-[11px] font-semibold text-ink">
        <span>{shape === 'node' ? '절점' : '관로'} · {scale.title}</span>
        <span className="font-normal text-ink-muted">{scale.unit}</span>
      </div>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center gap-2 text-[11px] text-ink-soft">
            {shape === 'node' ? (
              <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/40" style={{ background: toCss(row.color) }} />
            ) : (
              <span className="h-1 w-4 shrink-0 rounded-full" style={{ background: toCss(row.color) }} />
            )}
            <span className="tabular-nums">{row.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 지도 좌하단의 단계별 색상 범례 (수압·유속·유량 등 현재 주제도 기준). */
export function ColorRampLegend() {
  const { nodeScale, linkScale } = useThematic();
  if (!nodeScale && !linkScale) return null;
  return (
    <div className="pointer-events-none absolute bottom-10 left-3 z-10 flex gap-4 rounded-lg border border-line bg-panel/90 px-3 py-2 shadow-lg backdrop-blur">
      {nodeScale && <ScaleBlock scale={nodeScale} shape="node" />}
      {linkScale && <ScaleBlock scale={linkScale} shape="link" />}
    </div>
  );
}
