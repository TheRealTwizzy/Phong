import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

// The one-shot chaos_relabel_v1 migration.
//
// 'chaos' was a RETIRED difficulty that sat between Pro and Cyber, and
// normalizeDifficulty mapped it to 'cyber' ("a stored chaos still means the
// hard one"). The five-rung ladder revives the name as the NEW TOP RUNG — so
// a legacy history row left saying 'chaos' would silently start rendering as
// the hardest opponent in the game, a match its player never played. The
// migration rewrites those rows to what the retirement map already said they
// meant, exactly once, which is what let the map itself be deleted.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-chaos-relabel-test-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

// A database from the era when 'chaos' rows could still be written: the
// pre-`ranked`-column matches schema, with the wipe flags stamped so the
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
    `INSERT INTO matches VALUES (?, 'dev_chaoslegacy00001', 'Legacy', ?, ?, 'dev_chaoslegacy00001', 'Legacy', 5, 2, 6, ?, ?, ?)`
  );
  insert.run('m_chaos_1', 'AI-chaos', 'AI (chaos)', 'solo', 'chaos', now);
  insert.run('m_chaos_2', 'AI-chaos', 'AI (chaos)', 'solo', 'chaos', now);
  // Neighbours that must NOT be touched: a real cyber row, a rookie row, a duel.
  insert.run('m_cyber', 'AI-cyber', 'AI (cyber)', 'solo', 'cyber', now);
  insert.run('m_rookie', 'AI-rookie', 'AI (rookie)', 'solo', 'rookie', now);
  insert.run('m_duel', 'dev_chaoslegacy00002', 'Rival', 'multiplayer', null, now);
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

describe('chaos_relabel_v1', () => {
  it('relabels every legacy chaos row to cyber, touches nothing else, and stamps itself done', () => {
    const raw = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      const rows = raw.prepare('SELECT id, difficulty FROM matches ORDER BY id').all() as unknown as Array<{
        id: string;
        difficulty: string | null;
      }>;
      expect(Object.fromEntries(rows.map((r) => [r.id, r.difficulty]))).toEqual({
        m_chaos_1: 'cyber', // relabelled to what the retirement map said it meant
        m_chaos_2: 'cyber',
        m_cyber: 'cyber', // untouched
        m_rookie: 'rookie', // untouched
        m_duel: null, // a duel has no difficulty
      });
      const flag = raw.prepare("SELECT value FROM meta WHERE key = 'chaos_relabel_v1'").get();
      expect(flag).toBeTruthy();
    } finally {
      raw.close();
    }
  });

  it('leaves a NEW chaos row alone: the name now means the top rung', () => {
    // Recorded after the migration ran, by a player who has genuinely earned
    // the revived rung — this row must keep its difficulty, or the migration
    // would eat every chaos match played from here on.
    db.getProfile('dev_chaosnew00000001');
    const init = db.initializeProfile('dev_chaosnew00000001', 'ChaosPlayer');
    expect(init.ok).toBe(true);
    db.recordMatch({
      playerId: 'dev_chaosnew00000001',
      username: 'ChaosPlayer',
      playerScore: 5,
      opponentScore: 3,
      bestStreak: 4,
      endStreak: 0,
      earnedStreak: 4,
      mode: 'solo',
      difficulty: 'chaos',
      isWinner: true,
      matchKey: 'relabel:new-chaos:1',
    } as never);
    const raw = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      const row = raw
        .prepare("SELECT difficulty FROM matches WHERE player1Id = 'dev_chaosnew00000001'")
        .get() as { difficulty: string };
      expect(row.difficulty).toBe('chaos');
    } finally {
      raw.close();
    }
  });
});
