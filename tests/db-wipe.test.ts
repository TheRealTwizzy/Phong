import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';

// The one-time wipe_v1 boot migration: a database from before the fresh
// launch (players, matches, auth secret, even a legacy JSON file on disk)
// must come up completely empty — exactly once.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-wipe-test-'));
process.env.DATA_DIR = TMP;

// Build a pre-wipe database the way an old deployment would have left it.
function seedOldDatabase(dir: string) {
  const sql = new DatabaseSync(path.join(dir, 'phong.db'));
  sql.exec(`
    CREATE TABLE players (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      level INTEGER NOT NULL,
      xp INTEGER NOT NULL,
      xpNext INTEGER NOT NULL,
      eloRating INTEGER NOT NULL,
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
      rankTitle TEXT NOT NULL,
      recoveryCode TEXT
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
  const insert = sql.prepare(
    `INSERT INTO players VALUES (?, ?, 5, 3000, 4000, 1450, 30, 20, 10, 25, 150, 5, 3, ?, '[]', ?, ?, 'Ace', ?)`
  );
  insert.run('dev_0ldplayer000000001'.padEnd(22, '0').slice(0, 22), 'OldChampion', now.slice(0, 10), now, now, 'AAAA-BBBB');
  insert.run('bot-pro-01', 'NeonViper', now.slice(0, 10), now, now, 'CCCC-DDDD');
  sql.prepare(
    `INSERT INTO matches VALUES ('m1', 'dev_old', 'OldChampion', 'bot-pro-01', 'NeonViper', 'dev_old', 'OldChampion', 5, 2, 10, 'multiplayer', NULL, ?)`
  ).run(now);
  sql.prepare(`INSERT INTO meta VALUES ('auth_secret', 'old-secret-that-must-die')`).run();
  sql.close();
}

seedOldDatabase(TMP);
// A stray legacy JSON that the old code would have imported into an empty DB
fs.writeFileSync(
  path.join(TMP, 'game_database.json'),
  JSON.stringify({ players: { legacy_1: { id: 'legacy_1', username: 'Lazarus' } }, matches: [] })
);

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('wipe_v1 one-time player reset', () => {
  it('boots with 0 players despite pre-existing data, and stamps the flag', () => {
    expect(db.getLeaderboard('elo', 100, true)).toHaveLength(0);
    expect(db.getMatchHistory('dev_old')).toHaveLength(0);
    expect(db.getMeta('wipe_v1')).toBeTruthy();
  });

  it('clears the auth secret so every old device cookie is retired', () => {
    expect(db.getMeta('auth_secret')).not.toBe('old-secret-that-must-die');
  });

  it('never resurrects players from a legacy game_database.json', () => {
    // The file is still on disk, the DB is empty — the old importer would
    // have brought Lazarus back. The importer is gone.
    expect(fs.existsSync(path.join(TMP, 'game_database.json'))).toBe(true);
    const board = db.getLeaderboard('elo', 100, true);
    expect(board.some((e) => e.username === 'Lazarus')).toBe(false);
  });

  it('does not seed any bots', () => {
    const board = db.getLeaderboard('elo', 100, true);
    expect(board.some((e) => e.id.startsWith('bot-'))).toBe(false);
  });

  it('stamps EVERY wipe key, so no sibling wipe can re-fire later', () => {
    // Each wipe clears `meta`. If a wipe re-stamped only some keys, the
    // unstamped sibling would fire on the next boot, clear this stamp in
    // turn, and the two would alternate — a full player wipe and cookie
    // rotation on every single start.
    for (const key of ['wipe_v1', 'wipe_v2', 'wipe_v3']) {
      expect(db.getMeta(key)).toBeTruthy();
    }
  });

  it('runs exactly once: a second boot leaves post-wipe data intact', async () => {
    db.getProfile('dev_survivor000000001'.padEnd(22, '1').slice(0, 22));
    const id = 'dev_aaaaaaaaaaaaaaaa99';
    db.getProfile(id);
    const initialized = db.initializeProfile(id, 'Survivor');
    expect(initialized.ok).toBe(true);

    vi.resetModules();
    const { db: db2 } = await import('../server/db');
    expect(db2.getProfile(id).username).toBe('Survivor');
    for (const key of ['wipe_v1', 'wipe_v2', 'wipe_v3']) {
      expect(db2.getMeta(key)).toBeTruthy();
    }
  });

  it('wipes a database that had already run the earlier wipes', async () => {
    // The exact shape of the deployed server: wipe_v2 stamped, players
    // accumulated since. The next boot must run wipe_v3 once — and only once.
    const id = 'dev_bbbbbbbbbbbbbbbb99';
    // db already booted past all three wipes in this suite; simulate a
    // pre-v3 deployment by un-stamping v3 and seeding a player.
    db.getProfile(id);
    db.initializeProfile(id, 'PreReset');
    db.setMeta('wipe_v3', '');

    vi.resetModules();
    const { db: db3 } = await import('../server/db');
    expect(db3.getLeaderboard('elo', 100, true)).toHaveLength(0);
    const gone = db3.getProfile(id);
    expect(gone.initialized).toBe(false);
    for (const key of ['wipe_v1', 'wipe_v2', 'wipe_v3']) {
      expect(db3.getMeta(key)).toBeTruthy();
    }
  });
});

describe('manual db:reset script', () => {
  it('refuses without --yes and deletes the database files with it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-reset-script-'));
    try {
      for (const f of ['phong.db', 'phong.db-wal', 'game_database.json']) {
        fs.writeFileSync(path.join(dir, f), 'x');
      }
      const script = path.join(process.cwd(), 'scripts', 'db-reset.mjs');

      let failed = false;
      try {
        execFileSync(process.execPath, [script], { env: { ...process.env, DATA_DIR: dir } });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(fs.existsSync(path.join(dir, 'phong.db'))).toBe(true);

      execFileSync(process.execPath, [script, '--yes'], { env: { ...process.env, DATA_DIR: dir } });
      expect(fs.existsSync(path.join(dir, 'phong.db'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'phong.db-wal'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'game_database.json'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
