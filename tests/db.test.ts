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

// Profiles must be initialized (username locked in) before they can record
// matches — mirror the onboarding step every real player goes through.
const init = (id: string, username: string) => {
  db.getProfile(id);
  const result = db.initializeProfile(id, username);
  if (!result.ok) throw new Error(`init failed: ${result.code}`);
  return result.profile!;
};

describe('GameDatabase', () => {
  it('creates the SQLite database file in DATA_DIR', () => {
    expect(fs.existsSync(path.join(TMP, 'phong.db'))).toBe(true);
  });

  it('mints an UNINITIALIZED profile with a placeholder name on first read', () => {
    const p = db.getProfile('p_new');
    expect(p.initialized).toBe(false);
    expect(p.username.startsWith('Paddle-')).toBe(true);
    expect(p.eloRating).toBe(1200);
    expect(p.level).toBe(1);
  });

  it('initializes a profile with a chosen username exactly once', () => {
    const p = init('p_init', 'Fresh');
    expect(p.username).toBe('Fresh');
    expect(p.initialized).toBe(true);
    expect(p.initializedAt).toBeTruthy();
    expect(p.usernameChangedAt).toBeTruthy();
    const again = db.initializeProfile('p_init', 'OtherName');
    expect(again.ok).toBe(false);
    expect(again.code).toBe('ALREADY_INITIALIZED');
  });

  it('refuses to record a match for an uninitialized profile', () => {
    db.getProfile('p_uninit');
    expect(() => db.recordMatch(match('p_uninit'))).toThrow('PROFILE_NOT_INITIALIZED');
  });

  it('applies +24 ELO for a multiplayer win and -16 for a loss', () => {
    const before = init('p_elo', 'EloCase').eloRating;
    const win = db.recordMatch(match('p_elo'));
    expect(win.eloDelta).toBe(24);
    expect(win.profile.eloRating).toBe(before + 24);

    const loss = db.recordMatch(match('p_elo', { isWinner: false, playerScore: 2, opponentScore: 7 }));
    expect(loss.eloDelta).toBe(-16);
    expect(loss.profile.eloRating).toBe(before + 24 - 16);
  });

  it('records matches under the profile username, ignoring the payload name', () => {
    init('p_names', 'RealName');
    db.recordMatch(match('p_names', { username: 'Spoofed' }));
    const hist = db.getMatchHistory('p_names');
    expect(hist[0].player1Name).toBe('RealName');
  });

  it('never lets ELO fall below the 800 floor', () => {
    init('p_floor', 'FloorCase');
    for (let i = 0; i < 40; i++) {
      db.recordMatch(match('p_floor', { isWinner: false, playerScore: 0, maxRally: 1 }));
    }
    expect(db.getProfile('p_floor').eloRating).toBe(800);
  });

  it('unlocks first_win and multiplayer_champ on a first multiplayer win', () => {
    init('p_ach', 'AchCase');
    const res = db.recordMatch(match('p_ach'));
    const ids = res.newAchievements.map((a) => a.id);
    expect(ids).toContain('first_win');
    expect(ids).toContain('multiplayer_champ');
    // Recording again must not re-award them
    const again = db.recordMatch(match('p_ach'));
    expect(again.newAchievements.map((a) => a.id)).not.toContain('first_win');
  });

  it('survives 50 rapid sequential match writes without losing updates', () => {
    init('p_burst', 'Burst');
    for (let i = 0; i < 50; i++) {
      db.recordMatch(match('p_burst', { isWinner: i % 2 === 0 }));
    }
    const p = db.getProfile('p_burst');
    expect(p.matchesPlayed).toBe(50);
    expect(p.matchesWon).toBe(25);
  });

  it('re-derives level when achievement XP crosses a threshold', () => {
    // A first multiplayer win grants enough achievement XP (first_serve +
    // first_win + multiplayer_champ + rally_10 = 580) to level immediately.
    init('p_lvl', 'LevelCase');
    const res = db.recordMatch(match('p_lvl'));
    const expected = ((xp: number) => {
      let level = 1;
      let next = 120;
      while (xp >= next) {
        level++;
        next = Math.round(120 * Math.pow(level, 1.6));
      }
      return level;
    })(res.profile.xp);
    expect(res.profile.level).toBe(expected);
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
