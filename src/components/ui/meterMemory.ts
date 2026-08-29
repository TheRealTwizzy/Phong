// Where a meter resumes from, when it is asked to.
//
// Module scope, deliberately. Both meters this exists for live in MainMenu's
// header, and MainMenu is unmounted for the whole of a match — App renders
// `screen === 'menu' ? <MainMenu/> : <game>` under AnimatePresence mode="wait",
// so a ref inside the component, or inside MainMenu, is gone by the time the
// player walks back out of the court. Which is precisely the moment the value
// has changed and the movement is the thing worth showing.
//
// NOT persisted. A reload has no last position to resume from, and a bar that
// arrived already full on a cold start would be lying about continuity.
//
// A key names a BAND, not a meter: `menu-xp:7`, `rank:ace`. A level-up or a
// promotion is a new band with nothing remembered, so it fills from empty —
// which is true, and which is what stops the XP bar sweeping BACKWARDS from
// 0.95 to 0.05 to announce a level the player just gained. Two bars mounted at
// once must never share a key: each would write the other's origin.
//
// Its own file rather than module scope inside ProgressBar.tsx, for the reason
// src/gestures.ts is its own file: a rule belongs where a test can state it,
// and vitest runs in `node` here — importing the component would drag
// `motion/react` into a test that only wants the arithmetic.

const METER_ORIGIN = new Map<string, number>();

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Where this band was last rendered, 0..1. A band never seen resumes empty. */
export function meterOrigin(key: string): number {
  return METER_ORIGIN.get(key) ?? 0;
}

/**
 * Record where this band now stands. A non-finite value is dropped rather than
 * stored: NaN compares false against everything, so a poisoned key would resume
 * a bar at `scaleX: NaN` — which paints nothing at all, silently, forever.
 */
export function rememberMeter(key: string, value: number): void {
  if (!Number.isFinite(value)) return;
  METER_ORIGIN.set(key, clamp01(value));
}

/** Test seam. The store outlives every component by design, so a suite needs a way to empty it. */
export function resetMeterMemory(): void {
  METER_ORIGIN.clear();
}
