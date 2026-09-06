import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { PLAYBOT_NAMES } from '../server/playbotNames';

// The one-shot playbot_names_v1 migration.
//
// Play-bots were provisioned as `Rally01Bot`...`RallyNNBot`, and that name
// disclosed on every surface a name reaches — the in-match opponent label, the
// lobby, the result strip, the denormalized names in match history — none of
// which carries the BOT badge. Human-looking handles take that away, so the
// shared robot avatar becomes the tell instead. A build that renames only
// bots provisioned AFTER the change does nothing for a live server, which is
// entirely populated by the old ones.
//
// It cannot go through `db.changeUsername` (365-day lock) and it cannot go
// through `server/moderate.ts` (its `find()` selects
// `WHERE NOT EXISTS (SELECT 1 FROM bot_accounts ...)`, so the rename tool
// deliberately cannot see a bot at all). A one-shot beside chaos_relabel_v1 is
// the house idiom and keeps the only writer inside the migration.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-playbot-rename-test-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

const OLD = (n: number) => `Rally${String(n).padStart(2, '0')}Bot`;

// Deliberately out of createdAt order in the INSERT, so a migration that
// happened to read rows in rowid order would still have to sort to pass.
const BOTS: Array<{ id: string; username: string; createdAt: string; cookie: string | null }> = [
  { id: 'dev_playbot000000002', username: OLD(2), createdAt: '2026-01-02T00:00:00.000Z', cookie: 'c2' },
  { id: 'dev_playbot000000001', username: OLD(1), createdAt: '2026-01-01T00:00:00.000Z', cookie: 'c1' },
  { id: 'dev_playbot000000003', username: OLD(3), createdAt: '2026-01-03T00:00:00.000Z', cookie: 'c3' },
  // Curated ROSTER furniture: a bot_accounts row with NO credential. Not
  // drivable, never named by the population, and must not be renamed.
  { id: 'bot-ladder-01', username: 'CircuitPup', createdAt: '2026-01-01T00:00:00.000Z', cookie: null },
];

// A HUMAN holding the name bot #1 would otherwise be given. One taken name has
// to cost one name, not the migration.
const SQUATTER = { id: 'dev_human0000000001', username: PLAYBOT_NAMES[0]! };

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
      rankTitle TEXT
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
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const now = '2026-02-01T00:00:00.000Z';
  const player = sql.prepare(
    `INSERT INTO players VALUES (?, ?, 5, 900, 400, NULL, 12, 6, 6, 14, 60, 2, 1, ?, '[]', ?, ?, ?, NULL, NULL)`
  );
  const bot = sql.prepare(
    `INSERT INTO bot_accounts VALUES (?, ?, ?, 0.61, 0.03, 0.42, 0.5, 0.77, 0.2, 0.9, 0.4, 0.55)`
  );
  for (const b of BOTS) {
    player.run(b.id, b.username, now, b.createdAt, now, b.createdAt);
    bot.run(b.id, b.createdAt, b.cookie);
  }
  player.run(SQUATTER.id, SQUATTER.username, now, now, now, now);

  // A history row naming a bot by its old name, on a HUMAN's own filed row.
  sql.prepare(
    `INSERT INTO matches VALUES ('m1', ?, 'Human', ?, ?, ?, ?, 5, 3, 9, 'multiplayer', NULL, ?, 1)`
  ).run(SQUATTER.id, BOTS[1]!.id, OLD(1), BOTS[1]!.id, OLD(1), now);

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

