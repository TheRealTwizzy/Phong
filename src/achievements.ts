import { Achievement, AchievementBranch, AchievementGate, GameUnlock } from './types';
import { TIER_ORDER, Tier } from './rating';
import { WINNING_SCORES } from './matchRules';

// The achievement tree, shared by client and server like profileRules.ts,
// rating.ts and matchRules.ts. Definitions live here rather than in the
// database layer so the client can draw the tree without asking the server
// what shape it is.
//
// Achievements are laid out as BRANCHES, each a small tree: a root anyone can
// reach, and children that stay locked until their parent is earned. That is
// what makes the catalogue readable — a flat list of thirty is a checklist,
// five short trees are five things you are working toward.

/**
 * A branch may itself be concealed. The first five are open from the first
 * match; the last three are trees you DISCOVER — the tab shows as locked with
 * a one-line hint until the thing that opens it happens. A branch gate is a
 * prerequisite from OUTSIDE the branch, which is why every branch root is
 * parentless: `parent` chains within a tree, `gate` opens the tree.
 */
export interface BranchDef {
  id: AchievementBranch;
  titleKey: string;
  icon: string;
  gate?: { achievement?: string; level?: number };
  /** Shown on the locked tab so the player knows what to go and do. */
  gateHintKey?: string;
}

export const BRANCHES: BranchDef[] = [
  { id: 'foundation', titleKey: 'branch_foundation', icon: 'flag' },
  { id: 'rally', titleKey: 'branch_rally', icon: 'activity' },
  { id: 'ladder', titleKey: 'branch_ladder', icon: 'cpu' },
  { id: 'duel', titleKey: 'branch_duel', icon: 'smartphone' },
  { id: 'craft', titleKey: 'branch_craft', icon: 'target' },
  {
    id: 'ascent',
    titleKey: 'branch_ascent',
    icon: 'trending-up',
    gate: { achievement: 'first_duel' },
    gateHintKey: 'branch_ascent_hint',
  },
  {
    id: 'dominion',
    titleKey: 'branch_dominion',
    icon: 'swords',
    gate: { achievement: 'shutout' },
    gateHintKey: 'branch_dominion_hint',
  },
  {
    id: 'devotion',
    titleKey: 'branch_devotion',
    icon: 'flame',
    gate: { level: 5 },
    gateHintKey: 'branch_devotion_hint',
  },
];

/**
 * What a gate is measured against. The server passes the profile it is about
 * to write; the client passes the profile it is showing.
 */
export interface ProgressContext {
  level: number;
  tier: Tier;
}

const tierRank = (tier: Tier): number => TIER_ORDER.indexOf(tier);

/** Whether a level/tier gate is satisfied. No gate is always satisfied. */
export function gateMet(gate: AchievementGate | undefined, ctx: ProgressContext): boolean {
  if (!gate) return true;
  if (gate.level !== undefined && ctx.level < gate.level) return false;
  if (gate.tier !== undefined && tierRank(ctx.tier) < tierRank(gate.tier)) return false;
  return true;
}

/** Whether a whole branch is visible yet. */
export function isBranchRevealed(
  branch: AchievementBranch,
  earned: readonly string[],
  ctx: ProgressContext
): boolean {
  const def = BRANCHES.find((b) => b.id === branch);
  if (!def?.gate) return true;
  if (def.gate.achievement && !earned.includes(def.gate.achievement)) return false;
  if (def.gate.level !== undefined && ctx.level < def.gate.level) return false;
  return true;
}

export const branchDef = (branch: AchievementBranch): BranchDef | undefined =>
  BRANCHES.find((b) => b.id === branch);

/**
 * Every achievement. `parent` is the one that must be earned first; an entry
 * without a parent is the root of its branch.
 *
 * Rewards are flat constants, held in check by ACHIEVEMENT_BAND_CAP rather
 * than by hand — see the note in rating.ts. `scaled: true` marks the ones that
 * mean "you beat something", which pay by the match's surprise multiplier.
 */
