import React from 'react';

// A surface inside a sheet or a screen. `inset` recedes (a well for content
// that belongs to something else), `raised` steps forward (a card that is its
// own thing), `flat` just draws the boundary.

const VARIANT = {
  flat: 'bg-surface-2 border-line',
  raised: 'bg-surface-3 border-line-strong shadow-card',
  inset: 'bg-surface-1 border-line',
} as const;

const ACCENT = {
  neutral: '',
  accent: 'border-accent/40',
  win: 'border-win/40',
  loss: 'border-loss/40',
  warn: 'border-warn/40',
  locked: 'border-locked/40',
} as const;

// HTMLElement rather than HTMLDivElement: `as` makes this a div, an li or a
// section, and the props that pass through have to be assignable to whichever
// one it renders. Typed for a div, a Panel rendered `as="li"` was handing an
// li every div-shaped event handler.
export interface PanelProps extends React.HTMLAttributes<HTMLElement> {
  variant?: keyof typeof VARIANT;
  accent?: keyof typeof ACCENT;
  /** Adds press feedback. Use on a Panel that is itself a tap target. */
  interactive?: boolean;
  padded?: boolean;
  as?: 'div' | 'li' | 'section';
}

export const Panel: React.FC<PanelProps> = ({
  variant = 'flat',
  accent = 'neutral',
  interactive = false,
  padded = true,
  as: Tag = 'div',
  className = '',
  children,
  ...rest
}) => (
  <Tag
    {...rest}
    className={`rounded-card border ${VARIANT[variant]} ${ACCENT[accent]} ${
      padded ? 'p-3' : ''
    } ${
      interactive
        ? 'transition-colors active:scale-[0.99] motion-reduce:active:scale-100 hover:bg-surface-4'
        : ''
    } ${className}`}
  >
    {children}
  </Tag>
);
