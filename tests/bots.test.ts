import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BOT_ROSTER } from '../server/bots';
import { validateUsername } from '../src/profileRules';
import { levelFromXp, tierFor } from '../src/rating';

// The leaderboard's pace-setters.
//
// A launched deployment has no players and the boards refuse rows of zeros,
// so the first person to open the leaderboard met an empty list. The roster
// answers that — but a hand-written table of fake careers rots quietly: one
// edit and a Legend has a losing record, or a bot sits at the summit that
// nobody can ever displace. Those are the properties pinned here, not the
// numbers themselves, so the table can be retuned freely.

const dirs: string[] = [];
/** A database nobody else has touched — DATA_DIR is read at module load. */
async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-bots-'));
  dirs.push(dir);
  process.env.DATA_DIR = dir;
  vi.resetModules();
  return (await import('../server/db')).db;
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const winRate = (b: (typeof BOT_ROSTER)[number]) => b.matchesWon / b.matchesPlayed;

describe('the bot roster as data', () => {
  it('uses bot- ids and real, unique, claimable usernames', () => {
    const ids = BOT_ROSTER.map((b) => b.id);
    expect(ids.every((id) => id.startsWith('bot-'))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    for (const bot of BOT_ROSTER) {
      // Same rules a human's name obeys: a roster name occupies the same
      // unique index, so one the validator would reject could never be typed
      // by a player but would still sit in their namespace.
      expect(validateUsername(bot.username), bot.username).toEqual({ ok: true });
    }
    const lower = BOT_ROSTER.map((b) => b.username.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it('reads as a ladder: every column rises with the rating', () => {
    for (let i = 1; i < BOT_ROSTER.length; i++) {
      const prev = BOT_ROSTER[i - 1];
      const cur = BOT_ROSTER[i];
      const where = `${prev.username} -> ${cur.username}`;
      expect(cur.mu, where).toBeGreaterThan(prev.mu);
      expect(winRate(cur), where).toBeGreaterThan(winRate(prev));
      expect(levelFromXp(cur.xp).level, where).toBeGreaterThan(levelFromXp(prev.xp).level);
      expect(cur.highestRally, where).toBeGreaterThan(prev.highestRally);
    }
  });

  it('cannot claim more wins than matches', () => {
    for (const b of BOT_ROSTER) {
      expect(b.matchesWon, b.username).toBeLessThanOrEqual(b.matchesPlayed);
      expect(b.matchesWon, b.username).toBeGreaterThan(0);
    }
  });

  it('spans the ladder but leaves the summit to a human', () => {
    // A roster row's whole career is duels, so the duel count is its matches.
    const tiers = BOT_ROSTER.map((b) => tierFor(b.mu, b.matchesPlayed, 1.0, b.matchesPlayed));
    expect(new Set(tiers).size).toBeGreaterThanOrEqual(5);
    // The top rung is the board's most motivating slot. A bot parked there
    // makes it decorative, so nothing in the roster may reach it.
    expect(tiers).not.toContain('overlord');
    expect(tiers).not.toContain('unranked');
  });
});

describe('seeding', () => {
  it('seeds once and is a no-op forever after', async () => {
    const db = await freshDb();
    const first = db.seedBotRoster(BOT_ROSTER);
    expect(first.inserted).toBe(BOT_ROSTER.length);
    expect(first.skipped).toEqual([]);

    // A restart must not resurrect a bot an operator deleted on purpose.
    const second = db.seedBotRoster(BOT_ROSTER);
    expect(second.inserted).toBe(0);
  });

  it('lands bots on the board with null ranks, leaving human ranks alone', async () => {
    const db = await freshDb();
    db.seedBotRoster(BOT_ROSTER);
    db.getProfile('dev_111111111111111111');
    db.initializeProfile('dev_111111111111111111', 'RealPlayer');
    db.recordMatch({
      playerId: 'dev_111111111111111111', username: 'RealPlayer',
      playerScore: 5, opponentScore: 2, bestStreak: 6, endStreak: 0, earnedStreak: 6, mode: 'multiplayer', isWinner: true,
    } as any);

    const withBots = db.getLeaderboard('elo', 50, true);
    const bots = withBots.filter((e) => e.isBot);
    expect(bots.length).toBe(BOT_ROSTER.length);
    expect(bots.every((b) => b.rank === null)).toBe(true);

    const human = withBots.find((e) => e.id === 'dev_111111111111111111');
    const humanOnly = db.getLeaderboard('elo', 50, false);
    expect(humanOnly.some((e) => e.isBot)).toBe(false);
    expect(human?.rank).toBe(humanOnly.find((e) => e.id === 'dev_111111111111111111')?.rank);
  });

  it('skips a name a human already holds instead of failing the boot', async () => {
    const db = await freshDb();
    const taken = BOT_ROSTER[2].username;
    db.getProfile('dev_222222222222222222');
    db.initializeProfile('dev_222222222222222222', taken);

    // The username index is unique and case-insensitive, so this insert
    // throws. A roster is not worth taking a deployment down for.
    const result = db.seedBotRoster(BOT_ROSTER);
    expect(result.inserted).toBe(BOT_ROSTER.length - 1);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]).toContain(taken);
    // The human keeps the name, and the rest of the ladder still landed.
    expect(db.getLeaderboard('elo', 50, true).filter((e) => e.isBot).length)
      .toBe(BOT_ROSTER.length - 1);
  });
});
