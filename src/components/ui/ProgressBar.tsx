import React, { useEffect } from 'react';
import { motion } from 'motion/react';
import { useMotion } from './motion';
import { meterOrigin, rememberMeter } from './meterMemory';
import { ladderStop } from './ladderTone';

// Fills with transform: scaleX(), never width. Animating width relayouts the
// bar on every frame; a transform runs on the compositor. The visual result
// is identical because the fill is a solid block.

const TONE = {
  accent: 'bg-accent',
  xp: 'bg-xp',
  win: 'bg-win',
  loss: 'bg-loss',
  warn: 'bg-warn',
  // Picked by the fill rather than by this map — see LADDER below and
  // ladderTone.ts. The entry exists so `ladder` is a real key of TONE and the
  // union below needs no special case.
  ladder: '',
} as const;

/**
 * The one tone chosen by VALUE. `TONE` is static because every other bar means
 * one thing whatever it reads; the ladder meter takes low/mid/high by how full
 * it is, so it is resolved per render instead.
 */
const LADDER = ['bg-ladder-low', 'bg-ladder-mid', 'bg-ladder-high'] as const;

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
  /**
   * Resume from where this meter last stood instead of filling from empty on
   * every mount. The key names a BAND — see meterMemory.ts — and it is
   * deliberately NOT the `id`: an `id` is a Playwright selector contract that
   * has to stay stable, while a resume key has to CHANGE at a band boundary.
   * Directly conflicting requirements, so they are two props.
   */
  resumeKey?: string;
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
  resumeKey,
}) => {
  const m = useMotion();
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

  // A pure Map read on every render, consumed only when the keyed fill MOUNTS,
  // so StrictMode's double render costs nothing and cannot poison it — unlike a
  // first-run flag, which the first setup spends (see useArrivalRefetch.ts).
  // Reduced motion resumes nothing: with m.meter at duration 0 an origin would
  // be a one-frame flash of the stale value, which is the thing being avoided.
  const from = !resumeKey || m.reduced ? 0 : meterOrigin(resumeKey);

  // Written from an effect and never during render. The value recorded is the
  // TARGET rather than the painted position, so leaving the menu mid-tween
  // remembers where the bar was heading — right for a number that is already
  // true on the server.
  useEffect(() => {
    if (resumeKey) rememberMeter(resumeKey, pct);
  }, [resumeKey, pct]);

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
        {/* `key` is what makes a band change re-read `initial`: motion consumes
            it at mount only, so without this a level-up would keep the previous
            level's origin forever. `key={undefined}` is identical to no key, so
            every call site that passes no resumeKey is unchanged. */}
        <motion.div
          key={resumeKey}
          // transition-colors so a bar crossing a ladder threshold eases into
          // the next stop instead of snapping mid-tween. It is inert for every
          // other tone, whose class never changes, and reduced motion drops it
          // along with the scaleX tween m.meter already zeroes.
          className={`h-full origin-left rounded-chip transition-colors motion-reduce:transition-none ${
            tone === 'ladder' ? LADDER[ladderStop(pct)] : TONE[tone]
          }`}
          initial={animate ? { scaleX: from } : false}
          animate={{ scaleX: pct }}
          transition={m.meter}
          style={{ width: '100%' }}
        />
      </div>
    </div>
  );
};