export const ALL_ACHIEVEMENTS: Achievement[] = [
  // ---- Foundation: the shape of a playing career ------------------------
  {
    id: 'first_serve',
    title: 'First Impact',
    description: 'Complete your first cross-net volley.',
    branch: 'foundation',
    category: 'beginner',
    xpReward: 25,
    icon: 'zap',
  },
  {
    id: 'first_win',
    title: 'First Blood',
    description: 'Win your first full match in any mode.',
    branch: 'foundation',
    parent: 'first_serve',
    category: 'beginner',
    xpReward: 60,
    scaled: true,
    icon: 'trophy',
  },
  {
    id: 'shutout',
    title: 'Clean Sheet',
    description: 'Win a match without conceding a single point.',
    branch: 'foundation',
    parent: 'first_win',
    category: 'mastery',
    xpReward: 200,
    scaled: true,
    icon: 'star',
  },
  {
    id: 'veteran_10',
    title: 'Paddle Veteran',
    description: 'Complete 10 total matches.',
    branch: 'foundation',
    parent: 'first_serve',
    category: 'beginner',
    xpReward: 120,
    icon: 'award',
  },
  {
    id: 'veteran_50',
    title: 'Court Regular',
    description: 'Complete 50 total matches.',
    branch: 'foundation',
    parent: 'veteran_10',
    category: 'special',
    xpReward: 220,
    icon: 'award',
  },
  {
    id: 'veteran_200',
    title: 'Permanent Fixture',
    description: 'Complete 200 total matches.',
    branch: 'foundation',
    parent: 'veteran_50',
    category: 'special',
    xpReward: 420,
    hidden: true,
    icon: 'award',
  },
  {
    id: 'level_5',
    title: 'Rising Star',
    description: 'Reach Player Level 5.',
    branch: 'foundation',
    parent: 'first_win',
    category: 'special',
    xpReward: 120,
    icon: 'sparkles',
  },
  {
    id: 'level_10',
    title: 'Seasoned',
    description: 'Reach Player Level 10.',
    branch: 'devotion',
    category: 'special',
    xpReward: 200,
    icon: 'crown',
  },
  {
    id: 'level_25',
    title: 'Long Game',
    description: 'Reach Player Level 25.',
    branch: 'devotion',
    parent: 'level_10',
    category: 'special',
    xpReward: 380,
    hidden: true,
    icon: 'crown',
  },
  {
    id: 'streak_7',
    title: 'Creature of Habit',
    description: 'Play on 7 consecutive days.',
    branch: 'devotion',
    parent: 'daily_3',
    category: 'special',
    xpReward: 200,
    icon: 'flame',
  },

  // ---- Rally: how long you can keep a ball alive ------------------------
  {
    id: 'rally_10',
    title: 'Rally Apprentice',
    description: 'Sustain a streak of 7 returns without missing one.',
    branch: 'rally',
    category: 'mastery',
    xpReward: 60,
    icon: 'activity',
  },
  {
    id: 'rally_25',
    title: 'Sonic Speed',
    description: 'Sustain a streak of 18 returns without missing one.',
    branch: 'rally',
    parent: 'rally_10',
    category: 'mastery',
    xpReward: 200,
    icon: 'flame',
  },
  {
    id: 'rally_50',
    title: 'Quantum Reflexes',
    description: 'Sustain a legendary streak of 36 returns.',
    branch: 'rally',
    parent: 'rally_25',
    category: 'mastery',
    xpReward: 450,
    icon: 'shield',
  },
  {
    id: 'rally_100',
    title: 'Perpetual Motion',
    description: 'Sustain a streak of 72 returns.',
    branch: 'rally',
    parent: 'rally_50',
    category: 'mastery',
    xpReward: 700,
    hidden: true,
    icon: 'shield',
  },
  {
    id: 'wall_30',
    title: 'Wall Drill',
    description: 'Return 30 in a row on the Practice Wall.',
    branch: 'rally',
    parent: 'rally_10',
    category: 'mastery',
    xpReward: 120,
    icon: 'activity',
  },
  {
    id: 'wall_90',
    title: 'Immovable',
    description: 'Return 90 in a row on the Practice Wall.',
    branch: 'rally',
    parent: 'wall_30',
    category: 'mastery',
    xpReward: 300,
    hidden: true,
    icon: 'shield',
  },

  {
    id: 'rally_150',
    title: 'Immovable Object',
    description: 'Sustain a streak of 108 returns.',
    branch: 'rally',
    parent: 'rally_100',
    category: 'mastery',
    xpReward: 900,
    hidden: true,
    gate: { level: 15 },
    icon: 'activity',
  },
  {
    id: 'wall_200',
    title: 'The Wall Blinked First',
    description: 'Return 200 in a row on the Practice Wall.',
    branch: 'rally',
    parent: 'wall_90',
    category: 'mastery',
    xpReward: 520,
    hidden: true,
    icon: 'activity',
  },

  // ---- Ladder: climbing the AI difficulties -----------------------------
  {
    id: 'ai_rookie',
    title: 'Warm-Up Complete',
    description: 'Beat the Rookie AI in Solo mode.',
    branch: 'ladder',
    category: 'beginner',
    xpReward: 60,
    scaled: true,
    icon: 'cpu',
  },
  {
    id: 'ai_pro',
    title: 'Even Contest',
    description: 'Beat the Pro AI in Solo mode.',
    branch: 'ladder',
    parent: 'ai_rookie',
    category: 'mastery',
    xpReward: 160,
    scaled: true,
    icon: 'cpu',
  },
  {
    id: 'ai_rookie_10',
    title: 'Rookie Regular',
    description: 'Beat the Rookie AI 10 times.',
    branch: 'ladder',
    parent: 'ai_rookie',
    category: 'beginner',
    xpReward: 140,
    icon: 'cpu',
  },
  {
    id: 'ai_pro_10',
    title: 'Professional Standard',
    description: 'Beat the Pro AI 10 times, at level 10 or above.',
    branch: 'ladder',
    parent: 'ai_pro',
    category: 'mastery',
    xpReward: 340,
    gate: { level: 10 },
    icon: 'cpu',
  },
  {
    id: 'ai_elite',
    title: 'Upper Bracket',
    description: 'Beat the Elite AI in Solo mode.',
    branch: 'ladder',
    parent: 'ai_pro_10',
    category: 'mastery',
    xpReward: 360,
    scaled: true,
    icon: 'cpu',
  },
  {
    id: 'ai_elite_10',
    title: 'Bracket Fixture',
    description: 'Beat the Elite AI 10 times, at level 15 or above.',
    branch: 'ladder',
    parent: 'ai_elite',
    category: 'mastery',
    xpReward: 390,
    gate: { level: 15 },
    icon: 'cpu',
  },
  {
    id: 'cyber_slayer',
    title: 'Cyber Slayer',
    description: 'Beat the Cyber AI in Solo mode.',
    branch: 'ladder',
    parent: 'ai_elite_10',
    category: 'mastery',
    xpReward: 420,
    scaled: true,
    icon: 'cpu',
  },
  {
    id: 'cyber_shutout',
    title: 'Flawless Circuit',
    description: 'Beat the Cyber AI without conceding a single point.',
    branch: 'ladder',
    parent: 'cyber_slayer',
    category: 'mastery',
    xpReward: 500,
    scaled: true,
    hidden: true,
    icon: 'star',
  },

  {
    id: 'cyber_10',
    title: 'Machine Ender',
    description: 'Beat the Cyber AI 10 times, at Grandmaster tier or above.',
    branch: 'ladder',
    parent: 'cyber_shutout',
    category: 'mastery',
    xpReward: 800,
    hidden: true,
    gate: { tier: 'grandmaster' },
    icon: 'cpu',
  },
  {
    id: 'ai_chaos',
    title: 'Eye of the Storm',
    description: 'Beat the Chaos AI in Solo mode.',
    branch: 'ladder',
    parent: 'cyber_10',
    category: 'mastery',
    xpReward: 900,
    scaled: true,
    hidden: true,
    icon: 'cpu',
  },
  {
    id: 'chaos_10',
    title: 'Stormbreaker',
    description: 'Beat the Chaos AI 10 times, at Legend tier or above.',
    branch: 'ladder',
    parent: 'ai_chaos',
    category: 'mastery',
    xpReward: 1000,
    hidden: true,
    gate: { tier: 'legend' },
    icon: 'cpu',
  },

  // ---- Duel: the two-phone game -----------------------------------------
  {
    id: 'first_duel',
    title: 'Twin Link',
    description: 'Finish a 2-phone duel across the net.',
    branch: 'duel',
    category: 'online',
    xpReward: 60,
    icon: 'smartphone',
  },
  {
    id: 'multiplayer_champ',
    title: 'Twin Link Master',
    description: 'Win a 2-device online multiplayer match across the net.',
    branch: 'duel',
    parent: 'first_duel',
    category: 'online',
    xpReward: 240,
    scaled: true,
    icon: 'smartphone',
  },
  {
    id: 'duel_10',
    title: 'Road Warrior',
    description: 'Win 10 two-phone duels.',
    branch: 'duel',
    parent: 'multiplayer_champ',
    category: 'online',
    xpReward: 380,
    hidden: true,
    icon: 'trophy',
  },
  {
    id: 'master_tier',
    title: 'Elite Contender',
    description: 'Reach the Master tier in ranked play.',
    branch: 'ascent',
    parent: 'tier_ace',
    category: 'special',
    xpReward: 400,
    icon: 'trending-up',
  },
  {
    id: 'legend_tier',
    title: 'Living Legend',
    description: 'Reach the Legend tier in ranked play.',
    branch: 'ascent',
    parent: 'tier_grandmaster',
    category: 'special',
    xpReward: 650,
    hidden: true,
    icon: 'trending-up',
  },

  {
    id: 'duel_shutout',
    title: 'Nothing Given',
    description: 'Win a duel without conceding a point.',
    branch: 'duel',
    parent: 'multiplayer_champ',
    category: 'online',
    xpReward: 320,
    scaled: true,
    icon: 'smartphone',
  },
  {
    id: 'duel_50',
    title: 'Fixture',
    description: 'Win 50 duels.',
    branch: 'duel',
    parent: 'duel_10',
    category: 'online',
    xpReward: 700,
    hidden: true,
    gate: { tier: 'vanguard' },
    icon: 'smartphone',
  },

  // ---- Craft: what you do with the ball ---------------------------------
  {
    id: 'first_ace',
    title: 'Opening Statement',
    description: 'Win a point directly from your serve.',
    branch: 'craft',
    category: 'special',
    xpReward: 60,
    icon: 'target',
  },
  {
    id: 'ace_sniper',
    title: 'Ace Sniper',
    description: 'Score 5 or more career aces directly on serve.',
    branch: 'craft',
    parent: 'first_ace',
    category: 'special',
    xpReward: 150,
    icon: 'target',
  },
  {
    id: 'ace_25',
    title: "Sniper's Nest",
    description: 'Score 25 or more career aces directly on serve.',
    branch: 'craft',
    parent: 'ace_sniper',
    category: 'special',
    xpReward: 320,
    hidden: true,
    icon: 'target',
  },
  {
    id: 'points_100',
    title: 'Century',
    description: 'Score 100 career points.',
    branch: 'craft',
    category: 'special',
    xpReward: 150,
    icon: 'zap',
  },
  {
    id: 'points_500',
    title: 'Five Hundred Club',
    description: 'Score 500 career points.',
    branch: 'craft',
    parent: 'points_100',
    category: 'special',
    xpReward: 380,
    hidden: true,
    icon: 'zap',
  },
  {
    id: 'ace_100',
    title: 'Untouchable Serve',
    description: 'Score 100 career aces.',
    branch: 'craft',
    parent: 'ace_25',
    category: 'mastery',
    xpReward: 600,
    hidden: true,
    gate: { level: 15 },
    icon: 'target',
  },
  {
    id: 'points_2000',
    title: 'Two Thousand',
    description: 'Score 2,000 career points.',
    branch: 'craft',
    parent: 'points_500',
    category: 'special',
    xpReward: 850,
    hidden: true,
    gate: { level: 25 },
    icon: 'zap',
  },

  // ---- Ascent: the ranked ladder ----------------------------------------
  // Concealed until the player has actually played a duel — rank means
  // nothing before then, and a tier ladder read on day one is a wall.
  {
    id: 'placed',
    title: 'On the Board',
    description: 'Finish placement and earn a visible skill tier.',
    branch: 'ascent',
    category: 'online',
    xpReward: 180,
    icon: 'trending-up',
  },
  {
    id: 'tier_vanguard',
    title: 'Vanguard',
    description: 'Reach the Vanguard tier in ranked play.',
    branch: 'ascent',
    parent: 'placed',
    category: 'online',
    xpReward: 260,
    icon: 'trending-up',
  },
  {
    id: 'tier_ace',
    title: 'Ace',
    description: 'Reach the Ace tier in ranked play.',
    branch: 'ascent',
    parent: 'tier_vanguard',
    category: 'online',
    xpReward: 340,
    icon: 'trending-up',
  },
  {
    id: 'tier_grandmaster',
    title: 'Grandmaster',
    description: 'Reach the Grandmaster tier in ranked play.',
    branch: 'ascent',
    parent: 'master_tier',
    category: 'special',
    xpReward: 520,
    hidden: true,
    icon: 'trending-up',
  },
  {
    id: 'tier_overlord',
    title: 'Cyber Overlord',
    description: 'Reach the highest tier there is.',
    branch: 'ascent',
    parent: 'legend_tier',
    category: 'special',
    xpReward: 1000,
    hidden: true,
    icon: 'crown',
  },

  // ---- Dominion: winning, and winning without giving anything back ------
  // Concealed until a first shutout: you find this branch by doing the thing
  // it is about.
  {
    id: 'streak_3',
    title: 'On a Roll',
    description: 'Win 3 matches in a row.',
    branch: 'dominion',
    category: 'mastery',
    xpReward: 140,
    icon: 'flame',
  },
  {
    id: 'streak_5',
    title: 'Hot Hand',
    description: 'Win 5 matches in a row.',
    branch: 'dominion',
    parent: 'streak_3',
    category: 'mastery',
    xpReward: 260,
    icon: 'flame',
  },
  {
    id: 'streak_10',
    title: 'Untouchable',
    description: 'Win 10 matches in a row.',
    branch: 'dominion',
    parent: 'streak_5',
    category: 'special',
    xpReward: 520,
    hidden: true,
    gate: { level: 12 },
    icon: 'flame',
  },
  {
    id: 'shutout_5',
    title: 'Miser',
    description: 'Win 5 matches without conceding a point.',
    branch: 'dominion',
    category: 'mastery',
    xpReward: 300,
    icon: 'shield',
  },
  {
    id: 'shutout_15',
    title: 'Toll Collector',
    description: 'Win 15 matches without conceding a point.',
    branch: 'dominion',
    parent: 'shutout_5',
    category: 'special',
    xpReward: 620,
    hidden: true,
    icon: 'shield',
  },

  // ---- Devotion: the time you have put in --------------------------------
  // Concealed until level 5 — a branch about the long haul should not be
  // visible in the first twenty minutes.
  {
    id: 'daily_3',
    title: 'Back Again',
    description: 'Play on 3 consecutive days.',
    branch: 'devotion',
    category: 'special',
    xpReward: 100,
    icon: 'flame',
  },
  {
    id: 'daily_30',
    title: 'Part of the Furniture',
    description: 'Play on 30 consecutive days.',
    branch: 'devotion',
    parent: 'streak_7',
    category: 'special',
    xpReward: 700,
    hidden: true,
    icon: 'flame',
  },
  {
    id: 'level_50',
    title: 'Half a Century',
    description: 'Reach level 50.',
    branch: 'devotion',
    parent: 'level_25',
    category: 'special',
    xpReward: 800,
    hidden: true,
    icon: 'crown',
  },
];

