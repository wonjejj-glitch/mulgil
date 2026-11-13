import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 하단 버튼 영역. 왼쪽 안내문이 필요하면 첫 자식에 `mr-auto` 를 준다. */
  footer?: ReactNode;
  /** 대화상자 너비 Tailwind 클래스 (기본 560px). */
  widthClass?: string;
}

/** 공용 대화상자 틀: Esc·배경 클릭으로 닫기, 본문 스크롤, 하단 버튼 영역. */
export function Modal({ title, onClose, children, footer, widthClass = 'w-[560px]' }: ModalProps) {
  const panel = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    panel.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // 전역 단축키(도구 해제 등)가 함께 반응하지 않도록 여기서 끝낸다.
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`flex max-h-[88vh] max-w-full flex-col rounded-lg border border-line bg-panel shadow-2xl outline-none ${widthClass}`}
      >
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-line px-4">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <button
            type="button"
            aria-label="닫기"
            onClick={onClose}
            className="rounded p-1 text-ink-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer && <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
