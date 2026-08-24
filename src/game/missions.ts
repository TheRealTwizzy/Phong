import { DailyMission, MatchEndPayload, MissionType } from '../types';

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
   * what makes a single brutal day's work worth doing.
   */
  unlocks?: string;
  /** Solo difficulty the match must have been played at, if any. */
  difficulty?: 'rookie' | 'pro' | 'cyber';
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
];

export const ALL_MISSIONS: MissionDef[] = [...MISSION_POOL, ...ELITE_POOL];

/**
 * How many of each tier a player holds on any given day.
 *
 * Three regular, not five: a shorter list is one a player actually reads, and
 * it leaves more of the twelve-strong pool spare — which is what a claim needs
 * to deal a fresh task into the slot it empties. At five slots a productive
 * day exhausted the pool after about seven claims and the claimed task then
 * had nowhere to go; at three there is room for nine.
 */
export const REGULAR_SLOTS = 3;
export const ELITE_SLOTS = 1;

/** Rerolls granted per UTC day, per tier. Both reset with the day. */
export const REROLLS_REGULAR = 5;
export const REROLLS_ELITE = 1;

/**
 * How many recent deals block a task from being dealt again.
 *
 * Tasks are NOT one-and-done: finishing one puts it back in the pool, so the
 * twelve regular tasks can never be used up and a claim always has something
 * to deal. What stops the same task returning immediately is this window —
 * anything among the last few dealt is skipped, along with anything currently
 * held. Kept small deliberately: too large and it becomes the old exhaustion
 * problem wearing a different hat.
 */
export const RECENT_DEAL_MEMORY = 3;

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
      return match.isWinner && match.opponentScore === 0 && match.playerScore >= 5 ? 1 : 0;
    case 'rally':
      return 0; // handled as a maximum, not a sum — see applyMatchToProgress
    default:
      return 0;
  }
}

/** Next progress value for `def` after `match`, given `current`. */
export function applyMatchToProgress(
  def: MissionDef,
  current: number,
  match: MatchEndPayload
): number {
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