// ---------------------------------------------------------------------------
// What the tree opens up
// ---------------------------------------------------------------------------
//
// Achievements are not only rewards, they are the gate. A player cannot pick
// Pro until they have actually beaten Rookie, and cannot pick Cyber until they
// have beaten Pro — so the difficulty ladder is walked rather than jumped, and
// the odds shown on the menu are odds the player has some basis to judge.
// Longer matches open the same way: first-to-10 and first-to-15 are things you
// grow into, which is what makes a first-to-3 warm-up feel like a beginning
// rather than a lesser option.

export const UNLOCKS: Record<string, GameUnlock[]> = {
  first_serve: [{ kind: 'mode', value: 'multiplayer' }],
  first_win: [{ kind: 'winningScore', value: 10 }],
  veteran_10: [{ kind: 'winningScore', value: 15 }],
  ai_rookie: [{ kind: 'difficulty', value: 'pro' }],
  // Each higher rung opens on TEN wins at the rung below plus a progression
  // gate on the achievement itself (level or tier), so the ladder is climbed
  // a rung at a time — Cyber once opened on a SINGLE Pro win, which handed a
  // first-session player the then-hardest opponent in the game before they
  // had any feel for the middle rung.
  ai_pro_10: [{ kind: 'difficulty', value: 'elite' }],
  ai_elite_10: [{ kind: 'difficulty', value: 'cyber' }],
  cyber_10: [{ kind: 'difficulty', value: 'chaos' }],
};

