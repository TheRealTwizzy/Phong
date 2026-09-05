import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { PLACEMENT_GAMES, newRating } from '../src/rating';

// The one-shot `progress_reset_v1`: the ladder is cleared before the play-bot
// population is allowed onto it.
//
// A ladder that bots and humans share has to start from one line, and every
// rating on disk was earned in a game where the only opponents were people and
// the solo AI. So ranks, career statistics, mode statistics, match history,
// XP, levels, achievements and the permanent unlocks they gate are all reset.
//
// IT IS NOT A WIPE, and that is the whole design. `wipe_v1`..`wipe_v4` DROP
// every table and clear `meta`, which retires every device cookie and makes
// every player re-onboard and re-pick a username. Here identity SURVIVES:
// the account, the username, the avatar, the recovery code and every browser
// signed in to it are untouched, so a player opens the game and is still
// themselves, standing at the bottom of a ladder that has been reset.
//
// Two consequences are accepted deliberately rather than worked around:
//
//  - **It breaks "levels never regress"**, which is an invariant this
//    repository states in CLAUDE.md §7 and enforces everywhere else. Once, by
//    instruction, at a moment chosen for it.
//  - **Relocking achievements relocks content** -- the AI ladder above Rookie,
//    the longer winning scores, the earned cosmetics and titles. That needs no
//    new code because `playableDifficulty`/`playableWinningScore` already clamp
//    a stored setting down to what the profile has earned; it is asserted here
//    because it is the half somebody would otherwise discover as a 403.
//
// The CURATED ROSTER is deliberately exempt. Its eight rows are leaderboard
// furniture whose stats were seeded rather than earned, `bot_roster_v1` is
// already stamped so nothing would re-seed them, and zeroing them would leave
// the board showing eight accounts with nothing on them -- worse than either
// keeping or removing them. A bot's record is not a player's progress.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-progress-reset-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

const VETERAN = 'dev_veteran000000009';
const ROSTER = 'bot-reset-roster-01';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const raw = <T>(fn: (h: DatabaseSync) => T): T => {
  const h = new DatabaseSync(DB_FILE);
  try {
    return fn(h);
  } finally {
    h.close();
  }
};

const readOnly = <T>(fn: (h: DatabaseSync) => T): T => {
  const h = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    return fn(h);
  } finally {
    h.close();
  }
};

const playerRow = (id: string) =>
  readOnly(
    (h) =>
      h.prepare('SELECT * FROM players WHERE id = ?').get(id) as unknown as Record<string, unknown>
  );

const countIn = (table: string, where: string, bind: string) =>
  readOnly(
    (h) =>
      (h.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(bind) as { n: number }).n
  );

