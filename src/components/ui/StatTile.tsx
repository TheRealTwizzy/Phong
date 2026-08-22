import React from 'react';

// One number and what it means. The value leads; the label is the quiet part.
// Numerals are tabular so a row of tiles does not shuffle horizontally as the
// figures change.

const TONE = {
  default: 'text-ink',
  accent: 'text-accent',
  win: 'text-win',
  loss: 'text-loss',
  warn: 'text-warn',
  xp: 'text-xp',
  muted: 'text-ink-muted',
} as const;

export interface StatTileProps {
  id?: string;
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: keyof typeof TONE;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}

export const StatTile: React.FC<StatTileProps> = ({
  id,
  label,
  value,
  tone = 'default',
  icon,
  hint,
  className = '',
}) => (
  <div
    id={id}
    className={`flex flex-col items-center gap-0.5 rounded-card border border-line bg-surface-1 px-2 py-2.5 text-center ${className}`}
  >
    <div className={`flex items-center gap-1 text-title tnum ${TONE[tone]}`}>
      {icon}
      {value}
    </div>
    <div className="text-2xs font-normal tracking-normal text-ink-muted uppercase">
      {label}
    </div>
    {hint != null && <div className="text-2xs text-ink-dim">{hint}</div>}
  </div>
);
