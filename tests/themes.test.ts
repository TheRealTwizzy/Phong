import { describe, expect, it } from 'vitest';
import type { CourtTheme, PlayerProfile } from '../src/types';
import { THEMES, isThemeUnlocked } from '../src/game/themes';
import { TIER_ORDER, type Tier } from '../src/rating';

// isThemeUnlocked ORs five independent predicates — an achievement, an elite
// mission's permanent unlock, a level, a rally, a win count and a tier — and
// only the first two had ever been exercised. That was the whole of the
// module's branch gap: 98% of its statements ran, 56% of its branches.
//
// The tier arm is the one worth the trouble. TIER_ORDER does not contain
// 'unranked', so indexOf returns -1 on BOTH sides of the comparison and
// `-1 >= -1` passes; the only thing stopping an unranked player unlocking a
// Master-tier theme is the trailing `profile.tier !== 'unranked'` check on the
// same line. Nothing tested it.

const base = (over: Partial<PlayerProfile> = {}): PlayerProfile =>
  ({
    id: 'x', username: 'x', level: 1, xp: 0, xpNext: 250,
    mmrMu: 25, mmrSigma: 8.33, rankMu: 25, rankSigma: 8.33, rankedGames: 0,
    matchesPlayed: 0, matchesWon: 0, matchesLost: 0, highestRally: 0,
    totalPointsScored: 0, totalAces: 0, multiplayerWins: 0, dailyStreak: 0,
    tier: 'unranked', achievements: [], eliteUnlocks: [],
    createdAt: '', lastActive: '', initialized: true,
    hasAvatar: false, avatarVersion: 0,
    ...over,
  }) as PlayerProfile;

/**
 * Every theme, and how it can be earned. `free` themes need nothing; the rest
 * list each profile shape that should ON ITS OWN open them.
 *
 * The suite asserts this table names every theme that exists, so adding one
 * fails here until somebody says how it is earned — the same rule
 * tests/i18n.test.ts applies to the dictionary, for the same reason: a theme
 * nobody classified is a theme nobody can be sure is reachable.
 */
const CATALOGUE: Record<CourtTheme, Partial<PlayerProfile>[] | 'free'> = {
  neon: 'free',
  'retro-crt': 'free',
  midnight: 'free',
  cyberpunk: 'free',
  tennis: 'free',

  'emerald-matrix': [{ achievements: ['first_serve'] }],
  // These four carry a raw-stat fallback beside the achievement, and the
  // fallback arm is what had never run.
  'solar-flare': [{ achievements: ['rally_10'] }, { highestRally: 10 }],
  'hyper-violet': [{ achievements: ['first_win'] }, { matchesWon: 1 }],
  'monochrome-noir': [{ achievements: ['level_5'] }, { level: 5 }],
  'quantum-gold': [{ achievements: ['rally_25'] }, { highestRally: 25 }, { tier: 'master' }],

  'perpetual-blue': [{ achievements: ['rally_100'] }],
  'flawless-white': [{ achievements: ['cyber_shutout'] }],
  'legend-aurora': [{ achievements: ['legend_tier'] }],
  'fixture-bronze': [{ achievements: ['veteran_200'] }],

  'void-runner': [{ eliteUnlocks: ['void-runner'] }],
  'crimson-tide': [{ eliteUnlocks: ['crimson-tide'] }],
  'arctic-glass': [{ eliteUnlocks: ['arctic-glass'] }],
  'molten-core': [{ eliteUnlocks: ['molten-core'] }],
  'signal-lost': [{ eliteUnlocks: ['signal-lost'] }],
  'gilded-age': [{ eliteUnlocks: ['gilded-age'] }],
};

const themeIds = Object.keys(THEMES) as CourtTheme[];

