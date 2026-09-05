// Play-bot rating weights: what a match against a bot is worth, and the three
// anti-farming saturation ladders that decide when repeated play stops being
// competitive evidence at all.
//
// Pure and shared, like `src/rating.ts` and `src/matchRules.ts`. It deliberately
// does NOT live in `src/rating.ts`: that file owns the estimator, and a weight
// table that moves with product policy should not sit inside the arithmetic it
// scales. `recordMatch` asks `participantWeights` and nothing else re-derives a
// weight — the one-predicate rule `unrankedReasons` and `roomEntryVerdict`
// already follow.

export type PairKind = 'human-human' | 'human-bot' | 'bot-bot';

/**
 * PRIOR completed eligible matches — never including the match being recorded.
 *
 * The exposure queries exclude this match's own row, so every field here is a
 * count of what came BEFORE. The policy tables below are indexed by the CURRENT
 * match number, which is one more than each of these. That +1 lives in exactly
 * three places, immediately under this comment, and nowhere else: an off-by-one
 * anywhere else would shift a whole ladder by one match and look entirely
 * plausible in the process.
 */
export interface ExposureCounts {
  /** §2.3, this unordered pair, rolling 24h. */
  priorPairCount: number;
  /** §2.4, this bot rank band, rolling 24h. Human participant only. */
  priorBotBandCount: number;
  /** §2.5, all bot matches today, UTC calendar day. Human participant only. */
  priorBotDailyCount: number;
}

const currentPairMatchNumber = (c: ExposureCounts): number => c.priorPairCount + 1;
const currentBotBandMatchNumber = (c: ExposureCounts): number => c.priorBotBandCount + 1;
const currentBotDailyMatchNumber = (c: ExposureCounts): number => c.priorBotDailyCount + 1;

/** One rung of a same-pair ladder. `through` is the last match number in it. */
export interface PairBand {
  readonly through: number;
  readonly gain: number;
  readonly loss: number;
}

/** One rung of a saturation ladder. `through` is the last match number in it. */
export interface Saturation {
  readonly through: number;
  readonly factor: number;
}

/**
 * §2.3, a pair with a bot on at least one side. Hard cap from match 13.
 *
 * Bands 9-12 keep the ×0.40 / ×0.50 gain/loss asymmetry deliberately; measured
 * cost is -0.0245 mu a match, -0.098 across the whole four-match band at σ2.0.
 */
export const BOT_PAIR_BANDS: readonly PairBand[] = [
  { through: 3, gain: 1.0, loss: 1.0 },
  { through: 5, gain: 0.9, loss: 0.9 },
  { through: 8, gain: 0.7, loss: 0.7 },
  { through: 12, gain: 0.4, loss: 0.5 },
];

/** §2.3, two humans. Wider throughout — hard cap from match 25. */
export const HUMAN_PAIR_BANDS: readonly PairBand[] = [
  { through: 8, gain: 1.0, loss: 1.0 },
  { through: 12, gain: 0.9, loss: 0.9 },
  { through: 18, gain: 0.7, loss: 0.7 },
  { through: 24, gain: 0.4, loss: 0.5 },
];

/** §2.4, repeated exposure to one bot skill band. Human only. Cap from 33. */
export const BOT_BAND_SATURATION: readonly Saturation[] = [
  { through: 12, factor: 1.0 },
  { through: 18, factor: 0.9 },
  { through: 24, factor: 0.75 },
  { through: 32, factor: 0.5 },
];

/**
 * §2.5, all bot matches in one UTC calendar day. Human only. Cap from 76.
 *
 * The first 25 carry no aggregate reduction, so a human with nobody to play can
 * still make real ranked progress against varied bot accounts.
 */
export const BOT_DAILY_SATURATION: readonly Saturation[] = [
  { through: 25, factor: 1.0 },
  { through: 40, factor: 0.9 },
  { through: 55, factor: 0.75 },
  { through: 75, factor: 0.5 },
];

/**
 * §2.7. A HUMAN may bank at most this many `rankedDuels` qualification credits
 * from bot play in one UTC day.
 *
 * Read the guard as `!selfIsBot && oppIsBot`, never `oppIsBot` alone: in a
 * bot-vs-bot match every participant's opponent is a bot, so the looser
 * spelling throttles a bot's OWN credits to five a day and bot-vs-bot stops
 * progressing like the equivalent human duel — which is exactly what §2.7
 * promises it does. (It is a throttle and not a wall: five a day still reaches
 * OVERLORD_MIN_DUELS in five days. The defect is that qualification stops
 * tracking the matches actually played.)
 *
 * This is a qualification counter and NOT a saturation layer: it multiplies no
 * mu and no sigma and appears nowhere in the composition below.
 */
