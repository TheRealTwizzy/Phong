import { useReducedMotion, type TargetAndTransition, type Transition } from 'motion/react';

// The app's whole motion vocabulary, in one place.
//
// The direction is "restrained and fast": every move is short, eased out, and
// runs on the compositor. Springs are deliberately absent — they overshoot,
// and an overshoot reads as playful rather than competitive. Nothing here
// animates width, height, top/left, box-shadow, filter or backdrop-filter;
// transform and opacity only, so a mid-range phone holds 60fps.
//
// Reduced motion is handled ONCE, here: useMotion() collapses every duration
// to zero, so a component inherits the accessibility behaviour by using the
// hook rather than by remembering to check for it.

export const EASE_QUICK: [number, number, number, number] = [0.22, 1, 0.36, 1];
export const EASE_EXIT: [number, number, number, number] = [0.64, 0, 0.78, 0];

export const DURATION = {
  enter: 0.18,
  exit: 0.12,
  state: 0.14,
  /** Progress fills and rank rings — long enough to read as a change. */
  meter: 0.42,
} as const;

const NONE: Transition = { duration: 0 };

const enterT = (duration: number = DURATION.enter): Transition => ({
  duration,
  ease: EASE_QUICK,
});

const exitT = (): Transition => ({ duration: DURATION.exit, ease: EASE_EXIT });

/** A spreadable set of `motion` props: `<motion.div {...m.card} />`. */
export interface Choreography {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
  transition: Transition;
}

function choreograph(
  from: TargetAndTransition,
  to: TargetAndTransition,
  reduced: boolean,
  enterDuration?: number
): Choreography {
  if (reduced) {
    return { initial: to, animate: to, exit: to, transition: NONE };
  }
  return {
    initial: from,
    animate: to,
    // motion reads a `transition` inside the exit target, which is how the
    // leave gets its own faster, differently eased curve.
    exit: { ...from, transition: exitT() },
    transition: enterT(enterDuration),
  };
}

export interface MotionSet {
  reduced: boolean;
  /** Scrim behind a sheet. */
  backdrop: Choreography;
  /** A centred sheet card. */
  card: Choreography;
  /** A sheet that rises from the bottom edge. */
  bottomCard: Choreography;
  /** A toast entering from the top. */
  toast: Choreography;
  /** Screen-to-screen swap, for AnimatePresence mode="wait". */
  screen: Choreography;
  /** Progress fills, rank rings — anything animating a magnitude. */
  meter: Transition;
  /** A colour or state change on a control. */
  state: Transition;
}

export function useMotion(): MotionSet {
  const reduced = useReducedMotion() ?? false;
  return {
    reduced,
    backdrop: choreograph({ opacity: 0 }, { opacity: 1 }, reduced, 0.14),
    card: choreograph(
      { opacity: 0, y: 12, scale: 0.985 },
      { opacity: 1, y: 0, scale: 1 },
      reduced
    ),
    bottomCard: choreograph({ opacity: 0, y: 24 }, { opacity: 1, y: 0 }, reduced, 0.2),
    toast: choreograph({ opacity: 0, y: -12 }, { opacity: 1, y: 0 }, reduced),
    screen: choreograph(
      { opacity: 0, scale: 1.012 },
      { opacity: 1, scale: 1 },
      reduced,
      0.16
    ),
    meter: reduced ? NONE : enterT(DURATION.meter),
    state: reduced ? NONE : { duration: DURATION.state, ease: EASE_QUICK },
  };
}
