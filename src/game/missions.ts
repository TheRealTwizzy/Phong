import { AIDifficulty, DailyMission, GameUnlock, MatchEndPayload, MissionContext, MissionType } from '../types';
import { isShutout, SHUTOUT_MIN_POINTS } from '../matchRules';

// Daily mission DEFINITIONS, shared by client and server exactly like
// profileRules.ts and rating.ts. Progress and claims live on the SERVER
// (server/db.ts): missions used to be kept in localStorage and claimed by
// POSTing their own reward as an `xpDelta`, which meant clearing site data
// re-armed all five, and the raw endpoint could be called in a loop. Nothing
// in here reads or writes storage — it is pure data plus the rules for
// advancing progress.

export type MissionTier = 'regular' | 'elite';

export interface MissionDef {
  id: string;
  type: MissionType;
  tier: MissionTier;
  titleKey: string;
  descKey: string;
  target: number;
  xpReward: number;
  /**
   * A permanent unlock earned the FIRST time this mission is completed, ever.
   * Elite missions only: the XP is daily, but this is kept for good, which is
   * what makes a single brutal day's work worth doing. Names a cosmetic id OR
   * a title id (src/game/titles.ts) — the value is banked verbatim in
   * elite_completions, so the two catalogues must never share an id, and this
   * string must never be renamed once shipped.
   */
  unlocks?: string;
  /**
   * Solo difficulty the match must have been played at, if any. Never on a
   * `win_streak` task: that type reads the POOLED consecutive-wins counter,
   * which no filter applies to, so a filter here would disagree with it.
   */
  difficulty?: AIDifficulty;
  /** Restrict to a mode, e.g. an elite duel mission. */
  mode?: 'solo' | 'multiplayer';
}

/**
 * The regular pool. A player is dealt REGULAR_SLOTS of these each day, so
 * there is something to reroll INTO — a fixed five would make a reroll button
 * meaningless.
 */
