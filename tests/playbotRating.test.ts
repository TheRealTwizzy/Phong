import { describe, it, expect } from 'vitest';
import {
  pairKindFor,
  participantWeights,
  BOT_DUEL_CREDITS_PER_DAY,
  type ExposureCounts,
  type PairKind,
} from '../src/playbotRating';
import { updateRating, PVP_UPDATE } from '../src/rating';

// The weight tables of CLAUDE-plan §2.1-§2.6, asserted as LITERALS.
//
// Deliberately not read off the exported tables: a test that derives its
// expectations from the thing it is testing passes in every circumstance,
// which is the failure this repo already carries a scar from (the achievements
// "no dead ends" walk that asserted the set it had just populated). Every
// number below is transcribed from the plan by hand.

// Prior counts, given the CURRENT match number. The tables are indexed by the
// current match; every stored count is what came BEFORE it.
const at = (pair: number, band = 1, daily = 1): ExposureCounts => ({
  priorPairCount: pair - 1,
  priorBotBandCount: band - 1,
  priorBotDailyCount: daily - 1,
});

/** Weights with every saturation ladder held at its ×1.00 opening stage. */
const openStage = at(1, 1, 1);

const human = (kind: PairKind, counts: ExposureCounts | null, won: boolean) =>
  participantWeights({ kind, selfIsBot: false, won, counts });
const bot = (kind: PairKind, counts: ExposureCounts | null, won: boolean) =>
  participantWeights({ kind, selfIsBot: true, won, counts });

describe('pairKindFor', () => {
  it('names the three pair kinds from the two participants', () => {
    expect(pairKindFor(false, false)).toBe('human-human');
    expect(pairKindFor(false, true)).toBe('human-bot');
    expect(pairKindFor(true, false)).toBe('human-bot');
    expect(pairKindFor(true, true)).toBe('bot-bot');
  });
});

describe('§2.1/§2.2 base participant weight', () => {
  it('gives the HUMAN side of a human-vs-bot match ×0.70 on mu in BOTH directions', () => {
    expect(human('human-bot', openStage, true).mu).toBeCloseTo(0.7, 10);
    expect(human('human-bot', openStage, false).mu).toBeCloseTo(0.7, 10);
  });

  it('gives that human ×0.70 sigma evidence, outcome-independent', () => {
    expect(human('human-bot', openStage, true).sigma).toBeCloseTo(0.7, 10);
    expect(human('human-bot', openStage, false).sigma).toBeCloseTo(0.7, 10);
  });

  it('never reduces the BOT side of a human-vs-bot match', () => {
    for (const won of [true, false]) {
      const w = bot('human-bot', openStage, won);
      expect(w.mu).toBeCloseTo(1, 10);
      expect(w.sigma).toBeCloseTo(1, 10);
    }
  });

  it('leaves bot-vs-bot at ×1.00 for both participants — the population must progress', () => {
    for (const won of [true, false]) {
      const w = bot('bot-bot', openStage, won);
      expect(w.mu).toBeCloseTo(1, 10);
      expect(w.sigma).toBeCloseTo(1, 10);
    }
  });

  it('leaves human-vs-human at ×1.00', () => {
    for (const won of [true, false]) {
      const w = human('human-human', openStage, won);
      expect(w.mu).toBeCloseTo(1, 10);
      expect(w.sigma).toBeCloseTo(1, 10);
    }
  });
});

describe('§2.3 same-pair band — bot-involved pair', () => {
  // match # -> [gain, loss].  1-3 ×1.00 · 4-5 ×0.90 · 6-8 ×0.70 · 9-12 ×0.40/×0.50 · 13+ cap
  const CELLS: [number, number, number][] = [
    [1, 1.0, 1.0], [2, 1.0, 1.0], [3, 1.0, 1.0],
    [4, 0.9, 0.9], [5, 0.9, 0.9],
    [6, 0.7, 0.7], [7, 0.7, 0.7], [8, 0.7, 0.7],
    [9, 0.4, 0.5], [10, 0.4, 0.5], [11, 0.4, 0.5], [12, 0.4, 0.5],
  ];

  it.each(CELLS)('match %i scales a bot-vs-bot participant by gain %f / loss %f', (n, gain, loss) => {
    expect(bot('bot-bot', at(n), true).mu).toBeCloseTo(gain, 10);
    expect(bot('bot-bot', at(n), false).mu).toBeCloseTo(loss, 10);
  });

  it.each(CELLS)('match %i applies the same band to sigma (gain %f / loss %f)', (n, gain, loss) => {
    expect(bot('bot-bot', at(n), true).sigma).toBeCloseTo(gain, 10);
    expect(bot('bot-bot', at(n), false).sigma).toBeCloseTo(loss, 10);
  });

  it('compounds with the human base factor for the human side', () => {
    // match 6 is ×0.70 on the band, and the human base is ×0.70.
    expect(human('human-bot', at(6), true).mu).toBeCloseTo(0.7 * 0.7, 10);
    expect(human('human-bot', at(6), true).sigma).toBeCloseTo(0.7 * 0.7, 10);
  });

  it('hard-caps BOTH participants from match 13', () => {
    for (const w of [bot('bot-bot', at(13), true), bot('bot-bot', at(13), false),
                     human('human-bot', at(13), true), bot('human-bot', at(13), false)]) {
      expect(w.hardCapped).toBe(true);
      expect(w.mu).toBe(0);
      expect(w.sigma).toBe(0);
      expect(w.cappedBy).toBe('pair');
    }
  });

  it('does not cap at match 12', () => {
    expect(bot('bot-bot', at(12), true).hardCapped).toBe(false);
  });
});