/** Everything available from the start, before a single achievement. */
export const BASE_UNLOCKS: GameUnlock[] = [
  { kind: 'difficulty', value: 'rookie' },
  { kind: 'winningScore', value: 3 },
  { kind: 'winningScore', value: 5 },
  { kind: 'mode', value: 'solo' },
  { kind: 'mode', value: 'practice' },
  { kind: 'mode', value: 'split' },
];

const unlockKey = (u: GameUnlock) => `${u.kind}:${u.value}`;

/** The set of unlock keys a player holds, given the achievements they've earned. */
export function unlockedKeys(earned: readonly string[]): Set<string> {
  const keys = new Set(BASE_UNLOCKS.map(unlockKey));
  for (const id of earned) {
    for (const u of UNLOCKS[id] || []) keys.add(unlockKey(u));
  }
  return keys;
}

export const hasUnlock = (earned: readonly string[], kind: GameUnlock['kind'], value: string | number): boolean =>
  unlockedKeys(earned).has(`${kind}:${value}`);

/**
 * Hold a stored match setting to something the player may actually play.
 *
 * A setting outlives the profile that earned it: it is kept in localStorage on
 * the device, while the achievements that open it live on the server and can
 * be reset by a wipe. The pair could therefore drift apart — and did, from the
 * very first launch, because the app shipped with Pro preselected while Pro is
 * locked until Rookie has been beaten. The menu drew Pro as locked and played
 * it anyway, and `/api/match/record` answered every one of those matches with
 * 403 DIFFICULTY_LOCKED, which the client treats as a verdict rather than a
 * hiccup: the match was dropped, not queued. A new player's first solo matches
 * paid nothing at all.
 *
 * `order` must run easiest-first; the fallback is the last unlocked option
 * before the wanted one, and the first entry must always be in BASE_UNLOCKS so
 * there is something to fall back TO.
 */
