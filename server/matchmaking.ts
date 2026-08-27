import { Rating, winProbability } from '../src/rating';

// Skill-based matchmaking: who to pair, and how hard to insist on it.
//
// Pure, like server/room.ts and for the same reason — pairing rules can be
// argued about in a test without booting a process or opening a socket. No
// database, no sockets, no clock of its own: `now` is passed in.
//
// The brief asked for two things that a low-population server cannot both
// have: "never match players unless the win chance is within 40-60% for both"
// and "ensure players always find another player". `winProbability` is
// symmetric, so a lone queuer never matches however long the search runs, and
// a hard band means a quiet evening is a queue nobody ever leaves. So the band
// is a TARGET HELD FOR THE FIRST MINUTE AND A HALF rather than an absolute:
// tight while there is any hope of a good pairing, the brief's own 40-60 once
// that hope thins, and only then widening toward a game at all.

export interface Candidate {
  /** The verified device id — the queue's identity, as everywhere else. */
  deviceId: string;
  mu: number;
  sigma: number;
  /** When this candidate entered the queue. */
  joinedAt: number;
  /**
   * The client's own last round-trip measurement, or null.
   *
   * A HINT and a tiebreak only, never a gate. It is self-reported, so a
   * modified client can forge it — and forging it buys nothing but a
   * marginally better-connected opponent, which is why it is allowed to be
   * self-reported at all. Deliberately no geolocation: there is no IP handling
   * anywhere in this repo and this does not need to be the thing that adds it.
   */
  rttMs: number | null;
}

/** The acceptable win-probability window, widening with the wait. */
export interface Band {
  lo: number;
  hi: number;
}

/** Up to here the search insists on a coin flip. */
export const BAND_TIGHT_MS = 30_000;
/** And to here, on the brief's own 40-60. */
export const BAND_WIDE_MS = 90_000;
/** Past here the window stops widening: this is as loose as it ever gets. */
export const BAND_OPEN_MS = 180_000;

export const TIGHT_BAND: Band = { lo: 0.45, hi: 0.55 };
export const WIDE_BAND: Band = { lo: 0.4, hi: 0.6 };
export const OPEN_BAND: Band = { lo: 0.2, hi: 0.8 };

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * How fair a pairing still has to be, for somebody who has waited this long.
 *
 * Three steps rather than a smooth curve for the first two, because the first
 * two are promises: for half a minute the queue is looking for a coin flip,
 * and for the minute after that it holds the 40-60 the brief asked for. Only
 * past 90 seconds does it slide — and it slides rather than stepping, so
 * nobody is paired against a wall of a player the instant a threshold passes.
 */
export function bandFor(waitedMs: number): Band {
  const waited = Math.max(0, waitedMs);
  if (waited < BAND_TIGHT_MS) return TIGHT_BAND;
  if (waited < BAND_WIDE_MS) return WIDE_BAND;
  const t = Math.min(1, (waited - BAND_WIDE_MS) / (BAND_OPEN_MS - BAND_WIDE_MS));
  return {
    lo: lerp(WIDE_BAND.lo, OPEN_BAND.lo, t),
    hi: lerp(WIDE_BAND.hi, OPEN_BAND.hi, t),
  };
}

const ratingOf = (c: Candidate): Rating => ({ mu: c.mu, sigma: c.sigma });

/**
 * The best pair the queue can offer right now, or null.
 *
 * The band is judged on the MORE-WAITED of the two, deliberately: the point of
 * widening is to get somebody who has been waiting a game, and judging on the
 * newcomer's own (tight) band would let a fresh arrival veto the very pairing
 * the wait was widening toward.
 *
 * Among everyone inside the band, the closest to a coin flip wins, and a tie
 * on that goes to the better connection — which is all the RTT hint is ever
 * used for.
 *
 * Longest-waiting first, so a queue drains in the order it filled rather than
 * leaving somebody permanently unlucky.
 */
export function findPair(queue: Candidate[], now: number): [Candidate, Candidate] | null {
  const waiting = [...queue].sort((a, b) => a.joinedAt - b.joinedAt);
  for (let i = 0; i < waiting.length; i++) {
    const a = waiting[i];
    let best: Candidate | null = null;
    let bestGap = Infinity;
    for (let j = i + 1; j < waiting.length; j++) {
      const b = waiting[j];
      // `a` is the more-waited of the pair: the list is sorted by joinedAt.
      const band = bandFor(now - a.joinedAt);
      const p = winProbability(ratingOf(a), ratingOf(b));
      if (p < band.lo || p > band.hi) continue;
      const gap = Math.abs(p - 0.5);
      if (gap < bestGap - 1e-9) {
        best = b;
        bestGap = gap;
      } else if (Math.abs(gap - bestGap) <= 1e-9 && best) {
        // A tie on fairness goes to the better connection. An unknown RTT
        // loses to a known one rather than winning by default.
        const rtt = (c: Candidate) => (c.rttMs === null ? Infinity : c.rttMs);
        if (rtt(b) < rtt(best)) best = b;
      }
    }
    if (best) return [a, best];
  }
  return null;
}