export const MISSION_POOL: MissionDef[] = [
  { id: 'mission_games', type: 'games_played', tier: 'regular', titleKey: 'mission_games_title', descKey: 'mission_games_desc', target: 3, xpReward: 120 },
  { id: 'mission_games_6', type: 'games_played', tier: 'regular', titleKey: 'mission_games6_title', descKey: 'mission_games6_desc', target: 6, xpReward: 180 },
  { id: 'mission_win', type: 'matches_won', tier: 'regular', titleKey: 'mission_win_title', descKey: 'mission_win_desc', target: 1, xpReward: 150 },
  { id: 'mission_win_3', type: 'matches_won', tier: 'regular', titleKey: 'mission_win3_title', descKey: 'mission_win3_desc', target: 3, xpReward: 220 },
  { id: 'mission_rally', type: 'rally', tier: 'regular', titleKey: 'mission_rally_title', descKey: 'mission_rally_desc', target: 6, xpReward: 120 },
  { id: 'mission_rally_15', type: 'rally', tier: 'regular', titleKey: 'mission_rally15_title', descKey: 'mission_rally15_desc', target: 11, xpReward: 200 },
  { id: 'mission_multi', type: 'multiplayer', tier: 'regular', titleKey: 'mission_multi_title', descKey: 'mission_multi_desc', target: 1, xpReward: 200 },
  { id: 'mission_points', type: 'points_scored', tier: 'regular', titleKey: 'mission_points_title', descKey: 'mission_points_desc', target: 12, xpReward: 120 },
  { id: 'mission_points_25', type: 'points_scored', tier: 'regular', titleKey: 'mission_points25_title', descKey: 'mission_points25_desc', target: 25, xpReward: 200 },
  { id: 'mission_pro_win', type: 'matches_won', tier: 'regular', titleKey: 'mission_prowin_title', descKey: 'mission_prowin_desc', target: 1, xpReward: 200, difficulty: 'pro' },
  { id: 'mission_aces', type: 'aces', tier: 'regular', titleKey: 'mission_aces_title', descKey: 'mission_aces_desc', target: 3, xpReward: 180 },
  { id: 'mission_shutout', type: 'shutouts', tier: 'regular', titleKey: 'mission_shutout_title', descKey: 'mission_shutout_desc', target: 1, xpReward: 220 },
  // ---- Added with the progression-depth release ---------------------------
  // Appended AFTER the original twelve on purpose: tests/missions.test.ts
  // takes the FIRST entry of each type as the exemplar for that type's rule,
  // so the order above is load-bearing and nothing may be inserted into it.
  { id: 'mission_games_10', type: 'games_played', tier: 'regular', titleKey: 'mission_games10_title', descKey: 'mission_games10_desc', target: 10, xpReward: 260 },
  { id: 'mission_win_5', type: 'matches_won', tier: 'regular', titleKey: 'mission_win5_title', descKey: 'mission_win5_desc', target: 5, xpReward: 300 },
  { id: 'mission_points_50', type: 'points_scored', tier: 'regular', titleKey: 'mission_points50_title', descKey: 'mission_points50_desc', target: 50, xpReward: 280 },
  { id: 'mission_rally_20', type: 'rally', tier: 'regular', titleKey: 'mission_rally20_title', descKey: 'mission_rally20_desc', target: 20, xpReward: 260 },
  { id: 'mission_aces_6', type: 'aces', tier: 'regular', titleKey: 'mission_aces6_title', descKey: 'mission_aces6_desc', target: 6, xpReward: 260 },
  { id: 'mission_shutout_2', type: 'shutouts', tier: 'regular', titleKey: 'mission_shutout2_title', descKey: 'mission_shutout2_desc', target: 2, xpReward: 300 },
  { id: 'mission_rookie_win_3', type: 'matches_won', tier: 'regular', titleKey: 'mission_rookiewin3_title', descKey: 'mission_rookiewin3_desc', target: 3, xpReward: 150, difficulty: 'rookie' },
  { id: 'mission_pro_win_3', type: 'matches_won', tier: 'regular', titleKey: 'mission_prowin3_title', descKey: 'mission_prowin3_desc', target: 3, xpReward: 260, difficulty: 'pro' },
  { id: 'mission_elite_win', type: 'matches_won', tier: 'regular', titleKey: 'mission_elitewin_title', descKey: 'mission_elitewin_desc', target: 1, xpReward: 240, difficulty: 'elite' },
  { id: 'mission_elite_win_3', type: 'matches_won', tier: 'regular', titleKey: 'mission_elitewin3_title', descKey: 'mission_elitewin3_desc', target: 3, xpReward: 320, difficulty: 'elite' },
  { id: 'mission_cyber_win', type: 'matches_won', tier: 'regular', titleKey: 'mission_cyberwin_title', descKey: 'mission_cyberwin_desc', target: 1, xpReward: 280, difficulty: 'cyber' },
  { id: 'mission_chaos_win', type: 'matches_won', tier: 'regular', titleKey: 'mission_chaoswin_title', descKey: 'mission_chaoswin_desc', target: 1, xpReward: 320, difficulty: 'chaos' },
  { id: 'mission_duel_win', type: 'matches_won', tier: 'regular', titleKey: 'mission_duelwin_title', descKey: 'mission_duelwin_desc', target: 1, xpReward: 260, mode: 'multiplayer' },
  { id: 'mission_duel_2', type: 'multiplayer', tier: 'regular', titleKey: 'mission_duel2_title', descKey: 'mission_duel2_desc', target: 2, xpReward: 260 },
  { id: 'mission_duel_points_15', type: 'points_scored', tier: 'regular', titleKey: 'mission_duelpoints15_title', descKey: 'mission_duelpoints15_desc', target: 15, xpReward: 240, mode: 'multiplayer' },
  { id: 'mission_duel_rally_10', type: 'rally', tier: 'regular', titleKey: 'mission_duelrally10_title', descKey: 'mission_duelrally10_desc', target: 10, xpReward: 240, mode: 'multiplayer' },
  { id: 'mission_pro_rally_12', type: 'rally', tier: 'regular', titleKey: 'mission_prorally12_title', descKey: 'mission_prorally12_desc', target: 12, xpReward: 220, difficulty: 'pro' },
  { id: 'mission_cyber_points_10', type: 'points_scored', tier: 'regular', titleKey: 'mission_cyberpoints10_title', descKey: 'mission_cyberpoints10_desc', target: 10, xpReward: 260, difficulty: 'cyber' },
  { id: 'mission_close_win', type: 'close_wins', tier: 'regular', titleKey: 'mission_closewin_title', descKey: 'mission_closewin_desc', target: 1, xpReward: 200 },
  { id: 'mission_close_win_2', type: 'close_wins', tier: 'regular', titleKey: 'mission_closewin2_title', descKey: 'mission_closewin2_desc', target: 2, xpReward: 280 },
  { id: 'mission_dominant_win', type: 'dominant_wins', tier: 'regular', titleKey: 'mission_dominantwin_title', descKey: 'mission_dominantwin_desc', target: 1, xpReward: 200 },
  { id: 'mission_dominant_win_3', type: 'dominant_wins', tier: 'regular', titleKey: 'mission_dominantwin3_title', descKey: 'mission_dominantwin3_desc', target: 3, xpReward: 320 },
  { id: 'mission_long_win', type: 'long_wins', tier: 'regular', titleKey: 'mission_longwin_title', descKey: 'mission_longwin_desc', target: 1, xpReward: 220 },
  { id: 'mission_long_win_2', type: 'long_wins', tier: 'regular', titleKey: 'mission_longwin2_title', descKey: 'mission_longwin2_desc', target: 2, xpReward: 300 },
  { id: 'mission_streak_3', type: 'win_streak', tier: 'regular', titleKey: 'mission_streak3_title', descKey: 'mission_streak3_desc', target: 3, xpReward: 240 },
  { id: 'mission_streak_5', type: 'win_streak', tier: 'regular', titleKey: 'mission_streak5_title', descKey: 'mission_streak5_desc', target: 5, xpReward: 320 },
  { id: 'mission_wall_100', type: 'practice_returns', tier: 'regular', titleKey: 'mission_wall100_title', descKey: 'mission_wall100_desc', target: 100, xpReward: 150 },
  { id: 'mission_wall_300', type: 'practice_returns', tier: 'regular', titleKey: 'mission_wall300_title', descKey: 'mission_wall300_desc', target: 300, xpReward: 240 },
];