function clampToUnlocked<T extends string | number>(
  earned: readonly string[],
  kind: GameUnlock['kind'],
  order: readonly T[],
  wanted: T
): T {
  if (hasUnlock(earned, kind, wanted)) return wanted;
  const keys = unlockedKeys(earned);
  let best = order[0];
  for (const option of order) {
    if (option === wanted) break;
    if (keys.has(`${kind}:${option}`)) best = option;
  }
  return best;
}

/** Difficulties easiest-first. Only `rookie` is open from the first match. */
export const DIFFICULTY_ORDER = ['rookie', 'pro', 'elite', 'cyber', 'chaos'] as const;

/** Match lengths shortest-first. 3 and 5 are open from the first match. */
export const WINNING_SCORE_ORDER = WINNING_SCORES;

/** The hardest difficulty this player has earned, at or below `wanted`. */
export const playableDifficulty = (
  earned: readonly string[],
  wanted: string
): (typeof DIFFICULTY_ORDER)[number] =>
  clampToUnlocked(earned, 'difficulty', DIFFICULTY_ORDER, wanted as (typeof DIFFICULTY_ORDER)[number]);

/** The longest match length this player has earned, at or below `wanted`. */
export const playableWinningScore = (earned: readonly string[], wanted: number): number =>
  clampToUnlocked(earned, 'winningScore', WINNING_SCORE_ORDER, wanted as (typeof WINNING_SCORE_ORDER)[number]);

