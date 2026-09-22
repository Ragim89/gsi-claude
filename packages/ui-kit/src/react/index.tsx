import React from 'react';
import { toCssVariables } from '../tokens';
import './ui-kit.css';

/**
 * Injects design tokens as CSS custom properties. Render once at the app root.
 * All components below style themselves only through var(--gsi-…).
 * Layout uses CSS logical properties (margin-inline-start etc.) so RTL (ar) works
 * by setting dir="rtl" on <html> — see docs/02-localization.md.
 */
export function ThemeStyle() {
  return <style data-gsi-tokens>{toCssVariables()}</style>;
}

type ButtonVariant = 'primary' | 'secondary' | 'accent' | 'danger' | 'ghost';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
}

export function Button({ variant = 'primary', size = 'md', loading, disabled, className, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx('gsi-btn', `gsi-btn--${variant}`, `gsi-btn--${size}`, className)}
    >
      {loading ? <Spinner size={14} /> : null}
      {children}
    </button>
  );
}

export function Card({ title, actions, children, className }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cx('gsi-card', className)}>
      {(title || actions) && (
        <header className="gsi-card__header">
          {title ? <h2 className="gsi-card__title">{title}</h2> : <span />}
          {actions ? <div className="gsi-card__actions">{actions}</div> : null}
        </header>
      )}
      <div className="gsi-card__body">{children}</div>
    </section>
  );
}

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: React.ReactNode }) {
  return <span className={cx('gsi-badge', `gsi-badge--${tone}`)}>{children}</span>;
}

export function Field({ label, hint, error, children }: { label: React.ReactNode; hint?: React.ReactNode; error?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="gsi-field">
      <span className="gsi-field__label">{label}</span>
      {children}
      {error ? <span className="gsi-field__error">{error}</span> : hint ? <span className="gsi-field__hint">{hint}</span> : null}
    </label>
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} {...rest} className={cx('gsi-input', className)} />;
});

export const TextArea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} {...rest} className={cx('gsi-input', 'gsi-textarea', className)} />;
});

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...rest },
  ref,
) {
  return <select ref={ref} {...rest} className={cx('gsi-input', 'gsi-select', className)} />;
});

export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="gsi-table-wrap">
      <table className="gsi-table">{children}</table>
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="gsi-empty">{children}</div>;
}

export function Spinner({ size = 20 }: { size?: number }) {
  return <span className="gsi-spinner" style={{ width: size, height: size }} aria-hidden />;
}

export function Alert({ tone = 'danger', children }: { tone?: BadgeTone; children: React.ReactNode }) {
  return (
    <div role="alert" className={cx('gsi-alert', `gsi-alert--${tone}`)}>
      {children}
    </div>
  );
}

/** Segmented single-choice control (used for checklist OK / deviation / N/A). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T | null;
  options: { value: T; label: React.ReactNode; tone?: BadgeTone }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="gsi-segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          className={cx('gsi-segmented__opt', value === o.value && `is-active gsi-segmented__opt--${o.tone ?? 'info'}`)}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
