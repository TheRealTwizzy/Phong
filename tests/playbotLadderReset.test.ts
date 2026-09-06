import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { START_MU, START_SIGMA } from '../src/rating';

// The one-shot playbot_ladder_reset_v1 migration.
//
// The play-bot population arrived on the ladder through five pieces of broken
// wiring, and what it built while they were broken is not a measurement of
// anything: with the queue blind to pair history and a bot's action a lifelong
// constant, the account at the top had placed off five games against ONE
// opponent -- and placement moves 4.21 mu on the first of those, so five wins
// is Grandmaster. Fixing the wiring does not un-rank what it produced,
// because the ratings have converged and there is nothing to converge back
// toward.
//
// So the LADDER is reset and nothing else is. The line is: what decides where
// a bot stands, plus the windows that are evidence about it. XP, level,
// achievements, history and identity all describe play that really happened
// against real opponents, and zeroing `matchesPlayed` while keeping the level
// would put "level 5, 0 matches" on a public profile card.
//
// A one-shot rather than a wipe: it does not clear `meta`, does not touch
// `auth_secret`, and retires nobody's device cookie.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-playbot-ladder-reset-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

/** A drivable play-bot: a marker row WITH a credential. */
const BOT = { id: 'dev_playbot000000001', username: 'RiverKeeper', cookie: 'cookie-1' };
/** Curated roster furniture: a marker row with NO credential. Not drivable. */
const FURNITURE = { id: 'bot-ladder-01', username: 'CircuitPup', cookie: null };
/** An ordinary person, whose everything must survive untouched. */
const HUMAN = { id: 'dev_human0000000001', username: 'Trenton' };

