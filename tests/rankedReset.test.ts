import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { newRating, PLACEMENT_GAMES } from '../src/rating';
import { BOT_ROSTER } from '../server/bots';
import type { MatchEndPayload } from '../src/types';

// The one-shot ranked_reset_v1 migration. A run of rating exploits wrote real
// ratings nobody played for, and `matches` stores no pre-match rating, no
// opponent rating, no venue and no rules — so there is nothing to recompute
// from. The ladder starts over; everything else stays exactly where it was.
//
// The case this suite exists for is the SECOND one. seedBotRoster is one-shot
// behind bot_roster_v1 and runs after these migrations, so on any database
// that has booted once a blanket UPDATE flattens the eight curated ladder bots
// to unranked with nothing left to re-seed them.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-ranked-reset-test-'));
process.env.DATA_DIR = TMP;

const DB_FILE = path.join(TMP, 'phong.db');
const START = newRating();

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let mod: typeof import('../server/db');

const duel = (playerId: string, i: number, isWinner: boolean): MatchEndPayload => ({
  playerId,
  username: 'ignored',
  playerScore: isWinner ? 5 : 2,
  opponentScore: isWinner ? 2 : 5,
  bestStreak: 12, endStreak: 0, earnedStreak: 12,
  mode: 'multiplayer',
  isWinner,
  matchKey: `${playerId}:pvp:${i}`,
});

const init = (id: string, username: string) => {
  mod.db.getProfile(id);
  const res = mod.db.initializeProfile(id, username);
  if (!res.ok) throw new Error(`init failed: ${res.code}`);
};

/** Un-stamp the flag so the next boot runs the migration again. */
function armMigration() {
  const raw = new DatabaseSync(DB_FILE);
  raw.prepare('DELETE FROM meta WHERE key = ?').run('ranked_reset_v1');
  raw.close();
}

async function reboot() {
  vi.resetModules();
  mod = await import('../server/db');
}

beforeAll(async () => {
  mod = await import('../server/db');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('ranked_reset_v1', () => {
  it('puts a rated player back to placement without touching anything else', async () => {
    init('dev_rated_aaaaaaaaaaaaa', 'Climber');
    for (let i = 0; i < PLACEMENT_GAMES + 3; i++) {
      mod.db.recordMatch(duel('dev_rated_aaaaaaaaaaaaa', i, i % 3 !== 0));
    }

    const before = mod.db.getProfile('dev_rated_aaaaaaaaaaaaa');
    expect(before.tier).not.toBe('unranked');
    expect(before.rankedGames).toBeGreaterThanOrEqual(PLACEMENT_GAMES);
    expect(before.xp).toBeGreaterThan(0);
    // Non-vacuous: there is something in each of these to lose.
    expect(before.achievements.length).toBeGreaterThan(0);
    const historyBefore = mod.db.getMatchHistory('dev_rated_aaaaaaaaaaaaa').length;
    expect(historyBefore).toBeGreaterThan(0);

    armMigration();
    await reboot();

    const after = mod.db.getProfile('dev_rated_aaaaaaaaaaaaa');
    // The ladder is back to a standing start, on BOTH estimators.
    expect(after.rankMu).toBeCloseTo(START.mu, 6);
    expect(after.rankSigma).toBeCloseTo(START.sigma, 6);
    expect(after.mmrMu).toBeCloseTo(START.mu, 6);
    expect(after.mmrSigma).toBeCloseTo(START.sigma, 6);
    expect(after.rankedGames).toBe(0);
    expect(after.tier).toBe('unranked');

    // ...and nothing that was actually earned went with it.
    expect(after.username).toBe(before.username);
    expect(after.xp).toBe(before.xp);
    expect(after.level).toBe(before.level);
    expect(after.matchesPlayed).toBe(before.matchesPlayed);
    expect(after.matchesWon).toBe(before.matchesWon);
    expect(after.highestRally).toBe(before.highestRally);
    expect([...after.achievements].sort()).toEqual([...before.achievements].sort());
    expect(mod.db.getMatchHistory('dev_rated_aaaaaaaaaaaaa').length).toBe(historyBefore);
  });

  it('leaves the curated bot roster on the ladder', async () => {
    // Production's exact state: the roster is seeded and its flag is stamped,
    // so nothing will ever seed it again. A reset that swept the bots up would
    // take the whole leaderboard down with it, permanently.
    mod.db.seedBotRoster(BOT_ROSTER);
    const top = BOT_ROSTER[BOT_ROSTER.length - 1];
    expect(mod.db.getProfile(top.id).rankMu).toBeCloseTo(top.mu, 6);

    armMigration();
    await reboot();

    for (const bot of BOT_ROSTER) {
      const row = mod.db.getProfile(bot.id);
      expect(row.rankMu).toBeCloseTo(bot.mu, 6);
      expect(row.rankedGames).toBeGreaterThanOrEqual(PLACEMENT_GAMES);
      expect(row.tier).not.toBe('unranked');
    }
  });

  it('runs exactly once, so a rating earned afterwards is never re-reset', async () => {
    // Someone who placed again after the reset must keep what they played for.
    for (let i = 0; i < PLACEMENT_GAMES; i++) {
      mod.db.recordMatch(duel('dev_rated_aaaaaaaaaaaaa', 100 + i, true));
    }
    const replaced = mod.db.getProfile('dev_rated_aaaaaaaaaaaaa');
    expect(replaced.rankedGames).toBe(PLACEMENT_GAMES);
    expect(replaced.rankMu).toBeGreaterThan(START.mu);

    await reboot(); // no armMigration() — the flag still stands

    const kept = mod.db.getProfile('dev_rated_aaaaaaaaaaaaa');
    expect(kept.rankMu).toBeCloseTo(replaced.rankMu, 6);
    expect(kept.rankedGames).toBe(PLACEMENT_GAMES);
    expect(mod.db.getMeta('ranked_reset_v1')).toBeTruthy();
  });
});
