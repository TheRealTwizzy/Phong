import React from 'react';
import { motion } from 'motion/react';
import { useMotion } from './motion';

// Fills with transform: scaleX(), never width. Animating width relayouts the
// bar on every frame; a transform runs on the compositor. The visual result
// is identical because the fill is a solid block.

const TONE = {
  accent: 'bg-accent',
  xp: 'bg-xp',
  win: 'bg-win',
  loss: 'bg-loss',
  warn: 'bg-warn',
} as const;

const HEIGHT = { sm: 'h-1', md: 'h-2' } as const;

export interface ProgressBarProps {
  id?: string;
  /** 0..1. Values outside the range are clamped. */
  value: number;
  tone?: keyof typeof TONE;
  height?: keyof typeof HEIGHT;
  label?: React.ReactNode;
  trailing?: React.ReactNode;
  animate?: boolean;
  className?: string;
  /** Announced to assistive tech; the bar is decorative without it. */
  ariaLabel?: string;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  id,
  value,
  tone = 'accent',
  height = 'md',
  label,
  trailing,
  animate = true,
  className = '',
  ariaLabel,
}) => {
  const m = useMotion();
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

  return (
    <div className={className}>
      {(label != null || trailing != null) && (
        <div className="mb-1 flex items-baseline justify-between gap-2">
          {label != null && <span className="text-2xs text-ink-muted">{label}</span>}
          {trailing != null && <span className="text-2xs tnum text-ink">{trailing}</span>}
        </div>
      )}
      <div
        id={id}
        role={ariaLabel ? 'progressbar' : undefined}
        aria-label={ariaLabel}
        aria-valuenow={ariaLabel ? Math.round(pct * 100) : undefined}
        aria-valuemin={ariaLabel ? 0 : undefined}
        aria-valuemax={ariaLabel ? 100 : undefined}
        className={`w-full overflow-hidden rounded-chip bg-surface-1 ${HEIGHT[height]}`}
      >
        <motion.div
          className={`h-full origin-left rounded-chip ${TONE[tone]}`}
          initial={animate ? { scaleX: 0 } : false}
          animate={{ scaleX: pct }}
          transition={m.meter}
          style={{ width: '100%' }}
        />
      </div>
    </div>
  );
};
