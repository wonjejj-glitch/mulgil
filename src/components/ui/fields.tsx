import { useEffect, useState, type ReactNode } from 'react';

const INPUT_CLASS =
  'h-7 w-full min-w-0 rounded border border-line bg-field px-2 text-xs text-ink outline-none transition-colors focus:border-accent disabled:cursor-not-allowed disabled:opacity-50';

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line px-3 py-3">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

export function FieldRow({
  label,
  unit,
  plain,
  children,
}: {
  label: string;
  unit?: string;
  /** 입력 컨트롤이 아닌 내용(버튼 묶음 등)을 담을 때 true — label 요소의 클릭 전달을 피한다. */
  plain?: boolean;
  children: ReactNode;
}) {
  const Wrapper = plain ? 'div' : 'label';
  return (
    <Wrapper className="grid grid-cols-[92px_1fr] items-center gap-2 py-0.5">
      <span className="truncate text-xs text-ink-soft" title={label}>
        {label}
        {unit && <span className="ml-1 text-ink-muted">{unit}</span>}
      </span>
      {children}
    </Wrapper>
  );
}

interface NumberFieldProps {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  step?: number;
  disabled?: boolean;
}

/** 입력 중에는 로컬 문자열을 유지하고, 포커스를 잃거나 Enter 를 누를 때만 값을 확정한다. */
export function NumberField({ value, onCommit, min, step, disabled }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(parsed) || (min !== undefined && parsed < min)) {
      setDraft(String(value));
      return;
    }
    if (parsed !== value) onCommit(parsed);
    else setDraft(String(value));
  };

  return (
    <input
      type="number"
      className={`${INPUT_CLASS} tabular-nums`}
      value={draft}
      min={min}
      step={step ?? 'any'}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(String(value));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

interface TextFieldProps {
  value: string;
  onCommit: (value: string) => boolean | void;
  placeholder?: string;
  disabled?: boolean;
}

export function TextField({ value, onCommit, placeholder, disabled }: TextFieldProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const next = draft.trim();
    if (next === value) {
      setDraft(value);
      return;
    }
    if (onCommit(next) === false) setDraft(value);
  };

  return (
    <input
      type="text"
      className={INPUT_CLASS}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

interface SelectFieldProps<T extends string> {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

export function SelectField<T extends string>({ value, options, onChange, disabled }: SelectFieldProps<T>) {
  return (
    <select
      className={`${INPUT_CLASS} cursor-pointer pr-1`}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function ReadonlyValue({ children }: { children: ReactNode }) {
  return <span className="truncate text-xs tabular-nums text-ink">{children}</span>;
}

interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  title?: string;
  className?: string;
}

const BUTTON_VARIANTS: Record<NonNullable<ButtonProps['variant']>, string> = {
  default: 'border border-line bg-raised text-ink hover:border-line-strong hover:bg-line',
  primary: 'border border-accent-strong bg-accent-strong text-white hover:bg-accent',
  danger: 'border border-critical/60 bg-critical/15 text-[#f3a5a5] hover:bg-critical/30',
  ghost: 'border border-transparent text-ink-soft hover:bg-raised hover:text-ink',
};

export function Button({ children, onClick, variant = 'default', disabled, title, className = '' }: ButtonProps) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}
