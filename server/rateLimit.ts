// A fixed-window request counter, keyed on whatever the call site names.
//
// Pure, like server/room.ts and server/matchmaking.ts: no express, no clock of
// its own, no timers. `now` is passed in so the whole thing can be stated as a
// rule in the fast test layer rather than observed through a running server.
//
// There was exactly ONE limiter in this repo — the recovery-code sign-in in
// server.ts — and everything else was open. That was survivable while the only
// people here were invited; it is not survivable in public, because three of
// the unauthenticated routes cost something PERMANENT per call:
//
//  - POST /api/session mints a device identity and, through issueSession →
//    db.getProfile, INSERTS a players row. It is cookieless, so every call is
//    a fresh identity and a fresh row. pruneStaleGuests reclaims them after a
//    week, but only while they stay empty.
//  - POST /api/profile/initialize burns a username out of the pool, for good,
//    once per call — and a row that has been initialized is never pruned, so
//    the two together are a permanent namespace grab.
//  - GET /api/username-check answers "does this account exist" with no
//    identity at all, which is the enumeration half of the same attack.
//
// A fixed window rather than a token bucket: what is being defended is a
// permanent side effect, not a queue, so smoothing the rate buys nothing a
// flat ceiling per window does not.

export interface RateLimitState {
  windowMs: number;
  max: number;
  hits: Map<string, { n: number; until: number }>;
}

export function createRateLimit(windowMs: number, max: number): RateLimitState {
  return { windowMs, max, hits: new Map() };
}

/** True when ANY of these keys has spent the window's allowance. */
export function limitSpent(state: RateLimitState, keys: string[], now: number): boolean {
  return keys.some((key) => {
    const hit = state.hits.get(key);
    return !!hit && hit.until >= now && hit.n >= state.max;
  });
}

/**
 * Count one attempt against EVERY key.
 *
 * Every key, not the first that matches: a caller is counted against their
 * device and their IP independently, so a burst from one device behind a
 * shared NAT does not spend the building's allowance, and a burst from many
 * fresh devices on one IP is still caught by the IP.
 */
export function noteAttempt(state: RateLimitState, keys: string[], now: number): void {
  for (const key of keys) {
    const hit = state.hits.get(key);
    if (!hit || hit.until < now) state.hits.set(key, { n: 1, until: now + state.windowMs });
    else hit.n += 1;
  }
}

/**
 * Drop windows that have closed.
 *
 * Without this the map is a slow leak keyed by attacker-chosen ids — which is
 * the same shape as the thing being defended against, one layer down.
 */
export function sweepExpired(state: RateLimitState, now: number): void {
  for (const [key, hit] of state.hits) if (hit.until < now) state.hits.delete(key);
}
