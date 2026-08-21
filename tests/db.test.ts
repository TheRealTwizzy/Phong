import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { MatchEndPayload } from '../src/types';
import { levelFromXp } from '../src/rating';

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
    expect(p.tier).toBe('unranked');
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

  it('moves the ranked rating on a PvP win and back down on a loss', () => {
    const before = init('p_elo', 'EloCase').rankMu;
    const win = db.recordMatch(match('p_elo'));
    expect(win.profile.rankMu).toBeGreaterThan(before);
    expect(win.profile.rankedGames).toBe(1);

    const peak = win.profile.rankMu;
    const loss = db.recordMatch(match('p_elo', { isWinner: false, playerScore: 2, opponentScore: 7 }));
    expect(loss.profile.rankMu).toBeLessThan(peak);
    expect(loss.profile.rankedGames).toBe(2);
  });

  it('solo results move hidden MMR but NEVER the ranked rating or tier', () => {
    const p = init('p_solo_only', 'SoloOnly');
    const beforeRank = p.rankMu;
    const beforeMmr = p.mmrMu;
    for (let i = 0; i < 6; i++) {
      db.recordMatch(match('p_solo_only', { mode: 'solo', difficulty: 'cyber' }));
    }
    const after = db.getProfile('p_solo_only');
    expect(after.mmrMu).not.toBe(beforeMmr);
    expect(after.rankMu).toBe(beforeRank);
    expect(after.rankedGames).toBe(0);
    expect(after.tier).toBe('unranked');
  });

  it('awards more XP for beating a hard AI than an easy one', () => {
    init('p_xp_hard', 'XpHard');
    init('p_xp_easy', 'XpEasy');
    const hard = db.recordMatch(match('p_xp_hard', { mode: 'solo', difficulty: 'cyber' }));
    const easy = db.recordMatch(match('p_xp_easy', { mode: 'solo', difficulty: 'rookie' }));
    expect(hard.earnedXp).toBeGreaterThan(easy.earnedXp);
  });

  it('never subtracts XP, even on a heavy loss', () => {
    const before = init('p_xp_loss', 'XpLoss').xp;
    const res = db.recordMatch(
      match('p_xp_loss', { mode: 'solo', difficulty: 'rookie', isWinner: false, playerScore: 0 })
    );
    expect(res.earnedXp).toBeGreaterThan(0);
    expect(res.profile.xp).toBeGreaterThanOrEqual(before);
  });

  it('records matches under the profile username, ignoring the payload name', () => {
    init('p_names', 'RealName');
    db.recordMatch(match('p_names', { username: 'Spoofed' }));
    const hist = db.getMatchHistory('p_names');
    expect(hist[0].player1Name).toBe('RealName');
  });

  it('keeps uncertainty above the floor after a long losing streak', () => {
    init('p_floor', 'FloorCase');
    for (let i = 0; i < 40; i++) {
      db.recordMatch(match('p_floor', { isWinner: false, playerScore: 0, maxRally: 1 }));
    }
    const p = db.getProfile('p_floor');
    expect(p.rankSigma).toBeGreaterThanOrEqual(0.6);
    expect(p.rankMu).toBeLessThan(25);
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

  it('re-derives level from the shared curve after achievement XP lands', () => {
    init('p_lvl', 'LevelCase');
    const res = db.recordMatch(match('p_lvl'));
    expect(res.profile.level).toBe(levelFromXp(res.profile.xp).level);
    expect(res.profile.xpNext).toBe(levelFromXp(res.profile.xp).xpNext);
  });

  it('sorts the leaderboard with placed players first', () => {
    const rows = db.getLeaderboard('elo', 50);
    expect(rows.length).toBeGreaterThan(0);
    const placedFlags = rows.map((r) => r.tier !== 'unranked');
    // Once an unranked row appears, no placed row may follow it.
    const firstUnranked = placedFlags.indexOf(false);
    if (firstUnranked >= 0) {
      expect(placedFlags.slice(firstUnranked).every((p) => !p)).toBe(true);
    }
  });

  it('records match history newest-first', () => {
    const hist = db.getMatchHistory('p_burst');
    expect(hist.length).toBeGreaterThan(0);
    for (let i = 1; i < hist.length; i++) {
      expect(Date.parse(hist[i - 1].timestamp) >= Date.parse(hist[i].timestamp)).toBe(true);
    }
  });
});
