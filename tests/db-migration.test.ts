import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Verifies the one-time import of a pre-SQLite game_database.json.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-migrate-test-'));

const legacyProfile = {
  id: 'p_legacy',
  username: 'OldTimer',
  level: 4,
  xp: 1500,
  xpNext: 1611,
  eloRating: 1288,
  matchesPlayed: 12,
  matchesWon: 7,
  matchesLost: 5,
  highestRally: 18,
  totalPointsScored: 61,
  totalAces: 3,
  dailyStreak: 2,
  lastDailyDate: '2026-08-19',
  achievements: ['first_serve', 'rally_10', 'first_win'],
  createdAt: '2026-07-01T00:00:00.000Z',
  lastActive: '2026-08-19T00:00:00.000Z',
  rankTitle: 'Vanguard',
};

const legacyMatch = (n: number) => ({
  id: `match_legacy_${n}`,
  player1Id: 'p_legacy',
  player1Name: 'OldTimer',
  player2Id: 'AI-pro',
  player2Name: 'AI (pro)',
  winnerId: 'p_legacy',
  winnerName: 'OldTimer',
  scoreP1: 7,
  scoreP2: n,
  maxRally: 10 + n,
  mode: 'solo',
  difficulty: 'pro',
  timestamp: `2026-08-1${n}T00:00:00.000Z`,
});

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  fs.writeFileSync(
    path.join(TMP, 'game_database.json'),
    JSON.stringify({
      players: { p_legacy: legacyProfile },
      // Legacy store kept matches newest-first
      matches: [legacyMatch(3), legacyMatch(2), legacyMatch(1)],
      achievementLog: {},
    })
  );
  process.env.DATA_DIR = TMP;
  ({ db } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('legacy JSON import', () => {
  it('imports players with stats and achievements intact', () => {
    const p = db.getProfile('p_legacy');
    expect(p.username).toBe('OldTimer');
    expect(p.eloRating).toBe(1288);
    expect(p.matchesPlayed).toBe(12);
    expect(p.achievements).toEqual(['first_serve', 'rally_10', 'first_win']);
  });

  it('does not seed bots when legacy data exists', () => {
    const board = db.getLeaderboard('elo', 50);
    expect(board.some((e) => e.id.startsWith('bot-pro-'))).toBe(false);
  });

  it('imports match history preserving newest-first order', () => {
    const hist = db.getMatchHistory('p_legacy');
    expect(hist.map((m) => m.id)).toEqual(['match_legacy_3', 'match_legacy_2', 'match_legacy_1']);
  });
});
