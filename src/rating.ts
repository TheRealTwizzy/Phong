import { AIDifficulty, GameMode, RankMagnitude } from './types';

// TrueSkill-style skill rating, shared by client and server (same convention
// as profileRules.ts — the server imports from ../src so the two sides can
// never disagree about a prediction).
//
// Every player carries TWO Gaussian ratings:
//   * hidden MMR  — moved by EVERY match (solo included). Drives the win
//     prediction, the XP surprise multiplier, and difficulty recommendation.
//     Never shown as a number and never exposed on public profiles.
//   * ranked      — moved by PvP, and by solo at an EARNED difficulty
//     (RANKED_SOLO_DIFFICULTIES), always under SOLO_MU_CAPS. Drives the
//     visible tier badge.

export interface Rating {
  mu: number; // skill estimate
  sigma: number; // uncertainty
}

// Performance variance per game: how much a single result can be luck.
export const BETA = 4.1667;
// Per-match dynamics: keeps sigma from collapsing to zero forever.
export const TAU = 0.0833;
export const START_MU = 25;
export const START_SIGMA = 25 / 3;
export const SIGMA_FLOOR = 0.6;

export const newRating = (): Rating => ({ mu: START_MU, sigma: START_SIGMA });

// ---------------------------------------------------------------------------
// Gaussian helpers (dependency-free)
// ---------------------------------------------------------------------------

const pdf = (t: number): number => Math.exp((-t * t) / 2) / Math.sqrt(2 * Math.PI);

