import { describe, expect, it } from 'vitest';
import {
  BAND_OPEN_MS,
  BAND_TIGHT_MS,
  BAND_WIDE_MS,
  Candidate,
  OPEN_BAND,
  TIGHT_BAND,
  WIDE_BAND,
  bandFor,
  findPair,
} from '../server/matchmaking';
import { START_MU, START_SIGMA, winProbability } from '../src/rating';

// Who the queue pairs, and how hard it insists.
//
// The brief asked for two things a low-population server cannot both have —
// "never match unless the win chance is 40-60% for both" and "always find
// another player" — so the band is a target held for the first ninety seconds
// rather than an absolute. These tests pin BOTH halves of that trade: the
// promise while it holds, and the fact that it eventually gives.

const at = (mu: number, joinedAt = 0, rttMs: number | null = null): Candidate => ({
  deviceId: `d${mu}-${joinedAt}-${rttMs}`,
  mu,
  sigma: START_SIGMA,
  joinedAt,
  rttMs,
  isBot: false,
});

// Pair-class fixtures. sigma 2 rather than START_SIGMA because the band
// half-widths in MU then match the plan's own figures and the arithmetic is
// checkable by hand: c = sqrt(2*BETA^2 + 4 + 4) = 6.536, so p = 0.55 is a gap
// of 0.82 (TIGHT) and p = 0.8 is a gap of 5.50 (OPEN).
const seat = (
  id: string,
  mu: number,
  isBot: boolean,
  joinedAt = 0,
  rttMs: number | null = null
): Candidate => ({ deviceId: id, mu, sigma: 2, joinedAt, rttMs, isBot });

const human = (id: string, mu: number, joinedAt = 0, rttMs: number | null = null) =>
  seat(id, mu, false, joinedAt, rttMs);
const bot = (id: string, mu: number, joinedAt = 0, rttMs: number | null = null) =>
  seat(id, mu, true, joinedAt, rttMs);

/** Drive findPair the way sweepQueue does: pair, remove, repeat. */
const sweep = (queue: Candidate[], now: number): string[] => {
  let q = [...queue];
  const made: string[] = [];
  for (;;) {
    const pair = findPair(q, now);
    if (!pair) break;
    made.push([pair[0].deviceId, pair[1].deviceId].sort().join('/'));
    q = q.filter((c) => c !== pair[0] && c !== pair[1]);
  }
  return made;
};

const kindOf = (pair: [Candidate, Candidate] | null): string =>
  pair === null ? 'none' : `${pair[0].isBot ? 'b' : 'h'}${pair[1].isBot ? 'b' : 'h'}`
    .split('').sort().join('');

describe('bandFor', () => {
  it('insists on a coin flip for the first half-minute', () => {
    expect(bandFor(0)).toEqual(TIGHT_BAND);
    expect(bandFor(BAND_TIGHT_MS - 1)).toEqual(TIGHT_BAND);
    // A negative wait is not a thing, and must not read as "waited forever".
    expect(bandFor(-5000)).toEqual(TIGHT_BAND);
  });

  it("holds the brief's own 40-60 for the minute after that", () => {
    expect(bandFor(BAND_TIGHT_MS)).toEqual(WIDE_BAND);
    expect(bandFor(BAND_WIDE_MS - 1)).toEqual(WIDE_BAND);
  });

  it('slides open past 90 seconds rather than stepping', () => {
    // Stepping would pair somebody against a wall of a player the instant a
    // threshold passed. Halfway through the slide is halfway between.
    const half = bandFor((BAND_WIDE_MS + BAND_OPEN_MS) / 2);
    expect(half.lo).toBeCloseTo((WIDE_BAND.lo + OPEN_BAND.lo) / 2, 6);
    expect(half.hi).toBeCloseTo((WIDE_BAND.hi + OPEN_BAND.hi) / 2, 6);
    expect(half.lo).toBeGreaterThan(OPEN_BAND.lo);
    expect(half.lo).toBeLessThan(WIDE_BAND.lo);
  });

  it('stops widening, and never inverts', () => {
    expect(bandFor(BAND_OPEN_MS)).toEqual(OPEN_BAND);
    expect(bandFor(BAND_OPEN_MS * 100)).toEqual(OPEN_BAND);
    for (const ms of [0, 1000, 29_999, 30_000, 89_999, 120_000, 180_000, 10 ** 7]) {
      const band = bandFor(ms);
      expect({ ms, ok: band.lo < 0.5 && band.hi > 0.5 && band.lo < band.hi }).toEqual({
        ms,
        ok: true,
      });
    }
  });

  it('only ever widens as the wait grows', () => {
    let prev = bandFor(0);
    for (let ms = 0; ms <= BAND_OPEN_MS * 2; ms += 500) {
      const band = bandFor(ms);
      expect(band.lo).toBeLessThanOrEqual(prev.lo + 1e-9);
      expect(band.hi).toBeGreaterThanOrEqual(prev.hi - 1e-9);
      prev = band;
    }
  });
});

