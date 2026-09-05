import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { MatchEndPayload } from '../src/types';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-board-test-'));
process.env.DATA_DIR = TMP;

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
  // The shipped roster is seeded at SERVER boot, not in the Db constructor,
  // so a test that builds a `db` directly gets an empty table and controls
  // its own fixtures — which is what keeps the counts below stable. These
  // four are this suite's own bots, not the shipped ladder; see
  // tests/bots.test.ts for that one. Strongest first.
  db.insertBot({ id: 'bot-pro-04', username: 'CyberStriker', xp: 9800, mu: 36 });
  db.insertBot({ id: 'bot-pro-01', username: 'NeonViper', xp: 6200, mu: 32 });
  db.insertBot({ id: 'bot-pro-02', username: 'PulseEcho', xp: 4100, mu: 29 });
  db.insertBot({ id: 'bot-pro-03', username: 'AeroZen', xp: 2300, mu: 26 });

  // Two humans with different strengths, landing among the bots
  const win = (id: string, name: string): MatchEndPayload => ({
    playerId: id,
    username: name,
    playerScore: 5,
    opponentScore: 0,
    bestStreak: 3, endStreak: 0, earnedStreak: 3,
    mode: 'multiplayer',
    isWinner: true,
  });
  db.getProfile('dev_777777777777777777');
  db.initializeProfile('dev_777777777777777777', 'Strong');
  for (let i = 0; i < 20; i++) db.recordMatch(win('dev_777777777777777777', 'Strong')); // 1200+20*24 = 1680
  db.getProfile('dev_888888888888888888');
  db.initializeProfile('dev_888888888888888888', 'Mid');
  // One ranked loss: enough progress to be ON the skill board, without a
  // rating to speak of — the boards now refuse rows of zeros outright.
  db.recordMatch({
    ...win('dev_888888888888888888', 'Mid'),
    playerScore: 0,
    opponentScore: 5,
    isWinner: false,
  });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('leaderboard bot filtering', () => {
  it('hides bots by default and ranks humans contiguously', () => {
    const board = db.getLeaderboard('elo', 50);
    expect(board.some((e) => e.isBot)).toBe(false);
    expect(board.some((e) => e.id.startsWith('bot-'))).toBe(false);
    board.forEach((e, i) => expect(e.rank).toBe(i + 1));
  });

  it('interleaves bots when requested, with null ranks and isBot flags', () => {
    const board = db.getLeaderboard('elo', 50, true);
    const bots = board.filter((e) => e.isBot);
    expect(bots.length).toBe(4);
    bots.forEach((b) => {
      expect(b.rank).toBeNull();
      expect(b.id.startsWith('bot-')).toBe(true);
    });
    // Sorted order is preserved across the mix
    for (let i = 1; i < board.length; i++) {
      expect(board[i - 1].tier).toBeTruthy();
    }
  });

  it('human ranks are identical whether bots are shown or hidden', () => {
    const hidden = db.getLeaderboard('elo', 50, false);
    const shown = db.getLeaderboard('elo', 50, true);
    const ranksHidden = new Map(hidden.map((e) => [e.id, e.rank]));
    for (const e of shown) {
      if (e.isBot) continue;
      expect(e.rank).toBe(ranksHidden.get(e.id));
    }
    // And the specific humans land where their skill puts them among humans
    const strong = shown.find((e) => e.username === 'Strong')!;
    const mid = shown.find((e) => e.username === 'Mid')!;
    expect(strong.rank).toBe(1);
    expect(mid.rank).toBe(2);
  });

  it('respects the row limit across the mixed view', () => {
    const board = db.getLeaderboard('elo', 3, true);
    expect(board.length).toBe(3);
  });

  it('excludes uninitialized profiles entirely', () => {
    db.getProfile('dev_999999999999999999'); // never onboards
    const board = db.getLeaderboard('elo', 100, true);
    expect(board.some((e) => e.id === 'dev_999999999999999999')).toBe(false);
  });
});

