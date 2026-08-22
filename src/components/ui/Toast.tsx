import React from 'react';
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

const TONE = {
  info: 'border-accent/50 bg-accent/15 text-accent',
  win: 'border-win/50 bg-win/15 text-win',
  warn: 'border-warn/50 bg-warn/15 text-warn',
  loss: 'border-loss/50 bg-loss/15 text-loss',
  xp: 'border-xp/50 bg-xp/15 text-xp',
} as const;

export interface ToastSpec {
  id: string;
  tone?: keyof typeof TONE;
  content: React.ReactNode;
  /** Tapping dismisses; every toast in this app is dismiss-on-tap. */
  onDismiss: () => void;
}

export const ToastHost: React.FC<{ toasts: ToastSpec[] }> = ({ toasts }) => {
  const m = useMotion();
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex flex-col items-center gap-1.5 px-4 pt-safe">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.button
            key={toast.id}
            id={toast.id}
            layout={m.reduced ? false : 'position'}
            onClick={toast.onDismiss}
            className={`pointer-events-auto max-w-full rounded-card border px-4 py-2 text-2xs shadow-card ${
              TONE[toast.tone ?? 'info']
            }`}
            {...m.toast}
          >
            {toast.content}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
};
