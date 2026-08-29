import { describe, expect, it } from 'vitest';
import {
  AI_ADAPT_BAND,
  AI_ADAPT_DOWN_BAND,
  AI_ADAPT_DOWN_STRENGTH,
  AI_ADAPT_STRENGTH,
  AI_DIFFICULTIES,
  AI_RATINGS,
  aiRating,
  effectiveAiMu,
  soloMuCap,
  PLACEMENT_UPDATE,
  SIGMA_FLOOR,
  PLACEMENT_GAMES,
  PVP_UPDATE,
  SOLO_UPDATE,
  START_MU,
  Rating,
  newRating,
  recommendedDifficulty,
  isPlaced,
  tierFor,
  tierProgress,
  updateRating,
  winProbability,
} from '../src/rating';

const fresh = (): Rating => newRating();
const soloVs = (d: keyof typeof AI_RATINGS) => ({
  ...SOLO_UPDATE,
  cap: soloMuCap(d),
});

describe('win probability', () => {
  it('is symmetric', () => {
    const a = { mu: 30, sigma: 2 };
    const b = { mu: 22, sigma: 5 };
    expect(winProbability(a, b) + winProbability(b, a)).toBeCloseTo(1, 6);
  });

  it('is a coin flip between identical ratings', () => {
    expect(winProbability(fresh(), fresh())).toBeCloseTo(0.5, 6);
  });

  it('ranks the AI ladder in difficulty order for a new player', () => {
    const me = fresh();
    const rookie = winProbability(me, AI_RATINGS.rookie);
    const pro = winProbability(me, AI_RATINGS.pro);
    const cyber = winProbability(me, AI_RATINGS.cyber);
    expect(rookie).toBeGreaterThan(pro);
    expect(pro).toBeGreaterThan(cyber);
    expect(pro).toBeCloseTo(0.5, 1); // Pro is the average-skill anchor
  });

  it('recommends the difficulty closest to a coin flip', () => {
    // The recommendation is a property, not a fixed name: whichever difficulty
    // the player is pointed at must be the most even matchup available to them.
    for (const me of [fresh(), { mu: 35, sigma: 1.5 }, { mu: 18, sigma: 1.5 }]) {
      const pick = recommendedDifficulty(me);
      const gap = (d: (typeof AI_DIFFICULTIES)[number]) =>
        Math.abs(winProbability(me, aiRating(d, me.mu)) - 0.5);
      for (const d of AI_DIFFICULTIES) {
        expect(gap(pick)).toBeLessThanOrEqual(gap(d) + 1e-9);
      }
    }
    expect(recommendedDifficulty(fresh())).toBe('pro');
  });
});

