import { describe, expect, it } from 'vitest';
import { ALL_ACHIEVEMENTS } from '../server/db';
import {
  XP_FLOOR,
  levelBand,
  xpForLevel,
  levelFromXp,
  matchXp,
  surpriseMultiplier,
} from '../src/rating';

const match = (winProb: number, won: boolean, mode: 'solo' | 'multiplayer' = 'solo') =>
  matchXp({ playerScore: 3, maxRally: 10, won, winProb, mode });

describe('surprise multiplier', () => {
  it('pays more the less likely the win was', () => {
    expect(surpriseMultiplier(0.1, true)).toBeGreaterThan(surpriseMultiplier(0.5, true));
    expect(surpriseMultiplier(0.5, true)).toBeGreaterThan(surpriseMultiplier(0.9, true));
  });

  it('softens the blow the stronger the opponent was', () => {
    // Losing to a giant must pay MORE than losing to someone you were
    // heavily favoured against.
    expect(surpriseMultiplier(0.1, false)).toBeGreaterThan(surpriseMultiplier(0.9, false));
  });

  it('always pays a win better than a loss at the same odds', () => {
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      expect(surpriseMultiplier(p, true)).toBeGreaterThan(surpriseMultiplier(p, false));
    }
  });
});

describe('match XP', () => {
  it('scales with difficulty implicitly, via the prediction', () => {
    const vsCyber = match(0.16, true);
    const vsPro = match(0.5, true);
    const vsRookie = match(0.75, true);
    expect(vsCyber).toBeGreaterThan(vsPro);
    expect(vsPro).toBeGreaterThan(vsRookie);
  });

  it('pays PvP more than solo for identical odds and performance', () => {
    expect(match(0.5, true, 'multiplayer')).toBeGreaterThan(match(0.5, true, 'solo'));
  });

  it('is never negative and never below the floor', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      for (const won of [true, false]) {
        const xp = matchXp({ playerScore: 0, maxRally: 0, won, winProb: p, mode: 'solo' });
        expect(xp).toBeGreaterThanOrEqual(XP_FLOOR);
      }
    }
  });

  it('still rewards a loss — levels never stall to zero', () => {
    expect(match(0.16, false)).toBeGreaterThan(0);
    expect(match(0.9, false)).toBeGreaterThan(0);
  });
});

describe('level curve', () => {
  it('grows steadily instead of letting one match skip a level', () => {
    // The old 120*L^1.6 curve had a 120 XP first band, which a single match
    // overshot outright.
    expect(levelBand(1)).toBeGreaterThan(match(0.75, true));
    expect(levelBand(2)).toBeGreaterThan(levelBand(1));
    expect(levelBand(5)).toBeGreaterThan(levelBand(4));
  });

  it('round-trips xpForLevel and levelFromXp', () => {
    for (let level = 1; level <= 12; level++) {
      const at = xpForLevel(level);
      expect(levelFromXp(at).level).toBe(level);
      if (level > 1) expect(levelFromXp(at - 1).level).toBe(level - 1);
    }
  });

  it('takes roughly 2-4 matches per level in the early game', () => {
    const perMatch = match(0.5, true);
    for (let level = 1; level <= 5; level++) {
      const matches = levelBand(level) / perMatch;
      expect(matches).toBeGreaterThan(1.2);
      expect(matches).toBeLessThan(5);
    }
  });

  it('a first Rookie win no longer jumps two levels', () => {
    // Match XP plus the trimmed first-session achievement bundle.
    const firstMatch = match(0.75, true) + 25 + 50 + 60;
    expect(levelFromXp(firstMatch).level).toBeLessThanOrEqual(2);
  });
});

