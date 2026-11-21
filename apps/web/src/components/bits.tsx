import { type ButtonHTMLAttributes, type ReactNode, useState } from 'react';
import type { Side } from '@/api/types';
import { cn } from '@/lib/cn';

/** A figure: mono, tabular. */
export function Num({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span className={cn('num', className)} title={title}>
      {children}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'num rounded-tag border border-current px-3 text-xs font-medium opacity-80',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** Side is always a glyph and a word, as well as a colour. */
export function SideTag({ side, className }: { side: Side; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block min-w-25 rounded-tag px-3 py-px text-center text-xs font-semibold',
        side === 'buy' ? 'bg-buy-wash text-buy' : 'bg-sell-wash text-sell',
        className,
      )}
    >
      {side === 'buy' ? '▲ Buy' : '▼ Sell'}
    </span>
  );
}

const TONES = {
  buy: 'border-l-buy bg-buy-wash',
  sell: 'border-l-sell bg-sell-wash',
  info: 'border-l-info bg-info-wash',
  success: 'border-l-success bg-success-wash',
  warning: 'border-l-warning bg-warning-wash',
  danger: 'border-l-danger bg-danger-wash',
  plain: 'border-l-line-strong bg-well',
} as const;
export type Tone = keyof typeof TONES;

/** A sentence with a ruled left edge: what an order will do, what happened, or why it was refused. */
export function Callout({
  tone,
  title,
  children,
  className,
  role,
}: {
  tone: Tone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  role?: 'alert' | 'status';
}) {
  return (
    <div
      role={role}
      className={cn(
        'rounded-r-field border-l-[length:var(--border-accent)] px-5 py-4 text-sm text-ink',
        TONES[tone],
        className,
      )}
    >
      {title && <p className="font-semibold">{title}</p>}
      {children}
    </div>
  );
}

const BUTTONS = {
  buy: 'bg-buy text-on-buy',
  sell: 'bg-sell text-on-sell',
  brand: 'bg-brand text-on-brand',
  outline: 'border border-line-strong bg-surface text-ink',
  danger: 'border border-danger bg-surface text-danger',
  'danger-solid': 'bg-danger text-surface',
} as const;

export function Button({
  variant = 'outline',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTONS;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-4 whitespace-nowrap font-medium disabled:opacity-55',
        size === 'sm' && 'rounded-tag px-4 py-1 text-sm',
        size === 'md' && 'h-15 rounded-field px-7 text-md',
        size === 'lg' &&
          'h-22 w-full justify-between rounded-panel px-7 font-display text-lg font-semibold',
        BUTTONS[variant],
        className,
      )}
      {...props}
    />
  );
}

/** An inline action that reads as a link. */
export function LinkButton({
  className,
  tone = 'info',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'info' | 'danger' | 'ink' }) {
  return (
    <button
      type="button"
      className={cn(
        'rounded-tag text-sm underline underline-offset-4 disabled:opacity-55',
        tone === 'info' && 'text-info',
        tone === 'danger' && 'text-danger',
        tone === 'ink' && 'text-ink-2',
        className,
      )}
      {...props}
    />
  );
}

export function CopyButton({
  text,
  label = 'Copy',
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={cn('rounded-tag px-4 py-1 text-xs font-semibold', className)}
      aria-live="polite"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

/** A small word-and-colour marker for a state. `shape` adds the non-colour cue. */
export function StateChip({
  tone,
  shape = 'solid',
  children,
}: {
  tone: 'open' | 'partial' | 'filled' | 'cancelled' | 'pending' | 'replayed' | 'stale' | 'danger';
  shape?: 'solid' | 'dashed' | 'outline';
  children: ReactNode;
}) {
  const colour = {
    open: 'text-state-open border-state-open',
    partial: 'text-notice-ink border-notice-ink',
    filled: 'text-success border-success',
    cancelled: 'text-ink-3 border-ink-3',
    pending: 'text-you border-you',
    replayed: 'text-info border-info',
    stale: 'text-warning border-warning',
    danger: 'text-danger border-danger',
  }[tone];
  return (
    <span
      className={cn(
        'inline-block whitespace-nowrap rounded-tag border px-3 text-xs font-medium',
        colour,
        shape === 'dashed' && 'border-dashed',
        shape === 'solid' && 'border-transparent px-0',
      )}
    >
      {children}
    </span>
  );
}