describe('findPair', () => {
  it('pairs nobody out of an empty or lone queue', () => {
    expect(findPair([], 0)).toBe(null);
    expect(findPair([at(START_MU)], 60_000)).toBe(null);
  });

  it('pairs two even players immediately', () => {
    const pair = findPair([at(START_MU, 0), at(START_MU, 0)], 1000);
    expect(pair).not.toBe(null);
    expect(winProbability(pair![0], pair![1])).toBeCloseTo(0.5, 6);
  });

  it('refuses a mismatch while the tight band holds, and takes it later', () => {
    // The whole trade in one test. A wide gap is outside the coin-flip band,
    // so a fresh queue declines it — and a queue that has waited long enough
    // takes it rather than leaving both players with no game at all.
    const queue = [at(START_MU - 4, 0), at(START_MU + 4, 0)];
    expect(winProbability(queue[0], queue[1])).toBeLessThan(TIGHT_BAND.lo);
    expect(findPair(queue, 1000)).toBe(null);
    expect(findPair(queue, BAND_TIGHT_MS + 1000)).toBe(null); // still outside 40-60
    expect(findPair(queue, BAND_OPEN_MS + 1000)).not.toBe(null);
  });

  it('judges the band on the player who has waited longer', () => {
    // The point of widening is to get a game to somebody who has been waiting
    // for one. Judging on the NEWCOMER's own tight band would let a fresh
    // arrival veto the very pairing the wait was widening toward.
    const now = BAND_OPEN_MS + 5000;
    const veteran = at(START_MU - 4, 0);
    const newcomer = at(START_MU + 4, now);
    expect(findPair([veteran, newcomer], now)).not.toBe(null);
  });

  it('prefers the closest to a coin flip among everyone inside the band', () => {
    const now = 1000;
    const me = at(START_MU, 0);
    const near = at(START_MU + 0.2, 0);
    const far = at(START_MU + 2.5, 0);
    const pair = findPair([me, far, near], now);
    expect(pair).not.toBe(null);
    expect(new Set([pair![0].deviceId, pair![1].deviceId])).toEqual(
      new Set([me.deviceId, near.deviceId])
    );
  });

  it('breaks a tie on the better connection, and an unknown RTT does not win by default', () => {
    const now = 1000;
    const me = at(START_MU, 0);
    // Identical ratings, so identical fairness: only the connection separates
    // them.
    const laggy = { ...at(START_MU, 0, 300), deviceId: 'laggy' };
    const quick = { ...at(START_MU, 0, 30), deviceId: 'quick' };
    const unknown = { ...at(START_MU, 0, null), deviceId: 'unknown' };
    const pair = findPair([me, laggy, unknown, quick], now);
    expect(pair![1].deviceId).toBe('quick');
  });

  it('drains the queue in the order it filled', () => {
    // Otherwise somebody can be permanently unlucky: a queue that always
    // starts from the newest arrival never reaches the person at the back.
    const now = 10_000;
    const oldest = { ...at(START_MU, 0), deviceId: 'oldest' };
    const middle = { ...at(START_MU, 2000), deviceId: 'middle' };
    const newest = { ...at(START_MU, 4000), deviceId: 'newest' };
    const pair = findPair([newest, middle, oldest], now);
    expect(pair![0].deviceId).toBe('oldest');
  });

  it('always pairs two candidates who are inside the band', () => {
    // The property that matters more than any individual preference: if a
    // legal pairing exists, the queue must not sit on it.
    for (let gap = 0; gap <= 4; gap += 0.25) {
      const queue = [at(START_MU - gap / 2, 0), at(START_MU + gap / 2, 0)];
      const p = winProbability(queue[0], queue[1]);
      const legal = p >= TIGHT_BAND.lo && p <= TIGHT_BAND.hi;
      expect({ gap, paired: findPair(queue, 1000) !== null }).toEqual({ gap, paired: legal });
    }
  });
});

