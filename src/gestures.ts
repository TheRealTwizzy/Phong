/**
 * Horizontal swipe: what claims a pointer, and where a released drag settles.
 *
 * These live here rather than in the component for the reason `AIM_FULL_PUSH`
 * and `aimFromPush` do (`src/game/physics.ts`): the mapping from a drag to an
 * intent is a RULE the fast test layer can state, instead of something only a
 * browser can observe. The component does the pointer bookkeeping; this decides
 * what the bookkeeping means.
 *
 * That division matters more here than usual, because this environment cannot
 * test the other half. `touch-action` is enforced by the compositor hit-test,
 * and CDP's `Input.dispatchTouchEvent` injects events downstream of it — it
 * scrolls a `touch-action: none` element happily. So a browser suite can prove
 * the axis lock below and can NOT prove that the browser ceded the gesture in
 * the first place. Everything stated here is therefore stated in unit tests.
 */

/**
 * How far a drag must travel before either axis may claim it.
 *
 * The gesture is UNDECIDED below this on both axes — deliberately not "assume
 * vertical until proven horizontal", which condemns a slow, careful sideways
 * drag on its very first move: the user creeps three pixels, the gesture is
 * marked vertical for life, and the remaining two hundred pixels of travel do
 * nothing at all.
 */
export const SWIPE_CLAIM_PX = 12;

/**
 * How much more horizontal than vertical a drag must be to claim.
 *
 * A bare `|dx| > |dy|` accepts 45°, and neither Blink nor WebKit will reliably
 * hand over a drag that shallow — WebKit's directional cone is sticky once
 * engaged, so the browser has often already started scrolling. 1.5 is ~34°,
 * which is inside what both engines will cede, so our verdict and theirs agree
 * instead of competing.
 */
export const SWIPE_AXIS_RATIO = 1.5;

/**
 * Fraction of the page width that commits on distance alone.
 *
 * Kept modest because the fling below carries most of the intent: a player who
 * means to change page nearly always flicks, and a slow deliberate drag past a
 * fifth of the screen is unambiguous.
 */
export const SWIPE_COMMIT_FRACTION = 0.18;

/**
 * Fling threshold, in VIEWPORT WIDTHS per second rather than pixels per second.
 *
 * A pixel threshold means different things on a 390px phone and a 430px one —
 * the same flick is a page turn on one and not on the other. Expressing it
 * relative to the container is the same reasoning as the court's `[0,1]`
 * coordinates: the gesture should mean the same thing on every device.
 */
export const SWIPE_FLING_VW_PER_S = 1.1;

/**
 * Older than this and the last sample is not a velocity, it is a stale reading.
 *
 * A finger that comes to rest before lifting has ended its gesture; without
 * this, the position it stopped at keeps reporting whatever speed it arrived
 * with and a deliberate, carefully-placed drag commits as though it were flung.
 */
export const SWIPE_VELOCITY_STALE_MS = 100;

/** One sampled point of a live drag: the event's own timestamp and `clientX`. */
export interface SwipeSample {
  t: number;
  x: number;
}

/**
 * px/ms over the ~100ms before `now`, or 0 once the drag has gone still.
 *
 * `pageSettle` below states that its caller must zero a stale velocity. This is
 * that half, moved here so it can be STATED — it lived in the hook, where this
 * repo has no layer that can test a React hook, and it was wrong there.
 *
 * The window is measured from `now`, the RELEASE, and never from the newest
 * sample. That is the whole point: a finger held still fires no `pointermove`
 * at all, so the trail simply stops growing — and a trail measured against its
 * own last sample therefore reports the flick that ENDED it, however long ago
 * that was. Flick hard, hold for two seconds, lift, and a drag that never came
 * near the distance threshold turns the page.
 *
 * Not the last two samples either: fingers decelerate and roll before they
 * lift, so the final pair of a genuinely fast flick often reads near zero or
 * reverses sign, and the fling branch would quietly never fire.
 */
export function trailVelocity(trail: readonly SwipeSample[], now: number): number {
  if (trail.length < 2) return 0;
  const last = trail[trail.length - 1];
  if (now - last.t > SWIPE_VELOCITY_STALE_MS) return 0;
  // `last` is inside the window by the check above, so this scan always lands
  // on something and needs no fallback — which would be an unreachable branch
  // under a 95% floor. Walk back while the samples still qualify.
  let oldest = last;
  for (let i = trail.length - 2; i >= 0; i--) {
    if (now - trail[i].t > SWIPE_VELOCITY_STALE_MS) break;
    oldest = trail[i];
  }
  const dt = last.t - oldest.t;
  if (dt <= 0) return 0;
  return (last.x - oldest.x) / dt;
}