/** Which achievement opens a given thing, for telling the player what to do. */
export function unlockedBy(kind: GameUnlock['kind'], value: string | number): Achievement | undefined {
  for (const [id, list] of Object.entries(UNLOCKS)) {
    if (list.some((u) => u.kind === kind && u.value === value)) return BY_ID.get(id);
  }
  return undefined;
}

const BY_ID = new Map(ALL_ACHIEVEMENTS.map((a) => [a.id, a]));

export const achievementById = (id: string): Achievement | undefined => BY_ID.get(id);

/** Direct children of `id`, in catalogue order. */
export const childrenOf = (id: string | undefined): Achievement[] =>
  ALL_ACHIEVEMENTS.filter((a) => a.parent === id);

/** The roots of a branch — the achievements with no parent. */
export const rootsOfBranch = (branch: AchievementBranch): Achievement[] =>
  ALL_ACHIEVEMENTS.filter((a) => a.branch === branch && !a.parent);

/** Every ancestor of `id`, nearest first. */
export function ancestorsOf(id: string): Achievement[] {
  const chain: Achievement[] = [];
  let current = BY_ID.get(id)?.parent;
  while (current) {
    const node = BY_ID.get(current);
    if (!node || chain.some((a) => a.id === node.id)) break; // cycle guard
    chain.push(node);
    current = node.parent;
  }
  return chain;
}