describe('§2.3 same-pair band — human-vs-human pair', () => {
  // 1-8 ×1.00 · 9-12 ×0.90 · 13-18 ×0.70 · 19-24 ×0.40/×0.50 · 25+ cap
  const CELLS: [number, number, number][] = [
    [1, 1.0, 1.0], [8, 1.0, 1.0],
    [9, 0.9, 0.9], [12, 0.9, 0.9],
    [13, 0.7, 0.7], [18, 0.7, 0.7],
    [19, 0.4, 0.5], [24, 0.4, 0.5],
  ];

  it.each(CELLS)('match %i scales by gain %f / loss %f', (n, gain, loss) => {
    expect(human('human-human', at(n), true).mu).toBeCloseTo(gain, 10);
    expect(human('human-human', at(n), false).mu).toBeCloseTo(loss, 10);
    expect(human('human-human', at(n), true).sigma).toBeCloseTo(gain, 10);
    expect(human('human-human', at(n), false).sigma).toBeCloseTo(loss, 10);
  });

  it('hard-caps both participants from match 25, and not at 24', () => {
    expect(human('human-human', at(24), true).hardCapped).toBe(false);
    const capped = human('human-human', at(25), true);
    expect(capped.hardCapped).toBe(true);
    expect(capped.mu).toBe(0);
    expect(capped.sigma).toBe(0);
    expect(capped.cappedBy).toBe('pair');
  });

  it('uses the WIDER human thresholds — a human pair at match 13 is not where a bot pair is', () => {
    // A bot-involved pair is hard-capped at 13; a human pair is only at ×0.70.
    expect(human('human-human', at(13), true).hardCapped).toBe(false);
    expect(bot('bot-bot', at(13), true).hardCapped).toBe(true);
  });
});

describe('§2.4 bot rank-band saturation — human participant only', () => {
  // 1-12 ×1.00 · 13-18 ×0.90 · 19-24 ×0.75 · 25-32 ×0.50 · 33+ cap
  const CELLS: [number, number][] = [
    [1, 1.0], [12, 1.0], [13, 0.9], [18, 0.9], [19, 0.75], [24, 0.75], [25, 0.5], [32, 0.5],
  ];

  it.each(CELLS)('band match %i scales the human by %f', (n, factor) => {
    const w = human('human-bot', at(1, n, 1), true);
    expect(w.mu).toBeCloseTo(0.7 * factor, 10);
    expect(w.sigma).toBeCloseTo(0.7 * factor, 10);
  });

  it('hard-caps the human from band match 33, and not at 32', () => {
    expect(human('human-bot', at(1, 32, 1), true).hardCapped).toBe(false);
    const capped = human('human-bot', at(1, 33, 1), true);
    expect(capped.hardCapped).toBe(true);
    expect(capped.mu).toBe(0);
    expect(capped.sigma).toBe(0);
    expect(capped.cappedBy).toBe('band');
  });

  it('NEVER touches a bot participant, at any count including past the cap', () => {
    for (const n of [13, 19, 25, 33, 100]) {
      const w = bot('human-bot', at(1, n, 1), true);
      expect(w.mu).toBeCloseTo(1, 10);
      expect(w.sigma).toBeCloseTo(1, 10);
      expect(w.hardCapped).toBe(false);
    }
  });

  it('NEVER applies in a bot-vs-bot match, for either participant', () => {
    const w = bot('bot-bot', at(1, 33, 1), true);
    expect(w.mu).toBeCloseTo(1, 10);
    expect(w.hardCapped).toBe(false);
  });

  it('NEVER applies in a human-vs-human match', () => {
    const w = human('human-human', at(1, 33, 1), true);
    expect(w.mu).toBeCloseTo(1, 10);
    expect(w.hardCapped).toBe(false);
  });
});