// Standard normal CDF via Abramowitz & Stegun 7.1.26 erf approximation
// (|error| < 1.5e-7) — plenty for a win probability we render as a percent.
export function cdf(t: number): number {
  const p = 0.3275911;
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const sign = t < 0 ? -1 : 1;
  const x = Math.abs(t) / Math.SQRT2;
  const k = 1 / (1 + p * x);
  const erf =
    1 - ((((a[4] * k + a[3]) * k + a[2]) * k + a[1]) * k + a[0]) * k * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

// Mean of a Gaussian truncated at t — the "surprise" of the observed result.
const vWin = (t: number): number => {
  const denom = cdf(t);
  return denom < 1e-9 ? -t : pdf(t) / denom;
};
// Variance multiplier of the same truncated Gaussian.
const wWin = (t: number): number => {
  const v = vWin(t);
  return v * (v + t);
};

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

/** Probability that `a` beats `b`, in [0,1]. Symmetric: P(a,b) + P(b,a) = 1. */
export function winProbability(a: Rating, b: Rating): number {
  const c = Math.sqrt(2 * BETA * BETA + a.sigma * a.sigma + b.sigma * b.sigma);
  return cdf((a.mu - b.mu) / c);
}

// ---------------------------------------------------------------------------
// AI opponents as fixed anchors
// ---------------------------------------------------------------------------

// Each anchor is the strength of the PvP band its rung simulates, mapped from
// the real AI parameters in game/physics.ts (reaction time, max paddle speed,
// aim error). Anchors never move, and carry a small sigma because a difficulty
// tier is a known quantity. Against the tier floors in TIER_FLOORS below:
// Rookie plays like an Unranked/Contender human, Pro like Vanguard/Ace, Elite
// like Master/Grandmaster, Cyber like Grandmaster/Legend, Chaos like Legend+.
export const AI_RATINGS: Record<AIDifficulty, Rating> = {
  rookie: { mu: 20, sigma: 0.5 },
  pro: { mu: 24, sigma: 0.5 },
  elite: { mu: 30, sigma: 0.5 },
  cyber: { mu: 33, sigma: 0.5 },
  chaos: { mu: 36, sigma: 0.5 },
};

export const AI_DIFFICULTIES: AIDifficulty[] = ['rookie', 'pro', 'elite', 'cyber', 'chaos'];

/**
 * Coerce anything that claims to be a difficulty into one that exists.
 *
 * 'chaos' is deliberately NOT special-cased any more: it was retired (it sat
 * between Pro and Cyber, defined by volatility) and mapped to 'cyber' here,
 * but the name has been revived as the top rung — legacy matches rows were
 * relabelled to 'cyber' by chaos_relabel_v1 in server/db.ts BEFORE the name
 * changed hands, so a 'chaos' reaching this function now means the new rung.
 * A stale stored setting naming it is clamped down to an earned rung by
 * playableDifficulty like any other locked choice.
 */
export function normalizeDifficulty(value: unknown): AIDifficulty {
  const key = typeof value === 'string' ? value.toLowerCase() : '';
  if ((AI_DIFFICULTIES as string[]).includes(key)) return key as AIDifficulty;
  return 'pro';
}

// The anchors above are the *reference* strengths, calibrated for an average
// player (mu = START_MU). A fixed ladder cannot work for everyone: at those
// absolute settings Pro is unreachable for a beginner and Rookie is a formality
// for a veteran. Each difficulty therefore slides part-way toward the player's
// own hidden rating — partial tracking, so the four rungs keep distinct
// identities (Pro stays roughly a coin flip at any skill, Cyber stays a stretch)
// instead of collapsing into one rubber-banded opponent.
export const AI_ADAPT_STRENGTH = 0.6;
/** Most a difficulty may slide UP from its anchor, in mu points. */
export const AI_ADAPT_BAND = 7;
/**
 * Downward the ladder follows the player all the way, and the band is wide
 * enough never to strand them. Partial tracking leaves a residual gap of
 * (1 - strength) x deviation, which is fine above average — it is what lets a
 * player feel themselves outgrow Rookie — but below average it compounds: a
 * player losing to Pro fell to mu 13 while Pro stalled at the band edge of 18,
 * so their odds went 50% -> 22% and every further loss widened the gap. The
 * ladder must never get harder because you are losing.
 */
export const AI_ADAPT_DOWN_STRENGTH = 0.85;
export const AI_ADAPT_DOWN_BAND = 20;

/**
 * The mu the AI actually plays at for this player. This is the honest rating of
 * the opponent they face, so prediction and XP both key off it.
 */
export function effectiveAiMu(difficulty: AIDifficulty, playerMu: number): number {
  const base = AI_RATINGS[difficulty].mu;
  const deviation = playerMu - START_MU;
  // Asymmetric on purpose: full tracking down, partial up.
  return deviation < 0
    ? base + clamp(AI_ADAPT_DOWN_STRENGTH * deviation, -AI_ADAPT_DOWN_BAND, 0)
    : base + clamp(AI_ADAPT_STRENGTH * deviation, 0, AI_ADAPT_BAND);
}

/**
 * The most a solo win may lift μ to, per difficulty.
 *
 * The cap exists so that farming one rung converges on it and stops. It used
 * to be the difficulty's BASE anchor, which froze the whole early game (every
 * player started exactly on Pro's base, so beating Pro moved μ by nothing at
 * all while losses moved it freely down), and then `anchor + AI_ADAPT_BAND`,
 * which stopped working the moment the ladder grew: it hands Elite, Cyber and
 * Chaos an identical cap at the Overlord clamp, making the three top rungs
 * interchangeable for rank farming. So the cap is DATA, not a formula — each
 * value sits 0.1 under a tier floor, so farming a rung converges roughly one
 * tier above the band it simulates and stops, always short of the tier above.
 * AI_ADAPT_BAND is thereby purely a gameplay-adaptation range again; it no
 * longer decides what farming a rung is worth.
 *
 * Deliberately CONSTANTS rather than anything derived from the player's own
 * μ — a cap that rose with the player would chase them upward without bound.
 * Rookie's cap is START_MU exactly, so farming the one rung open from the
 * first match moves nothing from a standing start. Legend is the solo
 * ceiling: Overlord (37) is only ever reached through PvP, which is also what
 * keeps the self-reported-solo trade-off (CLAUDE.md §5) bounded.
 */
export const SOLO_MU_CAPS: Record<AIDifficulty, number> = {
  rookie: START_MU, // 25 — farming the open rung from a standing start moves nothing
  pro: 30.9, //   under the Grandmaster floor (31): Pro farming tops out at Master
  elite: 33.9, // under the Legend floor (34): Elite farming tops out at Grandmaster
  cyber: 36.9, // under the Overlord floor (37): tops out at Legend
  chaos: 36.9, // same — the apex stays a PvP achievement
};

export const soloMuCap = (difficulty: AIDifficulty): number => SOLO_MU_CAPS[difficulty];

/**
 * The solo difficulties that feed the RANKED track, not just hidden MMR.
 *
 * Rookie is the tutorial rung — open from the first match, and the one the
 * ladder hands you before you have proved anything — so placing against it
 * would be a formality and the tier badge would stop meaning much. Every
 * higher rung has to be earned through the achievement chain (see UNLOCKS in
 * achievements.ts), which is what makes them worth rating against.
 *
 * A solo result still weighs less than a duel wherever it lands: a lighter mu
 * step, and the SOLO_MU_CAPS ceiling, so no amount of farming an AI reaches
 * the top of the ladder. Note the standing trade-off (CLAUDE.md §5) — solo
 * stats are self-reported, so a modified client can forge them. That was the
 * reason the ranked track was PvP-only, and counting solo here accepts it
 * knowingly.
 */
export const RANKED_SOLO_DIFFICULTIES: readonly AIDifficulty[] = [
  'pro',
  'elite',
  'cyber',
  'chaos',
];

/** Whether a solo match at this difficulty moves the visible ranked rating. */
export const soloCountsForRank = (difficulty: AIDifficulty): boolean =>
  RANKED_SOLO_DIFFICULTIES.includes(difficulty);

/** The adapted anchor to rate a solo match against. */
export function aiRating(difficulty: AIDifficulty, playerMu: number): Rating {
  return { mu: effectiveAiMu(difficulty, playerMu), sigma: AI_RATINGS[difficulty].sigma };
}

/** The difficulty whose predicted win chance is closest to a coin flip. */
export function recommendedDifficulty(player: Rating): AIDifficulty {
  let best: AIDifficulty = 'pro';
  let bestGap = Infinity;
  for (const d of AI_DIFFICULTIES) {
    const gap = Math.abs(winProbability(player, aiRating(d, player.mu)) - 0.5);
    if (gap < bestGap) {
      bestGap = gap;
      best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Rating update
// ---------------------------------------------------------------------------

// PvP always moves a rating harder than an AI match does, three ways: a larger
// step, a full uncertainty reduction, and no cap.
export interface UpdateOptions {
  /** Scales the mu delta. */
  k: number;
  /** Scales how much sigma shrinks (certainty gained). */
  sigmaScale: number;
  /** Solo only: a win can never push mu past the AI anchor it beat, so
   *  farming a weak difficulty converges to that difficulty and stops. */
  cap?: number;
  /** TrueSkill-2 style performance weight (server-verified PvP only). */
  performance?: number;
}

/**
 * Placement matches shed uncertainty faster than ordinary ones — which is what
 * placement matches are FOR.
 *
 * Without this the two placement conditions disagreed about when placement
 * happens, and the slower one won silently. At the ordinary PvP shrink, sigma
 * after PLACEMENT_GAMES ranked matches is ~5.36 — still above PLACEMENT_SIGMA
 * — and does not reach 4.0 until about the SIXTEENTH ranked game. So a player
 * finished the five matches the profile screen counts, saw "5/5", and stayed
 * UNRANKED with no way to tell why: the counter is capped at 5 so it cannot
 * show the eleven games still actually required.
 *
 * The number of matches is the promise the UI makes, so that is the one made
 * true; the sigma condition stays as the safety net it was meant to be. At
 * this scale the worst case over five matches is sigma 3.84, and long-run
 * sigma is barely moved (1.97 vs 2.14 after 35 games), so ratings past
 * placement behave as before.
 */
export const PLACEMENT_SIGMA_SCALE = 2;

export const SOLO_UPDATE: UpdateOptions = { k: 0.35, sigmaScale: 0.5 };
export const PVP_UPDATE: UpdateOptions = { k: 1.0, sigmaScale: 1.0 };
/** A ranked match played while still unplaced. Same rating step, faster sigma. */
export const PLACEMENT_UPDATE: UpdateOptions = {
  ...PVP_UPDATE,
  sigmaScale: PVP_UPDATE.sigmaScale * PLACEMENT_SIGMA_SCALE,
};

/**
 * How far a match moved the visible ladder, as the number of arrows to draw.
 *
 * The overlay used to draw ONE arrow at any magnitude, so a first placement
 * game that moved 4.2 mu and a converged player's expected win that moved 0.05
 * drew the identical glyph — the direction was the whole message, and "how
 * much" was not asked.
 *
 * The bands are read off the real distribution, not chosen. A tier is exactly
 * 3 mu wide, which is what makes them mean anything; measured against
 * PVP_UPDATE at mu gaps of -6..+6 and an opponent at sigma 2:
 *
 *   sigma 0.6   0.018 - 0.088    ~34 wins to a tier
 *   sigma 1.0   0.049 - 0.238
 *   sigma 2.0   0.196 - 0.895    an even duel is 0.489
 *   sigma 3.0   0.442 - 1.852
 *   sigma 4.0   0.785 - 2.977
 *   placement   4.21, 3.01, 1.45, 1.51, 0.95 over the five games
 *   solo, earned rung, sigma 2   0.171
 *
 * MODERATE at 0.8 is where an ordinary settled duel stops and a real surprise
 * starts, so a routine ranked result is one arrow and two mean something. The
 * value has to clear the whole performance-weight range and not merely its
 * midpoint: performanceWeight is clamped to 0.5..1.5, and an even settled duel
 * scaled by it spans 0.245 to 0.734. 0.75 would sit 2% above the top of that;
 * 0.8 sits clear of it, so a 3-0 scoreline can never promote a routine duel to
 * two arrows on its own. The arrows report the LADDER, not the scoreboard.
 *
 * LARGE at 2.0 is "placement, or a big result while still uncertain" — rare
 * enough that a player who sees three arrows knows why. Rejected: 0.5/1.5,
 * which puts about half of steady-state results in the middle band and makes
 * two arrows the default.
 */
export const RANK_MOVE_EPSILON = 1e-9;
export const RANK_MOVE_MODERATE_MU = 0.8;
export const RANK_MOVE_LARGE_MU = 2.0;

/** Shared with the direction so the two can never disagree about 'none'. */
export function rankMoveSize(deltaMu: number): RankMagnitude {
  const d = Math.abs(deltaMu);
  // Negated rather than `d <= EPSILON`, so a NaN delta lands on 'none' too
  // rather than falling through to a magnitude nothing moved by.
  if (!(d > RANK_MOVE_EPSILON)) return 'none';
  if (d < RANK_MOVE_MODERATE_MU) return 'minor';
  if (d < RANK_MOVE_LARGE_MU) return 'moderate';
  return 'large';
}

/**
 * One-sided TrueSkill update: returns the new rating for `me` after a result
 * against `opponent`. The opponent is never modified — AI anchors are fixed,
 * and in PvP each client's own result is recorded against its own profile.
 */
export function updateRating(
  me: Rating,
  opponent: Rating,
  won: boolean,
  opts: UpdateOptions
): Rating {
  const sigma = Math.sqrt(me.sigma * me.sigma + TAU * TAU);
  const c = Math.sqrt(2 * BETA * BETA + sigma * sigma + opponent.sigma * opponent.sigma);
  // t is the standardised margin from the WINNER's point of view.
  const t = (won ? me.mu - opponent.mu : opponent.mu - me.mu) / c;

  const perf = clamp(opts.performance ?? 1, 0.5, 1.5);
  const delta = opts.k * perf * ((sigma * sigma) / c) * vWin(t);

  let mu = won ? me.mu + delta : me.mu - delta;
  if (opts.cap !== undefined && won && mu > opts.cap) {
    // Never drag a player DOWN to the cap — only stop the climb at it.
    mu = Math.max(me.mu, opts.cap);
  }

  const shrink = 1 - opts.sigmaScale * ((sigma * sigma) / (c * c)) * wWin(t);
  const nextSigma = Math.sqrt(sigma * sigma * Math.max(0.2, shrink));

  return { mu, sigma: Math.max(SIGMA_FLOOR, nextSigma) };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ---------------------------------------------------------------------------
// Visible tiers
// ---------------------------------------------------------------------------

// Tier is keyed on ranked MU, deliberately NOT on the conservative mu-3*sigma
// leaderboard rating: with mu-3*sigma an average player climbs two tiers just
// by playing more games as sigma shrinks, with zero change in actual skill.
// Placement (below) is what stops an unproven player ranking high.
export type Tier =
  | 'unranked'
  | 'rookie'
  | 'contender'
  | 'vanguard'
  | 'ace'
  | 'master'
  | 'grandmaster'
  | 'legend'
  | 'overlord';

export const TIER_ORDER: Tier[] = [
  'rookie',
  'contender',
  'vanguard',
  'ace',
  'master',
  'grandmaster',
  'legend',
  'overlord',
];

// Lower bound of each tier, in mu.
const TIER_FLOORS: { tier: Tier; mu: number }[] = [
  { tier: 'rookie', mu: -Infinity },
  { tier: 'contender', mu: 19 },
  { tier: 'vanguard', mu: 22 },
  { tier: 'ace', mu: 25 },
  { tier: 'master', mu: 28 },
  { tier: 'grandmaster', mu: 31 },
  { tier: 'legend', mu: 34 },
  { tier: 'overlord', mu: 37 },
];

// A rank is only shown once the rating has actually been tested against other
// humans and the uncertainty has come down.
export const PLACEMENT_GAMES = 5;
export const PLACEMENT_SIGMA = 4.0;

/**
 * How far the top of the ladder is numbered. Cyber Overlord is a rating
 * threshold like every other rung — reaching it is still rankMu >= 37 and
 * nothing else — but it is the one rung with no rung above it, so it reads as
 * a POSITION rather than a word: #1 through #100, counting down.
 *
 * Deliberately not the definition of the tier. Making the headcount decide who
 * is an Overlord would put every other player's activity inside `tierFor`,
 * which is a pure function of one player's own rating today — and on a server
 * with fewer than a hundred ranked players it would promote everyone placed.
 */
export const LADDER_TOP_N = 100;

export function isPlaced(rankedGames: number, rankSigma: number): boolean {
  return rankedGames >= PLACEMENT_GAMES && rankSigma <= PLACEMENT_SIGMA;
}

export function tierFor(rankMu: number, rankedGames: number, rankSigma: number): Tier {
  if (!isPlaced(rankedGames, rankSigma)) return 'unranked';
  let tier: Tier = 'rookie';
  for (const t of TIER_FLOORS) {
    if (rankMu >= t.mu) tier = t.tier;
  }
  return tier;
}

/** Progress through the current tier, 0..1 — for a badge progress ring. */
export function tierProgress(rankMu: number): number {
  const idx = TIER_FLOORS.findIndex((t, i) => {
    const next = TIER_FLOORS[i + 1];
    return rankMu >= t.mu && (!next || rankMu < next.mu);
  });
  if (idx <= 0) return clamp((rankMu - 16) / 3, 0, 1);
  const next = TIER_FLOORS[idx + 1];
  // The top band is FULL, always. There is no rung above Overlord, so the only
  // way to give this line a denominator was a synthetic `floor + 3` band —
  // which meant the apex meter measured progress toward a ceiling that does not
  // exist, read 0 at exactly the moment a player arrived there, and then
  // saturated at mu 40 and never moved again. A full bar is the honest answer:
  // the ladder is finished. What replaces the missing progress is the ladder
  // POSITION on the badge beside it (LADDER_TOP_N).
  if (!next) return 1;
  const floor = TIER_FLOORS[idx].mu;
  return clamp((rankMu - floor) / (next.mu - floor), 0, 1);
}

export const TIER_LABEL_KEY: Record<Tier, string> = {
  unranked: 'tier_unranked',
  rookie: 'tier_rookie',
  contender: 'tier_contender',
  vanguard: 'tier_vanguard',
  ace: 'tier_ace',
  master: 'tier_master',
  grandmaster: 'tier_grandmaster',
  legend: 'tier_legend',
  overlord: 'tier_overlord',
};

// Tailwind classes reusing the existing tinted-chip pattern already used for
// rankTitle / BOT pills, so tier badges match the rest of the UI.
export const TIER_STYLE: Record<Tier, string> = {
  unranked: 'bg-zinc-700/30 text-zinc-400 border-zinc-600/40 cos-light:text-zinc-700 cos-light:border-zinc-600/50',
  rookie: 'bg-slate-500/20 text-slate-300 border-slate-400/40 cos-light:text-slate-700 cos-light:border-slate-600/50',
  contender: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/40 cos-light:text-emerald-700 cos-light:border-emerald-600/50',
  vanguard: 'bg-cyan-500/15 text-cyan-300 border-cyan-400/40 cos-light:text-cyan-700 cos-light:border-cyan-600/50',
  ace: 'bg-sky-500/20 text-sky-300 border-sky-400/40 cos-light:text-sky-700 cos-light:border-sky-600/50',
  master: 'bg-violet-500/20 text-violet-300 border-violet-400/40 cos-light:text-violet-700 cos-light:border-violet-600/50',
  grandmaster: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-400/40 cos-light:text-fuchsia-700 cos-light:border-fuchsia-600/50',
  legend: 'bg-amber-500/20 text-amber-300 border-amber-400/40 cos-light:text-amber-700 cos-light:border-amber-600/50',
  overlord: 'bg-rose-500/20 text-rose-300 border-rose-400/50 cos-light:text-rose-700 cos-light:border-rose-600/50',
};

// ---------------------------------------------------------------------------
// Experience
// ---------------------------------------------------------------------------

// XP and rank are separate currencies. XP is the time-invested track: every
// match earns it (solo included), it is scaled by how surprising the result
// was, and it NEVER decreases — levels can't regress.
export const XP_PER_POINT = 12;
// Raised from 4 with the counting change. A rally number is one player's own
// consecutive returns now rather than a whole point's worth of both players',
// which measures about 0.72x the old figure across the ladder — so the rate
// goes up by roughly the reciprocal and the XP a rally is worth stays put.
export const XP_PER_RALLY = 6;
/**
 * How much of a rally streak one match may be paid for.
 *
 * A streak carries between matches, so without a ceiling the SAME run is paid
 * for again in every match it spans — a player who stops missing earns steadily
 * more per match for something they did once, and it never stops rising. The
 * cap sits around the 99th percentile of a streak built inside a single match,
 * so ordinary play never reaches it and only a carried run does.
 */
export const RALLY_XP_CAP = 25;
export const XP_WIN_BONUS = 40;
export const XP_PVP_MULTIPLIER = 1.5;
// Every finished match is progression, win or lose. Playing one is the part
// that costs the player time, so it is paid for on its own before anything
// about the result is considered.
export const XP_PLAY_BONUS = 35;
export const XP_FLOOR = 45;

/**
 * Multiplier from the pre-match prediction. `winProb` is the player's own
 * predicted chance of winning.
 *  - win:  0.60 (certain win) .. 2.00 (certain upset)
 *  - loss: 0.40 (lost while heavily favoured) .. 0.95 (lost to a giant)
 * Difficulty scaling is implicit: winProb already encodes opponent strength,
 * so there is no per-difficulty XP table anywhere. The loss floor is well
 * above zero deliberately: a loss used to pay the raw XP_FLOOR, about 25
 * losses to a level, which reads as no progression at all.
 */
export function surpriseMultiplier(winProb: number, won: boolean): number {
  const p = clamp(winProb, 0, 1);
  return won ? 0.6 + 1.4 * (1 - p) : 0.4 + 0.55 * (1 - p);
}

export function matchXp(params: {
  playerScore: number;
  /** This player's longest rally STREAK in the match — their own returns. */
  bestStreak: number;
  won: boolean;
  winProb: number;
  mode: GameMode;
}): number {
  const base =
    XP_PLAY_BONUS +
    params.playerScore * XP_PER_POINT +
    Math.min(params.bestStreak, RALLY_XP_CAP) * XP_PER_RALLY +
    (params.won ? XP_WIN_BONUS : 0);
  const modeMult = params.mode === 'multiplayer' ? XP_PVP_MULTIPLIER : 1;
  const xp = base * surpriseMultiplier(params.winProb, params.won) * modeMult;
  return Math.max(XP_FLOOR, Math.round(xp));
}

// ---------------------------------------------------------------------------
// Solo XP momentum and fatigue
// ---------------------------------------------------------------------------
//
// Two forces, multiplied into SOLO match XP only, both computed server-side
// inside recordMatch — a client still never sends an XP amount, and PvP XP is
// untouched:
//
//   soloXp = clamp(matchXp × momentum(w) × fatigue(n), XP_FLOOR, SOLO_XP_MATCH_CAP)
//
// MOMENTUM rewards consecutive solo wins, ramping with diminishing increments
// toward saturation. `w` is the solo win streak the player CARRIES INTO the
// match — the streak before this result is applied, the same walked-in-on
// convention the rally carry uses — which is what makes a loss that ends a
// long run still pay more than an early loss: the multiplier applies to
// losses too, on the run they arrived holding, and the loss then resets the
// streak as it always did.
//
// FATIGUE decays the multiplier with the number of solo matches already
// recorded today (UTC), floored well above zero: same-day solo grinding
// trends toward reduced efficiency but never toward nothing, so "solo cannot
// be farmed at full efficiency" is arithmetic rather than a rule someone has
// to remember. PvP never fatigues.
//
// The CAP is a constant, deliberately not scaled by anything — however long
// the streak, no solo match ever pays more than it. XP_FLOOR survives
// unchanged underneath, so "every match is progression, levels never regress"
// keeps holding: fatigue attacks the multiplier, never the floor.
//
// Difficulty needs no term here. The anchors are monotone and adaptation
// preserves their spread, so winProbability is strictly lower against a
// harder rung and both surprise multipliers rise as it falls — harder always
// pays more, win or loss, with no per-difficulty XP table anywhere.

/** Saturation of the win-streak ramp: a long run at most doubles XP. */
export const SOLO_MOMENTUM_MAX = 2.0;
/** Fatigue never cuts a match below this fraction of its unfatigued value. */
export const SOLO_FATIGUE_FLOOR = 0.6;
/** Solo matches per day before fatigue starts to bite. */
export const SOLO_FATIGUE_FREE_GAMES = 3;
/**
 * Multiplier lost per fatigued game until the floor. Deliberately gentle
 * next to the ramp: the specifying example has a mid-session win streak
 * paying strictly more per match through game eight even as the day's games
 * mount, so the ramp must outpace the decay over any realistic streak —
 * fatigue is there to tax streak-LESS grinding, not to cancel momentum.
 */
export const SOLO_FATIGUE_STEP = 0.02;
/** No solo match ever pays more than this, however long the streak. */
export const SOLO_XP_MATCH_CAP = 450;

/** Concave, saturating: increments diminish as the streak grows. */
export const soloMomentum = (winStreak: number): number => {
  const w = Math.max(0, Math.floor(winStreak || 0));
  return 1 + (SOLO_MOMENTUM_MAX - 1) * (w / (w + 3));
};

export const soloFatigue = (gamesToday: number): number => {
  const n = Math.max(0, Math.floor(gamesToday || 0));
  return Math.max(
    SOLO_FATIGUE_FLOOR,
    1 - SOLO_FATIGUE_STEP * Math.max(0, n - SOLO_FATIGUE_FREE_GAMES)
  );
};

/**
 * Momentum and fatigue applied to a solo match's XP. `winStreak` is the solo
 * win streak carried INTO the match; `gamesToday` counts solo matches already
 * recorded this UTC day, before this one.
 */
export function soloAdjustedXp(baseXp: number, winStreak: number, gamesToday: number): number {
  const adjusted = Math.round(baseXp * soloMomentum(winStreak) * soloFatigue(gamesToday));
  return Math.min(SOLO_XP_MATCH_CAP, Math.max(XP_FLOOR, adjusted));
}

// ---------------------------------------------------------------------------
// Practice Wall
// ---------------------------------------------------------------------------
//
// Practice has no opponent and the return line gives the ball back every time,
// so a streak is a measure of endurance, not of beating anyone. It pays real
// but deliberately thin XP, keyed on the best streak of the session, and is
// capped per day: without a cap it would be the fastest XP in the game by a
// wide margin precisely because it cannot be lost.

export const PRACTICE_XP_PER_RETURN = 2;
export const PRACTICE_XP_SESSION_CAP = 90;
export const PRACTICE_XP_DAILY_CAP = 300;

/** XP for one Practice Wall session, from its best return streak. */
export function practiceXp(bestStreak: number): number {
  const streak = Math.max(0, Math.floor(bestStreak || 0));
  if (streak < 3) return 0; // a couple of taps is not a session
  // Square-root shaped: early returns are worth the most, so a long grind
  // cannot out-earn simply playing real matches.
  const raw = PRACTICE_XP_PER_RETURN * Math.sqrt(streak) * 3;
  return Math.min(PRACTICE_XP_SESSION_CAP, Math.round(raw));
}

// Level curve: each level costs a bit more than the last, growing linearly
// instead of the old 120*L^1.6 (whose level-1 band was only 120 XP — a single
// match overshot an entire level).
export const LEVEL_BASE = 250;
export const LEVEL_STEP = 60;

export const levelBand = (level: number): number => LEVEL_BASE + LEVEL_STEP * (level - 1);

/**
 * Most of a level band any ONE achievement may hand over.
 *
 * Achievement rewards are flat constants but level bands grow, so a reward
 * sized for the mid game lands as a windfall early: `level_10` paid 750 into a
 * 790-wide band, awarding almost the whole of the level it was celebrating,
 * and a scaled achievement multiplied by a 1.9 surprise could beat that. The
 * cap makes "an achievement never hands you most of a level" true by
 * construction rather than by keeping thirteen constants in sync by hand.
 */
export const ACHIEVEMENT_BAND_CAP = 0.6;

/** The most an achievement may pay a player at `level`. */
export const achievementXpCap = (level: number): number =>
  Math.round(levelBand(level) * ACHIEVEMENT_BAND_CAP);

/** Cumulative XP required to REACH `level`. */
export function xpForLevel(level: number): number {
  let total = 0;
  for (let l = 1; l < level; l++) total += levelBand(l);
  return total;
}

export function levelFromXp(xp: number): { level: number; xpNext: number } {
  let level = 1;
  let next = xpForLevel(2);
  while (xp >= next) {
    level++;
    next = xpForLevel(level + 1);
  }
  return { level, xpNext: next };
}