describe('adaptive AI anchors', () => {
  it('leaves the anchors untouched for an average player', () => {
    for (const d of AI_DIFFICULTIES) {
      expect(effectiveAiMu(d, 25)).toBeCloseTo(AI_RATINGS[d].mu, 6);
    }
  });

  it('slides each difficulty part-way toward the player, never all the way', () => {
    const player = 35;
    for (const d of AI_DIFFICULTIES) {
      const slide = effectiveAiMu(d, player) - AI_RATINGS[d].mu;
      expect(slide).toBeGreaterThan(0);
      // Partial tracking: a 10-point climb must not move the AI 10 points.
      expect(slide).toBeLessThan(player - 25);
      expect(slide).toBeCloseTo(AI_ADAPT_STRENGTH * (player - 25), 6);
    }
  });

  it('slides down for a struggling player', () => {
    for (const d of AI_DIFFICULTIES) {
      expect(effectiveAiMu(d, 15)).toBeLessThan(AI_RATINGS[d].mu);
    }
  });

  it('follows a falling player all the way down', () => {
    // The regression this exists for: partial tracking left a residual gap of
    // (1 - strength) x deviation, and the band capped the slide, so a player
    // losing to Pro fell to mu 13 while Pro stalled at 18 — their odds went
    // 50% -> 22% and every further loss made it worse. Losing must never make
    // the ladder harder.
    let worst = 1;
    for (const mu of [25, 22, 19, 16, 13, 10, 7]) {
      const p = winProbability({ mu, sigma: 2 }, aiRating('pro', mu));
      expect(p).toBeGreaterThan(0.45);
      worst = Math.min(worst, p);
    }
    expect(worst).toBeGreaterThan(0.45);
    // Full downward tracking means the gap closes entirely, not partially.
    expect(effectiveAiMu('pro', 10)).toBeCloseTo(AI_RATINGS.pro.mu - 15, 6);
    expect(AI_ADAPT_DOWN_STRENGTH).toBe(1);
  });

  it('keeps the rungs ordered and distinct at every skill level', () => {
    for (const mu of [12, 18, 25, 32, 40, 55]) {
      const order = ['rookie', 'pro', 'cyber'] as const;
      for (let i = 1; i < order.length; i++) {
        expect(effectiveAiMu(order[i], mu)).toBeGreaterThan(effectiveAiMu(order[i - 1], mu));
      }
      // The ladder keeps its absolute spread — it slides, it never compresses.
      expect(effectiveAiMu('cyber', mu) - effectiveAiMu('rookie', mu)).toBeCloseTo(
        AI_RATINGS.cyber.mu - AI_RATINGS.rookie.mu,
        6
      );
    }
  });

  it('never slides further than the adaptation bands', () => {
    for (const d of AI_DIFFICULTIES) {
      for (const mu of [-50, 0, 12, 25, 45, 80, 500]) {
        const slide = effectiveAiMu(d, mu) - AI_RATINGS[d].mu;
        expect(slide).toBeLessThanOrEqual(AI_ADAPT_BAND + 1e-9);
        expect(slide).toBeGreaterThanOrEqual(-AI_ADAPT_DOWN_BAND - 1e-9);
      }
    }
  });

  it('stays partial upward so a strong player can outgrow the low rungs', () => {
    const slide = effectiveAiMu('rookie', 40) - AI_RATINGS.rookie.mu;
    expect(slide).toBeGreaterThan(0);
    expect(slide).toBeLessThan(40 - 25); // never full tracking upward
    expect(AI_ADAPT_STRENGTH).toBeLessThan(1);
  });

  it('keeps Pro a genuine contest across the whole skill range', () => {
    for (const mu of [15, 20, 25, 30, 35, 40]) {
      const me = { mu, sigma: 2 };
      const adapted = winProbability(me, aiRating('pro', mu));
      const fixed = winProbability(me, AI_RATINGS.pro);
      // Partial tracking pulls every skill level back toward a real contest:
      // at mu 15 the fixed ladder is a 5% hope, the adapted one about 26%.
      expect(Math.abs(adapted - 0.5)).toBeLessThanOrEqual(Math.abs(fixed - 0.5) + 1e-9);
      // Playable at both ends. It never reaches a flat 50/50 by design —
      // that would be rubber-banding, and would erase the rungs entirely.
      // (Pro anchors at 24 now — a shade under START_MU — so a very strong
      // player is favoured a little harder than under the old 25 anchor.)
      expect(adapted).toBeGreaterThan(0.45);
      expect(adapted).toBeLessThan(0.95);
    }
  });

  it('keeps Cyber the hardest rung at every skill level', () => {
    // Cyber is the ceiling, not a wall. Since the anchor came down to 29 a
    // strong player is EXPECTED to beat it more often than not — that is what
    // lowering the ceiling means. What must never change is its position: it
    // stays the hardest thing available, whoever is playing.
    for (const mu of [12, 18, 25, 32, 40]) {
      const me = { mu, sigma: 2 };
      const cyber = winProbability(me, aiRating('cyber', mu));
      const pro = winProbability(me, aiRating('pro', mu));
      const rookie = winProbability(me, aiRating('rookie', mu));
      expect(cyber).toBeLessThan(pro);
      expect(pro).toBeLessThan(rookie);
    }
  });

  it('still makes Cyber a real stretch for an average player', () => {
    const average = winProbability({ mu: 25, sigma: 2 }, aiRating('cyber', 25));
    expect(average).toBeLessThan(0.42);
    // ...and reachable once they improve.
    expect(winProbability({ mu: 40, sigma: 2 }, aiRating('cyber', 40))).toBeGreaterThan(average);
  });
});

