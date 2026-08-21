import { AIDifficulty, GameMode } from './types';

// TrueSkill-style skill rating, shared by client and server (same convention
// as profileRules.ts — the server imports from ../src so the two sides can
// never disagree about a prediction).
//
// Every player carries TWO Gaussian ratings:
//   * hidden MMR  — moved by EVERY match (solo included). Drives the win
//     prediction, the XP surprise multiplier, and difficulty recommendation.
//     Never shown as a number and never exposed on public profiles.
//   * ranked      — moved by PvP ONLY. Drives the visible tier badge.
// Solo results therefore can never move a player's rank.

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

// Mapped from the real AI parameters in game/physics.ts (reaction time, max
// paddle speed, aim error). Anchors never move, and carry a small sigma
// because a difficulty tier is a known quantity.
export const AI_RATINGS: Record<AIDifficulty, Rating> = {
  rookie: { mu: 18, sigma: 0.5 },
  pro: { mu: 25, sigma: 0.5 },
  cyber: { mu: 29, sigma: 0.5 },
};

export const AI_DIFFICULTIES: AIDifficulty[] = ['rookie', 'pro', 'cyber'];

/**
 * Coerce anything that claims to be a difficulty into one that still exists.
 * Retired names map to the nearest surviving rung rather than silently
 * becoming the default, so a stored 'chaos' still means "the hard one" and an
 * old match-history row still renders.
 */
const RETIRED_DIFFICULTIES: Record<string, AIDifficulty> = { chaos: 'cyber' };

export function normalizeDifficulty(value: unknown): AIDifficulty {
  const key = typeof value === 'string' ? value.toLowerCase() : '';
  if ((AI_DIFFICULTIES as string[]).includes(key)) return key as AIDifficulty;
  return RETIRED_DIFFICULTIES[key] || 'pro';
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
export const AI_ADAPT_DOWN_STRENGTH = 1;
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

export const SOLO_UPDATE: UpdateOptions = { k: 0.35, sigmaScale: 0.5 };
export const PVP_UPDATE: UpdateOptions = { k: 1.0, sigmaScale: 1.0 };

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
  const floor = TIER_FLOORS[idx].mu;
  const next = TIER_FLOORS[idx + 1]?.mu ?? floor + 3;
  return clamp((rankMu - floor) / (next - floor), 0, 1);
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
  unranked: 'bg-zinc-700/30 text-zinc-400 border-zinc-600/40',
  rookie: 'bg-slate-500/20 text-slate-300 border-slate-400/40',
  contender: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/40',
  vanguard: 'bg-cyan-500/15 text-cyan-300 border-cyan-400/40',
  ace: 'bg-sky-500/20 text-sky-300 border-sky-400/40',
  master: 'bg-violet-500/20 text-violet-300 border-violet-400/40',
  grandmaster: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-400/40',
  legend: 'bg-amber-500/20 text-amber-300 border-amber-400/40',
  overlord: 'bg-rose-500/20 text-rose-300 border-rose-400/50',
};

// ---------------------------------------------------------------------------
// Experience
// ---------------------------------------------------------------------------

// XP and rank are separate currencies. XP is the time-invested track: every
// match earns it (solo included), it is scaled by how surprising the result
// was, and it NEVER decreases — levels can't regress.
export const XP_PER_POINT = 12;
export const XP_PER_RALLY = 4;
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
  maxRally: number;
  won: boolean;
  winProb: number;
  mode: GameMode;
}): number {
  const base =
    XP_PLAY_BONUS +
    params.playerScore * XP_PER_POINT +
    params.maxRally * XP_PER_RALLY +
    (params.won ? XP_WIN_BONUS : 0);
  const modeMult = params.mode === 'multiplayer' ? XP_PVP_MULTIPLIER : 1;
  const xp = base * surpriseMultiplier(params.winProb, params.won) * modeMult;
  return Math.max(XP_FLOOR, Math.round(xp));
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
