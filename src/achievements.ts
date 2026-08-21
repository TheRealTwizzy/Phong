import { Achievement, AchievementBranch, GameUnlock } from './types';

// The achievement tree, shared by client and server like profileRules.ts,
// rating.ts and matchRules.ts. Definitions live here rather than in the
// database layer so the client can draw the tree without asking the server
// what shape it is.
//
// Achievements are laid out as BRANCHES, each a small tree: a root anyone can
// reach, and children that stay locked until their parent is earned. That is
// what makes the catalogue readable — a flat list of thirty is a checklist,
// five short trees are five things you are working toward.

export const BRANCHES: { id: AchievementBranch; titleKey: string; icon: string }[] = [
  { id: 'foundation', titleKey: 'branch_foundation', icon: 'flag' },
  { id: 'rally', titleKey: 'branch_rally', icon: 'activity' },
  { id: 'ladder', titleKey: 'branch_ladder', icon: 'cpu' },
  { id: 'duel', titleKey: 'branch_duel', icon: 'smartphone' },
  { id: 'craft', titleKey: 'branch_craft', icon: 'target' },
];

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
    branch: 'foundation',
    parent: 'level_5',
    category: 'special',
    xpReward: 200,
    icon: 'crown',
  },
  {
    id: 'level_25',
    title: 'Long Game',
    description: 'Reach Player Level 25.',
    branch: 'foundation',
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
    branch: 'foundation',
    parent: 'veteran_10',
    category: 'special',
    xpReward: 200,
    icon: 'flame',
  },

  // ---- Rally: how long you can keep a ball alive ------------------------
  {
    id: 'rally_10',
    title: 'Rally Apprentice',
    description: 'Sustain a rally of 10 or more hits in a single point.',
    branch: 'rally',
    category: 'mastery',
    xpReward: 60,
    icon: 'activity',
  },
  {
    id: 'rally_25',
    title: 'Sonic Speed',
    description: 'Sustain a lightning-fast rally of 25 or more hits.',
    branch: 'rally',
    parent: 'rally_10',
    category: 'mastery',
    xpReward: 200,
    icon: 'flame',
  },
  {
    id: 'rally_50',
    title: 'Quantum Reflexes',
    description: 'Reach a legendary 50-hit rally without missing.',
    branch: 'rally',
    parent: 'rally_25',
    category: 'mastery',
    xpReward: 450,
    icon: 'shield',
  },
  {
    id: 'rally_100',
    title: 'Perpetual Motion',
    description: 'Reach a 100-hit rally without missing.',
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
    id: 'cyber_slayer',
    title: 'Cyber Slayer',
    description: 'Beat the Cyber AI in Solo mode.',
    branch: 'ladder',
    parent: 'ai_pro',
    category: 'mastery',
    xpReward: 260,
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
    branch: 'duel',
    parent: 'multiplayer_champ',
    category: 'special',
    xpReward: 400,
    icon: 'trending-up',
  },
  {
    id: 'legend_tier',
    title: 'Living Legend',
    description: 'Reach the Legend tier in ranked play.',
    branch: 'duel',
    parent: 'master_tier',
    category: 'special',
    xpReward: 650,
    hidden: true,
    icon: 'trending-up',
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
  ai_pro: [{ kind: 'difficulty', value: 'cyber' }],
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
 * Whether `id` may be unlocked given what is already earned. This is the tree
 * rule: a child stays locked until its parent is earned, so the catalogue
 * reads as a path rather than a checklist.
 */
export function isUnlockable(id: string, earned: readonly string[]): boolean {
  const def = BY_ID.get(id);
  if (!def) return false;
  return !def.parent || earned.includes(def.parent);
}

/**
 * Whether an achievement should be shown by name. A hidden one stays a
 * silhouette until its parent is earned — or until it is earned itself, since
 * a player who has it should always be able to read what they did.
 */
export function isRevealed(id: string, earned: readonly string[]): boolean {
  const def = BY_ID.get(id);
  if (!def) return false;
  if (!def.hidden) return true;
  if (earned.includes(id)) return true;
  return !!def.parent && earned.includes(def.parent);
}
