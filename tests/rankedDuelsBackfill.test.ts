import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

// The one-shot ranked_duels_backfill_v1 migration.
//
// `rankedDuels` arrives through `addColumn(... DEFAULT 0)`, so every duel
// played before it existed contributes nothing to it — and Cyber Overlord now
// asks for OVERLORD_MIN_DUELS of them. Without a backfill every existing
// Overlord would read Legend on the next load, owing duels they had genuinely
// played. So the duels still on disk are counted, once.
//
// Three things the count has to get right, each with a row below:
//   - only a DUEL that RATED counts: `mode = 'multiplayer' AND ranked = 1`,
//     so a Casual-venue duel (ranked 0) and a rated solo match are both left
//     out;
//   - it runs AFTER ranked_backfill_v1, which classifies legacy NULLs from
//     mode + difficulty — judged first, a legacy duel reads NULL and is missed;
//   - it is a MAX, never an assignment: `insertMatch` trims `matches` to the
//     newest 500 rows per player, so a straight count would take duels away
//     from exactly the accounts that have played the most.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-ranked-duels-backfill-test-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

const VETERAN = 'dev_veteran000000001';
const TRIMMED = 'dev_trimmed000000001';
const RIVAL = 'dev_rival00000000001';

/** [id, player1Id, player2Id, winnerId, mode, difficulty, ranked] */
type Row = [string, string, string, string, string, string | null, number | null];

const ROWS: Row[] = [
  // Veteran: two rated duels already classified...
  ['d1', VETERAN, RIVAL, VETERAN, 'multiplayer', null, 1],
  ['d2', VETERAN, RIVAL, RIVAL, 'multiplayer', null, 1],
  // ...one from before the `ranked` column existed, which ranked_backfill_v1
  // classifies as rated (a duel on stock rules) BEFORE this count runs...
  ['d3', VETERAN, RIVAL, VETERAN, 'multiplayer', null, null],
  // ...a Casual-venue duel, which was played and did not rate...
  ['d4', VETERAN, RIVAL, VETERAN, 'multiplayer', null, 0],
  // ...and a rated SOLO match, which is a ranked game and not a duel.
  ['s1', VETERAN, 'AI-cyber', VETERAN, 'solo', 'cyber', 1],
  // Rival's own filed row of d1: a duel for Rival too, counted onto Rival.
  ['d1b', RIVAL, VETERAN, VETERAN, 'multiplayer', null, 1],
  // Trimmed: one row survives, but the counter already says nine.
  ['t1', TRIMMED, RIVAL, TRIMMED, 'multiplayer', null, 1],
];

/**
 * A database from a build that had the column but had not counted into it —
 * `rankedDuels` present so the MAX has something to be measured against, the
 * `ranked` column present so a NULL can stand for a legacy row, and everything
 * else db.ts adds through `addColumn` left out so the boot path adds it.
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
      rankedDuels INTEGER NOT NULL DEFAULT 0,
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
      rankTitle TEXT
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
  const now = new Date().toISOString();

  const player = sql.prepare(
    `INSERT INTO players VALUES (?, ?, 12, 4000, 500, NULL, ?, 40, 30, 10, 22, 180, 9, 3, ?, '[]', ?, ?, NULL)`
  );
  player.run(VETERAN, 'Veteran', 0, now, now, now);
  player.run(TRIMMED, 'Trimmed', 9, now, now, now);
  player.run(RIVAL, 'Rival', 0, now, now, now);

  const insert = sql.prepare(
    `INSERT INTO matches VALUES (?, ?, 'P1', ?, 'P2', ?, 'W', 5, 3, 6, ?, ?, ?, ?)`
  );
  for (const [id, p1, p2, winner, mode, difficulty, ranked] of ROWS) {
    insert.run(id, p1, p2, winner, mode, difficulty, now, ranked);
  }

  const stamp = sql.prepare('INSERT INTO meta VALUES (?, ?)');
  for (const key of ['wipe_v1', 'wipe_v2', 'wipe_v3', 'wipe_v4']) stamp.run(key, now);
  sql.close();
}

seedLegacyDatabase();

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('ranked_duels_backfill_v1', () => {
  it('counts the rated duels on disk, and only those', () => {
    // d1, d2 and the legacy d3 — not the Casual d4, not the solo s1.
    expect(db.getProfile(VETERAN).rankedDuels).toBe(3);
  });

  it('runs after the legacy rows have been classified', () => {
    // d3 arrived with ranked NULL. Counted, so ranked_backfill_v1 had already
    // turned it into a 1 by the time this ran — the ordering the boot path
    // promises, held by the fixture rather than assumed.
    const sql = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      const row = sql.prepare('SELECT ranked FROM matches WHERE id = ?').get('d3') as { ranked: number };
      expect(row.ranked).toBe(1);
    } finally {
      sql.close();
    }
  });

  it("credits the opponent's own filed row to the opponent, never to the rival", () => {
    expect(db.getProfile(RIVAL).rankedDuels).toBe(1);
  });

  it('only ever finds MORE, so the 500-row trim cannot take duels away', () => {
    expect(db.getProfile(TRIMMED).rankedDuels).toBe(9);
  });

  it('is stamped, so it runs once', () => {
    const sql = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      const row = sql.prepare("SELECT value FROM meta WHERE key = 'ranked_duels_backfill_v1'").get() as
        | { value: string }
        | undefined;
      expect(row?.value).toBeTruthy();
    } finally {
      sql.close();
    }
  });
});