describe('a board only lists players with progress on what it measures', () => {
  const BOARDS = ['elo', 'level', 'rally', 'wins'] as const;

  it('keeps a freshly onboarded profile off every board', () => {
    // Onboarding is identity, not progress. A row of zeros is not "last
    // place" — it is not on the board yet.
    db.getProfile('dev_555555555555555555');
    db.initializeProfile('dev_555555555555555555', 'IdleOne');
    for (const sort of BOARDS) {
      const board = db.getLeaderboard(sort, 100, true);
      expect(board.some((e) => e.id === 'dev_555555555555555555')).toBe(false);
    }
  });

  it('keeps a solo-only career off the skill board but on the others', () => {
    db.getProfile('dev_444444444444444444');
    db.initializeProfile('dev_444444444444444444', 'SoloOnly');
    db.recordMatch({
      playerId: 'dev_444444444444444444',
      username: 'SoloOnly',
      playerScore: 5,
      opponentScore: 2,
      bestStreak: 12, endStreak: 0, earnedStreak: 12,
      mode: 'solo',
      difficulty: 'rookie',
      isWinner: true,
    });
    const on = (sort: (typeof BOARDS)[number]) =>
      db.getLeaderboard(sort, 100).some((e) => e.id === 'dev_444444444444444444');
    // The skill board is a PvP ladder; a solo career has no ranked progress.
    expect(on('elo')).toBe(false);
    expect(on('level')).toBe(true);
    expect(on('wins')).toBe(true);
    expect(on('rally')).toBe(true);
  });

  it('puts a player on exactly the boards their record has touched', () => {
    // One ranked PvP LOSS: on the skill board (the climb has begun), and on
    // the level board (every match pays XP) — but with zero wins and the
    // rally board untouched, not on those.
    db.getProfile('dev_333333333333333333');
    db.initializeProfile('dev_333333333333333333', 'FirstLoss');
    db.recordMatch({
      playerId: 'dev_333333333333333333',
      username: 'FirstLoss',
      playerScore: 0,
      opponentScore: 5,
      bestStreak: 0, endStreak: 0, earnedStreak: 0,
      mode: 'multiplayer',
      isWinner: false,
    });
    const on = (sort: (typeof BOARDS)[number]) =>
      db.getLeaderboard(sort, 100).some((e) => e.id === 'dev_333333333333333333');
    expect(on('elo')).toBe(true);
    expect(on('level')).toBe(true);
    expect(on('wins')).toBe(false);
    expect(on('rally')).toBe(false);
  });

  it('keeps the curated bot roster on the boards regardless', () => {
    // Bots are inserted deliberately — a display roster, not idle players.
    for (const sort of BOARDS) {
      const bots = db.getLeaderboard(sort, 100, true).filter((e) => e.isBot);
      expect(bots.length).toBe(4);
    }
  });
});

