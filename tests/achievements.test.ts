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
  isBranchRevealed,
  isRevealed,
  isUnlockable,
  rootsOfBranch,
  hasUnlock,
  unlockedBy,
  unlockedKeys,
  UNLOCKS,
  DIFFICULTY_ORDER,
  WINNING_SCORE_ORDER,
  playableDifficulty,
  playableWinningScore,
} from '../src/achievements';
import { AI_DIFFICULTIES } from '../src/rating';
import type { AchievementBranch } from '../src/types';

// Gate contexts used across the tree tests.
const NEWBIE = { level: 1, tier: 'unranked' } as const;
const VETERAN = { level: 99, tier: 'legend' } as const;

const branchGate = (id: AchievementBranch) => BRANCHES.find((b) => b.id === id)?.gate;
/** The achievement ids that open a branch, if any. */
const branchOpeners = (id: AchievementBranch): string[] => {
  const gate = branchGate(id);
  return gate?.achievement ? [gate.achievement] : [];
};

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
    // The tree spans a whole playing career across eight branches — 200
    // matches, Cyber Overlord, a 150-hit rally, level 50 — so it is worth more
    // in total than the old flat list, spread far thinner per match by the
    // band cap. The ceiling is what stops the catalogue quietly becoming the
    // main way to level: earning ALL of it must still be a career, not a
    // shortcut past one.
    expect(level).toBeGreaterThanOrEqual(12);
    expect(level).toBeLessThanOrEqual(28);
  });
});

describe('level jumps', () => {
  // These walk hundreds of matches through the real write path rather than a
  // model of it, which is the point of them — but it also means a slow CI
  // runner needs more than vitest's default five seconds.
  const SIMULATION_TIMEOUT = 30_000;

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
        // Rescaled with the rally rework. The old 4..26 was the spread of a
        // shared counter that both players fed within a point; one player's
        // own consecutive returns measures about 0.72x that, and simulating
        // on the old spread against the new XP_PER_RALLY would model matches
        // nobody can actually play.
        bestStreak: 3 + Math.floor(rnd() * 16), endStreak: 0, earnedStreak: 3 + Math.floor(rnd() * 16),
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
  }, SIMULATION_TIMEOUT);

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
  }, SIMULATION_TIMEOUT);

  it('still moves at a few matches per level', () => {
    const { finalLevel } = play(29, 'pro', 60);
    const perLevel = 60 / (finalLevel - 1);
    expect(perLevel).toBeGreaterThan(1.5);
    expect(perLevel).toBeLessThan(6);
  }, SIMULATION_TIMEOUT);
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
      playerScore: 5, opponentScore: 0, bestStreak: 50, endStreak: 0, earnedStreak: 50,
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
      playerScore: 5, opponentScore: 0, bestStreak: 30, endStreak: 0, earnedStreak: 30,
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
    const child = ALL_ACHIEVEMENTS.find((a) => a.parent && !a.gate && !branchGate(a.branch))!;
    expect(isUnlockable(child.id, [], VETERAN)).toBe(false);
    expect(isUnlockable(child.id, [child.parent!], VETERAN)).toBe(true);
    // Roots of an OPEN branch are always reachable.
    for (const branch of BRANCHES.filter((b) => !b.gate)) {
      for (const root of rootsOfBranch(branch.id)) {
        expect(isUnlockable(root.id, [], NEWBIE)).toBe(true);
      }
    }
  });

  it('conceals hidden rungs until their parent is earned', () => {
    const secret = ALL_ACHIEVEMENTS.find((a) => a.hidden && !branchGate(a.branch))!;
    expect(isRevealed(secret.id, [], VETERAN)).toBe(false);
    expect(isRevealed(secret.id, [secret.parent!], VETERAN)).toBe(true);
    // Someone who already holds it can always read what they did.
    expect(isRevealed(secret.id, [secret.id], NEWBIE)).toBe(true);
    // Nothing reachable on day one is hidden — an OPEN branch has to have a
    // visible way in or a player never learns it exists. A concealed branch is
    // the opposite by design: the branch itself is the silhouette.
    for (const branch of BRANCHES.filter((b) => !b.gate)) {
      for (const root of rootsOfBranch(branch.id)) expect(root.hidden).toBeFalsy();
    }
  });

  it('roots every branch on a node inside it', () => {
    // `parent` chains WITHIN a tree; `gate` opens the tree. A cross-branch
    // parent would make a branch unreadable as a tree of its own.
    for (const b of BRANCHES) {
      expect(rootsOfBranch(b.id).length).toBeGreaterThan(0);
      for (const node of ALL_ACHIEVEMENTS.filter((a) => a.branch === b.id && a.parent)) {
        expect(achievementById(node.parent!)!.branch).toBe(b.id);
      }
    }
  });
});