export const BOT_DUEL_CREDITS_PER_DAY = 5;

/** Which ladder, if any, zeroed this participant. For a failing test's message. */
export type CappedBy = 'pair' | 'band' | 'daily' | null;

export interface ParticipantWeights {
  /** Multiplies `opts.k`. */
  mu: number;
  /** Multiplies `opts.sigmaScale`. */
  sigma: number;
  /** mu 0, sigma 0, no `rankedGames`, no `rankedDuels`. */
  hardCapped: boolean;
  cappedBy: CappedBy;
}

const HARD_CAP = (cappedBy: Exclude<CappedBy, null>): ParticipantWeights => ({
  mu: 0,
  sigma: 0,
  hardCapped: true,
  cappedBy,
});

export function pairKindFor(selfIsBot: boolean, oppIsBot: boolean): PairKind {
  if (selfIsBot && oppIsBot) return 'bot-bot';
  if (selfIsBot || oppIsBot) return 'human-bot';
  return 'human-human';
}

/** The rung a match number falls in, or null past the last one — which is the cap. */
const rungFor = <T extends { through: number }>(
  ladder: readonly T[],
  matchNumber: number
): T | null => ladder.find((r) => matchNumber <= r.through) ?? null;

/**
 * The weights this ONE participant's rating update is scaled by.
 *
 * Composed in §2.6's order: the opponent-type weight, then the same-pair band,
 * then the two human-only saturation ladders. An explicit zero from any layer
 * stays zero — nothing downstream can revive it, which is why each cap returns
 * immediately rather than multiplying through.
 *
 * `counts: null` means "no anti-farming modifier" and NOT "weights ×1.00": the
 * opponent-type weight is a fact about who was played, so it applies to every
 * estimator that legitimately updates. A Casual human-vs-bot duel writes no
 * exposure row and moves no visible rank, and its HIDDEN update still carries
 * the human's ×0.70 — making the base weight conditional on eligibility would
 * let hidden MMR treat a bot duel as a full-value human duel, which is the
 * divergence §2.1 forbids.
 */
export function participantWeights(a: {
  kind: PairKind;
  selfIsBot: boolean;
  won: boolean;
  counts: ExposureCounts | null;
}): ParticipantWeights {
  const { kind, selfIsBot, won, counts } = a;

  // The human side of a human-vs-bot match, and only that participant, is the
  // one carrying the reduced stakes. ×0.70 in BOTH directions on mu, so a human
  // performing exactly to rating against bots neither inflates nor deflates;
  // and ×0.70 sigma as a fixed evidence factor, never outcome-dependent.
  const humanVsBot = kind === 'human-bot' && !selfIsBot;
  let mu = humanVsBot ? 0.7 : 1;
  let sigma = humanVsBot ? 0.7 : 1;

  if (counts === null) {
    return { mu, sigma, hardCapped: false, cappedBy: null };
  }

  // §2.3 — same pair, BOTH participants, whatever the kind.
  const pairLadder = kind === 'human-human' ? HUMAN_PAIR_BANDS : BOT_PAIR_BANDS;
  const pairRung = rungFor(pairLadder, currentPairMatchNumber(counts));
  if (!pairRung) return HARD_CAP('pair');
  const pairFactor = won ? pairRung.gain : pairRung.loss;
  mu *= pairFactor;
  sigma *= pairFactor;

  // §2.4 and §2.5 are the HUMAN's alone, and only against a bot. A bot keeps
  // its ×1.00 progression and its own counters, subject only to §2.3 above.
  if (!humanVsBot) {
    return { mu, sigma, hardCapped: false, cappedBy: null };
  }

  const bandRung = rungFor(BOT_BAND_SATURATION, currentBotBandMatchNumber(counts));
  if (!bandRung) return HARD_CAP('band');
  mu *= bandRung.factor;
  sigma *= bandRung.factor;

  const dailyRung = rungFor(BOT_DAILY_SATURATION, currentBotDailyMatchNumber(counts));
  if (!dailyRung) return HARD_CAP('daily');
  mu *= dailyRung.factor;
  sigma *= dailyRung.factor;

  return { mu, sigma, hardCapped: false, cappedBy: null };
}
