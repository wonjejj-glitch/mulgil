import { CircleCheck, CircleX, Info, LocateFixed, TriangleExclamationPoint, X, type LucideIcon } from 'lucide-react';
import { useEffect } from 'react';
import { focusObjects } from '../../app/actions';
import { useUIStore, type Toast, type ToastLevel } from '../../store/useUIStore';

/** life: 자동으로 사라지기까지의 시간(ms). null 이면 사용자가 닫을 때까지 남는다. */
const LEVELS: Record<ToastLevel, { icon: LucideIcon; iconClass: string; borderClass: string; label: string; life: number | null }> = {
  info: { icon: Info, iconClass: 'text-accent', borderClass: 'border-line-strong', label: '안내', life: 5000 },
  success: { icon: CircleCheck, iconClass: 'text-good', borderClass: 'border-good/50', label: '완료', life: 5000 },
  warning: { icon: TriangleExclamationPoint, iconClass: 'text-warn', borderClass: 'border-warn/60', label: '경고', life: 15000 },
  error: { icon: CircleX, iconClass: 'text-critical', borderClass: 'border-critical/70', label: '오류', life: null },
};

function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useUIStore((s) => s.dismissToast);
  const level = LEVELS[toast.level];
  const Icon = level.icon;
  const highlight = toast.highlight;

  useEffect(() => {
    if (level.life === null) return;
    const timer = window.setTimeout(() => dismiss(toast.id), level.life);
    return () => window.clearTimeout(timer);
  }, [toast.id, level.life, dismiss]);

  return (
    <div
      role={toast.level === 'error' || toast.level === 'warning' ? 'alert' : 'status'}
      className={`toast-enter pointer-events-auto w-[360px] max-w-full rounded-md border bg-panel/95 p-3 shadow-xl backdrop-blur ${level.borderClass}`}
    >
      <div className="flex items-start gap-2.5">
        <Icon size={16} className={`mt-0.5 shrink-0 ${level.iconClass}`} aria-label={level.label} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold leading-snug text-ink">{toast.title}</p>
          {toast.message && <p className="mt-1 text-xs leading-relaxed text-ink-soft">{toast.message}</p>}
          {toast.details && toast.details.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 border-l-2 border-line pl-2 text-[11px] leading-relaxed text-ink-muted">
              {toast.details.slice(0, 5).map((detail, index) => (
                <li key={index} className="break-words">
                  {detail}
                </li>
              ))}
            </ul>
          )}
          {highlight && (
            <button
              type="button"
              onClick={() => focusObjects(highlight)}
              className="mt-2 inline-flex h-6 items-center gap-1.5 rounded border border-line bg-raised px-2 text-[11px] font-medium text-ink transition-colors hover:border-line-strong"
            >
              <LocateFixed size={12} />
              문제 위치 보기
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="알림 닫기"
          onClick={() => dismiss(toast.id)}
          className="shrink-0 rounded p-0.5 text-ink-muted transition-colors hover:bg-raised hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

/** 지도 우상단의 알림 스택. 해석 경고·오류를 한국어로 알리고 문제 객체로 이동할 수 있게 한다. */
export function Toaster() {
  const toasts = useUIStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none absolute right-14 top-3 z-20 flex max-w-[calc(100%-5rem)] flex-col items-end gap-2">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
