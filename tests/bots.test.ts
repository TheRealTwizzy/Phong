import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BOT_ROSTER, botProfileFields } from '../server/bots';
import { validateUsername } from '../src/profileRules';
import { PLACEMENT_GAMES, START_MU, START_SIGMA } from '../src/rating';

// The play-bot roster.
//
// It used to be a table of hand-written CAREERS — pre-placed rows that gave an
// empty leaderboard a scale — and what this suite pinned was that the fiction
// stayed self-consistent: every column rising with the rating, so a Legend
// never had a losing record. That whole class of assertion is gone, because
// the fiction is gone. A play-bot starts where a person starts and earns its
// row, so there is no fabricated number left to keep consistent.
//
// What is pinned now is the opposite property: that NOTHING is handed over.

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

describe('the play-bot roster as data', () => {
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

  it('hands a bot nothing it has not played for', () => {
    // The rule the old roster broke by existing. A seeded bot is a brand-new
    // account: opening rating, no ranked games, and a career of zeros. Its
    // STRENGTH is fixed and hidden (trueSkillForBot); its RATING is what the
    // ladder discovers, which is the whole reason it starts unplaced.
    for (const bot of BOT_ROSTER) {
      const f = botProfileFields(bot) as Record<string, number | string>;
      expect(f.mu, bot.username).toBe(START_MU);
      expect(f.rankSigma, bot.username).toBe(START_SIGMA);
      expect(f.rankedGames, bot.username).toBe(0);
      expect(f.rankedDuels, bot.username).toBe(0);
      for (const column of [
        'xp', 'matchesPlayed', 'matchesWon', 'matchesLost',
        'highestRally', 'totalPointsScored', 'multiplayerWins',
      ]) {
        expect(f[column], `${bot.username}.${column}`).toBe(0);
      }
    }
  });

  it('carries no career column that could contradict itself', () => {
    // The old table needed four columns kept in step by hand and a test to
    // notice when they drifted. A seed with nothing in it cannot drift, and
    // this is what stops one being added back without the reasoning above
    // being read again.
    for (const bot of BOT_ROSTER) {
      expect(Object.keys(bot).sort(), bot.username).toEqual(['id', 'username']);
    }
  });

  it('is big enough to spread across the ladder once it has placed', () => {
    // The strength spread needs bots in most tier bands to look like a
    // population rather than a handful of outliers.
    expect(BOT_ROSTER.length).toBeGreaterThanOrEqual(12);
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

    // A freshly seeded bot is on the board from the first boot, with nothing
    // played — bots keep their exemption from the rows-of-zeros filter, which
    // is what stops a launched deployment opening on an empty list. What it
    // no longer carries is a fabricated CAREER to go with the row.
    const withBots = db.getLeaderboard('elo', 50, true);
    const bots = withBots.filter((e) => e.isBot);
    expect(bots.length).toBe(BOT_ROSTER.length);
    expect(bots.every((b) => b.rank === null)).toBe(true);
    // And every one is UNRANKED with nothing played: a bot climbs out of
    // Unranked exactly the way a person does rather than on arrival.
    expect(bots.every((b) => b.tier === 'unranked')).toBe(true);
    expect(bots.every((b) => b.rankedGames < PLACEMENT_GAMES)).toBe(true);

    const human = withBots.find((e) => e.id === 'dev_111111111111111111');
    const humanOnly = db.getLeaderboard('elo', 50, false);
    expect(humanOnly.some((e) => e.isBot)).toBe(false);
    expect(human?.rank).toBe(humanOnly.find((e) => e.id === 'dev_111111111111111111')?.rank);
  });

  it('resets bots that an older build seeded with a career', async () => {
    // The migration this key exists for. A deployment that already ran
    // `bot_roster_v1` holds pre-placed rows with hand-written careers — a mu, a
    // win record, a real tier — none of which those accounts played for. Left
    // alone they would sit on the board beside bots that earned their rung, on
    // the same screen and indistinguishable.
    const db = await freshDb();
    db.insertBot({
      id: 'bot-ladder-01', username: 'CircuitPup',
      mu: 35, xp: 27700, matchesPlayed: 231, matchesWon: 158,
      highestRally: 43, totalPointsScored: 1056, rankedDuels: 231,
    });
    const legacy = db.getProfile('bot-ladder-01');
    expect(legacy.tier).not.toBe('unranked');
    expect(legacy.matchesPlayed).toBe(231);

    const result = db.seedBotRoster(BOT_ROSTER);
    expect(result.reset).toBeGreaterThan(0);

    const after = db.getProfile('bot-ladder-01');
    expect(after.tier).toBe('unranked');
    expect(after.rankedGames).toBe(0);
    expect(after.matchesPlayed).toBe(0);
    expect(after.xp).toBe(0);
    expect(after.rankMu).toBe(START_MU);
    expect(after.rankSigma).toBe(START_SIGMA);
    // Its NAME survives — the account is the same account, it has simply
    // stopped claiming a career it never had.
    expect(after.username).toBe('CircuitPup');
  });

  it('never wipes a ladder a bot has since played its way to', async () => {
    // The flag is what makes the reset safe to ship: it runs once. A second
    // boot must not take back the rating a bot has earned since, which would
    // make every restart a silent demotion for the whole population.
    const db = await freshDb();
    db.seedBotRoster(BOT_ROSTER);
    db.recordMatch({
      playerId: 'bot-ladder-01', username: 'CircuitPup',
      opponentId: 'bot-ladder-02', opponentName: 'StaticDrift',
      playerScore: 5, opponentScore: 2, bestStreak: 4, endStreak: 4, earnedStreak: 4,
      mode: 'multiplayer', isWinner: true, matchKey: 'bot-earned-1',
    } as any);
    const earned = db.getProfile('bot-ladder-01');
    expect(earned.rankedGames).toBe(1);

    const second = db.seedBotRoster(BOT_ROSTER);
    expect(second.reset).toBe(0);
    expect(db.getProfile('bot-ladder-01').rankedGames).toBe(1);
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
    // The human keeps the name, and the rest of the roster still landed.
    expect(db.getLeaderboard('elo', 50, true).filter((e) => e.isBot).length)
      .toBe(BOT_ROSTER.length - 1);
  });
});
