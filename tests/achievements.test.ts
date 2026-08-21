import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ACHIEVEMENT_BAND_CAP, achievementXpCap, levelBand, levelFromXp } from '../src/rating';
import {
  ALL_ACHIEVEMENTS,
  BRANCHES,
  achievementById,
  ancestorsOf,
  isRevealed,
  isUnlockable,
  rootsOfBranch,
  hasUnlock,
  unlockedBy,
  unlockedKeys,
  UNLOCKS,
} from '../src/achievements';
import { AI_DIFFICULTIES } from '../src/rating';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-ach-test-'));
process.env.DATA_DIR = TMP;

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
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
    // The tree spans a whole playing career — 200 matches, Legend tier, a
    // 100-hit rally — so it is worth more in total than the old flat list,
    // spread far thinner per match by the band cap.
    expect(level).toBeGreaterThanOrEqual(8);
    expect(level).toBeLessThanOrEqual(16);
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
          // Only the opening bands are narrow enough for one great match to
          // clear more than one of them: at level 4 the band is 430 against a
          // best-case match of about 355 plus a capped achievement batch.
          expect(jump.from).toBeLessThanOrEqual(4);
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

describe('the tree itself', () => {
  it('gives every achievement a branch and a real parent', () => {
    const ids = new Set(ALL_ACHIEVEMENTS.map((a) => a.id));
    for (const a of ALL_ACHIEVEMENTS) {
      expect(BRANCHES.some((b) => b.id === a.branch)).toBe(true);
      if (a.parent) {
        expect(ids.has(a.parent)).toBe(true);
        // A child always sits in the same branch as its parent, or the tabs
        // would draw edges that leave the tree they belong to.
        expect(achievementById(a.parent)!.branch).toBe(a.branch);
      }
    }
  });

  it('has no cycles and no orphan branches', () => {
    for (const a of ALL_ACHIEVEMENTS) {
      // ancestorsOf walks up; a cycle would either loop forever or repeat.
      const chain = ancestorsOf(a.id).map((x) => x.id);
      expect(new Set(chain).size).toBe(chain.length);
      expect(chain).not.toContain(a.id);
    }
    for (const branch of BRANCHES) {
      expect(rootsOfBranch(branch.id).length).toBeGreaterThan(0);
    }
  });

  it('has unique ids', () => {
    const ids = ALL_ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('pays deeper rungs more than the roots above them', () => {
    for (const a of ALL_ACHIEVEMENTS) {
      const parent = a.parent ? achievementById(a.parent)! : null;
      if (parent) expect(a.xpReward).toBeGreaterThan(parent.xpReward);
    }
  });

  it('keeps a child locked until its parent is earned', () => {
    const child = ALL_ACHIEVEMENTS.find((a) => a.parent)!;
    expect(isUnlockable(child.id, [])).toBe(false);
    expect(isUnlockable(child.id, [child.parent!])).toBe(true);
    // Roots are always reachable.
    for (const branch of BRANCHES) {
      for (const root of rootsOfBranch(branch.id)) {
        expect(isUnlockable(root.id, [])).toBe(true);
      }
    }
  });

  it('conceals hidden rungs until their parent is earned', () => {
    const secret = ALL_ACHIEVEMENTS.find((a) => a.hidden)!;
    expect(isRevealed(secret.id, [])).toBe(false);
    expect(isRevealed(secret.id, [secret.parent!])).toBe(true);
    // Someone who already holds it can always read what they did.
    expect(isRevealed(secret.id, [secret.id])).toBe(true);
    // Nothing reachable on day one is hidden — a branch has to have a visible
    // way in or a player never learns it exists.
    for (const branch of BRANCHES) {
      for (const root of rootsOfBranch(branch.id)) expect(root.hidden).toBeFalsy();
    }
  });
});

describe('parent gating in play', () => {
  const init = (id: string, name: string) => {
    db.getProfile(id);
    db.initializeProfile(id, name);
  };
  const solo = (id: string, over: Record<string, unknown> = {}) =>
    db.recordMatch({
      playerId: id, username: 'Gate', playerScore: 5, opponentScore: 1,
      maxRally: 5, mode: 'solo', difficulty: 'pro', isWinner: true, ...over,
    } as never);

  it('refuses a deep rung to a player who skipped the path', () => {
    init('g_skip', 'GateSkip');
    // Beating Cyber without ever having beaten Rookie or Pro. Auto-granting
    // the ancestors would hand out "Warm-Up Complete" for a difficulty the
    // player never beat, so it stays locked instead.
    const res = solo('g_skip', { difficulty: 'cyber' });
    const ids = res.newAchievements.map((a) => a.id);
    expect(ids).not.toContain('cyber_slayer');
    expect(ids).not.toContain('ai_rookie');
  });

  it('opens the chain one rung at a time as the path is walked', () => {
    init('g_walk', 'GateWalk');
    expect(solo('g_walk', { difficulty: 'rookie' }).newAchievements.map((a) => a.id))
      .toContain('ai_rookie');
    expect(solo('g_walk', { difficulty: 'pro' }).newAchievements.map((a) => a.id))
      .toContain('ai_pro');
    expect(solo('g_walk', { difficulty: 'cyber' }).newAchievements.map((a) => a.id))
      .toContain('cyber_slayer');
  });

  it('lets one result climb a chain when it genuinely satisfies every rung', () => {
    init('g_rally', 'GateRally');
    // A 50-hit rally really is also a 25 and a 10, so all three land at once.
    const ids = solo('g_rally', { maxRally: 50 }).newAchievements.map((a) => a.id);
    expect(ids).toContain('rally_10');
    expect(ids).toContain('rally_25');
    expect(ids).toContain('rally_50');
  });
});

describe('the tree gates the game', () => {
  it('opens only the warm-up rungs to a brand-new player', () => {
    expect(hasUnlock([], 'difficulty', 'rookie')).toBe(true);
    expect(hasUnlock([], 'difficulty', 'pro')).toBe(false);
    expect(hasUnlock([], 'difficulty', 'cyber')).toBe(false);
    // Short matches are available; long ones are grown into.
    expect(hasUnlock([], 'winningScore', 3)).toBe(true);
    expect(hasUnlock([], 'winningScore', 5)).toBe(true);
    expect(hasUnlock([], 'winningScore', 10)).toBe(false);
    expect(hasUnlock([], 'winningScore', 15)).toBe(false);
  });

  it('opens the next rung of the ladder only by beating the one below', () => {
    expect(hasUnlock(['ai_rookie'], 'difficulty', 'pro')).toBe(true);
    expect(hasUnlock(['ai_rookie'], 'difficulty', 'cyber')).toBe(false);
    expect(hasUnlock(['ai_rookie', 'ai_pro'], 'difficulty', 'cyber')).toBe(true);
  });

  it('opens longer matches as a career builds', () => {
    expect(hasUnlock(['first_win'], 'winningScore', 10)).toBe(true);
    expect(hasUnlock(['first_win'], 'winningScore', 15)).toBe(false);
    expect(hasUnlock(['first_win', 'veteran_10'], 'winningScore', 15)).toBe(true);
  });

  it('can name the achievement that opens each locked thing', () => {
    expect(unlockedBy('difficulty', 'pro')!.id).toBe('ai_rookie');
    expect(unlockedBy('difficulty', 'cyber')!.id).toBe('ai_pro');
    expect(unlockedBy('winningScore', 15)!.id).toBe('veteran_10');
    // Nothing gates what is open from the start.
    expect(unlockedBy('difficulty', 'rookie')).toBeUndefined();
  });

  it('never gates something behind an achievement that needs it', () => {
    // A gate you can only open by using what it locks is a dead end. Walking
    // the ladder must be possible from an empty account.
    for (const [id, unlocks] of Object.entries(UNLOCKS)) {
      for (const u of unlocks) {
        if (u.kind !== 'difficulty') continue;
        // The achievement that opens a difficulty must itself be earnable on
        // a difficulty that is already open at that point.
        const openedBefore = unlockedKeys(ancestorsOf(id).map((a) => a.id).concat(id));
        expect(openedBefore.has(`difficulty:${u.value}`)).toBe(true);
      }
    }
  });

  it('reaches every difficulty by playing forward from nothing', () => {
    let earned: string[] = [];
    const reachable = () => AI_DIFFICULTIES.filter((d) => hasUnlock(earned, 'difficulty', d));
    expect(reachable()).toEqual(['rookie']);
    earned = [...earned, 'ai_rookie'];
    expect(reachable()).toEqual(['rookie', 'pro']);
    earned = [...earned, 'ai_pro'];
    expect(reachable()).toEqual(['rookie', 'pro', 'cyber']);
  });
});