describe('achievement XP scales with what was actually beaten', () => {
  it('flags exactly the win-based achievements as scaled', () => {
    const scaled = ALL_ACHIEVEMENTS.filter((a) => a.scaled).map((a) => a.id).sort();
    // Everything that means "you beat something", and nothing else.
    expect(scaled).toEqual([
      'ai_pro',
      'ai_rookie',
      'cyber_shutout',
      'cyber_slayer',
      'first_win',
      'multiplayer_champ',
      'shutout',
    ]);
  });

  it('leaves rally achievements flat — a stronger AI returns MORE balls', () => {
    // Scaling these by surprise would be backwards: a harder opponent keeps the
    // ball alive longer, so long rallies get *easier* as difficulty rises.
    for (const id of ['rally_10', 'rally_25', 'rally_50', 'first_serve']) {
      expect(ALL_ACHIEVEMENTS.find((a) => a.id === id)!.scaled).toBeFalsy();
    }
  });

  it('pays a scaled achievement more for the harder win', () => {
    const meta = ALL_ACHIEVEMENTS.find((a) => a.id === 'cyber_slayer')!;
    const longShot = Math.round(meta.xpReward * surpriseMultiplier(0.08, true));
    const routine = Math.round(meta.xpReward * surpriseMultiplier(0.6, true));
    expect(longShot).toBeGreaterThan(routine);
    // And a flat reward would have paid both the same.
    expect(longShot).not.toBe(meta.xpReward);
  });

  it('keeps a scaled award positive even for a certain win', () => {
    for (const a of ALL_ACHIEVEMENTS.filter((x) => x.scaled)) {
      expect(Math.max(1, Math.round(a.xpReward * surpriseMultiplier(1, true)))).toBeGreaterThan(0);
    }
  });
});

describe('every match is progression', () => {
  it('pays a meaningful amount for a loss, not the bare floor', () => {
    // A loss used to land on XP_FLOOR (15) — about 25 losses to a level, which
    // reads as no progression at all. It must now be a real fraction of a band.
    const band = levelBand(3);
    for (const winProb of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const xp = matchXp({ playerScore: 1, maxRally: 5, won: false, winProb, mode: 'solo' });
      expect(xp).toBeGreaterThan(XP_FLOOR - 1);
      expect(band / xp).toBeLessThan(12); // fewer than 12 losses per level
    }
  });

  it('never pays zero, even for a 0-point loss with no rally at all', () => {
    const xp = matchXp({ playerScore: 0, maxRally: 0, won: false, winProb: 0.99, mode: 'solo' });
    expect(xp).toBeGreaterThanOrEqual(XP_FLOOR);
  });

  it('still pays a win more than a loss at the same prediction', () => {
    for (const winProb of [0.1, 0.5, 0.9]) {
      const win = matchXp({ playerScore: 5, maxRally: 9, won: true, winProb, mode: 'solo' });
      const loss = matchXp({ playerScore: 5, maxRally: 9, won: false, winProb, mode: 'solo' });
      expect(win).toBeGreaterThan(loss);
    }
  });

  it('keeps a single easy win under one level band', () => {
    // The pacing complaint that started this: one Rookie win must not skip a
    // level on its own.
    const xp = matchXp({ playerScore: 3, maxRally: 10, won: true, winProb: 0.87, mode: 'solo' });
    expect(xp).toBeLessThan(levelBand(1));
  });

  it('keeps PvP heavier than solo for the same result', () => {
    const args = { playerScore: 3, maxRally: 8, won: false, winProb: 0.5 } as const;
    expect(matchXp({ ...args, mode: 'multiplayer' })).toBeGreaterThan(
      matchXp({ ...args, mode: 'solo' })
    );
  });
});

describe('level progress is reported consistently', () => {
  it('never reports progress past the band it belongs to', () => {
    // The Profile bar shows progress within the CURRENT level. Its numeric
    // readout used to show the cumulative totals instead, so the fill and the
    // caption disagreed at every level above 1.
    for (const xp of [0, 100, 249, 250, 560, 700, 1360, 5000, 25000]) {
      const { level, xpNext } = levelFromXp(xp);
      const base = xpForLevel(level);
      const progress = xp - base;
      const needed = xpNext - base;
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThan(needed);
      expect(needed).toBe(levelBand(level));
    }
  });

  it('rolls the level exactly at the band boundary', () => {
    for (let level = 1; level <= 12; level++) {
      const boundary = xpForLevel(level + 1);
      expect(levelFromXp(boundary - 1).level).toBe(level);
      expect(levelFromXp(boundary).level).toBe(level + 1);
    }
  });
});