describe('concealed branches', () => {
  it('hides a gated branch, and everything in it, until it opens', () => {
    const gated = BRANCHES.filter((x) => x.gate);
    expect(gated.length).toBeGreaterThanOrEqual(3);
    for (const b of gated) {
      expect(isBranchRevealed(b.id, [], NEWBIE)).toBe(false);
      for (const node of ALL_ACHIEVEMENTS.filter((a) => a.branch === b.id)) {
        expect(isRevealed(node.id, [], NEWBIE)).toBe(false);
        expect(isUnlockable(node.id, [], NEWBIE)).toBe(false);
      }
    }
  });

  it('opens each one on the thing it names, and not before', () => {
    expect(isBranchRevealed('ascent', ['first_duel'], NEWBIE)).toBe(true);
    expect(isBranchRevealed('ascent', ['shutout'], NEWBIE)).toBe(false);
    expect(isBranchRevealed('dominion', ['shutout'], NEWBIE)).toBe(true);
    expect(isBranchRevealed('dominion', ['first_duel'], NEWBIE)).toBe(false);
    expect(isBranchRevealed('devotion', [], { level: 5, tier: 'unranked' })).toBe(true);
    expect(isBranchRevealed('devotion', [], { level: 4, tier: 'unranked' })).toBe(false);
  });

  it('gives every concealed branch a hint, gated on something outside itself', () => {
    for (const b of BRANCHES.filter((x) => x.gate)) {
      expect(b.gateHintKey).toBeTruthy();
      if (b.gate?.achievement) {
        const opener = achievementById(b.gate.achievement)!;
        expect(opener).toBeTruthy();
        // A branch gated on one of its own nodes could never open.
        expect(opener.branch).not.toBe(b.id);
      }
    }
  });
});

