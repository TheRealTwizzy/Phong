import React from 'react';
import { Achievement } from '../../types';
import { LockBadge } from './LockBadge';

// One control for every "pick exactly one of these" row: AI difficulty,
// winning score, auto-serve timer, and the room's terms in the lobby.
//
// The selected state is exposed as `aria-checked` and `data-selected` rather
// than being inferable only from a colour. The e2e suite used to read
// `el.className.includes('border-accent')` to find the selection, which
// coupled the tests to a literal Tailwind class and meant any restyle broke
// them; `data-selected` follows the precedent already set by `data-locked` on
// the achievement branch tabs.
//
// `disabled` stays a REAL attribute on a locked or read-only segment: the
// suites read el.disabled to assert what a new player may play and that a
// guest cannot edit the host's terms. A locked segment therefore cannot be
// its own tap target, which is why the lock affordance is an overlay — see
// LockBadge.

export interface SegmentOption<T> {
  value: T;
  /** e.g. 'menu-pts-5', 'lobby-pts-3'. */
  id: string;
  label: React.ReactNode;
  /** The win-% under a difficulty, say. */
  sublabel?: React.ReactNode;
  sublabelId?: string;
  sublabelTone?: 'win' | 'warn' | 'loss' | 'muted';
  /** A ribbon over the segment, e.g. the BALANCED recommendation. */
  badge?: { id?: string; text: string };
  /** Present = gated. Disables the segment and renders the lock affordance. */
  lock?: Achievement | null;
  lockId?: string;
  /** Disabled for a reason that is not a gate (a guest reading host terms). */
  disabled?: boolean;
}

export interface SegmentedControlProps<T> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  columns?: 2 | 3 | 4;
  /** Visible but not editable — every segment keeps a real disabled attribute. */
  readOnly?: boolean;
  ariaLabel: string;
  /** Omit and a lock renders as a plain marker instead of a tappable reveal. */
  onLockTap?: (achievement: Achievement) => void;
  className?: string;
}

const COLUMNS = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
} as const;

const SUBLABEL_TONE = {
  win: 'text-win',
  warn: 'text-warn',
  loss: 'text-loss',
  muted: 'text-ink-muted',
} as const;

export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  columns = 4,
  readOnly = false,
  ariaLabel,
  onLockTap,
  className = '',
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`grid gap-1.5 ${COLUMNS[columns]} ${className}`}
    >
      {options.map((o) => {
        const locked = Boolean(o.lock);
        const selected = o.value === value;
        const isDisabled = readOnly || locked || Boolean(o.disabled);

        return (
          <div key={String(o.value)} className="relative">
            <button
              id={o.id}
              type="button"
              role="radio"
              aria-checked={selected}
              data-selected={selected ? 'true' : 'false'}
              disabled={isDisabled}
              onClick={() => onChange(o.value)}
              className={`flex w-full min-h-9 flex-col items-center justify-center gap-0.5 rounded-ctl border px-1 py-1.5 text-2xs transition-colors ${
                locked
                  ? 'border-line bg-surface-1 text-locked'
                  : selected
                    ? 'border-accent bg-accent/12 text-accent'
                    : 'border-line bg-surface-3 text-ink-muted'
              } ${readOnly ? 'cursor-default' : ''} ${
                o.disabled && !locked ? 'opacity-60' : ''
              }`}
            >
              {o.label}
              {o.sublabel != null && (
                <span
                  id={o.sublabelId}
                  className={`text-2xs tnum ${
                    SUBLABEL_TONE[o.sublabelTone ?? 'muted']
                  }`}
                >
                  {o.sublabel}
                </span>
              )}
            </button>

            {o.badge && (
              <span
                id={o.badge.id}
                className="pointer-events-none absolute -top-1.5 left-1/2 -translate-x-1/2 rounded-chip bg-accent px-1 text-2xs text-ink-on-accent"
              >
                {o.badge.text}
              </span>
            )}

            {locked && (
              <LockBadge id={o.lockId} achievement={o.lock!} onReveal={onLockTap} />
            )}
          </div>
        );
      })}
    </div>
  );
}
