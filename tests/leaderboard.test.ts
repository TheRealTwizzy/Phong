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
  // Bots no longer seed automatically (the fresh launch starts with 0
  // players) — insert a roster through the insertBot seam so the
  // interleave/rank contract stays covered for the future bot rollout.
  // Bot skill anchors, strongest first.
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
  db.initializeProfile('dev_888888888888888888', 'Mid'); // stays at 1200
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