describe('the theme catalogue', () => {
  it('says how every theme in the game is earned', () => {
    const unclassified = themeIds.filter((id) => !(id in CATALOGUE));
    expect(unclassified, `no unlock rule stated for: ${unclassified.join(', ')}`).toEqual([]);

    const ghosts = Object.keys(CATALOGUE).filter((id) => !themeIds.includes(id as CourtTheme));
    expect(ghosts, `catalogue names themes that do not exist: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('ships twenty themes: five open, nine earned, six elite', () => {
    const free = themeIds.filter((id) => !THEMES[id].unlockRequirement);
    const elite = themeIds.filter((id) => THEMES[id].unlockRequirement?.eliteMissionId);
    expect(themeIds).toHaveLength(20);
    expect(free).toHaveLength(5);
    expect(elite).toHaveLength(6);
  });
});

describe('isThemeUnlocked', () => {
  it('opens the starter themes to everyone, profile or not', () => {
    for (const [id, rule] of Object.entries(CATALOGUE)) {
      if (rule !== 'free') continue;
      expect(isThemeUnlocked(id as CourtTheme, base()), id).toBe(true);
      // Before onboarding there is no profile at all.
      expect(isThemeUnlocked(id as CourtTheme, null), id).toBe(true);
    }
  });

  it('keeps every earned theme shut for a fresh player', () => {
    for (const [id, rule] of Object.entries(CATALOGUE)) {
      if (rule === 'free') continue;
      expect(isThemeUnlocked(id as CourtTheme, base()), id).toBe(false);
      expect(isThemeUnlocked(id as CourtTheme, null), id).toBe(false);
    }
  });

  it('opens each earned theme by every route that should open it', () => {
    for (const [id, rule] of Object.entries(CATALOGUE)) {
      if (rule === 'free') continue;
      for (const shape of rule) {
        expect(
          isThemeUnlocked(id as CourtTheme, base(shape)),
          `${id} should open for ${JSON.stringify(shape)}`
        ).toBe(true);
      }
    }
  });

  it('is not opened by somebody else achievement or elite unlock', () => {
    // Owning one unlock must not spill into another's theme.
    expect(isThemeUnlocked('void-runner', base({ eliteUnlocks: ['crimson-tide'] }))).toBe(false);
    expect(isThemeUnlocked('perpetual-blue', base({ achievements: ['rally_25'] }))).toBe(false);
    expect(isThemeUnlocked('legend-aurora', base({ achievements: ['veteran_200'] }))).toBe(false);
  });

  it('returns false for a theme that does not exist', () => {
    expect(isThemeUnlocked('no-such-theme' as CourtTheme, base({ level: 99 }))).toBe(false);
  });
});

describe('the raw-stat fallbacks are thresholds, not approximations', () => {
  it('opens at the stated number and not one short of it', () => {
    // Rescaled with the rally rework: a rally number is one player's own
    // consecutive returns now, which measures ~0.72x the old figure.
    expect(isThemeUnlocked('solar-flare', base({ highestRally: 6 }))).toBe(false);
    expect(isThemeUnlocked('solar-flare', base({ highestRally: 7 }))).toBe(true);

    expect(isThemeUnlocked('monochrome-noir', base({ level: 4 }))).toBe(false);
    expect(isThemeUnlocked('monochrome-noir', base({ level: 5 }))).toBe(true);

    expect(isThemeUnlocked('hyper-violet', base({ matchesWon: 0 }))).toBe(false);
    expect(isThemeUnlocked('hyper-violet', base({ matchesWon: 1 }))).toBe(true);

    expect(isThemeUnlocked('quantum-gold', base({ highestRally: 17 }))).toBe(false);
    expect(isThemeUnlocked('quantum-gold', base({ highestRally: 18 }))).toBe(true);
  });
});

describe('the tier gate', () => {
  it('opens at Master and above, and stays shut below it', () => {
    const belowMaster: Tier[] = ['rookie', 'contender', 'vanguard', 'ace'];
    const masterUp: Tier[] = ['master', 'grandmaster', 'legend', 'overlord'];

    for (const tier of belowMaster) {
      expect(isThemeUnlocked('quantum-gold', base({ tier })), tier).toBe(false);
    }
    for (const tier of masterUp) {
      expect(isThemeUnlocked('quantum-gold', base({ tier })), tier).toBe(true);
    }
  });

  it('does NOT open for an unranked player, however strong their stats', () => {
    // The guard this is here for. TIER_ORDER has no 'unranked' entry, so both
    // sides of the comparison index to -1 and it would otherwise pass — and a
    // player who had never placed would be handed a Master-tier reward.
    expect(TIER_ORDER).not.toContain('unranked');
    expect(TIER_ORDER.indexOf('unranked' as Tier)).toBe(-1);

    const unplaced = base({ tier: 'unranked', rankMu: 40, rankedGames: 4, level: 4 });
    expect(isThemeUnlocked('quantum-gold', unplaced)).toBe(false);
  });

  it('still opens for an unranked player who earned it another way', () => {
    // The tier arm being shut must not shut the theme: the rules are an OR.
    expect(isThemeUnlocked('quantum-gold', base({ tier: 'unranked', highestRally: 30 }))).toBe(true);
  });
});
