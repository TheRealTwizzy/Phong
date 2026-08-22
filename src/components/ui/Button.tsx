import React from 'react';
import { Loader2 } from 'lucide-react';

// Apple's HIG puts the minimum size for a tappable control at 44×44pt, which
// is what min-h-11 on `md` and `lg` implements. `sm` is for controls that sit
// inside a larger tap target and is not a general-purpose size — where a
// small glyph needs a bigger target, pad the target rather than shrinking
// below this floor.

const VARIANT = {
  primary: 'bg-accent text-ink-on-accent shadow-accent hover:bg-accent-press',
  secondary: 'bg-surface-3 text-ink border border-line-strong hover:bg-surface-4',
  ghost: 'bg-transparent text-ink-muted border border-line hover:bg-surface-3 hover:text-ink',
  danger: 'bg-loss text-ink shadow-card hover:brightness-110',
  quiet: 'bg-transparent text-ink-muted hover:text-ink',
} as const;

const SIZE = {
  sm: 'min-h-8 px-2.5 py-1.5 text-2xs gap-1 rounded-ctl',
  md: 'min-h-11 px-3.5 py-2 text-2xs gap-1.5 rounded-ctl',
  lg: 'min-h-11 px-4 py-3 text-kicker gap-2 rounded-card',
} as const;

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: keyof typeof VARIANT;
  size?: keyof typeof SIZE;
  icon?: React.ReactNode;
  iconRight?: React.ReactNode;
  loading?: boolean;
  block?: boolean;
  className?: string;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  block = false,
  disabled,
  className = '',
  children,
  ...rest
}) => (
  <button
    {...rest}
    disabled={disabled || loading}
    className={`inline-flex items-center justify-center font-display uppercase transition-colors select-none active:scale-[0.98] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none ${
      VARIANT[variant]
    } ${SIZE[size]} ${block ? 'w-full' : ''} ${className}`}
  >
    {loading ? <Loader2 className="h-4 w-4 animate-spin" data-motion-essential /> : icon}
    {children}
    {iconRight}
  </button>
);
