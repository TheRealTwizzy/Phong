// Which stop of the ladder ramp a fill is at.
//
// The rank meter in the menu capsule is the one bar in the app whose colour is
// chosen by its VALUE rather than by what it means: cyan near empty, violet
// through the middle, magenta as it fills. Every other tone in ProgressBar is a
// fixed class, so this is the only rule that needs stating at all.
//
// Its own file rather than module scope inside ProgressBar.tsx, for the reason
// meterMemory.ts is its own file: a rule belongs where a test can state it, and
// vitest runs in `node` here — importing the component would drag
// `motion/react` into a test that only wants the arithmetic.
//
// The thresholds are the shape that was asked for: low up to about a third,
// mid across the middle, high from about two thirds. They are NOT tied to the
// tier bands — the meter measures progress within whichever band it is drawing,
// so the same fraction means the same colour whether it is counting placement
// games or the climb through Grandmaster.

/** Below this the meter is `low`. */
export const LADDER_MID_AT = 0.3;
/** At or above this the meter is `high`. */
export const LADDER_HIGH_AT = 0.7;

/**
 * 0, 1 or 2 — low, mid, high.
 *
 * Anything outside [0,1] is clamped and anything non-finite reads as empty,
 * because the alternative is an undefined index and a bar painted with no
 * background at all. ProgressBar clamps its own `value` the same way, so this
 * is a backstop rather than the only guard.
 */
export function ladderStop(fraction: number): 0 | 1 | 2 {
  if (!Number.isFinite(fraction) || fraction < LADDER_MID_AT) return 0;
  return fraction < LADDER_HIGH_AT ? 1 : 2;
}