// ---------------------------------------------------------------------------
// Pair classes (§4.12, D28). Human/Human > Human/Bot > Bot/Bot, enforced INSIDE
// findPair because precedence is a pairing rule — anywhere else and the matcher
// stays type-blind, so the next caller reintroduces it.
//
// `Candidate.isBot` is REQUIRED rather than optional. Nothing here can assert
// that: an optional field would still be supplied by these fixtures. It is
// `tsc` that enforces it, at `queueCandidate` in server.ts, which is where a
// forgotten `isBot` would otherwise default to false and misclassify every bot.
// ---------------------------------------------------------------------------

describe('findPair pair classes', () => {
  const NOW = 10_000;
  const soon = NOW - 1_000; // everyone inside TIGHT_BAND

  it('1. a human pairs with a human before a BETTER-FITTING bot', () => {
    // Discriminating on purpose. With every seat at the same mu the tie
    // resolves to whoever is first in the queue, so a type-blind matcher
    // satisfies this by accident — which is what the first draft did. The bot
    // here is the CLOSER coin flip, so a matcher that does not know what a bot
    // is prefers it.
    const a = human('A', 25, soon);
    const b = human('B', 25.5, soon + 1); // p 0.5305 — in band, slightly off
    const c = bot('C', 25, soon + 2); //     p 0.5000 — the better fit
    expect(kindOf(findPair([a, b, c], NOW))).toBe('hh');
  });

  it('2. a lone human takes the better-suited bot before the bots take each other', () => {
    const a = human('A', 25, soon);
    const near = bot('NEAR', 25, soon + 1);
    const far = bot('FAR', 25.6, soon + 2);
    const pair = findPair([a, near, far], NOW);
    expect(kindOf(pair)).toBe('bh');
    expect([pair![0].deviceId, pair![1].deviceId]).toContain('NEAR');
  });

  it('2b. a human takes a bot even when the SPARE bots could pair each other', () => {
    // The case that actually discriminates pass 2 from pass 3, and the one
    // the first draft was missing. Whenever an unpaired human is compatible
    // with a bot the reservation withholds it, so pass 3 is usually empty by
    // construction and swapping the two passes is a no-op — caught by the
    // mutation check, not by review.
    //
    // Here one human reserves ONE of three identical bots, leaving TWO free,
    // which can pair each other. Precedence is what stops them: the human's
    // game comes first.
    const h = human('H', 25, soon + 9);
    const q = [bot('B0', 25, soon), bot('B1', 25, soon + 1), bot('B2', 25, soon + 2), h];
    expect(kindOf(findPair(q, NOW))).toBe('bh');
    // And with the human gone, the spares do pair — so it was precedence that
    // withheld them, not the band.
    expect(kindOf(findPair(q.filter((c) => c !== h), NOW))).toBe('bb');
  });

  it('3. an incompatible bot is skipped for a compatible one', () => {
    const a = human('A', 25, soon);
    const out = bot('OUT', 40, soon + 1); // far outside every band
    const good = bot('GOOD', 25, soon + 2);
    const pair = findPair([a, out, good], NOW);
    expect(kindOf(pair)).toBe('bh');
    expect([pair![0].deviceId, pair![1].deviceId]).toContain('GOOD');
  });

  it('4. two bots may pair when no human needs either', () => {
    expect(kindOf(findPair([bot('X', 25, soon), bot('Y', 25, soon + 1)], NOW))).toBe('bb');
  });

  it('5. a sweep preserves pair-class precedence on the RESIDUAL queue', () => {
    // Asserted over the sequence, not one call: a class-order break only shows
    // on a later pairing. Deliberately NOT "drains every valid pair of a
    // class" — each pass is greedy, so a class can be left with legal pairs
    // unmade (§4.14), and asserting exhaustion would assert the
    // maximum-cardinality property §1A forbids implementing.
    // Humans mutually slightly mismatched and bots a perfect fit for
    // everyone, so a type-blind matcher would open with a human-bot pair.
    const q = [
      human('H1', 25, soon),
      human('H2', 25.5, soon + 1),
      human('H3', 26, soon + 2),
      bot('B1', 25, soon + 3),
      bot('B2', 25, soon + 4),
      bot('B3', 25, soon + 5),
    ];
    const made = sweep(q, NOW);
    const classOf = (m: string) =>
      m.split('/').map((id) => (id.startsWith('B') ? 'b' : 'h')).sort().join('');
    const classes = made.map(classOf);
    // Once a human-bot pair appears, no human-human pair may follow; once a
    // bot-bot pair appears, neither of the others may.
    const rank = { hh: 0, bh: 1, bb: 2 } as Record<string, number>;
    for (let i = 1; i < classes.length; i++) {
      expect(rank[classes[i]]).toBeGreaterThanOrEqual(rank[classes[i - 1]]);
    }
    expect(classes[0]).toBe('hh');
  });

  it('6. a longer-waiting bot does not override pair-class priority', () => {
    // The bot is at the HEAD of the queue by joinedAt and still loses to the
    // human-human pair — the failure the type-blind matcher had.
    const early = bot('EARLY', 25, soon - 5_000);
    const h1 = human('H1', 25, soon);
    const h2 = human('H2', 25, soon + 1);
    expect(kindOf(findPair([early, h1, h2], NOW))).toBe('hh');
  });

  it('7. a bot reserved as a human fallback is not consumed by bot-vs-bot', () => {
    // The ONLY case that exercises freeBots. Cases 2 and 3 do not: pass 2
    // succeeds there, so pass 3 never runs. Built so pass 2 FAILS and pass 3
    // is reachable.
    //   H has waited briefly, so H's band is TIGHT (half-width 0.82 mu).
    //   X sits 3 mu from H — outside H's band NOW, inside H's eventual
    //   OPEN_BAND (half-width 5.50) — so no human-bot pair is legal this tick.
    //   Y sits beside X, so X/Y is a legal bot-bot pair right now.
    const x = bot('X', 28, soon);
    const y = bot('Y', 28, soon + 1);
    const h = human('H', 25, soon + 2);

    // The premise, asserted rather than assumed.
    expect(winProbability({ mu: 28, sigma: 2 }, { mu: 25, sigma: 2 })).toBeGreaterThan(TIGHT_BAND.hi);
    expect(winProbability({ mu: 28, sigma: 2 }, { mu: 25, sigma: 2 })).toBeLessThan(OPEN_BAND.hi);

    expect(findPair([x, y, h], NOW)).toBeNull();
    // Control: with H absent the pair was legal all along, so it was the
    // reservation that withheld it and not the band.
    expect(kindOf(findPair([x, y], NOW))).toBe('bb');
  });

  it('8a. exactly ONE bot is withheld, not the whole band', () => {
    const h = human('H', 25, soon + 99);
    const bots = [0, 1, 2, 3, 4, 5].map((i) => bot(`B${i}`, 28, soon + i));
    // Six bots, all inside H's eventual OPEN_BAND and all pairable with each
    // other. One is reserved; the other five still pair, which is two
    // bot-bot matches out of the remaining five rather than zero.
    expect(sweep([...bots, h], NOW).length).toBe(2);
  });

  it('8b. N unpaired humans reserve exactly N distinct bots', () => {
    // The reservation SIZE has to be observable, which a big bot pool hides:
    // with ten bots, n=1 and n=2 both leave enough free to make the same
    // number of matches. So the pool is sized to the answer instead — with
    // n+1 bots exactly one is left free, which cannot pair with itself, and
    // with n+2 exactly one pair forms. Anything that over- or under-reserves
    // moves one of those two numbers.
    //
    // Humans mutually OUT of band (so no human-human pair forms and every one
    // of them reaches the reservation step unpaired) and each outside TIGHT
    // but inside OPEN of the bots at 25 (so pass 2 finds nothing now, and
    // every human is still entitled to a fallback later).
    const MUS = [21, 27, 29.5];
    for (const n of [1, 2, 3]) {
      const humans = MUS.slice(0, n).map((mu, i) => human(`H${i}`, mu, soon + 50 + i));
      const mk = (count: number) =>
        Array.from({ length: count }, (_, i) => bot(`B${i}`, 25, soon + i));

      // Premise, asserted rather than assumed: no human-human and no
      // human-bot pair is legal this tick.
      expect(kindOf(findPair(humans, NOW))).toBe('none');

      // n + 1 bots: n reserved, one left over, nothing can pair.
      expect(findPair([...mk(n + 1), ...humans], NOW)).toBeNull();

      // n + 2 bots: n reserved, two free, exactly one bot-bot match.
      const made = sweep([...mk(n + 2), ...humans], NOW);
      expect(made.length).toBe(1);
      expect(made[0].split('/').every((id) => id.startsWith('B'))).toBe(true);
    }
  });

  it('8c. the invariants, on any fixture including scarce ones', () => {
    // What greedy wait-order reservation actually provides. No assertion here
    // claims maximum-cardinality reservation — see §4.14 and the
    // characterization test below.
    const h = human('H', 25, soon + 99);
    const x = bot('X', 28, soon);
    const y = bot('Y', 28, soon + 1);
    const q = [x, y, h];

    // Each bot reserved at most once, each human reserves at most one: with
    // one human and two compatible bots, exactly one bot is withheld, so the
    // other is free and yet no pair forms — because a bot-bot pair needs TWO
    // free bots.
    expect(findPair(q, NOW)).toBeNull();
    // Pair the human off and the reservation lifts: the bot becomes free.
    expect(kindOf(findPair([x, y], NOW))).toBe('bb');
  });
});