describe('§2.5 daily bot saturation — human participant only', () => {
  // 1-25 ×1.00 · 26-40 ×0.90 · 41-55 ×0.75 · 56-75 ×0.50 · 76+ cap
  const CELLS: [number, number][] = [
    [1, 1.0], [25, 1.0], [26, 0.9], [40, 0.9], [41, 0.75], [55, 0.75], [56, 0.5], [75, 0.5],
  ];

  it.each(CELLS)('daily match %i scales the human by %f', (n, factor) => {
    const w = human('human-bot', at(1, 1, n), true);
    expect(w.mu).toBeCloseTo(0.7 * factor, 10);
    expect(w.sigma).toBeCloseTo(0.7 * factor, 10);
  });

  it('hard-caps the human from daily match 76, and not at 75', () => {
    expect(human('human-bot', at(1, 1, 75), true).hardCapped).toBe(false);
    const capped = human('human-bot', at(1, 1, 76), true);
    expect(capped.hardCapped).toBe(true);
    expect(capped.mu).toBe(0);
    expect(capped.sigma).toBe(0);
    expect(capped.cappedBy).toBe('daily');
  });

  it('NEVER touches a bot participant, at any count including past the cap', () => {
    for (const n of [26, 41, 56, 76, 500]) {
      const w = bot('human-bot', at(1, 1, n), true);
      expect(w.mu).toBeCloseTo(1, 10);
      expect(w.sigma).toBeCloseTo(1, 10);
      expect(w.hardCapped).toBe(false);
    }
  });

  it('NEVER applies in bot-vs-bot or human-vs-human', () => {
    expect(bot('bot-bot', at(1, 1, 76), true).hardCapped).toBe(false);
    expect(human('human-human', at(1, 1, 76), true).hardCapped).toBe(false);
  });
});

describe('§4.1 counts: null — the BASE weight still applies', () => {
  it('keeps the human ×0.70 for a trusted-but-ineligible human-vs-bot match', () => {
    const w = human('human-bot', null, true);
    expect(w.mu).toBeCloseTo(0.7, 10);
    expect(w.sigma).toBeCloseTo(0.7, 10);
    expect(w.hardCapped).toBe(false);
    expect(w.cappedBy).toBeNull();
  });

  it('leaves the bot side and the other two kinds at ×1.00', () => {
    expect(bot('human-bot', null, true).mu).toBeCloseTo(1, 10);
    expect(bot('bot-bot', null, true).mu).toBeCloseTo(1, 10);
    expect(human('human-human', null, true).mu).toBeCloseTo(1, 10);
  });

  it('never hard-caps, however many matches came before — no ladder is consulted', () => {
    expect(human('human-bot', null, false).hardCapped).toBe(false);
  });
});

