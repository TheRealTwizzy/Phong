import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { MatchEndPayload } from '../src/types';

// db.ts resolves DATA_DIR at import time, so point it at a temp dir first.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-db-test-'));
process.env.DATA_DIR = TMP;

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const match = (playerId: string, overrides: Partial<MatchEndPayload> = {}): MatchEndPayload => ({
  playerId,
  username: `Tester-${playerId}`,
  playerScore: 7,
  opponentScore: 3,
  maxRally: 8,
  mode: 'multiplayer',
  isWinner: true,
  ...overrides,
});

describe('GameDatabase', () => {
  it('creates the database file in DATA_DIR', () => {
    expect(fs.existsSync(path.join(TMP, 'game_database.json'))).toBe(true);
  });

  it('creates a profile on first read with the requested username', () => {
    const p = db.getProfile('p_new', 'Fresh');
    expect(p.username).toBe('Fresh');
    expect(p.eloRating).toBe(1200);
    expect(p.level).toBe(1);
  });

  it('applies +24 ELO for a multiplayer win and -16 for a loss', () => {
    const before = db.getProfile('p_elo', 'EloCase').eloRating;
    const win = db.recordMatch(match('p_elo'));
    expect(win.eloDelta).toBe(24);
    expect(win.profile.eloRating).toBe(before + 24);

    const loss = db.recordMatch(match('p_elo', { isWinner: false, playerScore: 2, opponentScore: 7 }));
    expect(loss.eloDelta).toBe(-16);
    expect(loss.profile.eloRating).toBe(before + 24 - 16);
  });

  it('never lets ELO fall below the 800 floor', () => {
    db.getProfile('p_floor', 'FloorCase');
    for (let i = 0; i < 40; i++) {
      db.recordMatch(match('p_floor', { isWinner: false, playerScore: 0, maxRally: 1 }));
    }
    expect(db.getProfile('p_floor').eloRating).toBe(800);
  });

  it('unlocks first_win and multiplayer_champ on a first multiplayer win', () => {
    const res = db.recordMatch(match('p_ach'));
    const ids = res.newAchievements.map((a) => a.id);
    expect(ids).toContain('first_win');
    expect(ids).toContain('multiplayer_champ');
    // Recording again must not re-award them
    const again = db.recordMatch(match('p_ach'));
    expect(again.newAchievements.map((a) => a.id)).not.toContain('first_win');
  });

  it('survives 50 rapid sequential match writes without losing updates', () => {
    db.getProfile('p_burst', 'Burst');
    for (let i = 0; i < 50; i++) {
      db.recordMatch(match('p_burst', { isWinner: i % 2 === 0 }));
    }
    const p = db.getProfile('p_burst');
    expect(p.matchesPlayed).toBe(50);
    expect(p.matchesWon).toBe(25);
    // On-disk copy is valid JSON and agrees with memory
    const disk = JSON.parse(fs.readFileSync(path.join(TMP, 'game_database.json'), 'utf-8'));
    expect(disk.players['p_burst'].matchesPlayed).toBe(50);
  });

  it('sorts the leaderboard by ELO descending', () => {
    const rows = db.getLeaderboard('elo', 50);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].eloRating).toBeGreaterThanOrEqual(rows[i].eloRating);
    }
    expect(rows.length).toBeGreaterThan(0);
  });

  it('records match history newest-first', () => {
    const hist = db.getMatchHistory('p_burst');
    expect(hist.length).toBeGreaterThan(0);
    for (let i = 1; i < hist.length; i++) {
      expect(Date.parse(hist[i - 1].timestamp) >= Date.parse(hist[i].timestamp)).toBe(true);
    }
  });
});