/**
 * The elite pool. Deliberately punishing — a day's work, not an errand — and
 * each one carries a permanent unlock the first time it is ever completed.
 */
export const ELITE_POOL: MissionDef[] = [
  { id: 'elite_cyber_3', type: 'matches_won', tier: 'elite', titleKey: 'elite_cyber3_title', descKey: 'elite_cyber3_desc', target: 3, xpReward: 600, difficulty: 'cyber', unlocks: 'void-runner' },
  { id: 'elite_rally_40', type: 'rally', tier: 'elite', titleKey: 'elite_rally40_title', descKey: 'elite_rally40_desc', target: 28, xpReward: 600, unlocks: 'crimson-tide' },
  { id: 'elite_shutout_2', type: 'shutouts', tier: 'elite', titleKey: 'elite_shutout2_title', descKey: 'elite_shutout2_desc', target: 2, xpReward: 600, unlocks: 'arctic-glass' },
  { id: 'elite_points_60', type: 'points_scored', tier: 'elite', titleKey: 'elite_points60_title', descKey: 'elite_points60_desc', target: 60, xpReward: 600, unlocks: 'molten-core' },
  { id: 'elite_duel_3', type: 'matches_won', tier: 'elite', titleKey: 'elite_duel3_title', descKey: 'elite_duel3_desc', target: 3, xpReward: 600, mode: 'multiplayer', unlocks: 'signal-lost' },
  { id: 'elite_aces_8', type: 'aces', tier: 'elite', titleKey: 'elite_aces8_title', descKey: 'elite_aces8_desc', target: 8, xpReward: 600, unlocks: 'gilded-age' },
  // ---- Added with the progression-depth release ---------------------------
  // The first four bank a theme; the rest bank a TITLE (src/game/titles.ts),
  // because the palette-distinctness floor had room for four more looks and
  // not for ten. 43 is 60 x 0.72, the rally rescale every other rally figure
  // in the game carries.
  { id: 'elite_chaos_3', type: 'matches_won', tier: 'elite', titleKey: 'elite_chaos3_title', descKey: 'elite_chaos3_desc', target: 3, xpReward: 600, difficulty: 'chaos', unlocks: 'event-horizon' },
  { id: 'elite_rally_60', type: 'rally', tier: 'elite', titleKey: 'elite_rally60_title', descKey: 'elite_rally60_desc', target: 43, xpReward: 600, unlocks: 'glasshouse' },
  { id: 'elite_duel_5', type: 'matches_won', tier: 'elite', titleKey: 'elite_duel5_title', descKey: 'elite_duel5_desc', target: 5, xpReward: 600, mode: 'multiplayer', unlocks: 'floodlights' },
  { id: 'elite_shutout_5', type: 'shutouts', tier: 'elite', titleKey: 'elite_shutout5_title', descKey: 'elite_shutout5_desc', target: 5, xpReward: 600, unlocks: 'moss-court' },
  { id: 'elite_streak_10', type: 'win_streak', tier: 'elite', titleKey: 'elite_streak10_title', descKey: 'elite_streak10_desc', target: 10, xpReward: 700, unlocks: 'unbroken' },
  { id: 'elite_points_120', type: 'points_scored', tier: 'elite', titleKey: 'elite_points120_title', descKey: 'elite_points120_desc', target: 120, xpReward: 600, unlocks: 'scoreboard' },
  { id: 'elite_aces_15', type: 'aces', tier: 'elite', titleKey: 'elite_aces15_title', descKey: 'elite_aces15_desc', target: 15, xpReward: 600, unlocks: 'sniper' },
  { id: 'elite_wall_1000', type: 'practice_returns', tier: 'elite', titleKey: 'elite_wall1000_title', descKey: 'elite_wall1000_desc', target: 1000, xpReward: 600, unlocks: 'wallbreaker' },
  { id: 'elite_close_3', type: 'close_wins', tier: 'elite', titleKey: 'elite_close3_title', descKey: 'elite_close3_desc', target: 3, xpReward: 650, unlocks: 'clutch' },
  { id: 'elite_cyber_shutout', type: 'shutouts', tier: 'elite', titleKey: 'elite_cybershutout_title', descKey: 'elite_cybershutout_desc', target: 1, xpReward: 700, difficulty: 'cyber', unlocks: 'cold-steel' },
];

