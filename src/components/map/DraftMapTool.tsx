/**
 * 관망 초안용 지도 도구 (대화상자를 잠시 닫고 지도에서 한다).
 *  - 'area'  : 누른 채 끌어 네모 범위를 그린다 → 그 안의 건물로 수용가를 만든다
 *  - 'erase' : 수용가 빼기 — 클릭하면 가까운 수용가 하나, 끌면 네모 안의 수용가 전부. 되돌리기 가능, '끝내기'로 돌아간다
 * 도구를 쓰는 동안 지도 끌기(이동)는 끄고, 휠 확대는 그대로 둔다. Esc 로 끝낸다.
 */
import type { Map as MaplibreMap } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { applyDraftArea, eraseCustomers, finishDraftTool, undoErase } from '../../app/draftActions';
import { useDraftStore } from '../../store/useDraftStore';

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 이보다 적게 움직이면 끌기가 아니라 클릭으로 본다 (화면 px) */
const CLICK_PX = 5;
/** 클릭으로 수용가를 고를 때 찾는 반경 (화면 px) */
const PICK_PX = 12;

export function DraftMapTool({ getMap }: { getMap: () => MaplibreMap | null }) {
  const tool = useDraftStore((s) => s.mapTool);
  const undoCount = useDraftStore((s) => s.removed.length);
  const removedTotal = useDraftStore((s) => s.removed.reduce((n, b) => n + b.length, 0));
  const customers = useDraftStore((s) => s.customers.length);
  const [rect, setRect] = useState<Rect | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const map = getMap();
    if (!tool || !map) return;
    const container = map.getCanvasContainer();
    map.dragPan.disable();
    map.boxZoom.disable();
    map.doubleClickZoom.disable();
    const local = (e: MouseEvent) => {
      const r = container.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const p = local(e);
      start.current = p;
      setRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    };
    const move = (e: MouseEvent) => {
      if (!start.current) return;
      const p = local(e);
      setRect({ x0: start.current.x, y0: start.current.y, x1: p.x, y1: p.y });
    };
    const up = (e: MouseEvent) => {
      const s = start.current;
      if (!s) return;
      start.current = null;
      setRect(null);
      const p = local(e);
      const clicked = Math.hypot(p.x - s.x, p.y - s.y) < CLICK_PX;
      const toLngLat = (x: number, y: number): [number, number] => {
        const ll = map.unproject([x, y]);
        return [ll.lng, ll.lat];
      };
      if (tool === 'area') {
        if (clicked) return; // 끌지 않고 누르기만 하면 무시 — 다시 끌면 된다
        const a = toLngLat(Math.min(s.x, p.x), Math.max(s.y, p.y));
        const b = toLngLat(Math.max(s.x, p.x), Math.min(s.y, p.y));
        applyDraftArea([a[0], a[1], b[0], b[1]]);
        return;
      }
      // 수용가 빼기
      const list = useDraftStore.getState().customers;
      if (clicked) {
        let best = '';
        let bestD = PICK_PX;
        for (const c of list) {
          const q = map.project(c.position);
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d <= bestD) [best, bestD] = [c.id, d];
        }
        if (best) eraseCustomers([best]);
        return;
      }
      const [xa, xb] = [Math.min(s.x, p.x), Math.max(s.x, p.x)];
      const [ya, yb] = [Math.min(s.y, p.y), Math.max(s.y, p.y)];
      const ids = list
        .filter((c) => {
          const q = map.project(c.position);
          return q.x >= xa && q.x <= xb && q.y >= ya && q.y <= yb;
        })
        .map((c) => c.id);
      if (ids.length) eraseCustomers(ids);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finishDraftTool();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && tool === 'erase') {
        e.preventDefault();
        e.stopPropagation();
        undoErase();
      }
    };
    container.addEventListener('mousedown', down, true);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('keydown', key, true);
    return () => {
      container.removeEventListener('mousedown', down, true);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('keydown', key, true);
      map.dragPan.enable();
      map.boxZoom.enable();
      map.doubleClickZoom.enable();
      start.current = null;
      setRect(null);
    };
  }, [tool, getMap]);

  if (!tool) return null;
  const erase = tool === 'erase';
  return (
    <>
      {rect && (
        <div
          className={`pointer-events-none absolute z-20 border-2 ${erase ? 'border-red-400 bg-red-400/15' : 'border-white bg-white/10'}`}
          style={{ left: Math.min(rect.x0, rect.x1), top: Math.min(rect.y0, rect.y1), width: Math.abs(rect.x1 - rect.x0), height: Math.abs(rect.y1 - rect.y0) }}
        />
      )}
      <div className="absolute left-1/2 top-3 z-20 flex w-max max-w-[calc(100%-7rem)] -translate-x-1/2 items-center gap-2 rounded-md border border-line bg-panel/95 px-3 py-1.5 text-xs text-ink-soft shadow-lg">
        {erase ? (
          <>
            <span>
              <b className="text-ink">수용가 빼기</b> — 클릭: 한 곳 · 끌기: 네모 안 전부 · 남은 {customers.toLocaleString()}곳
              {removedTotal > 0 && ` · 뺀 ${removedTotal.toLocaleString()}곳`}
            </span>
            <button type="button" disabled={undoCount === 0} onClick={undoErase} className="whitespace-nowrap rounded border border-line px-2 py-0.5 text-ink hover:bg-raised disabled:opacity-40">
              되돌리기
            </button>
          </>
        ) : (
          <span>
            <b className="text-ink">범위 지정</b> — 지도를 누른 채 끌어 네모를 그리세요 (휠로 확대·축소)
          </span>
        )}
        <button type="button" onClick={finishDraftTool} className="whitespace-nowrap rounded border border-accent/60 bg-accent/20 px-2 py-0.5 text-ink hover:bg-accent/30">
          {erase ? '끝내기' : '취소'}
        </button>
      </div>
    </>
  );
}