describe('level and rank gates', () => {
  it('refuses a gated rung until the level or tier is there', () => {
    const gated = ALL_ACHIEVEMENTS.filter((a) => a.gate);
    expect(gated.length).toBeGreaterThan(4);
    for (const a of gated) {
      const earned = [...(a.parent ? [a.parent] : []), ...branchOpeners(a.branch)];
      const open = a.gate!.level
        ? { level: a.gate!.level, tier: 'legend' as const }
        : { level: 99, tier: a.gate!.tier! };
      const short = a.gate!.level
        ? { level: a.gate!.level - 1, tier: 'legend' as const }
        : { level: 99, tier: 'rookie' as const };
      expect(isUnlockable(a.id, earned, open)).toBe(true);
      expect(isUnlockable(a.id, earned, short)).toBe(false);
    }
  });

  it('banks a feat performed before its gate opened', () => {
    // A 150-hit rally at level 3 must not vanish: rally rungs are measured on
    // the profile's stored best, so the rung lands on the first match played
    // after the gate is finally met.
    db.getProfile('g_bank');
    db.initializeProfile('g_bank', 'GateBank');
    const play = (over: Record<string, unknown> = {}) =>
      db.recordMatch({
        playerId: 'g_bank', username: 'GateBank', playerScore: 5, opponentScore: 1,
        bestStreak: 5, endStreak: 0, earnedStreak: 5, mode: 'solo', difficulty: 'rookie', isWinner: true, ...over,
      } as never);
    play({ bestStreak: 150 });
    const early = db.getProfile('g_bank');
    expect(early.highestRally).toBe(150);
    expect(early.achievements).toContain('rally_100');
    expect(early.achievements).not.toContain('rally_150'); // gate: level 15
    // Grind ordinary matches until level 15; the banked rally then pays out.
    for (let i = 0; i < 200 && db.getProfile('g_bank').level < 15; i++) play();
    for (let i = 0; i < 3 && !db.getProfile('g_bank').achievements.includes('rally_150'); i++) play();
    expect(db.getProfile('g_bank').level).toBeGreaterThanOrEqual(15);
    expect(db.getProfile('g_bank').achievements).toContain('rally_150');
  }, 30_000);

  it('never gates a rung behind a level the game does not reach', () => {
    // A gate is a delay, not a dead end. Level 25 is the deepest milestone the
    // tree itself celebrates, so nothing may ask for more than that.
    for (const a of ALL_ACHIEVEMENTS.filter((x) => x.gate?.level)) {
      expect(a.gate!.level).toBeLessThanOrEqual(25);
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
      bestStreak: 5, endStreak: 0, earnedStreak: 5, mode: 'solo', difficulty: 'pro', isWinner: true, ...over,
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
  });

  it('will not open Cyber on one Pro win, and does open it on the climb', () => {
    // The complaint this rung answers: Cyber arrived in a first session, off a
    // single Pro win, before the player had any feel for the middle rung.
    init('g_cyber', 'GateCyber');
    solo('g_cyber', { difficulty: 'rookie' });
    solo('g_cyber', { difficulty: 'pro' });
    const early = db.getProfile('g_cyber');
    expect(hasUnlock(early.achievements, 'difficulty', 'cyber')).toBe(false);

    // Ten Pro wins AND level 10. Ten wins alone arrive first; the gate holds
    // until the level does too.
    for (let i = 0; i < 9; i++) solo('g_cyber', { difficulty: 'pro' });
    const after = db.getProfile('g_cyber');
    expect(after.proWins).toBeGreaterThanOrEqual(10);
    if (after.level < 10) {
      expect(hasUnlock(after.achievements, 'difficulty', 'cyber')).toBe(false);
    }
    // Keep playing until the level lands; the rung then opens by itself.
    for (let i = 0; i < 40 && db.getProfile('g_cyber').level < 10; i++) {
      solo('g_cyber', { difficulty: 'pro' });
    }
    const climbed = db.getProfile('g_cyber');
    expect(climbed.level).toBeGreaterThanOrEqual(10);
    expect(climbed.achievements).toContain('ai_pro_10');
    expect(hasUnlock(climbed.achievements, 'difficulty', 'cyber')).toBe(true);
  });

  it('lets one result climb a chain when it genuinely satisfies every rung', () => {
    init('g_rally', 'GateRally');
    // A 50-hit rally really is also a 25 and a 10, so all three land at once.
    const ids = solo('g_rally', { bestStreak: 50 }).newAchievements.map((a) => a.id);
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
    // A single Pro win is no longer enough — that used to hand a first-session
    // player the hardest opponent in the game.
    expect(hasUnlock(['ai_rookie', 'ai_pro'], 'difficulty', 'cyber')).toBe(false);
    expect(hasUnlock(['ai_rookie', 'ai_pro', 'ai_pro_10'], 'difficulty', 'cyber')).toBe(true);
  });

  it('opens longer matches as a career builds', () => {
    expect(hasUnlock(['first_win'], 'winningScore', 10)).toBe(true);
    expect(hasUnlock(['first_win'], 'winningScore', 15)).toBe(false);
    expect(hasUnlock(['first_win', 'veteran_10'], 'winningScore', 15)).toBe(true);
  });

  it('can name the achievement that opens each locked thing', () => {
    expect(unlockedBy('difficulty', 'pro')!.id).toBe('ai_rookie');
    expect(unlockedBy('difficulty', 'cyber')!.id).toBe('ai_pro_10');
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
    // Beating Pro once opens nothing further: the top rung is behind ten Pro
    // wins AND level 10.
    earned = [...earned, 'ai_pro'];
    expect(reachable()).toEqual(['rookie', 'pro']);
    earned = [...earned, 'ai_pro_10'];
    expect(reachable()).toEqual(['rookie', 'pro', 'cyber']);
  });

  it('makes the Cyber gate a real climb, not a first-session accident', () => {
    const gate = unlockedBy('difficulty', 'cyber')!;
    // Ten Pro wins is the trigger; level 10 is the gate on the same rung.
    expect(gate.gate?.level).toBe(10);
    expect(isUnlockable(gate.id, ['ai_pro'], { level: 9, tier: 'unranked' })).toBe(false);
    expect(isUnlockable(gate.id, ['ai_pro'], { level: 10, tier: 'unranked' })).toBe(true);
  });
});

describe('a playable setting is never a locked one', () => {
  // The bug this guards: the app shipped with Pro preselected, and Pro is
  // locked until Rookie has been beaten. The menu drew it as locked and played
  // it anyway; /api/match/record answered 403 DIFFICULTY_LOCKED, which the
  // client treats as a verdict rather than a hiccup — so a new player's solo
  // matches were dropped outright. No XP, no missions, no history.

  it('opens the easiest rung of every ladder from the first match', () => {
    // What makes the shipped defaults safe by construction: App.tsx takes them
    // from the head of these ladders, so if the head is base-unlocked the
    // default cannot be a locked option.
    expect(hasUnlock([], 'difficulty', DIFFICULTY_ORDER[0])).toBe(true);
    expect(hasUnlock([], 'winningScore', WINNING_SCORE_ORDER[0])).toBe(true);
  });

  it('never falls back to something harder, or to something still locked', () => {
    // The contract, checked exhaustively rather than assumed: whatever the
    // clamp hands back is (a) actually unlocked, (b) never further up the
    // ladder than what was asked for, and (c) exactly what was asked for when
    // that is already open. Handing back a HARDER option would recreate the
    // original bug — a setting the server then refuses to record.
    const sets: string[][] = [
      [],
      ['ai_rookie'],
      ['ai_rookie', 'ai_pro'],
      ['ai_rookie', 'ai_pro', 'ai_pro_10'],
      ['first_win'],
      ['first_win', 'veteran_10'],
      // A deep rung without its parent. Not reachable by playing — gating is
      // strict — but the clamp must not misbehave if it ever were.
      ['veteran_10'],
      ALL_ACHIEVEMENTS.map((a) => a.id),
    ];

    for (const earned of sets) {
      for (const [index, wanted] of DIFFICULTY_ORDER.entries()) {
        const got = playableDifficulty(earned, wanted);
        expect(hasUnlock(earned, 'difficulty', got)).toBe(true);
        expect(DIFFICULTY_ORDER.indexOf(got)).toBeLessThanOrEqual(index);
        if (hasUnlock(earned, 'difficulty', wanted)) expect(got).toBe(wanted);
      }
      for (const [index, wanted] of WINNING_SCORE_ORDER.entries()) {
        const got = playableWinningScore(earned, wanted);
        expect(hasUnlock(earned, 'winningScore', got)).toBe(true);
        expect(WINNING_SCORE_ORDER.indexOf(got as any)).toBeLessThanOrEqual(index);
        if (hasUnlock(earned, 'winningScore', wanted)) expect(got).toBe(wanted);
      }
    }
  });

  it('clamps a difficulty the player has not earned down to one they have', () => {
    // A brand-new profile, and the difficulty the app used to ship with.
    expect(playableDifficulty([], 'pro')).toBe('rookie');
    expect(playableDifficulty([], 'cyber')).toBe('rookie');
    // Exactly the case a wipe creates: the device kept the setting, the
    // server cleared the achievement that opened it.
    expect(playableDifficulty(['ai_rookie'], 'cyber')).toBe('pro');
  });

  it('leaves a difficulty alone once it has actually been earned', () => {
    expect(playableDifficulty(['ai_rookie'], 'pro')).toBe('pro');
    expect(playableDifficulty(['ai_rookie', 'ai_pro', 'ai_pro_10'], 'cyber')).toBe('cyber');
    // Never promotes: asking for less than you own gives you what you asked.
    expect(playableDifficulty(['ai_rookie', 'ai_pro', 'ai_pro_10'], 'rookie')).toBe('rookie');
  });

  it('clamps the match length the same way', () => {
    expect(playableWinningScore([], 10)).toBe(5);
    expect(playableWinningScore([], 15)).toBe(5);
    expect(playableWinningScore(['first_win'], 15)).toBe(10);
    expect(playableWinningScore(['first_win'], 10)).toBe(10);
    expect(playableWinningScore([], 3)).toBe(3);
  });
});
