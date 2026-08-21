import { describe, expect, it } from 'vitest';
import {
  XP_FLOOR,
  levelBand,
  levelFromXp,
  matchXp,
  surpriseMultiplier,
  xpForLevel,
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
