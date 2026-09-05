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
  /**
   * Whether this seat is a play-bot, from `bot_accounts` (D26) via
   * `queueCandidate`.
   *
   * REQUIRED, not optional. An optional field defaults to false and silently
   * misclassifies every bot — the reasoning `tierFor` already uses for its
   * required fourth argument. `tsc` is what enforces it at the call site,
   * which no test in this file can do.
   */
  isBot: boolean;
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
export function bestPairAmong(
  candidates: Candidate[],
  now: number,
  eligiblePair?: (a: Candidate, b: Candidate) => boolean
): [Candidate, Candidate] | null {
  const waiting = [...candidates].sort((a, b) => a.joinedAt - b.joinedAt);
  for (let i = 0; i < waiting.length; i++) {
    const a = waiting[i];
    let best: Candidate | null = null;
    let bestGap = Infinity;
    for (let j = i + 1; j < waiting.length; j++) {
      const b = waiting[j];
      // The ONLY addition: an admissibility question asked BEFORE the
      // existing scoring evaluates the pair. Omitted, every pair is eligible
      // and this function is byte-equivalent to what it always was.
      if (eligiblePair && !eligiblePair(a, b)) continue;
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

/**
 * The bots no waiting human is entitled to fall back on.
 *
 * Pass 2 returning null means no human-bot pair is legal RIGHT NOW; it does
 * not mean no bot is needed, because a waiting human's band is still widening
 * and a bot paired into a bot-vs-bot match now will not be there when it does.
 * So each still-unpaired human, longest-waiting first, claims their best
 * OPEN_BAND-compatible bot.
 *
 * ONE bot per unpaired human, never every bot in the band. Measured, the
 * blanket version reserved 42-44% of a live-ladder roster per waiting human,
 * so bot-vs-bot would have stopped whenever anyone was queued and the
 * simulated population's own ladder would only progress while nobody played.
 *
 * `OPEN_BAND` is the compatibility test because the question is what that
 * human will be entitled to once their band widens — it is no longer the
 * QUANTITY rule.
 *
 * What this guarantees is narrower than "every human is covered", and
 * deliberately so: greedy wait-order assignment is not maximum matching. With
 * h1 compatible with {X, Y} and h2, h3 with {X} only, h1 takes X and Y is
 * never reserved. That is the same greedy-cardinality class as the defect
 * `tests/matchmaking.test.ts` records against findPair itself, it is accepted
 * for this feature, and it must not be fixed here.
 */
function freeBots(humans: Candidate[], bots: Candidate[]): Candidate[] {
  const reserved = new Set<Candidate>();
  // Longest-waiting first, matching findPair's own ordering, so the human who
  // has waited most gets first claim on the bot best suited to them.
  for (const h of [...humans].sort((a, b) => a.joinedAt - b.joinedAt)) {
    let best: Candidate | null = null;
    let bestGap = Infinity;
    for (const b of bots) {
      if (reserved.has(b)) continue;
      const p = winProbability(ratingOf(h), ratingOf(b));
      if (p < OPEN_BAND.lo || p > OPEN_BAND.hi) continue;
      const gap = Math.abs(p - 0.5);
      if (gap < bestGap - 1e-9) {
        best = b;
        bestGap = gap;
      }
    }
    if (best) reserved.add(best);
  }
  return bots.filter((b) => !reserved.has(b));
}

/**
 * The best pair the queue can offer right now, or null — in pair-class
 * precedence order (D28).
 *
 *   1  Human vs Human        always wins
 *   2  Human vs Play-Bot     a waiting human beats bots playing each other
 *   3  Play-Bot vs Play-Bot  only with bots no waiting human needs
 *
 * Bots fill gaps. Stated as the guarantee actually provided rather than the
 * stronger one: bots never displace a valid human-human pairing; a bot
 * ACTUALLY reserved as a human's fallback is not consumed by bot-vs-bot;
 * unreserved bots stay free; and greedy reservation does NOT guarantee
 * maximum-cardinality fallback coverage.
 *
 * The precedence lives here rather than in the bot's own policy layer because
 * it is a pairing rule — anywhere else and the matcher stays type-blind, so
 * the next caller, or a bot entering the queue by a path that layer does not
 * own, reintroduces exactly this.
 *
 * Each call preserves precedence on the RESIDUAL queue. It does not "drain
 * every legal pair" of a class: each pass is `bestPairAmong`, which is greedy,
 * so a class can be left with legal pairs unmade. Precedence is the guarantee;
 * cardinality is not.
 */
export function findPair(queue: Candidate[], now: number): [Candidate, Candidate] | null {
  const humans = queue.filter((c) => !c.isBot);
  const bots = queue.filter((c) => c.isBot);

  const hh = bestPairAmong(humans, now);
  if (hh) return hh;

  // Exactly ONE bot, so the predicate is `a.isBot !== b.isBot` — a
  // DIFFERENT-class test. Run over the whole queue rather than a pre-split
  // set, which is what keeps a human's partner search seeing every legal bot
  // and a bot's seeing every legal human.
  const hb = bestPairAmong(queue, now, (a, b) => a.isBot !== b.isBot);
  if (hb) return hb;

  return bestPairAmong(freeBots(humans, bots), now);
}