describe('rating updates scale with the prediction', () => {
  it('pays far more for an upset than for an expected win', () => {
    const me = fresh();
    const expectedWin = updateRating(me, AI_RATINGS.rookie, true, soloVs('rookie'));
    const upsetWin = updateRating(me, AI_RATINGS.cyber, true, soloVs('cyber'));
    expect(upsetWin.mu - me.mu).toBeGreaterThan(expectedWin.mu - me.mu);
    expect(upsetWin.mu).toBeGreaterThan(me.mu);
  });

  it('gives a converged player almost nothing for beating a weak opponent', () => {
    const strong = { mu: 30, sigma: 1.5 };
    const after = updateRating(strong, AI_RATINGS.rookie, true, soloVs('rookie'));
    expect(after.mu - strong.mu).toBeLessThan(0.05);
  });

  it('drops mu on a loss', () => {
    const me = fresh();
    const after = updateRating(me, AI_RATINGS.rookie, false, SOLO_UPDATE);
    expect(after.mu).toBeLessThan(me.mu);
  });

  it('never increases sigma, and respects the floor', () => {
    let r = fresh();
    for (let i = 0; i < 60; i++) {
      const next = updateRating(r, AI_RATINGS.pro, i % 2 === 0, PVP_UPDATE);
      expect(next.sigma).toBeLessThanOrEqual(r.sigma + 1e-9);
      r = next;
    }
    expect(r.sigma).toBeGreaterThanOrEqual(0.6);
  });
});

describe('solo is capped and always lighter than PvP', () => {
  it('PvP moves mu further than solo for the same opponent strength', () => {
    const me = fresh();
    const human = { ...AI_RATINGS.cyber };
    const solo = updateRating(me, AI_RATINGS.cyber, true, SOLO_UPDATE);
    const pvp = updateRating(me, human, true, PVP_UPDATE);
    expect(pvp.mu - me.mu).toBeGreaterThan(solo.mu - me.mu);
  });

  it('PvP sheds uncertainty faster than solo', () => {
    const me = fresh();
    const solo = updateRating(me, AI_RATINGS.pro, true, SOLO_UPDATE);
    const pvp = updateRating(me, AI_RATINGS.pro, true, PVP_UPDATE);
    expect(pvp.sigma).toBeLessThan(solo.sigma);
  });

  it('farming the easiest rung from a standing start moves nothing', () => {
    let r = fresh();
    for (let i = 0; i < 40; i++) {
      r = updateRating(r, AI_RATINGS.rookie, true, soloVs('rookie'));
    }
    // Rookie's ceiling lands exactly on START_MU, so a starting player is
    // already at it: 40 straight wins over the easiest AI prove nothing and
    // must move mu not at all.
    expect(soloMuCap('rookie')).toBe(newRating().mu);
    expect(r.mu).toBeCloseTo(newRating().mu, 6);
  });

  it('lifts a weak player up to the rung they beat, never past it', () => {
    let r = { mu: 10, sigma: 8.333 };
    for (let i = 0; i < 50; i++) {
      r = updateRating(r, AI_RATINGS.rookie, true, soloVs('rookie'));
    }
    expect(r.mu).toBeLessThanOrEqual(soloMuCap('rookie') + 1e-9);
    expect(r.mu).toBeGreaterThan(10);
  });

  it('lets a solo win move mu from the very first match', () => {
    // The regression this guards: the cap used to be the BASE anchor, and
    // every player starts at exactly Pro's base — so beating Pro moved mu by
    // nothing while losing moved it freely down. The hidden rating could only
    // ratchet DOWNWARD, and prediction, XP scaling and the AI's own upward
    // adaptation all key off it.
    const start = fresh();
    const afterWin = updateRating(start, aiRating('pro', start.mu), true, soloVs('pro'));
    expect(afterWin.mu).toBeGreaterThan(start.mu);
    const afterLoss = updateRating(start, aiRating('pro', start.mu), false, soloVs('pro'));
    expect(afterLoss.mu).toBeLessThan(start.mu);
  });

  it('converges on the rung being farmed and then stops', () => {
    for (const difficulty of AI_DIFFICULTIES) {
      let r = fresh();
      for (let i = 0; i < 200; i++) {
        r = updateRating(r, aiRating(difficulty, r.mu), true, soloVs(difficulty));
      }
      expect(r.mu).toBeCloseTo(soloMuCap(difficulty), 6);
      // One more win changes nothing: the ceiling is a stop, not a slope.
      const more = updateRating(r, aiRating(difficulty, r.mu), true, soloVs(difficulty));
      expect(more.mu).toBeCloseTo(r.mu, 9);
    }
  });

  it('caps each rung one tier above what it simulates, and all of solo below Overlord', () => {
    // The caps are DATA, not the anchor+band formula: with five rungs that
    // formula collides Elite, Cyber and Chaos at one ceiling and makes the
    // top rungs interchangeable for rank farming. Pinned value-by-value so a
    // moved anchor cannot silently move what farming a rung is worth.
    expect(soloMuCap('rookie')).toBe(START_MU); // farming the open rung from a standing start moves nothing
    expect(soloMuCap('pro')).toBe(30.9);
    expect(soloMuCap('elite')).toBe(33.9);
    expect(soloMuCap('cyber')).toBe(36.9);
    expect(soloMuCap('chaos')).toBe(36.9);
    // Every cap is a constant that sits strictly below the Overlord floor
    // (37): the apex is a PvP achievement, however much solo is farmed.
    for (const difficulty of AI_DIFFICULTIES) {
      expect(soloMuCap(difficulty)).toBeLessThan(37);
      // And no cap may fall below its own anchor, or a rung would be
      // unfarmable the moment it was unlocked.
      expect(soloMuCap(difficulty)).toBeGreaterThanOrEqual(AI_RATINGS[difficulty].mu - 1e-9);
    }
  });

  it('lets a strong solo player outgrow the rungs below them', () => {
    // The documented intent that was unreachable while mu was frozen at 25.
    let r = fresh();
    for (let i = 0; i < 60; i++) {
      const won = i % 10 < 7; // a 70% win rate against Pro
      r = updateRating(r, aiRating('pro', r.mu), won, soloVs('pro'));
    }
    expect(r.mu).toBeGreaterThan(newRating().mu);
    // Rookie is now clearly beneath them, and Pro has come up to meet them.
    expect(winProbability(r, aiRating('rookie', r.mu))).toBeGreaterThan(0.85);
    expect(effectiveAiMu('pro', r.mu)).toBeGreaterThan(AI_RATINGS.pro.mu);
  });

  it('still follows a losing player down, so the ladder never hardens', () => {
    let r = fresh();
    for (let i = 0; i < 60; i++) {
      const won = i % 10 < 3; // a 30% win rate against Pro
      r = updateRating(r, aiRating('pro', r.mu), won, soloVs('pro'));
    }
    expect(r.mu).toBeLessThan(newRating().mu);
    // Pro tracks them all the way down at full strength, holding its fixed
    // offset from START_MU (its 24 anchor sits one mu under it), so the odds
    // must not have worsened as they fell.
    expect(effectiveAiMu('pro', r.mu)).toBeCloseTo(r.mu + (AI_RATINGS.pro.mu - START_MU), 6);
  });
});

