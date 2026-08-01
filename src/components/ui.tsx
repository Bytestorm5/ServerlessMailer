'use client';

import { clsx } from '@/lib/clsx';
import type { ReactNode } from 'react';

/** Small shared primitives. Deliberately plain — this is an internal tool. */

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'default',
  disabled,
  className,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const variants: Record<string, string> = {
    default: 'bg-white border border-ink-200 text-ink-800 hover:bg-ink-50',
    primary: 'bg-ink-900 text-white hover:bg-ink-800 border border-ink-900',
    danger: 'bg-red-600 text-white hover:bg-red-700 border border-red-600',
    ghost: 'bg-transparent text-ink-600 hover:bg-ink-100 border border-transparent',
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('rounded-lg border border-ink-200 bg-white p-5 shadow-sm', className)}>{children}</div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tones: Record<string, string> = {
    draft: 'bg-ink-100 text-ink-700',
    scheduled: 'bg-blue-100 text-blue-800',
    sending: 'bg-amber-100 text-amber-900',
    paused: 'bg-orange-100 text-orange-900',
    sent: 'bg-emerald-100 text-emerald-900',
    failed: 'bg-red-100 text-red-800',
    confirmed: 'bg-emerald-100 text-emerald-900',
    pending: 'bg-amber-100 text-amber-900',
    unsubscribed: 'bg-ink-100 text-ink-700',
    bounced: 'bg-red-100 text-red-800',
    complained: 'bg-red-200 text-red-900',
  };
  return (
    <span
      className={clsx(
        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        tones[status] ?? 'bg-ink-100 text-ink-700',
      )}
    >
      {status}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-ink-500">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  'w-full rounded border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-ink-500 focus:ring-1 focus:ring-ink-500';

export function Spinner() {
  return (
    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-300 border-t-ink-700" />
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{children}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-white/60 p-10 text-center">
      <p className="font-medium text-ink-700">{title}</p>
      {children ? <div className="mt-1 text-sm text-ink-500">{children}</div> : null}
    </div>
  );
}