/** Undecided, until one axis clears `SWIPE_CLAIM_PX`. The caller latches it. */
export type SwipeIntent = 'none' | 'horizontal' | 'vertical';

/**
 * Which axis a drag belongs to, or `'none'` while it is still too small to say.
 *
 * `dx`/`dy` are current-minus-origin in pixels, measured from where the pointer
 * went DOWN rather than accumulated per move — a curved path drifts otherwise.
 *
 * **Vertical is the cheap error, and the RATIO is what buys it** — not the
 * order of the checks. The browser is the other claimant for a vertical drag,
 * so ceding costs nothing (the scroll container is right there and does the
 * right thing) while claiming wrongly costs a cancelled pointer and a page that
 * jumps under a player who was reading a list. So horizontal has to prove
 * itself decisively, and anything past the claim distance that has not is
 * vertical.
 *
 * Testing vertical FIRST looks like the same thing and is not: it makes any
 * drag with `|dy| > SWIPE_CLAIM_PX` vertical however horizontal it is, so
 * `dx=200, dy=13` — an emphatically sideways drag with a little drift, which is
 * what a real thumb produces — could never turn a page.
 *
 * The caller must LATCH the first non-`'none'` answer for the life of the
 * pointer. A gesture that has been read as vertical must never become
 * horizontal partway through, or a scroll that drifts sideways turns the page
 * mid-flick.
 */
export function swipeIntent(dx: number, dy: number): SwipeIntent {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax > SWIPE_CLAIM_PX && ax > ay * SWIPE_AXIS_RATIO) return 'horizontal';
  if (ay > SWIPE_CLAIM_PX) return 'vertical';
  return 'none';
}

/**
 * Which page a released drag settles on, as a DELTA: -1 back, 0 stay, +1 forward.
 *
 * **The sign convention is the single easiest thing here to invert.**
 * `offsetPx` is current-minus-start, so it is NEGATIVE when the finger has
 * moved LEFT — and a finger moving left drags the NEXT page in from the right,
 * following the finger. So the delta is the OPPOSITE sign of the offset.
 *
 * A decisive fling decides, in whichever direction it points: flung the way the
 * drag was going, it commits; flung back against it, it is a player putting the
 * page back and the answer is 0 even if the distance alone would have committed.
 * Only when there is no decisive fling does distance decide.
 *
 * `velocityPxPerMs` is signed the same way as `offsetPx` and should already have
 * been zeroed by the caller if the last samples are older than
 * `SWIPE_VELOCITY_STALE_MS`. A zero or non-finite width settles on 0 rather than
 * dividing by it — the same guard `aimFromPush` puts on a zero angle limit.
 */
export function pageSettle(
  offsetPx: number,
  widthPx: number,
  velocityPxPerMs: number
): -1 | 0 | 1 {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return 0;
  if (!Number.isFinite(offsetPx) || offsetPx === 0) return 0;

  const forward: -1 | 1 = offsetPx < 0 ? 1 : -1;
  const velocity = Number.isFinite(velocityPxPerMs) ? velocityPxPerMs : 0;

  // px/ms → viewport widths per second, so the threshold means the same thing
  // on every screen.
  const flung = (Math.abs(velocity) * 1000) / widthPx >= SWIPE_FLING_VW_PER_S;
  if (flung) {
    // Sign agreement, not magnitude: a flick back is "put it back", and it
    // outranks a drag that had already travelled far enough to commit.
    return Math.sign(velocity) === Math.sign(offsetPx) ? forward : 0;
  }

  return Math.abs(offsetPx) / widthPx >= SWIPE_COMMIT_FRACTION ? forward : 0;
}

/**
 * Modular index for a strip with no ends, so the loop needs no cloned DOM.
 *
 * Cloning the edge pages would be the other way to make a loop seamless, and it
 * is the wrong tool in this repo: every browser assertion here is an `#id`, and
 * a clone puts a second element carrying each one into the document.
 *
 * `wrapIndex(-1, 5) === 4`. A count of zero or less has no valid index and
 * answers 0.
 */
export function wrapIndex(i: number, count: number): number {
  if (!Number.isFinite(i) || !Number.isFinite(count) || count <= 0) return 0;
  const n = Math.floor(count);
  return ((Math.floor(i) % n) + n) % n;
}