export const ALL_MISSIONS: MissionDef[] = [...MISSION_POOL, ...ELITE_POOL];

/**
 * What a task demands before it can be DEALT — the unlocks a player has to
 * already hold for the task to be finishable at all.
 *
 * A task nobody can complete is the most confusing kind of task there is, and
 * the elite pool held the worst case: `elite_cyber_3` asks for three Cyber
 * wins, carries 600 XP and a permanent theme, and was dealt to players who had
 * not opened Cyber — against a single elite reroll a day. The player is told
 * to beat an opponent the menu will not let them select.
 *
 * Note the two spellings, because missing either one leaves half the problem:
 * a duel task says so through `mode` (`elite_duel_3`) OR through `type`
 * (`mission_multi`, which carries no `mode` field at all).
 */
export const missionRequires = (def: MissionDef): GameUnlock[] => {
  const needs: GameUnlock[] = [];
  if (def.difficulty) needs.push({ kind: 'difficulty', value: def.difficulty });
  if (def.mode === 'multiplayer' || def.type === 'multiplayer') {
    needs.push({ kind: 'mode', value: 'multiplayer' });
  }
  // A first-to-10 is behind a first win; a task asking for one before the
  // length can be picked is the elite_cyber_3 problem in a new shape.
  if (def.type === 'long_wins') needs.push({ kind: 'winningScore', value: 10 });
  return needs;
};

/**
 * The pool a given player may be dealt from. Kept here rather than in the
 * database layer so the deal and the progress rule read the same definitions,
 * and so a test can state the property that matters: every tier still deals a
 * FULL hand at the worst case, which is an account with no achievements at
 * all. Filtering a pool below its slot count would trade an impossible task
 * for a missing one.
 */
export const dealablePool = (
  pool: readonly MissionDef[],
  holds: (unlock: GameUnlock) => boolean
): MissionDef[] => pool.filter((def) => missionRequires(def).every(holds));

/**
 * How many of each tier a player holds on any given day.
 *
 * Three regular, not five: a shorter list is one a player actually reads, and
 * it leaves more of the pool spare — which is what a claim needs to deal a
 * fresh task into the slot it empties. At five slots a productive day
 * exhausted the then twelve-strong pool after about seven claims and the
 * claimed task then had nowhere to go; at three there was room for nine, and
 * the pool is forty now.
 */
export const REGULAR_SLOTS = 3;
export const ELITE_SLOTS = 1;

/** Rerolls granted per UTC day, per tier. Both reset with the day. */
export const REROLLS_REGULAR = 5;
export const REROLLS_ELITE = 1;

