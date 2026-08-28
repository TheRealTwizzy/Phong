import React, { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useMotion } from './motion';

// One toast surface. App.tsx had five hand-rolled <button> toasts inline —
// unlock, practice XP, ejected, opponent-left, record-failed — each with its
// own copy of the same absolute positioning and its own colour guess, and
// none of them animating out. They stack here instead, so two arriving
// together no longer draw on top of each other.
//
// Each toast keeps its own id, because that is what the suites reach for
// (#toast-ejected, #toast-opponent-left).
//
// The host owns BOTH halves of what makes a notification temporary — the
// timer and the tap target — so neither can be forgotten at a call site.
// The achievement toast used to own its own of each: it had no tap handler
// at all, and its timer was armed by an effect that listed the dismiss
// callback among its dependencies. App rebuilds that callback on every
// render and re-renders once per animation frame while a ball is in play, so
// the timer was torn down and re-armed sixty times a second and never got to
// fire. It outlived the match that raised it, and the menu after that.

const TONE = {
  info: 'border-accent/50 bg-accent/15 text-accent',
  win: 'border-win/50 bg-win/15 text-win',
  warn: 'border-warn/50 bg-warn/15 text-warn',
  loss: 'border-loss/50 bg-loss/15 text-loss',
  xp: 'border-xp/50 bg-xp/15 text-xp',
} as const;

/**
 * How long each kind of notice holds the top of the screen. Together here
 * rather than as loose numbers at seven call sites, because the only way to
 * judge one is against the others.
 */
export const TOAST_TTL = {
  /** An unlock or a level — read the name, take the confetti, move on. */
  celebration: 3000,
  /** Something the player earned and may want to read twice. */
  reward: 6000,
  /** Something went wrong; it owes them longer to take it in. */
  notice: 8000,
} as const;

export interface ToastSpec {
  id: string;
  tone?: keyof typeof TONE;
  /**
   * A `card` brings its own chrome and only wants the positioning, the
   * motion and the tap target; the default pill takes the tone classes.
   */
  chrome?: 'pill' | 'card';
  /** Rendered as `data-toast`, so a suite can find a kind without an id. */
  kind?: string;
  content: React.ReactNode;
  /** Auto-dismiss after this long. Omit for a toast that waits to be tapped. */
  ttlMs?: number;
  /** Tapping dismisses; every toast in this app is dismiss-on-tap. */
  onDismiss: () => void;
}

const ToastItem: React.FC<{ spec: ToastSpec }> = ({ spec }) => {
  const m = useMotion();

  // The callback is rebuilt by App on every render. Reading it through a ref
  // keeps it current while the effect below sees only stable primitives —
  // which is the whole reason a toast now expires when it says it will.
  const dismiss = useRef(spec.onDismiss);
  dismiss.current = spec.onDismiss;

  const { id, ttlMs } = spec;
  useEffect(() => {
    if (!ttlMs) return;
    const timer = setTimeout(() => dismiss.current(), ttlMs);
    return () => clearTimeout(timer);
  }, [id, ttlMs]);

  return (
    <motion.button
      id={id}
      data-toast={spec.kind}
      layout={m.reduced ? false : 'position'}
      onClick={() => dismiss.current()}
      className={
        spec.chrome === 'card'
          ? 'pointer-events-auto w-full max-w-md text-left'
          : `pointer-events-auto max-w-full rounded-card border px-4 py-2 text-2xs shadow-card ${
              TONE[spec.tone ?? 'info']
            }`
      }
      {...m.toast}
    >
      {spec.content}
    </motion.button>
  );
};

export const ToastHost: React.FC<{ toasts: ToastSpec[] }> = ({ toasts }) => (
  // z-[75] clears every Sheet: the bands are 50/60/70 and a stacked sheet adds
  // its depth, capped at four, so 74 is the highest one can reach. Stays under
  // the onboarding tour's 80. At z-50 this stack sat EARLIER in the DOM than the modals, so
  // the theme-unlock notice was painted over by the very Missions sheet that
  // raised it — invisible until the player closed it, and now that it expires
  // on a timer, invisible for good.
  <div
    role="status"
    aria-live="polite"
    className="pointer-events-none absolute inset-x-0 top-0 z-[75] flex flex-col items-center gap-1.5 px-4 pt-safe-bar"
  >
    <AnimatePresence initial={false}>
      {toasts.map((toast) => (
        <ToastItem key={toast.id} spec={toast} />
      ))}
    </AnimatePresence>
  </div>
);