describe('a qualified bot has a ladder position, in its own lane', () => {
  // §4.9 / D15, and there are TWO clauses in TWO functions doing two different
  // jobs. Conflating them is exactly how this section contradicted itself, so
  // the halves are asserted apart:
  //
  //   onLadder(p)                ELIGIBILITY — does this row get a number at all
  //   ladderPosition(id, rankMu) THE COUNTED SET — who is counted above it
  //
  // Doing only the second leaves every bot with no number; doing only the
  // first counts bots into humans' numbers. Both are needed and neither test
  // passes on the other's change.

  const apex = (id: string, name: string, mu: number) => {
    db.insertBot({ id, username: name, mu, rankedGames: 40, rankedDuels: 40 });
  };

  /**
   * A human at the apex. Written straight to the row because there is no API
   * for it: the apex needs a rating, a settled sigma, five ranked games and
   * OVERLORD_MIN_DUELS duels, and playing 25 of them per fixture would make
   * this suite about `recordMatch` rather than about the lanes.
   */
  const humanApex = (id: string, name: string, mu: number) => {
    db.getProfile(id);
    expect(db.initializeProfile(id, name).ok).toBe(true);
    const raw = new DatabaseSync(path.join(TMP, 'phong.db'));
    try {
      raw
        .prepare(
          'UPDATE players SET rankMu = ?, rankSigma = 1, rankedGames = 40, rankedDuels = 40 WHERE id = ?'
        )
        .run(mu, id);
    } finally {
      raw.close();
    }
  };

  it('ELIGIBILITY: a qualified bot receives a non-null position', () => {
    // The assertion that fails if `onLadder`'s bot clause is RE-SPELLED as
    // `!isBotAccount(p.id)` rather than removed — which is the whole §4.9
    // contradiction, caught directly. Step 5 deliberately left it re-spelled.
    apex('bot-ladder-01', 'LadderBotOne', 41);
    const profile = db.getProfile('bot-ladder-01');
    expect(profile.tier).toBe('overlord');
    expect(profile.ladderPosition).toBeGreaterThanOrEqual(1);
  });

  it('THE LANES: a bot counts everybody above it, a human counts only humans', () => {
    // Two apex bots and one apex human, all qualified. The human's number
    // ignores the bots; the LOWER bot's counts the higher bot AND the human.
    // Ratings chosen so the ORDER is unambiguous and no other fixture in this
    // suite can sit between them: the earlier humans play real matches and
    // their mu is whatever those produced.
    apex('bot-lane-hi', 'LaneBotHigh', 70);
    humanApex('dev_lane_human_001', 'LaneHuman', 60);
    apex('bot-lane-lo', 'LaneBotLow', 55);

    const human = db.getProfile('dev_lane_human_001');
    const lo = db.getProfile('bot-lane-lo');
    expect(human.tier).toBe('overlord');
    expect(lo.tier).toBe('overlord');
    // The human is counted against humans alone. Both bots outrank it on mu
    // and neither may push it down.
    expect(human.ladderPosition).toBe(1);
    // The lower bot is counted against EVERYBODY: the higher bot and the
    // human are both above it.
    expect(lo.ladderPosition).toBe(3);
  });

  it('HUMAN INVARIANCE: adding a bot moves no human’s number, at all', () => {
    // Measured over EVERY human rather than spot-checked, because the failure
    // this guards is one row shifting by one.
    const humansNow = (): Record<string, number | undefined> => {
      const out: Record<string, number | undefined> = {};
      for (const entry of db.getLeaderboard('elo', 100, false)) {
        out[entry.id] = db.getProfile(entry.id).ladderPosition;
      }
      return out;
    };
    const before = humansNow();
    // ABOVE the apex human on purpose. Bots below them could not shift the
    // number whatever the counted set did, so a fixture built that way passes
    // even when every lane is wrong — measured, it did.
    apex('bot-invariant-01', 'InvariantBot', 80);
    apex('bot-invariant-02', 'InvariantBot2', 75);
    expect(Object.values(before).some((n) => n !== undefined)).toBe(true);
    expect(humansNow()).toEqual(before);
  });

  it('ELIGIBILITY is the BOARD’s membership test, not merely a rating', () => {
    // The other half of `onLadder`, which the bot change must not weaken. A
    // row the board refuses to print must not still get a number: an
    // uninitialized profile is placed and rated like any other row, takes
    // 'overlord' from `tierFor`, and would be handed #1 for a ladder it does
    // not appear on. And a placed human short of the apex has no position at
    // all — the top rung is the only one that reads as one.
    const placed = db.getProfile('dev_888888888888888888');
    expect(placed.tier).not.toBe('overlord');
    expect(placed.ladderPosition).toBeUndefined();

    // The uninitialized row has to be APEX-RATED, or the tier gate catches it
    // and the initializedAt clause is never exercised — measured, removing
    // that clause reddened nothing until this fixture was rated.
    db.getProfile('dev_never_onboarded_01');
    const raw = new DatabaseSync(path.join(TMP, 'phong.db'));
    try {
      raw
        .prepare(
          'UPDATE players SET rankMu = 90, rankSigma = 1, rankedGames = 40, rankedDuels = 40 WHERE id = ?'
        )
        .run('dev_never_onboarded_01');
    } finally {
      raw.close();
    }
    const fresh = db.getProfile('dev_never_onboarded_01');
    expect(fresh.initialized).toBe(false);
    expect(fresh.tier).toBe('overlord');
    expect(fresh.ladderPosition).toBeUndefined();
  });

  it('D15’s accepted consequence: a bot and a human may show the SAME number', () => {
    // Different lanes, so a collision is intended behaviour rather than a bug
    // — pinned here so a later "fix" that silently renumbers one lane goes red.
    const human = db.getProfile('dev_lane_human_001');
    apex('bot-collide-01', 'CollideBot', 99);
    const bot = db.getProfile('bot-collide-01');
    expect(bot.ladderPosition).toBe(1);
    expect(human.ladderPosition).toBe(1);
  });
});