describe('the credit allowance constant', () => {
  it('is 5 per human per UTC day (§2.7)', () => {
    expect(BOT_DUEL_CREDITS_PER_DAY).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Step 2 — §2.6 composition order.
//
// These pass against step 1's implementation the moment they are written, so
// RED cannot be the proof here. The mutation checks named in each test's
// comment are: each was confirmed to redden by removing the clause it names.
// ---------------------------------------------------------------------------

describe('§2.6 composition', () => {
  it('multiplies base × pair × band × daily, in order, when all three are mid-band', () => {
    // pair match 6 → ×0.70 · band match 13 → ×0.90 · daily match 26 → ×0.90
    // base for the human side of a human-vs-bot match → ×0.70
    const expected = 0.7 * 0.7 * 0.9 * 0.9;
    const w = human('human-bot', at(6, 13, 26), true);
    expect(w.mu).toBeCloseTo(expected, 10);
    expect(w.sigma).toBeCloseTo(expected, 10);
    expect(w.hardCapped).toBe(false);
    // A product, not a minimum and not a sum: 0.3969 is below every factor.
    expect(w.mu).toBeLessThan(0.7 * 0.7);
  });

  it('applies the SAME chain to sigma as to mu wherever the band is symmetric', () => {
    const w = human('human-bot', at(6, 19, 41), false);
    expect(w.sigma).toBeCloseTo(w.mu, 10);
  });

  it('lets the gain/loss asymmetry reach sigma too, in the bands that carry one', () => {
    // Bot pair band 9-12 is the only asymmetric rung: gain ×0.40, loss ×0.50.
    const win = human('human-bot', at(9), true);
    const loss = human('human-bot', at(9), false);
    expect(win.mu).toBeCloseTo(0.7 * 0.4, 10);
    expect(loss.mu).toBeCloseTo(0.7 * 0.5, 10);
    expect(win.sigma).toBeCloseTo(win.mu, 10);
    expect(loss.sigma).toBeCloseTo(loss.mu, 10);
  });

  it('an explicit zero from the PAIR ladder survives every later factor', () => {
    // Pair capped at 13, while band and daily are both wide open at ×1.00.
    const w = human('human-bot', at(13, 1, 1), true);
    expect(w.mu).toBe(0);
    expect(w.sigma).toBe(0);
    expect(w.hardCapped).toBe(true);
    expect(w.cappedBy).toBe('pair');
  });

  it('an explicit zero from the BAND ladder survives the daily factor', () => {
    const w = human('human-bot', at(1, 33, 1), true);
    expect(w.mu).toBe(0);
    expect(w.sigma).toBe(0);
    expect(w.cappedBy).toBe('band');
  });

  it('reports the FIRST ladder to fire when several would cap at once', () => {
    // All three past their caps. §2.6's order is pair, then band, then daily.
    expect(human('human-bot', at(13, 33, 76), true).cappedBy).toBe('pair');
    // Pair open, band and daily both capped → band.
    expect(human('human-bot', at(1, 33, 76), true).cappedBy).toBe('band');
    // Only daily capped.
    expect(human('human-bot', at(1, 1, 76), true).cappedBy).toBe('daily');
  });
});

// ---------------------------------------------------------------------------
// Step 3 — the neutrality invariant (§3.2 as an assertion).
//
// This is the property that decided ×0.70/×0.70 over ×0.70/×0.50: a human
// performing exactly to rating against bots must neither inflate nor deflate.
// Any gain weight above the loss weight settles a bot-only human ABOVE true
// skill — measured at +1.2 to +1.35 mu, about 0.45 of a tier band, uniformly.
// ---------------------------------------------------------------------------

describe('§3.2 neutrality — a human at true skill neither inflates nor deflates', () => {
  const equalPair = () => ({ me: { mu: 25, sigma: 2 }, opp: { mu: 25, sigma: 2 } });

  /** Expected mu drift per match at a 50% win rate, under these weights. */
  const drift = (wGain: number, wLoss: number, sigma: number): number => {
    const me = { mu: 25, sigma };
    const opp = { mu: 25, sigma: 2 };
    const gain = updateRating(me, opp, true, { k: PVP_UPDATE.k * wGain, sigmaScale: 0 }).mu - me.mu;
    const loss = me.mu - updateRating(me, opp, false, { k: PVP_UPDATE.k * wLoss, sigmaScale: 0 }).mu;
    return 0.5 * gain - 0.5 * loss;
  };

  it('the human-vs-bot base weight is neutral — gain weight equals loss weight', () => {
    const { me, opp } = equalPair();
    expect(me.mu).toBe(opp.mu); // the premise: equal ratings
    const win = human('human-bot', openStage, true);
    const loss = human('human-bot', openStage, false);
    expect(win.mu).toBeCloseTo(loss.mu, 12);
  });

  it('drifts nothing at a 50% win rate, at every sigma', () => {
    const win = human('human-bot', openStage, true).mu;
    const loss = human('human-bot', openStage, false).mu;
    for (const sigma of [0.6, 1.0, 2.0, 3.0, 8.333]) {
      expect(drift(win, loss, sigma)).toBeCloseTo(0, 12);
    }
  });

  it('would NOT be neutral at ×0.70/×0.50 — the rejected draft, kept as the contrast', () => {
    // The whole reason the loss weight is 0.70 and not 0.50. If this ever
    // reads zero, the neutrality assertion above has stopped meaning anything.
    expect(Math.abs(drift(0.7, 0.5, 2.0))).toBeGreaterThan(0.01);
  });

  it('stays neutral through every SYMMETRIC pair band', () => {
    // Bot pair bands 1-3, 4-5 and 6-8 are symmetric, so neutrality survives them.
    for (const n of [1, 4, 6]) {
      const win = human('human-bot', at(n), true).mu;
      const loss = human('human-bot', at(n), false).mu;
      expect(win).toBeCloseTo(loss, 12);
      expect(drift(win, loss, 2.0)).toBeCloseTo(0, 12);
    }
  });

  it('is deliberately NOT neutral in the asymmetric 9-12 band — a documented cost', () => {
    const win = human('human-bot', at(9), true).mu;
    const loss = human('human-bot', at(9), false).mu;
    expect(win).toBeLessThan(loss); // gain ×0.40 against loss ×0.50
    // Downward, which is the safe direction for an anti-farming rung.
    expect(drift(win, loss, 2.0)).toBeLessThan(0);
  });

  it('is neutral for a BOT in every kind — bots are never weighted', () => {
    for (const kind of ['human-bot', 'bot-bot'] as PairKind[]) {
      const win = bot(kind, openStage, true).mu;
      const loss = bot(kind, openStage, false).mu;
      expect(win).toBeCloseTo(1, 12);
      expect(loss).toBeCloseTo(1, 12);
      expect(drift(win, loss, 2.0)).toBeCloseTo(0, 12);
    }
  });
});