describe('placement and tiers', () => {
  it('actually places a player who finishes their placement games', () => {
    // The bug: the profile screen counts ranked games to PLACEMENT_GAMES and
    // stops, but placement ALSO needs sigma <= PLACEMENT_SIGMA — which at the
    // ordinary PvP shrink was not reached until about the sixteenth game. A
    // player saw "5/5" and stayed UNRANKED with nothing to explain it.
    for (const pattern of ['wins', 'losses', 'alternating'] as const) {
      let r = fresh();
      for (let i = 1; i <= PLACEMENT_GAMES; i++) {
        const won = pattern === 'wins' ? true : pattern === 'losses' ? false : i % 2 === 0;
        r = updateRating(r, fresh(), won, { ...PLACEMENT_UPDATE });
      }
      expect(isPlaced(PLACEMENT_GAMES, r.sigma)).toBe(true);
      expect(tierFor(r.mu, PLACEMENT_GAMES, r.sigma)).not.toBe('unranked');
    }
  });

  it('does not place anyone early, however fast their sigma falls', () => {
    let r = fresh();
    for (let i = 1; i < PLACEMENT_GAMES; i++) {
      r = updateRating(r, fresh(), true, { ...PLACEMENT_UPDATE });
      expect(isPlaced(i, r.sigma)).toBe(false);
      expect(tierFor(r.mu, i, r.sigma)).toBe('unranked');
    }
  });

  it('leaves ratings past placement behaving as they did', () => {
    // The boost is for placement only; it must not quietly freeze everyone's
    // rating afterwards by collapsing sigma.
    let boosted = fresh();
    for (let i = 1; i <= PLACEMENT_GAMES; i++) boosted = updateRating(boosted, fresh(), i % 2 === 0, PLACEMENT_UPDATE);
    for (let i = 0; i < 30; i++) boosted = updateRating(boosted, fresh(), i % 2 === 0, PVP_UPDATE);

    let plain = fresh();
    for (let i = 0; i < 35; i++) plain = updateRating(plain, fresh(), i % 2 === 0, PVP_UPDATE);

    expect(Math.abs(boosted.sigma - plain.sigma)).toBeLessThan(0.5);
    expect(boosted.sigma).toBeGreaterThan(SIGMA_FLOOR);
  });

  it('moves the rating itself no further during placement than after it', () => {
    // Only the uncertainty shrinks faster; the mu step is untouched, so
    // placement cannot be farmed for a bigger rating swing.
    const start = fresh();
    const placing = updateRating(start, fresh(), true, PLACEMENT_UPDATE);
    const ordinary = updateRating(start, fresh(), true, PVP_UPDATE);
    expect(placing.mu).toBeCloseTo(ordinary.mu, 9);
    expect(placing.sigma).toBeLessThan(ordinary.sigma);
  });

  it('stays unranked until enough ranked games AND low enough sigma', () => {
    expect(isPlaced(PLACEMENT_GAMES - 1, 2)).toBe(false);
    expect(isPlaced(PLACEMENT_GAMES, 8)).toBe(false);
    expect(isPlaced(PLACEMENT_GAMES, 2)).toBe(true);
    expect(tierFor(40, PLACEMENT_GAMES - 1, 2)).toBe('unranked');
  });

  it('maps mu onto the tier ladder once placed', () => {
    expect(tierFor(15, 10, 2)).toBe('rookie');
    expect(tierFor(20, 10, 2)).toBe('contender');
    expect(tierFor(25, 10, 2)).toBe('ace');
    expect(tierFor(30, 10, 2)).toBe('master');
    expect(tierFor(40, 10, 2)).toBe('overlord');
  });

  // tierProgress had no test at all until the top band changed under it, which
  // is exactly why it could: its only caller is a component, and this repo has
  // no component tests by choice.
  it('measures progress through the band a rating actually sits in', () => {
    // Contender runs 19 to 22, so 20.5 is halfway.
    expect(tierProgress(20.5)).toBeCloseTo(0.5, 5);
    expect(tierProgress(19)).toBeCloseTo(0, 5);
    // Just under the next floor is nearly full, never over it.
    expect(tierProgress(21.99)).toBeGreaterThan(0.99);
    expect(tierProgress(21.99)).toBeLessThan(1);
  });

  it('fills the top band completely, because there is no rung above it', () => {
    // The apex used to be measured against a synthetic `floor + 3` band, so a
    // player arriving at Overlord saw an EMPTY meter at the moment they got
    // there, a half-full one at mu 38.5, and a permanently full one from mu 40
    // on that could never move again. There is nothing above Overlord to be
    // partway toward; the ladder is finished, and the meter says so.
    expect(tierProgress(37)).toBe(1);
    expect(tierProgress(38.5)).toBe(1);
    expect(tierProgress(40)).toBe(1);
    expect(tierProgress(99)).toBe(1);
    // And the band below it is still a real fraction, so this is a special
    // case for the TOP rung and not a clamp that swallowed the whole ladder.
    expect(tierProgress(35.5)).toBeCloseTo(0.5, 5);
  });

  it('does NOT change tier as sigma alone shrinks', () => {
    // Regression: a conservative mu-3*sigma rating would drift an average
    // player two tiers upward purely from playing more games.
    const early = tierFor(25, 10, 3.9);
    const converged = tierFor(25, 200, 0.7);
    expect(converged).toBe(early);
  });

  it('pushes a smurf to the top of the ladder within a handful of PvP games', () => {
    let r = fresh();
    const strong = { mu: 34, sigma: 1.5 };
    for (let i = 0; i < PLACEMENT_GAMES; i++) {
      r = updateRating(r, strong, true, PVP_UPDATE);
    }
    expect(isPlaced(PLACEMENT_GAMES, r.sigma)).toBe(true);
    expect(['legend', 'overlord']).toContain(tierFor(r.mu, PLACEMENT_GAMES, r.sigma));
  });
});