/**
 * How many times a CLAIM may deal a fresh task into the slot it empties, per
 * UTC day and per tier. Past this the slot is cleared for the day.
 *
 * The free re-deal used to be unlimited, on the reasoning that the paid
 * allowance is for tasks you did not want and finishing one is the opposite
 * of that. True, and it turned the daily list into the largest XP source in
 * the game: a one-match task (a shutout, a rally, a single win) can be claimed
 * and re-dealt EVERY match, so a strong player took 13,500 to 29,000 task XP
 * a day at sixty matches — up to 480 XP per match on top of the match — and
 * all six elite themes fell in one afternoon because the elite slot cycled the
 * whole elite pool. "Daily" tasks that pay per match are not daily. Three and
 * one bound a day at eight claims: enough that finishing the hand is not the
 * end of the day, few enough that it is still a hand.
 */
export const FREE_REDEALS_REGULAR = 3;
export const FREE_REDEALS_ELITE = 1;

/**
 * How many recent deals block a task from being dealt again.
 *
 * Tasks are NOT one-and-done: finishing one puts it back in the pool, so the
 * regular tasks can never be used up and a claim always has something to
 * deal. What stops the same task returning immediately is this window —
 * anything among the last few dealt is skipped, along with anything currently
 * held. Six against a forty-strong pool: it was three against twelve, and the
 * window grew with the pool so a week of hands reads as variety rather than
 * the same three tasks in rotation. Still small enough that the pool can never
 * be swallowed by it, which is the old exhaustion problem in a different hat.
 */
export const RECENT_DEAL_MEMORY = 6;

/** Pick a hand of `count` from `order`, avoiding anything recently dealt. */
export function pickHand(order: readonly string[], recent: ReadonlySet<string>, count: number): string[] {
  const hand = order.filter((id) => !recent.has(id)).slice(0, count);
  // A pool small enough that the recency window swallows it still has to deal
  // a full hand; falling back to the plain order is better than a short one.
  for (const id of order) {
    if (hand.length >= count) break;
    if (!hand.includes(id)) hand.push(id);
  }
  return hand;
}

/** Legacy alias — the fixed five before missions became a dealt hand. */
export const MISSION_DEFS = MISSION_POOL;

// ---------------------------------------------------------------------------
// Dealing the daily hand
// ---------------------------------------------------------------------------

/** Deterministic 32-bit hash of a string, so a day's hand is reproducible. */
function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shuffle a copy of `items` with the given seed. */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The order a player's pool is dealt in on a given day. The hand is the first
 * REGULAR_SLOTS of it; a reroll takes the next one along. Deterministic from
 * (playerId, dayKey), so it survives a restart without being stored, and two
 * players get different hands on the same day.
 */
export const dealOrder = (pool: MissionDef[], playerId: string, dayKey: string, salt: string): string[] =>
  seededShuffle(pool, hashString(`${playerId}|${dayKey}|${salt}`)).map((m) => m.id);

export const findMission = (id: string): MissionDef | undefined =>
  ALL_MISSIONS.find((m) => m.id === id);

/**
 * The day a mission set belongs to, in UTC. Deliberately not local time: the
 * server owns mission state, and a local-time key would hand a player a fresh
 * set every time they changed timezone.
 */
export function missionDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Milliseconds until the next UTC midnight, for the countdown in the UI. */
export function msUntilMissionReset(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(0, next - now.getTime());
}