function seedLegacyDatabase() {
  const sql = new DatabaseSync(DB_FILE);
  sql.exec(`
    CREATE TABLE players (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      level INTEGER NOT NULL,
      xp INTEGER NOT NULL,
      xpNext INTEGER NOT NULL,
      eloRating INTEGER,
      matchesPlayed INTEGER NOT NULL,
      matchesWon INTEGER NOT NULL,
      matchesLost INTEGER NOT NULL,
      highestRally INTEGER NOT NULL,
      totalPointsScored INTEGER NOT NULL,
      totalAces INTEGER NOT NULL,
      dailyStreak INTEGER NOT NULL,
      lastDailyDate TEXT NOT NULL,
      achievements TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      lastActive TEXT NOT NULL,
      initializedAt TEXT,
      usernameChangedAt TEXT,
      rankTitle TEXT,
      mmrMu REAL, mmrSigma REAL, rankMu REAL, rankSigma REAL,
      rankedGames INTEGER, rankedDuels INTEGER
    );
    CREATE TABLE bot_accounts (
      botId TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL,
      deviceCookie TEXT,
      skill REAL, volatility REAL, aggression REAL, spinRead REAL, rankedBias REAL,
      queueAppetite REAL, hostAppetite REAL, joinAppetite REAL, rematchAppetite REAL
    );
    CREATE TABLE matches (
      id TEXT PRIMARY KEY,
      player1Id TEXT NOT NULL, player1Name TEXT NOT NULL,
      player2Id TEXT NOT NULL, player2Name TEXT NOT NULL,
      winnerId TEXT NOT NULL, winnerName TEXT NOT NULL,
      scoreP1 INTEGER NOT NULL, scoreP2 INTEGER NOT NULL,
      maxRally INTEGER NOT NULL, mode TEXT NOT NULL,
      difficulty TEXT, timestamp TEXT NOT NULL,
      ranked INTEGER
    );
    CREATE TABLE competitive_exposure (
      playerId     TEXT NOT NULL,
      oppId        TEXT NOT NULL,
      matchKey     TEXT NOT NULL,
      at           TEXT NOT NULL,
      day          TEXT NOT NULL,
      oppIsBot     INTEGER NOT NULL,
      oppBand      TEXT NOT NULL,
      duelCredited INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (playerId, matchKey)
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const now = '2026-02-01T00:00:00.000Z';
  const player = sql.prepare(
    `INSERT INTO players VALUES (?, ?, ?, ?, 400, NULL, ?, 7, 5, 41, 60, 2, 1, ?, ?, ?, ?, ?, NULL, NULL,
       ?, ?, ?, ?, ?, ?)`
  );
  // A career on the ladder: placed, rated, and a long way from the start.
  player.run(BOT.id, BOT.username, 5, 900, 12, now, '["first_win","duel_10"]', now, now, now,
    32, 2.1, 33.4, 2.4, 20, 30);
  player.run(FURNITURE.id, FURNITURE.username, 9, 4000, 44, now, '["first_win"]', now, now, now,
    31, 1, 31, 1, 5, 5);
  player.run(HUMAN.id, HUMAN.username, 6, 1500, 18, now, '["first_win"]', now, now, now,
    29.5, 2.2, 29.1, 2.3, 20, 22);

  const bot = sql.prepare(
    `INSERT INTO bot_accounts VALUES (?, ?, ?, 0.61, 0.03, 0.42, 0.5, 0.77, 0.2, 0.9, 0.4, 0.55)`
  );
  bot.run(BOT.id, now, BOT.cookie);
  bot.run(FURNITURE.id, now, FURNITURE.cookie);

  // One duel, filed twice — every seat files its OWN row.
  const m = sql.prepare(
    `INSERT INTO matches VALUES (?, ?, ?, ?, ?, ?, ?, 5, 3, 9, 'multiplayer', NULL, ?, 1)`
  );
  m.run('m-bot', BOT.id, BOT.username, HUMAN.id, HUMAN.username, BOT.id, BOT.username, now);
  m.run('m-human', HUMAN.id, HUMAN.username, BOT.id, BOT.username, BOT.id, BOT.username, now);

  // ...and one exposure row per participant, which is how the saturation
  // ladders count. Both directions exist for an ordinary match.
  const e = sql.prepare(`INSERT INTO competitive_exposure VALUES (?, ?, ?, ?, ?, ?, ?, 1)`);
  e.run(BOT.id, HUMAN.id, 'k1', now, '2026-02-01', 0, 'ace');
  e.run(HUMAN.id, BOT.id, 'k1', now, '2026-02-01', 1, 'grandmaster');

  const stamp = sql.prepare('INSERT INTO meta VALUES (?, ?)');
  // Every destructive key, so the fixture is not deleted before a single
  // assertion runs -- catalogue shape 12, and `progress_reset_v1` is the one
  // that bites here because it runs LAST and clears `matches` wholesale.
  // `roster_retire_v1` is on the list because it DELETES every cookieless
  // bot_accounts row, which is the furniture fixture below -- and the whole
  // point of that fixture is to prove this migration keys on the credential
  // rather than on an id prefix.
  for (const key of [
    'wipe_v1', 'wipe_v2', 'wipe_v3', 'wipe_v4', 'progress_reset_v1', 'roster_retire_v1',
  ])
    stamp.run(key, now);
  sql.close();
}

seedLegacyDatabase();

const read = <T>(fn: (h: DatabaseSync) => T): T => {
  const h = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    return fn(h);
  } finally {
    h.close();
  }
};

const row = (id: string): Record<string, number | string> =>
  read((h) => h.prepare('SELECT * FROM players WHERE id = ?').get(id)) as never;

const exposureOf = (id: string): number =>
  read(
    (h) =>
      (h.prepare('SELECT COUNT(*) AS n FROM competitive_exposure WHERE playerId = ?').get(id) as {
        n: number;
      }).n
  );

const matchesFiledBy = (id: string): number =>
  read(
    (h) =>
      (h.prepare('SELECT COUNT(*) AS n FROM matches WHERE player1Id = ?').get(id) as { n: number }).n
  );

beforeAll(async () => {
  // Importing runs `migrateSchema`, which is what drives the one-shot. The key
  // is deliberately absent from the seed above; a suite that stamped it would
  // drive nothing and a mutation to the SQL would redden nothing.
  await import('../server/db');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('playbot_ladder_reset_v1', () => {
  it('puts a drivable play-bot back at the start of the ladder', () => {
    const r = row(BOT.id);
    expect(r.rankMu).toBe(START_MU);
    expect(r.rankSigma).toBe(START_SIGMA);
    expect(r.mmrMu).toBe(START_MU);
    expect(r.mmrSigma).toBe(START_SIGMA);
    expect(r.rankedGames).toBe(0);
    expect(r.rankedDuels).toBe(0);
  });

  it('clears the windows that are evidence about that ladder', () => {
    // The pair, band and day counters are all read off this table, and a
    // surviving row is a saturation window about matches that no longer count.
    expect(exposureOf(BOT.id)).toBe(0);
  });

  it('keeps everything that is not the ladder', () => {
    // The play HAPPENED, against real opponents, through a relay that vouched
    // every result from room state it owned. XP and the level are what that
    // play earned and they do not regress; the history row is the record of
    // it; and the achievements it opened stay open, which is the call §7
    // already makes for a solo-farmed Overlord held back to Legend.
    const r = row(BOT.id);
    expect(r.xp).toBe(900);
    expect(r.level).toBe(5);
    expect(r.matchesPlayed).toBe(12);
    expect(r.username).toBe(BOT.username);
    expect(r.achievements).toBe('["first_win","duel_10"]');
    expect(matchesFiledBy(BOT.id)).toBe(1);
  });

  it('leaves the traits alone, because creation seeds and nothing steers', () => {
    const t = read((h) =>
      h.prepare('SELECT skill, rankedBias, hostAppetite FROM bot_accounts WHERE botId = ?').get(BOT.id)
    ) as { skill: number; rankedBias: number; hostAppetite: number };
    expect(t).toEqual({ skill: 0.61, rankedBias: 0.77, hostAppetite: 0.9 });
  });

  it('does not touch a HUMAN, on either side of the delete', () => {
    // The half that catches a symmetric `OR oppId IN (bots)`. That spelling
    // reads as tidy and would erase every human's §2.3 pair count, §2.4 band
    // count and §2.5 daily count against the whole population -- handing all
    // of them fresh unsaturated weight against every bot on the server.
    const r = row(HUMAN.id);
    expect(r.rankMu).toBe(29.1);
    expect(r.rankedGames).toBe(20);
    expect(r.rankedDuels).toBe(22);
    expect(exposureOf(HUMAN.id)).toBe(1);
    // And their own filed row for a match they really played, which a
    // `player2Id IN (bots)` delete would take out of their history while
    // their career counters went on counting it.
    expect(matchesFiledBy(HUMAN.id)).toBe(1);
  });

  it('does not touch the curated roster, which has no career to reset', () => {
    // Keyed on `deviceCookie IS NOT NULL`, the schema's own discriminator
    // between furniture and a drivable play-bot -- never on an id prefix,
    // which is the classifier D26 retired.
    const r = row(FURNITURE.id);
    expect(r.rankMu).toBe(31);
    expect(r.rankedGames).toBe(5);
  });

  it('stamps itself, so a second boot is a no-op', () => {
    expect(
      read((h) => h.prepare(`SELECT value FROM meta WHERE key = ?`).get('playbot_ladder_reset_v1'))
    ).toBeTruthy();
  });
});
