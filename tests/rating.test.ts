import { describe, expect, it } from 'vitest';
import {
  AI_RATINGS,
  PLACEMENT_GAMES,
  PVP_UPDATE,
  SOLO_UPDATE,
  Rating,
  newRating,
  recommendedDifficulty,
  isPlaced,
  tierFor,
  updateRating,
  winProbability,
} from '../src/rating';

const fresh = (): Rating => newRating();
const soloVs = (d: keyof typeof AI_RATINGS) => ({
  ...SOLO_UPDATE,
  cap: AI_RATINGS[d].mu,
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
    const chaos = winProbability(me, AI_RATINGS.chaos);
    const cyber = winProbability(me, AI_RATINGS.cyber);
    expect(rookie).toBeGreaterThan(pro);
    expect(pro).toBeGreaterThan(chaos);
    expect(chaos).toBeGreaterThan(cyber);
    expect(pro).toBeCloseTo(0.5, 1); // Pro is the average-skill anchor
  });

  it('recommends the difficulty closest to a coin flip', () => {
    expect(recommendedDifficulty(fresh())).toBe('pro');
    expect(recommendedDifficulty({ mu: 35, sigma: 1.5 })).toBe('cyber');
    expect(recommendedDifficulty({ mu: 18, sigma: 1.5 })).toBe('rookie');
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

  it('farming a weak AI converges on that AI and stops', () => {
    let r = fresh();
    for (let i = 0; i < 40; i++) {
      r = updateRating(r, AI_RATINGS.rookie, true, soloVs('rookie'));
    }
    // The cap is Rookie's own mu; a starting player already sits above it,
    // so 40 straight wins must not move mu at all.
    expect(r.mu).toBeCloseTo(newRating().mu, 6);
  });

  it('the cap lifts a weak player only up to the anchor, never past it', () => {
    let r = { mu: 10, sigma: 8.333 };
    for (let i = 0; i < 50; i++) {
      r = updateRating(r, AI_RATINGS.rookie, true, soloVs('rookie'));
    }
    expect(r.mu).toBeLessThanOrEqual(AI_RATINGS.rookie.mu + 1e-9);
    expect(r.mu).toBeGreaterThan(10);
  });
});

describe('placement and tiers', () => {
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