const nameOf = (id: string): string =>
  read(
    (h) => (h.prepare('SELECT username FROM players WHERE id = ?').get(id) as { username: string }).username
  );

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('playbot_names_v1', () => {
  it('renames the drivable bots in creation order', () => {
    expect(db).toBeTruthy();
    // Bot #1 is created first, so it takes the first name the list offers —
    // which here is the SECOND entry, because a human holds the first.
    expect(nameOf(BOTS[1]!.id)).toBe(PLAYBOT_NAMES[1]);
    expect(nameOf(BOTS[0]!.id)).toBe(PLAYBOT_NAMES[2]);
    expect(nameOf(BOTS[2]!.id)).toBe(PLAYBOT_NAMES[3]);
  });

  it('skips a name a human already holds without costing the batch', () => {
    // The whole point of advancing rather than aborting: one collision must
    // cost one name. `seedBotRoster` treats a roster collision the same way.
    expect(nameOf(SQUATTER.id)).toBe(PLAYBOT_NAMES[0]);
    expect(read((h) => h.prepare('SELECT COUNT(*) AS n FROM players WHERE username = ?').get(PLAYBOT_NAMES[0]!)))
      .toEqual({ n: 1 });
  });

  it('spends no name on the curated roster', () => {
    // `deviceCookie IS NULL` is the schema's own discriminator between
    // furniture and a drivable account — the same test `playbotAccounts()`
    // asks. Keying on the `bot-` id prefix instead would be D26's classifier,
    // which tests/botIdentity.test.ts greps the tree for.
    //
    // Asserted through the CURSOR rather than by reading the row back, because
    // `roster_retire_v1` deletes the furniture later in the same boot and
    // there is nothing left to look at. That is the sharper assertion anyway:
    // a rename that failed to skip it would have spent a list entry on it, so
    // the three play-bots would each have shifted one name along — which is
    // exactly what the first test in this block pins.
    expect(read((h) => h.prepare('SELECT id FROM players WHERE id = ?').get('bot-ladder-01')))
      .toBeUndefined();
    expect(nameOf(BOTS[2]!.id)).toBe(PLAYBOT_NAMES[3]);
    expect(nameOf(BOTS[2]!.id)).not.toBe(PLAYBOT_NAMES[4]);
  });

  it('stamps usernameChangedAt, so the new name gets its own lock', () => {
    const changed = read(
      (h) =>
        (h.prepare('SELECT usernameChangedAt AS t FROM players WHERE id = ?').get(BOTS[1]!.id) as {
          t: string | null;
        }).t
    );
    expect(changed).toBeTruthy();
  });

  it('returns the old names to the pool', () => {
    // Which falls out of the row going: the unique index covers initialized
    // rows only. Asserted because it is the difference between a rename and a
    // name burned out of the pool for good.
    const held = read(
      (h) =>
        (h.prepare('SELECT COUNT(*) AS n FROM players WHERE username LIKE ?').get('Rally%Bot') as {
          n: number;
        }).n
    );
    expect(held).toBe(0);
  });

  it('leaves every trait byte-identical', () => {
    // The question a rename raises, because `provision` seeds traits FROM the
    // username. It seeds at creation only — every later read comes off
    // bot_accounts — so a rename must not disturb a live bot's competence,
    // which is exactly what "creation may seed, nothing after creation may
    // steer" forbids. The migration touches `players` and nothing else.
    const traits = read((h) =>
      h.prepare('SELECT skill, rankedBias, hostAppetite FROM bot_accounts WHERE botId = ?').get(BOTS[1]!.id)
    );
    expect(traits).toEqual({ skill: 0.61, rankedBias: 0.77, hostAppetite: 0.9 });
  });

  it('scrubs the old name out of match history', () => {
    // `matches` denormalizes both names, so without this a human's own history
    // keeps naming Rally07Bot while the profile that row links to says
    // something else. `deleteAccount` already rewrites these columns the same
    // way for the same reason.
    const row = read((h) =>
      h.prepare('SELECT player2Name AS p2, winnerName AS w FROM matches WHERE id = ?').get('m1')
    );
    expect(row).toEqual({ p2: PLAYBOT_NAMES[1], w: PLAYBOT_NAMES[1] });
  });

  it('is stamped, so a second boot renames nothing again', () => {
    const stamped = read((h) => h.prepare('SELECT value FROM meta WHERE key = ?').get('playbot_names_v1'));
    expect(stamped).toBeTruthy();
  });
});
