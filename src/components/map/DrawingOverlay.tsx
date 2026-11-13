import { useEffect, useReducer } from 'react';
import { useMap } from 'react-map-gl/maplibre';
import type { LngLat } from '../../core/model/types';
import { metersToModelLength, unitLabels } from '../../core/model/units';
import { useNetworkStore } from '../../store/useNetworkStore';
import { useUIStore } from '../../store/useUIStore';
import { pathLengthMeters } from '../../utils/geoMath';

const ACCENT = '#ffdd33';

/**
 * 작도 중인 관로의 임시 형상(고무줄 선), 꺾임점, 절점 스냅 표시.
 * 지도 위에 SVG 로 겹쳐 그리며 마우스 이벤트는 통과시킨다.
 */
export function DrawingOverlay() {
  const { current: map } = useMap();
  const tool = useUIStore((s) => s.tool);
  const drawing = useUIStore((s) => s.drawing);
  const cursor = useUIStore((s) => s.cursor);
  const snapNodeId = useUIStore((s) => s.snapNodeId);
  const areaDraft = useUIStore((s) => s.areaDraft);
  const nodes = useNetworkStore((s) => s.model.nodes);
  const flowUnits = useNetworkStore((s) => s.model.options.flowUnits);
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!map) return;
    map.on('move', redraw);
    return () => {
      map.off('move', redraw);
    };
  }, [map]);

  if (!map || tool === 'select') return null;

  const toScreen = (p: LngLat): [number, number] => {
    const point = map.project(p);
    return [point.x, point.y];
  };
  const snapNode = snapNodeId ? nodes[snapNodeId] : undefined;
  const startNode = drawing ? nodes[drawing.startNodeId] : undefined;
  const target: LngLat | null = snapNode?.position ?? cursor;

  let rubberBand: [number, number][] = [];
  let lengthLabel = '';
  if (drawing && startNode && target) {
    const path: LngLat[] = [startNode.position, ...drawing.vertices, target];
    rubberBand = path.map(toScreen);
    const length = metersToModelLength(pathLengthMeters(path), flowUnits);
    lengthLabel = `${length.toFixed(1)} ${unitLabels(flowUnits).length}`;
  }
  const snapPoint = snapNode ? toScreen(snapNode.position) : null;
  const labelAt = rubberBand.length > 0 ? rubberBand[rubberBand.length - 1] : null;
  const area = tool === 'area' && areaDraft.length > 0 ? [...areaDraft, ...(cursor ? [cursor] : [])].map(toScreen) : [];

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full">
      {area.length > 1 && (
        <>
          <polygon points={area.map((p) => p.join(',')).join(' ')} fill="rgba(57, 135, 229, 0.14)" stroke="#3987e5" strokeWidth={2} strokeDasharray="6 4" />
          {area.slice(0, areaDraft.length).map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r={3.5} fill="#3987e5" stroke="#0f1318" strokeWidth={1} />
          ))}
        </>
      )}
      {rubberBand.length > 1 && (
        <>
          <polyline
            points={rubberBand.map((p) => p.join(',')).join(' ')}
            fill="none"
            stroke="#0f1318"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.7}
          />
          <polyline
            points={rubberBand.map((p) => p.join(',')).join(' ')}
            fill="none"
            stroke={ACCENT}
            strokeWidth={2}
            strokeDasharray="7 5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {rubberBand.slice(1, -1).map((p, i) => (
            <rect key={i} x={p[0] - 3.5} y={p[1] - 3.5} width={7} height={7} fill={ACCENT} stroke="#0f1318" strokeWidth={1} />
          ))}
        </>
      )}
      {snapPoint && (
        <circle cx={snapPoint[0]} cy={snapPoint[1]} r={13} fill="rgba(255, 221, 51, 0.15)" stroke={ACCENT} strokeWidth={2} />
      )}
      {labelAt && lengthLabel && (
        <g transform={`translate(${labelAt[0] + 14}, ${labelAt[1] - 14})`}>
          <rect x={-5} y={-13} width={lengthLabel.length * 7 + 12} height={19} rx={4} fill="rgba(15, 19, 24, 0.88)" />
          <text x={1} y={1} fill="#f0efec" fontSize={12} fontFamily="system-ui, sans-serif">
            {lengthLabel}
          </text>
        </g>
      )}
    </svg>
  );
}
