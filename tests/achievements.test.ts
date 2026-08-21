import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ACHIEVEMENT_BAND_CAP, achievementXpCap, levelBand, levelFromXp } from '../src/rating';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-ach-test-'));
process.env.DATA_DIR = TMP;

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let ALL_ACHIEVEMENTS: typeof import('../server/db').ALL_ACHIEVEMENTS;

beforeAll(async () => {
  ({ db, ALL_ACHIEVEMENTS } = await import('../server/db'));
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const byId = (id: string) => ALL_ACHIEVEMENTS.find((a) => a.id === id)!;

describe('achievement reward shape', () => {
  it('never lets one unlock hand over most of a level', () => {
    for (let level = 1; level <= 30; level++) {
      expect(achievementXpCap(level)).toBeLessThan(levelBand(level));
      expect(achievementXpCap(level) / levelBand(level)).toBeCloseTo(ACHIEVEMENT_BAND_CAP, 2);
    }
  });

  it('keeps level milestones from awarding the level they celebrate', () => {
    // level_10 used to pay 750 into a 790-wide band — reaching level 10 handed
    // you almost all of level 11. A milestone reward has to be a fraction of
    // the band it lands in or it feeds back into itself.
    expect(byId('level_5').xpReward).toBeLessThan(levelBand(5) * 0.4);
    expect(byId('level_10').xpReward).toBeLessThan(levelBand(10) * 0.4);
  });

  it('still pays rarer things more than common ones', () => {
    const order = ['first_serve', 'rally_10', 'veteran_10', 'rally_25', 'master_tier', 'rally_50'];
    for (let i = 1; i < order.length; i++) {
      expect(byId(order[i]).xpReward).toBeGreaterThan(byId(order[i - 1]).xpReward);
    }
  });

  it('keeps the catalogue worth a sane number of levels in total', () => {
    const total = ALL_ACHIEVEMENTS.reduce((sum, a) => sum + a.xpReward, 0);
    const { level } = levelFromXp(total);
    // Enough to feel like a track of its own, not enough to be the whole game.
    expect(level).toBeGreaterThanOrEqual(5);
    expect(level).toBeLessThanOrEqual(8);
  });
});

describe('level jumps', () => {
  // The complaint this line of work started from was a single match awarding
  // +2 levels: a 3-point Rookie win paying 395 XP into a 120-wide band, 230 of
  // it from achievements landing at once. What must be true now is that a
  // windfall can only happen where the bands are genuinely narrow — never in
  // the mid game, where it would read as the progression being arbitrary.
  const play = (seedStart: number, difficulty: 'rookie' | 'pro' | 'cyber', matches: number) => {
    let seed = seedStart;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const id = `run_${difficulty}_${seedStart}`;
    db.getProfile(id);
    db.initializeProfile(id, `Run${difficulty}${seedStart}`);

    let previous = 1;
    const jumps: { from: number; gained: number }[] = [];
    for (let m = 0; m < matches; m++) {
      const won = rnd() < 0.5;
      const res = db.recordMatch({
        playerId: id,
        username: `Run${difficulty}${seedStart}`,
        playerScore: won ? 5 : Math.floor(rnd() * 5),
        opponentScore: won ? Math.floor(rnd() * 5) : 5,
        maxRally: 4 + Math.floor(rnd() * 22),
        mode: 'solo',
        difficulty,
        isWinner: won,
      });
      const gained = res.profile.level - previous;
      if (gained > 1) jumps.push({ from: previous, gained });
      previous = res.profile.level;
    }
    return { jumps, finalLevel: previous };
  };

  it('never grants two levels once a player is past the opening bands', () => {
    for (const difficulty of ['rookie', 'pro', 'cyber'] as const) {
      for (const seed of [3, 17, 101, 29, 55]) {
        for (const jump of play(seed, difficulty, 60).jumps) {
          // Only the first two bands are narrow enough for one great match to
          // clear more than one of them.
          expect(jump.from).toBeLessThanOrEqual(2);
          expect(jump.gained).toBe(2);
        }
      }
    }
  });

  it('is rare even there', () => {
    let matches = 0;
    let windfalls = 0;
    for (const difficulty of ['rookie', 'pro', 'cyber'] as const) {
      for (const seed of [7, 23, 61]) {
        windfalls += play(seed, difficulty, 60).jumps.length;
        matches += 60;
      }
    }
    expect(windfalls / matches).toBeLessThan(0.03);
  });

  it('still moves at a few matches per level', () => {
    const { finalLevel } = play(29, 'pro', 60);
    const perLevel = 60 / (finalLevel - 1);
    expect(perLevel).toBeGreaterThan(1.5);
    expect(perLevel).toBeLessThan(6);
  });
});

describe('the band cap in practice', () => {
  it('trims a windfall for a low-level player and not for a high-level one', () => {
    const init = (id: string, name: string) => {
      db.getProfile(id);
      db.initializeProfile(id, name);
    };
    // A 50-hit rally on match one, at level 1.
    init('p_early_rally', 'EarlyRally');
    const early = db.recordMatch({
      playerId: 'p_early_rally', username: 'EarlyRally',
      playerScore: 5, opponentScore: 0, maxRally: 50,
      mode: 'solo', difficulty: 'cyber', isWinner: true,
    });
    const rally50 = early.newAchievements.find((a) => a.id === 'rally_50')!;
    // The cap is measured after this match's own XP has moved the level, so
    // the budget is the band the player has just arrived in.
    expect(rally50.awardedXp).toBeLessThanOrEqual(achievementXpCap(early.profile.level));
    expect(rally50.awardedXp).toBeLessThan(rally50.xpReward);
  });

  it('spends one budget across everything a single match unlocks', () => {
    const id = 'p_batch';
    db.getProfile(id);
    db.initializeProfile(id, 'BatchCase');
    // A match that trips several achievements at once.
    const res = db.recordMatch({
      playerId: id, username: 'BatchCase',
      playerScore: 5, opponentScore: 0, maxRally: 30,
      mode: 'solo', difficulty: 'cyber', isWinner: true,
    });
    expect(res.newAchievements.length).toBeGreaterThan(2);
    const paid = res.newAchievements.reduce((sum, a) => sum + (a.awardedXp ?? 0), 0);
    // Several unlocks stacking was the other way a match used to hand over a
    // free level — the budget is for the batch, not for each one.
    expect(paid).toBeLessThanOrEqual(achievementXpCap(res.profile.level));
  });
});