export function formatMissionReset(now: Date = new Date()): string {
  const total = Math.floor(msUntilMissionReset(now) / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * How one recorded match advances a mission. `rally` keeps the best rally of
 * the day; everything else accumulates. Progress is never decremented, and is
 * held at the target so a mission cannot bank surplus toward tomorrow.
 */
export function missionProgressDelta(def: MissionDef, match: MatchEndPayload): number {
  // A mission restricted to a difficulty or a mode only counts matches that
  // actually meet it — an elite "win 3 against Cyber" must not be satisfied by
  // three Rookie wins.
  if (def.difficulty && match.difficulty !== def.difficulty) return 0;
  if (def.mode && match.mode !== def.mode) return 0;
  if (def.difficulty && match.mode !== 'solo') return 0;

  switch (def.type) {
    case 'games_played':
      return 1;
    case 'matches_won':
      return match.isWinner ? 1 : 0;
    case 'multiplayer':
      return match.mode === 'multiplayer' ? 1 : 0;
    case 'points_scored':
      return Math.max(0, Math.round(match.playerScore || 0));
    case 'aces':
      return Math.max(0, Math.round(match.aces || 0));
    case 'shutouts':
      // The shared rule, not a third copy of it — the floor is a match length
      // and matchRules.ts owns those. A task promising "without conceding"
      // while silently demanding five points is a task a player at
      // first-to-3 can never finish and is never told why.
      return isShutout(match) ? 1 : 0;
    case 'close_wins':
      // Won by exactly one point: the match went to the wire and was held.
      return match.isWinner && score(match.playerScore) - score(match.opponentScore) === 1 ? 1 : 0;
    case 'dominant_wins':
      // A near-shutout at shutout LENGTH. The floor is the same match length
      // the clean sheet carries, for the same reason: a 3-1 at first-to-3 is
      // most of a match, not a match dominated.
      return match.isWinner && score(match.playerScore) >= SHUTOUT_MIN_POINTS && score(match.opponentScore) <= 1 ? 1 : 0;
    case 'long_wins':
      // A first-to-10 or longer, read off the winner's own score: the payload
      // carries no winning score, and a winner's score IS the match length.
      return match.isWinner && score(match.playerScore) >= 10 ? 1 : 0;
    case 'rally':
    case 'win_streak':
    case 'practice_returns':
      return 0; // maxima, not sums — see applyMatchToProgress / applyPracticeToProgress
    default:
      return 0;
  }
}

const score = (value: number | undefined): number => Math.max(0, Math.round(value || 0));

/** Next progress value for `def` after `match`, given `current`. */
export function applyMatchToProgress(
  def: MissionDef,
  current: number,
  match: MatchEndPayload,
  ctx: MissionContext = {}
): number {
  if (def.type === 'win_streak') {
    // The POOLED consecutive-wins counter the server has just bumped for this
    // match (players.winStreak), held as a maximum like a rally: a loss puts
    // the run back to zero and the task keeps the best it saw. Read from the
    // profile rather than counted here because a task is dealt mid-day, and
    // "wins in a row" has to mean the run the player is actually on — which is
    // also why this type never carries a difficulty or a mode (see MissionDef).
    return Math.min(def.target, Math.max(current, score(ctx.winStreak)));
  }
  if (def.type === 'practice_returns') return current; // a match is not the wall
  if (def.type === 'rally') {
    if (def.difficulty && (match.difficulty !== def.difficulty || match.mode !== 'solo')) return current;
    if (def.mode && match.mode !== def.mode) return current;
    // The run EARNED here, not the peak it reached. A streak carries between
    // matches, so bestStreak opens on whatever was carried in — and a rally
    // task dealt or rerolled onto a player already on a long run completed
    // itself on the next recorded match without them returning another ball.
    // At its worst that paid an elite task's 600 XP and its permanent theme
    // for nothing. It also broke the rule the deal is built on: a dealt task
    // starts from zero and must never arrive already finished.
    //
    // The honest limit of using this number: a run that spans the deal
    // boundary counts only the part built after it, so a carried 3 plus 5 more
    // is 5 against the target and not 8. That is the safe side of the trade —
    // the alternative pays for work done before the task existed.
    return Math.min(def.target, Math.max(current, Math.max(0, Math.round(match.earnedStreak || 0))));
  }
  return Math.min(def.target, current + missionProgressDelta(def, match));
}

/**
 * The Practice Wall's one contribution to the daily list: a `practice_returns`
 * task counts the DAY's returns — the same `daily_practice.returns` the XP
 * curve is measured over, handed in after the session and held as a maximum,
 * so splitting a session buys nothing here either. Every other task ignores
 * the wall: a session is not a match, and practice pays through its own
 * capped math rather than through anything a match would move.
 */
export function applyPracticeToProgress(def: MissionDef, current: number, dayReturns: number): number {
  if (def.type !== 'practice_returns') return current;
  return Math.min(def.target, Math.max(current, score(dayReturns)));
}

export function getMissionsStatusSummary(missions: DailyMission[]): {
  total: number;
  completed: number;
  unclaimed: number;
  claimed: number;
  hasUnclaimed: boolean;
} {
  let completed = 0;
  let unclaimed = 0;
  let claimed = 0;

  missions.forEach((m) => {
    if (m.claimed) {
      claimed++;
      completed++;
    } else if (m.current >= m.target) {
      completed++;
      unclaimed++;
    }
  });

  return { total: missions.length, completed, unclaimed, claimed, hasUnclaimed: unclaimed > 0 };
}