// §4.14 — a measured, PRE-EXISTING defect, gated. Not a feature test, so it
// never enters the RED -> GREEN cycle: an intentionally executing failure
// would leave `npm test` red, which trains people to ignore it and breaks the
// one signal the suite exists to give. It is here so the next person to touch
// findPair reads it.
//
// Measured against the repo's own findPair and winProbability:
//   Four humans, mu 17/21/24/29, sigma 2, all past BAND_OPEN_MS:
//     A-B 0.270 IN BAND   B-C 0.323 IN BAND   C-D 0.222 IN BAND
//     A-C 0.142 out       B-D 0.110 out       A-D 0.033 out
//   greedy sweep produced 1 match (B/C); maximum possible is 2 (A/B, C/D).
// B is longest-waiting and B-C is nearer a coin flip than B-A, so B takes C
// and strands A and D, who have no other legal partner.
//
// This has nothing to do with play-bots: it is reachable today with four
// humans and no bot in the queue, and every §4.12 pass inherits it because
// each pass is bestPairAmong, which is this same greedy body. The repair is
// maximum-cardinality matching over the in-band graph, which changes pairing
// for HUMANS in production — a separate decision, taken on its own.
describe.todo('greedy pairing loses matches (§4.14, gated — not this feature)', () => {
  it.todo('four humans at mu 17/21/24/29 produce 2 pairings, not 1', () => {
    const now = 1_000_000;
    const past = now - BAND_OPEN_MS - 1_000;
    const q = [
      human('A', 17, past + 1),
      human('B', 21, past),
      human('C', 24, past + 2),
      human('D', 29, past + 3),
    ];
    expect(sweep(q, now).sort()).toEqual(['A/B', 'C/D']);
  });
});
