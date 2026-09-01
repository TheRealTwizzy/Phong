// Cross-net coordinate transform. Both phones face each other, so when the
// ball leaves one screen at the net it must be mirrored horizontally and sent
// travelling downward into the opponent's half. Kept in one server-side place
// so the two clients can never disagree about where the ball arrived.

export interface CrossNetBall {
  x: number;
  vx: number;
  vy: number;
  spin: number;
  speedMultiplier: number;
}

/**
 * The widest any single component of a crossing ball may be.
 *
 * MAX_BALL_SPEED is 2.4 and the per-match band tops out at +20%, so 8 is far
 * above anything the physics can legitimately produce on one axis — this is a
 * sanity bound on a hostile payload, not a game rule. The rules-aware clamp
 * stays where it belongs, on the receiving client.
 */
const MAX_COMPONENT = 8;
const MAX_SPIN = 8;

/** Finite or the fallback. `Math.abs(undefined)` and `-'x'` are both NaN. */
const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function transformBallForOpponent(raw: {
  x: number;
  vx: number;
  vy: number;
  spin?: number;
  speedMultiplier?: number;
}): CrossNetBall {
  // Every field is coerced and bounded, not just x. It used to be x alone, so
  // a single `{ vy: 'x' }` reached the opponent's court as NaN — and there
  // `b.y += NaN * dt` makes every subsequent comparison false, so the ball
  // never bounces, never crosses and never scores, isServing stays false so
  // auto-serve never arms, and the point simply never ends. The victim's only
  // way out is quitting, which the relay records as an abandon: a real ranked
  // loss. That is a different thing from the documented "a modified client can
  // cheat" trade, because it costs the person who did nothing.
  const vy = num(raw.vy);
  return {
    x: clamp(1 - num(raw.x, 0.5), 0.02, 0.98),
    vx: clamp(-num(raw.vx), -MAX_COMPONENT, MAX_COMPONENT),
    // Moving DOWN into the opponent's screen. A zero here would be a ball that
    // never arrives, so it keeps the sign convention and the smallest nudge.
    vy: clamp(Math.abs(vy) || 0.1, 0.1, MAX_COMPONENT),
    spin: clamp(-num(raw.spin), -MAX_SPIN, MAX_SPIN),
    speedMultiplier: clamp(num(raw.speedMultiplier, 1) || 1, 0.1, 10),
  };
}
