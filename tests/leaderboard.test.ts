import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
    maxRally: 3,
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
      maxRally: 12,
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
      maxRally: 0,
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