describe('progress_reset_v1 clears the ladder without clearing anybody', () => {
  let before: Record<string, unknown>;
  // Snapshotted in beforeAll, NOT read per test. `getProfile` writes on read
  // -- it runs updatePlayerStreak and normalizes the equipped cosmetic -- so
  // a later test calling it would repair `lastDailyDate` and `cosmetic` out
  // from under an earlier one's assertions, and the suite's answer would
  // depend on its own running order rather than on the migration.
  let after: Record<string, unknown>;

  beforeAll(async () => {
    // A veteran with a career on every axis the reset touches, written
    // directly so the fixture does not depend on how any of it is earned.
    db.getProfile(VETERAN);
    expect(db.initializeProfile(VETERAN, 'ResetVeteran').ok).toBe(true);
    // Roster furniture, seeded and never earned. Its own stats must survive.
    db.insertBot({
      id: ROSTER, username: 'ResetRoster', mu: 34, rankedGames: 40,
      matchesPlayed: 120, matchesWon: 80, xp: 9000, level: 14,
    });

    raw((h) => {
      h.prepare(
        `UPDATE players SET
           level = 42, xp = 51000, xpNext = 3000,
           mmrMu = 31.5, mmrSigma = 2.1, rankMu = 33.25, rankSigma = 1.9,
           rankedGames = 90, rankedDuels = 40,
           matchesPlayed = 300, matchesWon = 200, matchesLost = 100,
           highestRally = 140, totalPointsScored = 2400, totalAces = 90,
           multiplayerWins = 120, winStreak = 7, bestWinStreak = 19,
           shutoutsWon = 12, rookieWins = 30, proWins = 40, eliteWins = 20,
           cyberWins = 10, chaosWins = 4, abandons = 3,
           dailyStreak = 33, lastDailyDate = '2026-09-04',
           achievements = '["first_win","ai_pro","ai_pro_10","rally_150"]',
           cosmetic = 'legend-aurora', title = 'overlord'
         WHERE id = ?`
      ).run(VETERAN);
      h.prepare(
        `INSERT INTO matches (id, player1Id, player1Name, player2Id, player2Name,
           winnerId, winnerName, scoreP1, scoreP2, maxRally, mode, difficulty,
           timestamp, ranked, advancedLadder, rankedDuelCredited)
         VALUES ('m_reset_1', ?, 'ResetVeteran', 'AI-cyber', 'AI', ?, 'ResetVeteran',
           5, 0, 30, 'solo', 'cyber', '2026-09-04T00:00:00.000Z', 1, 1, 0)`
      ).run(VETERAN, VETERAN);
      h.prepare(
        `INSERT INTO player_mode_stats (playerId, mode, matchesPlayed, matchesWon,
           matchesLost, pointsScored, aces, bestStreak, currentStreak, streakAt,
           winStreak, bestWinStreak)
         VALUES (?, 'solo', 200, 150, 50, 1800, 60, 140, 12,
           '2026-09-04T00:00:00.000Z', 7, 19)`
      ).run(VETERAN);
      h.prepare(
        `INSERT INTO elite_completions (playerId, missionId, unlockId, completedAt)
         VALUES (?, 'elite_streak_10', 'unbroken', '2026-09-04T00:00:00.000Z')`
      ).run(VETERAN);
      h.prepare(
        `INSERT INTO recorded_matches (playerId, matchKey, recordedAt, result)
         VALUES (?, 'k_reset_1', '2026-09-04T00:00:00.000Z', '{}')`
      ).run(VETERAN);
      h.prepare(
        `INSERT INTO competitive_exposure (playerId, oppId, matchKey, at, day,
           oppIsBot, oppBand, duelCredited)
         VALUES (?, 'dev_other', 'k_reset_1', '2026-09-04T00:00:00.000Z',
           '2026-09-04', 0, 'master', 1)`
      ).run(VETERAN);
      // Identity, which must all survive.
      h.prepare('INSERT INTO avatars (playerId, data, updatedAt) VALUES (?, ?, ?)')
        .run(VETERAN, Buffer.from([1, 2, 3]), '2026-09-04T00:00:00.000Z');
      h.prepare('INSERT INTO device_links (deviceId, playerId, linkedAt) VALUES (?, ?, ?)')
        .run('dev_secondbrowser0001', VETERAN, '2026-09-04T00:00:00.000Z');
      // Un-stamp so the next boot runs it, since the constructor already has.
      h.prepare("DELETE FROM meta WHERE key = 'progress_reset_v1'").run();
    });

    before = playerRow(VETERAN);
    // A one-shot is INVISIBLE to a test that does not re-import: its key is
    // already in `meta` by the time this file runs, so nothing would drive it.
    vi.resetModules();
    const { db: booted } = await import('../server/db');
    void booted;
    after = playerRow(VETERAN);
  });

  it('zeroes both rating pairs and the counts the ladder is judged on', () => {
    const fresh = newRating();
    expect(after.mmrMu).toBeCloseTo(fresh.mu, 6);
    expect(after.mmrSigma).toBeCloseTo(fresh.sigma, 6);
    expect(after.rankMu).toBeCloseTo(fresh.mu, 6);
    expect(after.rankSigma).toBeCloseTo(fresh.sigma, 6);
    expect(after.rankedGames).toBe(0);
    expect(after.rankedDuels).toBe(0);
    // The precondition, or this passes on a fixture that was never rated.
    expect(before.rankMu).toBe(33.25);
    expect(before.rankedGames).toBe(90);
    // And the player is UNPLACED again, which is what the badge reads.
    expect(db.getProfile(VETERAN).tier).toBe('unranked');
    expect(Number(after.rankedGames)).toBeLessThan(PLACEMENT_GAMES);
  });

  it('zeroes every career counter, and the fixture had a value in each', () => {
    const zeroed = [
      'matchesPlayed', 'matchesWon', 'matchesLost', 'highestRally',
      'totalPointsScored', 'totalAces', 'multiplayerWins', 'winStreak',
      'bestWinStreak', 'shutoutsWon', 'rookieWins', 'proWins', 'eliteWins',
      'cyberWins', 'chaosWins', 'abandons',
    ];
    for (const key of zeroed) {
      // Both halves in one assertion so a column that was never seeded cannot
      // pass as a column that was correctly cleared.
      expect({ key, was: Number(before[key]) > 0, now: after[key] }).toEqual({
        key, was: true, now: 0,
      });
    }
  });

  it('takes XP, level and the daily streak back to a first-load account', () => {
    expect({ level: after.level, xp: after.xp }).toEqual({ level: 1, xp: 0 });
    expect(Number(after.xpNext)).toBeGreaterThan(0);
    // The one invariant this migration knowingly breaks -- CLAUDE.md §7 says
    // levels never regress, and this is the once it does.
    expect(Number(before.level)).toBeGreaterThan(1);
    // A streak of consecutive active days is a statistic like any other, and
    // it gates daily_3 / streak_7 / daily_30 / daily_100 besides.
    expect(after.dailyStreak).toBe(1);
    expect(after.lastDailyDate).toBe('');
  });

  it('relocks achievements and the permanent unlocks they gate', () => {
    expect(after.achievements).toBe('[]');
    // Cosmetics and titles are EARNED, so "everything earned" includes them --
    // and leaving `legend-aurora` equipped would paint a look the picker no
    // longer offers, on an account that no longer holds the tier.
    expect(after.cosmetic).toBe(null);
    expect(after.title).toBe(null);
    // The elite ledger is the other half: it is deliberately not day-keyed,
    // so a surviving row hands back a theme the achievements no longer gate.
    expect(countIn('elite_completions', 'playerId = ?', VETERAN)).toBe(0);
  });

  it('clears history, mode stats, exposure and the idempotency ledger', () => {
    expect(countIn('matches', 'player1Id = ?', VETERAN)).toBe(0);
    expect(countIn('player_mode_stats', 'playerId = ?', VETERAN)).toBe(0);
    expect(countIn('competitive_exposure', 'playerId = ?', VETERAN)).toBe(0);
    // Stamps for matches that no longer exist would answer a replay with
    // `alreadyRecorded` for a match this account is no longer credited with.
    expect(countIn('recorded_matches', 'playerId = ?', VETERAN)).toBe(0);
  });

  it('leaves IDENTITY completely alone, which is what makes it not a wipe', () => {
    for (const key of ['id', 'username', 'createdAt', 'recoveryCode', 'initializedAt', 'usernameChangedAt']) {
      expect({ key, value: after[key] }).toEqual({ key, value: before[key] });
    }
    // The avatar and every browser signed in to the account survive with it.
    expect(countIn('avatars', 'playerId = ?', VETERAN)).toBe(1);
    expect(countIn('device_links', 'playerId = ?', VETERAN)).toBe(1);
    // And the account is still initialized, so nobody re-onboards and no
    // username goes back into the pool -- the whole difference from a wipe.
    expect(db.getProfile(VETERAN).initializedAt).toBeTruthy();
    expect(db.isUsernameAvailable('ResetVeteran')).toBe(false);
  });

  it('exempts the curated roster, so the board is not left showing zeros', () => {
    const bot = playerRow(ROSTER);
    expect(bot.rankedGames).toBe(40);
    expect(Number(bot.rankMu)).toBeCloseTo(34, 6);
    expect(Number(bot.matchesPlayed)).toBeGreaterThan(0);
  });

  it('runs once, and a second boot does not re-clear a rebuilt career', async () => {
    // The point of the meta flag. Without it every deploy would reset the
    // ladder again, which is the failure mode that makes a one-shot a one-shot.
    raw((h) => h.prepare('UPDATE players SET rankedGames = 7, xp = 900 WHERE id = ?').run(VETERAN));
    vi.resetModules();
    const { db: again } = await import('../server/db');
    void again;
    const after = playerRow(VETERAN);
    expect({ rankedGames: after.rankedGames, xp: after.xp }).toEqual({ rankedGames: 7, xp: 900 });
  });
});
