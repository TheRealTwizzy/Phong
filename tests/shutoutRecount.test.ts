import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { isShutout, SHUTOUT_MIN_POINTS } from '../src/matchRules';

// The one-shot shutout_recount_v1 migration.
//
// `shutoutsWon` arrived through `addColumn(... DEFAULT 0)`, so every match
// played before it existed contributes nothing to it — and `shutout_5` and
// `shutout_15` read nothing else. An established player's counter started at
// zero on a career that had already earned plenty, with no path back: the
// counter is only ever incremented by the match in hand. So the history that
// is still on disk is recounted, once.
//
// The half that matters most is that it may only ever find MORE. `insertMatch`
// trims `matches` to the newest 500 rows per player, so a straight recount
// would quietly take shutouts away from exactly the accounts that have played
// the most — which is why the statement is a MAX and why 'Trimmed' below is in
// the fixture at all.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-shutout-recount-test-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

const VETERAN = 'dev_veteran000000001';
const TRIMMED = 'dev_trimmed000000001';
const RIVAL = 'dev_rival00000000001';

/** [id, player1Id, player2Id, winnerId, scoreP1, scoreP2] */
type Row = [string, string, string, string, number, number];

// Each seat files its OWN row and `recordMatch` writes the reporter as
// player1, so a player's history is the `player1Id` rows and nothing else —
// the same reason `getMatchHistory` does not match `player2Id`.
const ROWS: Row[] = [
  // Veteran: three real clean sheets.
  ['m_v1', VETERAN, 'AI-cyber', VETERAN, 5, 0],
  ['m_v2', VETERAN, 'AI-cyber', VETERAN, 7, 0],
  ['m_v3', VETERAN, RIVAL, VETERAN, 10, 0],
  // ...and four that are not, one per way of failing.
  ['m_v4', VETERAN, 'AI-cyber', VETERAN, 5, 1], // conceded
  ['m_v5', VETERAN, 'AI-cyber', VETERAN, 3, 0], // the whole of a first-to-3
  ['m_v6', VETERAN, RIVAL, RIVAL, 2, 5], // lost
  // The opponent's own filed row of m_v3. It is a clean sheet for Veteran and
  // must not be counted onto Rival, who was on the receiving end of it.
  ['m_v3b', RIVAL, VETERAN, VETERAN, 0, 10],
  // Trimmed: two rows survive, but the counter says nine.
  ['m_t1', TRIMMED, 'AI-cyber', TRIMMED, 5, 0],
  ['m_t2', TRIMMED, 'AI-cyber', TRIMMED, 5, 0],
];

/**
 * A database from before the recount. The `players` table is a snapshot of the
 * schema as it stood, deliberately — a legacy fixture that tracked the current
 * schema would stop being a legacy fixture. Everything db.ts adds through
 * `addColumn` is left out so the boot path adds it, exactly as it would in the
 * field.
 */
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
      shutoutsWon INTEGER NOT NULL DEFAULT 0,
      dailyStreak INTEGER NOT NULL,
      lastDailyDate TEXT NOT NULL,
      achievements TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      lastActive TEXT NOT NULL,
      rankTitle TEXT
    );
    CREATE TABLE matches (
      id TEXT PRIMARY KEY,
      player1Id TEXT NOT NULL, player1Name TEXT NOT NULL,
      player2Id TEXT NOT NULL, player2Name TEXT NOT NULL,
      winnerId TEXT NOT NULL, winnerName TEXT NOT NULL,
      scoreP1 INTEGER NOT NULL, scoreP2 INTEGER NOT NULL,
      maxRally INTEGER NOT NULL, mode TEXT NOT NULL,
      difficulty TEXT, timestamp TEXT NOT NULL
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const now = new Date().toISOString();

  const player = sql.prepare(
    `INSERT INTO players VALUES (?, ?, 12, 4000, 500, NULL, 40, 30, 10, 22, 180, 9, ?, 3, ?, '[]', ?, ?, NULL)`
  );
  // Veteran is the ordinary case: the column defaulted to 0 on a real career.
  player.run(VETERAN, 'Veteran', 0, now, now, now);
  // Trimmed's older shutouts have been swept out of `matches` by the 500-row
  // cap, so history under-reports what the counter already knows.
  player.run(TRIMMED, 'Trimmed', 9, now, now, now);
  player.run(RIVAL, 'Rival', 0, now, now, now);

  const insert = sql.prepare(
    `INSERT INTO matches VALUES (?, ?, 'P1', ?, 'P2', ?, 'W', ?, ?, 6, 'solo', 'cyber', ?)`
  );
  for (const [id, p1, p2, winner, s1, s2] of ROWS) insert.run(id, p1, p2, winner, s1, s2, now);

  const stamp = sql.prepare('INSERT INTO meta VALUES (?, ?)');
  // Every DESTRUCTIVE one-shot is stamped, or it erases the legacy history this
  // fixture exists to migrate. progress_reset_v1 deletes `matches` outright and
  // zeroes every career counter, and it runs LAST, so without this the migration
  // under test runs correctly and its result is wiped before a single assertion.
  for (const key of ['wipe_v1', 'wipe_v2', 'wipe_v3', 'wipe_v4', 'progress_reset_v1'])
    stamp.run(key, now);
  sql.close();
}

seedLegacyDatabase();

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** What `isShutout` makes of the seeded history, so the SQL cannot drift off it. */
const expectedFor = (playerId: string) =>
  ROWS.filter(
    ([, p1, , winner, s1, s2]) =>
      p1 === playerId && isShutout({ isWinner: winner === p1, playerScore: s1, opponentScore: s2 })
  ).length;

describe('shutout_recount_v1', () => {
  it('recounts a career the column was added to after the fact', () => {
    // Three clean sheets in the fixture, and the four near-misses beside them
    // are what makes that number mean something.
    expect(expectedFor(VETERAN)).toBe(3);
    expect(db.getProfile(VETERAN).shutoutsWon).toBe(3);
  });

  it('agrees with isShutout about every row, rather than keeping its own rule', () => {
    // The migration spells the rule out in SQL because it has to run inside
    // SQLite. This is the check that keeps that copy honest.
    for (const id of [VETERAN, TRIMMED, RIVAL]) {
      expect(db.getProfile(id).shutoutsWon).toBeGreaterThanOrEqual(expectedFor(id));
    }
    expect(SHUTOUT_MIN_POINTS).toBe(5);
  });

  it('never lowers a counter it cannot see the history for', () => {
    // Trimmed has two surviving rows and a stored nine. `matches` is trimmed
    // to the newest 500 per player, so the most active accounts are exactly
    // the ones a plain recount would rob.
    expect(expectedFor(TRIMMED)).toBe(2);
    expect(db.getProfile(TRIMMED).shutoutsWon).toBe(9);
  });

  it('does not credit the player who was shut out', () => {
    // Rival holds their own filed row of the 10-0 they lost. Counting the
    // `player2Id` side would hand them the winner's clean sheet.
    expect(expectedFor(RIVAL)).toBe(0);
    expect(db.getProfile(RIVAL).shutoutsWon).toBe(0);
  });

  it('stamps itself so a restart cannot run it twice', () => {
    expect(db.getMeta('shutout_recount_v1')).toBeTruthy();
  });
});