/** How deep in its branch an achievement sits; a root is 0. */
export const depthOf = (id: string): number => ancestorsOf(id).length;

/**
 * Whether `id` may be unlocked. Three rules, all of which must hold:
 *   - the tree rule: a child stays locked until its parent is earned;
 *   - the branch gate: a concealed branch opens on something outside it;
 *   - the rung's own gate: a minimum level and/or visible tier.
 *
 * The context is REQUIRED rather than optional on purpose. An optional one
 * would let a caller that forgot it silently ungate every rung, which is the
 * same class of bug as auto-granting ancestors: it fails open.
 */
export function isUnlockable(
  id: string,
  earned: readonly string[],
  ctx: ProgressContext
): boolean {
  const def = BY_ID.get(id);
  if (!def) return false;
  if (def.parent && !earned.includes(def.parent)) return false;
  if (!isBranchRevealed(def.branch, earned, ctx)) return false;
  return gateMet(def.gate, ctx);
}

/**
 * Whether an achievement should be shown by name. A hidden one stays a
 * silhouette until its parent is earned — or until it is earned itself, since
 * a player who has it should always be able to read what they did. A rung in a
 * concealed branch is never shown at all: the branch itself is the silhouette.
 */
export function isRevealed(
  id: string,
  earned: readonly string[],
  ctx: ProgressContext
): boolean {
  const def = BY_ID.get(id);
  if (!def) return false;
  if (earned.includes(id)) return true;
  if (!isBranchRevealed(def.branch, earned, ctx)) return false;
  if (!def.hidden) return true;
  return !!def.parent && earned.includes(def.parent);
}

/** Everything a player has NOT yet earned in a branch, for a progress count. */
export const branchProgress = (
  branch: AchievementBranch,
  earned: readonly string[]
): { earned: number; total: number } => {
  const all = ALL_ACHIEVEMENTS.filter((a) => a.branch === branch);
  return { earned: all.filter((a) => earned.includes(a.id)).length, total: all.length };
};
