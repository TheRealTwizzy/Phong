import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

// The one-shot roster_retire_v1 migration.
//
// `server/bots.ts` seeded eight accounts with fabricated careers — CircuitPup
// through ObsidianArc — because a launched deployment had no players and the
// boards deliberately refuse rows of zeros, so the first person to open the
// leaderboard saw an empty list. Play-bots now do that job with records they
// actually earned, so the furniture is removed rather than hidden: eight
// accounts with invented match counts, reachable through the public profile
// route, are worse than an honest short board.
//
// It goes through `db.deleteAccount` rather than a bare DELETE, because that
// is the function that walks PLAYER_KEYED_TABLES and clears `device_links` in
// both directions — a surviving link row reads as `superseded` in
// `resolveSession`, which is a full-screen wall about an account that is live
// nowhere. `wipe_v1` shipped without dropping that table and learned it the
// same way.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-roster-retire-test-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

const FURNITURE = 'bot-ladder-01';
const PLAYBOT = 'dev_playbot000000001';
const HUMAN = 'dev_human0000000001';

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
      rankTitle TEXT
    );
    CREATE TABLE bot_accounts (
      botId TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL,
      deviceCookie TEXT,
      skill REAL, volatility REAL, aggression REAL, spinRead REAL, rankedBias REAL,
      queueAppetite REAL, hostAppetite REAL, joinAppetite REAL, rematchAppetite REAL
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const now = '2026-02-01T00:00:00.000Z';
  const player = sql.prepare(
    `INSERT INTO players VALUES (?, ?, 9, 2900, 400, NULL, 24, 8, 16, 9, 104, 3, 1, ?, '[]', ?, ?, ?, NULL)`
  );
  player.run(FURNITURE, 'CircuitPup', now, now, now, now);
  player.run(PLAYBOT, 'mia_ruiz', now, now, now, now);
  player.run(HUMAN, 'Human', now, now, now, now);

  const bot = sql.prepare(
    `INSERT INTO bot_accounts VALUES (?, ?, ?, 0.6, 0.03, 0.4, 0.5, 0.8, 0.2, 0.9, 0.4, 0.5)`
  );
  // The discriminator: furniture carries NO credential, a play-bot does.
  bot.run(FURNITURE, now, null);
  bot.run(PLAYBOT, now, 'cookie-1');

  const stamp = sql.prepare('INSERT INTO meta VALUES (?, ?)');
  for (const key of ['wipe_v1', 'wipe_v2', 'wipe_v3', 'wipe_v4', 'progress_reset_v1'])
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

const countIn = (table: string, col: string, id: string): number =>
  read(
    (h) =>
      (h.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(id) as { n: number }).n
  );

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let isBotAccount: typeof import('../server/db').isBotAccount;

beforeAll(async () => {
  ({ db, isBotAccount } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('roster_retire_v1', () => {
  it('removes the curated furniture', () => {
    expect(db).toBeTruthy();
    expect(countIn('players', 'id', FURNITURE)).toBe(0);
  });

  it('clears the bot_accounts row too', () => {
    // `deleteAccount` walks PLAYER_KEYED_TABLES and `bot_accounts` is keyed
    // `botId`, deliberately NOT `playerId` — a playerId column there would
    // drag roster rows onto a human's device on sign-in, which is what
    // tests/identity.test.ts walks the live schema to prevent. So it is not in
    // that list and the migration has to clear it by hand.
    expect(countIn('bot_accounts', 'botId', FURNITURE)).toBe(0);
  });

  it('leaves the in-memory classifier agreeing with the table', () => {
    // The cache is derived state with a lifecycle rule: after any COMMITTED
    // mutation it must equal the table. A stale id left in the Set makes
    // `isBotAccount` answer true for an account that no longer exists — and
    // since it is the sole authoritative classifier, nothing else could
    // notice.
    expect(isBotAccount(FURNITURE)).toBe(false);
    expect(isBotAccount(PLAYBOT)).toBe(true);
  });

  it('spares a drivable play-bot', () => {
    // Keyed on `deviceCookie IS NOT NULL` — the same test `playbotAccounts()`
    // asks — and never on the `bot-` id prefix, which is D26's retired
    // classifier. Both rows are bots; only one is furniture.
    expect(countIn('players', 'id', PLAYBOT)).toBe(1);
    expect(countIn('bot_accounts', 'botId', PLAYBOT)).toBe(1);
  });

  it('spares humans', () => {
    expect(countIn('players', 'id', HUMAN)).toBe(1);
  });

  it('returns the furniture usernames to the pool', () => {
    expect(
      read(
        (h) =>
          (h.prepare('SELECT COUNT(*) AS n FROM players WHERE username = ?').get('CircuitPup') as {
            n: number;
          }).n
      )
    ).toBe(0);
  });

  it('is stamped, so a second boot deletes nothing again', () => {
    expect(read((h) => h.prepare('SELECT value FROM meta WHERE key = ?').get('roster_retire_v1')))
      .toBeTruthy();
  });
});
