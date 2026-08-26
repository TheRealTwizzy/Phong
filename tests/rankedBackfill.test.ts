import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

// The one-shot ranked_backfill_v1 migration: a database whose matches were
// recorded before the `ranked` column existed comes up with every row
// classified from the two inputs that survive — mode and difficulty — rather
// than the whole history rendering Un-Ranked and both Ranked sub-tabs empty,
// which is how the column's no-backfill first release read on a live server.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-backfill-test-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

// A database the #58 deployment would have left behind: the pre-column
// matches schema, rows from every mode, and the wipe flags stamped so the
// boot-time wipes know this data has already survived them.
function seedLegacyDatabase() {
  const sql = new DatabaseSync(DB_FILE);
  sql.exec(`
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
  const insert = sql.prepare(
    `INSERT INTO matches VALUES (?, 'dev_legacy0000000001', 'Legacy', ?, ?, 'dev_legacy0000000001', 'Legacy', 5, 2, 6, ?, ?, ?)`
  );
  insert.run('m_duel', 'dev_legacy0000000002', 'Rival', 'multiplayer', null, now);
  insert.run('m_pro', 'AI-pro', 'AI (pro)', 'solo', 'pro', now);
  insert.run('m_cyber', 'AI-cyber', 'AI (cyber)', 'solo', 'cyber', now);
  insert.run('m_rookie', 'AI-rookie', 'AI (rookie)', 'solo', 'rookie', now);
  insert.run('m_wall', 'wall', 'Practice Wall', 'practice', null, now);
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

describe('ranked_backfill_v1', () => {
  it('classifies every legacy row from mode and difficulty, once', () => {
    const raw = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      const rows = raw.prepare('SELECT id, ranked FROM matches ORDER BY id').all() as unknown as Array<{
        id: string;
        ranked: number | null;
      }>;
      expect(Object.fromEntries(rows.map((r) => [r.id, r.ranked]))).toEqual({
        m_cyber: 1, // earned difficulty: counted for the ladder
        m_duel: 1, // a duel counted for the ladder
        m_pro: 1, // earned difficulty
        m_rookie: 0, // rookie never ranks
        m_wall: 0, // practice never ranks
      });
      // Nothing left unclassified, and the one-shot is stamped done.
      const nulls = raw.prepare('SELECT COUNT(*) AS n FROM matches WHERE ranked IS NULL').get() as { n: number };
      expect(nulls.n).toBe(0);
      const flag = raw.prepare("SELECT value FROM meta WHERE key = 'ranked_backfill_v1'").get();
      expect(flag).toBeTruthy();
    } finally {
      raw.close();
    }
  });

  it('feeds the classified rows straight into the ranked filters', () => {
    const ranked = db.getMatchHistoryPage('dev_legacy0000000001', { ranked: 'ranked' });
    expect(ranked.total).toBe(3);
    const unranked = db.getMatchHistoryPage('dev_legacy0000000001', { ranked: 'unranked' });
    expect(unranked.total).toBe(2);
    expect(db.getMatchHistoryPage('dev_legacy0000000001', { mode: 'multiplayer', ranked: 'ranked' }).total).toBe(1);
    expect(db.getMatchHistoryPage('dev_legacy0000000001', { mode: 'solo', ranked: 'ranked' }).total).toBe(2);
  });
});
