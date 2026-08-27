import { describe, expect, it } from 'vitest';
import type { CosmeticId, PlayerProfile } from '../src/types';
import { readFileSync } from 'fs';
import {
  COSMETICS,
  DEFAULT_COSMETIC_ID,
  LEGACY_COSMETIC_IDS,
  cosmeticVars,
  isCosmeticUnlocked,
  normalizeCosmeticId,
} from '../src/game/cosmetics';
import { contrastRatio, luminance, paletteDistance } from '../src/game/color';
import { TIER_ORDER, type Tier } from '../src/rating';
import { ALL_ACHIEVEMENTS } from '../src/achievements';
import { ELITE_POOL } from '../src/game/missions';

// isCosmeticUnlocked ORs five independent predicates — an achievement, an elite
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
const CATALOGUE: Record<CosmeticId, Partial<PlayerProfile>[] | 'free'> = {
  neon: 'free',
  'retro-crt': 'free',
  midnight: 'free',
  cyberpunk: 'free',
  'arena-pro': 'free',

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

const themeIds = Object.keys(COSMETICS) as CosmeticId[];

describe('the theme catalogue', () => {
  it('says how every theme in the game is earned', () => {
    const unclassified = themeIds.filter((id) => !(id in CATALOGUE));
    expect(unclassified, `no unlock rule stated for: ${unclassified.join(', ')}`).toEqual([]);

    const ghosts = Object.keys(CATALOGUE).filter((id) => !themeIds.includes(id as CosmeticId));
    expect(ghosts, `catalogue names themes that do not exist: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('ships twenty themes: five open, nine earned, six elite', () => {
    const free = themeIds.filter((id) => !COSMETICS[id].unlockRequirement);
    const elite = themeIds.filter((id) => COSMETICS[id].unlockRequirement?.eliteMissionId);
    expect(themeIds).toHaveLength(20);
    expect(free).toHaveLength(5);
    expect(elite).toHaveLength(6);
  });
});

describe('isCosmeticUnlocked', () => {
  it('opens the starter themes to everyone, profile or not', () => {
    for (const [id, rule] of Object.entries(CATALOGUE)) {
      if (rule !== 'free') continue;
      expect(isCosmeticUnlocked(id as CosmeticId, base()), id).toBe(true);
      // Before onboarding there is no profile at all.
      expect(isCosmeticUnlocked(id as CosmeticId, null), id).toBe(true);
    }
  });

  it('keeps every earned theme shut for a fresh player', () => {
    for (const [id, rule] of Object.entries(CATALOGUE)) {
      if (rule === 'free') continue;
      expect(isCosmeticUnlocked(id as CosmeticId, base()), id).toBe(false);
      expect(isCosmeticUnlocked(id as CosmeticId, null), id).toBe(false);
    }
  });

  it('opens each earned theme by every route that should open it', () => {
    for (const [id, rule] of Object.entries(CATALOGUE)) {
      if (rule === 'free') continue;
      for (const shape of rule) {
        expect(
          isCosmeticUnlocked(id as CosmeticId, base(shape)),
          `${id} should open for ${JSON.stringify(shape)}`
        ).toBe(true);
      }
    }
  });

  it('is not opened by somebody else achievement or elite unlock', () => {
    // Owning one unlock must not spill into another's theme.
    expect(isCosmeticUnlocked('void-runner', base({ eliteUnlocks: ['crimson-tide'] }))).toBe(false);
    expect(isCosmeticUnlocked('perpetual-blue', base({ achievements: ['rally_25'] }))).toBe(false);
    expect(isCosmeticUnlocked('legend-aurora', base({ achievements: ['veteran_200'] }))).toBe(false);
  });

  it('returns false for a theme that does not exist', () => {
    expect(isCosmeticUnlocked('no-such-theme' as CosmeticId, base({ level: 99 }))).toBe(false);
  });
});

describe('the raw-stat fallbacks are thresholds, not approximations', () => {
  it('opens at the stated number and not one short of it', () => {
    // Rescaled with the rally rework: a rally number is one player's own
    // consecutive returns now, which measures ~0.72x the old figure.
    expect(isCosmeticUnlocked('solar-flare', base({ highestRally: 6 }))).toBe(false);
    expect(isCosmeticUnlocked('solar-flare', base({ highestRally: 7 }))).toBe(true);

    expect(isCosmeticUnlocked('monochrome-noir', base({ level: 4 }))).toBe(false);
    expect(isCosmeticUnlocked('monochrome-noir', base({ level: 5 }))).toBe(true);

    expect(isCosmeticUnlocked('hyper-violet', base({ matchesWon: 0 }))).toBe(false);
    expect(isCosmeticUnlocked('hyper-violet', base({ matchesWon: 1 }))).toBe(true);

    expect(isCosmeticUnlocked('quantum-gold', base({ highestRally: 17 }))).toBe(false);
    expect(isCosmeticUnlocked('quantum-gold', base({ highestRally: 18 }))).toBe(true);
  });
});

describe('the tier gate', () => {
  it('opens at Master and above, and stays shut below it', () => {
    const belowMaster: Tier[] = ['rookie', 'contender', 'vanguard', 'ace'];
    const masterUp: Tier[] = ['master', 'grandmaster', 'legend', 'overlord'];

    for (const tier of belowMaster) {
      expect(isCosmeticUnlocked('quantum-gold', base({ tier })), tier).toBe(false);
    }
    for (const tier of masterUp) {
      expect(isCosmeticUnlocked('quantum-gold', base({ tier })), tier).toBe(true);
    }
  });

  it('does NOT open for an unranked player, however strong their stats', () => {
    // The guard this is here for. TIER_ORDER has no 'unranked' entry, so both
    // sides of the comparison index to -1 and it would otherwise pass — and a
    // player who had never placed would be handed a Master-tier reward.
    expect(TIER_ORDER).not.toContain('unranked');
    expect(TIER_ORDER.indexOf('unranked' as Tier)).toBe(-1);

    const unplaced = base({ tier: 'unranked', rankMu: 40, rankedGames: 4, level: 4 });
    expect(isCosmeticUnlocked('quantum-gold', unplaced)).toBe(false);
  });

  it('still opens for an unranked player who earned it another way', () => {
    // The tier arm being shut must not shut the theme: the rules are an OR.
    expect(isCosmeticUnlocked('quantum-gold', base({ tier: 'unranked', highestRally: 30 }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The two floors
//
// A cosmetic used to be seventeen loose colours the canvas painted with. Now it
// paints the entire shell, so two things that were matters of taste became
// matters of correctness, and both are checked here rather than looked at:
//
//   - it has to be READABLE, because a cosmetic now supplies the ink and the
//     surface behind it, and nothing else in the app would notice if a pair of
//     them could not be told apart;
//   - it has to be DISTINCT, because a reward you cannot distinguish from one
//     you already had is not a reward.
//
// Both run over every cosmetic and every pair, so they hold for the twenty-first
// as well — which is the whole reason the shell is derived rather than authored.
// ---------------------------------------------------------------------------

describe('every cosmetic is readable', () => {
  // The ratios src/index.css states as its own contract. `ink` is nowhere near
  // its floor on any shipped cosmetic; the two that bind are ink-muted, which is
  // body text, and ink-dim, which is only ever >=18px or decorative.
  const FLOORS = { ink: 7, inkMuted: 4.5, inkDim: 3 } as const;

  for (const id of themeIds) {
    it(`${id}: ink is legible on its own card`, () => {
      const { shell } = COSMETICS[id];
      for (const [key, floor] of Object.entries(FLOORS)) {
        const ratio = contrastRatio(shell[key as keyof typeof FLOORS], shell.surface2);
        expect(ratio, `${id}.${key} on surface2`).not.toBeNull();
        expect(ratio!, `${id}.${key} on surface2 is ${ratio!.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          floor
        );
      }
    });
  }

  // The accent is the one surface a cosmetic does not choose the ink for —
  // shellFrom picks whichever of near-black or near-white can be read on it.
  // A yellow accent and a navy one need opposite answers, so assuming either is
  // how a primary button ships with invisible text.
  it('picks ink for the accent that can actually be read on it', () => {
    for (const id of themeIds) {
      const { shell } = COSMETICS[id];
      const ratio = contrastRatio(shell.inkOnAccent, shell.accent)!;
      expect(ratio, `${id}: ink-on-accent is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('holds the floor for a light cosmetic too, not just the dark ones', () => {
    // Guards a specific mistake rather than restating the loop above. The first
    // shellFrom expressed both modes as one expression with the direction
    // flipped, which lightens a dark card off a dark page and DARKENS a light
    // card off a light one — landing dark ink on a darkened card. Every light
    // cosmetic failed, and there was one, so it was noticed; with none in the
    // catalogue the derivation would have been broken and silent.
    const light = themeIds.filter((id) => COSMETICS[id].mode === 'light');
    expect(light.length, 'no light cosmetic ships, so nothing exercises that branch').toBeGreaterThan(0);
    for (const id of light) {
      const { shell } = COSMETICS[id];
      expect(luminance(shell.surface2)!).toBeGreaterThan(luminance(shell.surface1)!);
      expect(luminance(shell.ink)!).toBeLessThan(luminance(shell.surface2)!);
    }
  });
});

describe('no two cosmetics look alike', () => {
  // Mean perceptual distance across the colours a player actually reads a
  // cosmetic by. 0.08 is calibrated, not picked: at the time it was set the
  // catalogue's closest pair sat at 0.034 and its median at 0.17, seven pairs
  // failed, and the next step up (0.10) failed eighteen — a redesign of the
  // whole catalogue rather than a fix.
  const FLOOR = 0.08;
  const KEYS = [
    'background',
    'courtColor',
    'playerPaddleColor',
    'opponentPaddleColor',
    'ballColor',
    'accentColor',
    'netGlowColor',
  ] as const;

  it('keeps every pair above the distinctness floor', () => {
    const tooClose: string[] = [];
    for (let i = 0; i < themeIds.length; i++) {
      for (let j = i + 1; j < themeIds.length; j++) {
        const a = themeIds[i];
        const b = themeIds[j];
        const d = paletteDistance(COSMETICS[a], COSMETICS[b], KEYS);
        if (d < FLOOR) tooClose.push(`${a} vs ${b} (${d.toFixed(4)})`);
      }
    }
    expect(
      tooClose,
      `these cosmetics are too close to tell apart:\n  ${tooClose.join('\n  ')}`
    ).toEqual([]);
  });

  it('measures the whole palette, not its most different swatch', () => {
    // The metric is a MEAN for a reason. A minimum calls two cosmetics distinct
    // the moment any single swatch differs, which is exactly what shipped:
    // retro-crt and monochrome-noir agreed on white-on-black everywhere and
    // differed in one glow, and a player read them as the same cosmetic.
    const identicalButOne = {
      ...COSMETICS.neon,
      accentColor: '#ff0000',
    };
    expect(paletteDistance(COSMETICS.neon, identicalButOne, KEYS)).toBeLessThan(FLOOR);
  });
});

describe('the equipped cosmetic survives being stored', () => {
  it('publishes a value for every token index.css expects', () => {
    // A token declared in index.css but missing here inherits whatever the
    // enclosing subtree had — which, on the public-profile card, is the
    // OBSERVER's colour. That is the exact bug the feature exists to prevent,
    // and it is invisible against a viewer whose own cosmetic is the default.
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    const declared = [...css.matchAll(/^\s*(--color-[a-z0-9-]+):/gm)].map((m) => m[1]);
    const published = Object.keys(cosmeticVars(COSMETICS.neon));
    const missing = declared.filter((name) => !published.includes(name));
    expect(missing, `declared in index.css but never published: ${missing.join(', ')}`).toEqual([]);
  });

  it('resolves a renamed id forward instead of silently defaulting', () => {
    // The equipped id lives in localStorage and in a players column, so a rename
    // is not a compile error — it is a player quietly losing a cosmetic they own.
    for (const [legacy, current] of Object.entries(LEGACY_COSMETIC_IDS)) {
      expect(normalizeCosmeticId(legacy), `${legacy} should resolve to ${current}`).toBe(current);
      expect(COSMETICS[current], `${legacy} maps to an id that does not exist`).toBeDefined();
    }
  });

  it('falls back to the default for anything it does not recognise', () => {
    for (const junk of [undefined, null, 42, {}, '', 'not-a-cosmetic']) {
      expect(normalizeCosmeticId(junk)).toBe(DEFAULT_COSMETIC_ID);
    }
    expect(COSMETICS[DEFAULT_COSMETIC_ID].unlockRequirement).toBeUndefined();
  });

  it('keeps every id it currently ships', () => {
    for (const id of themeIds) expect(normalizeCosmeticId(id)).toBe(id);
  });
});
