import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { BackupConfig } from '../server/backup';
import { resolveBackupScript, snapshotOnce } from '../server/backupRun';

// scripts/backup.mjs, driven for real — and its first CI guard ever.
//
// Until now that script had no test coverage and no CI registration of any
// kind: `npm test` never touched it, `tsc` does not read `.mjs`, the coverage
// `include` does not match `scripts/`, and `lint:suites` polices only
// `e2e-*.mjs`. It could have been broken for months, exactly the way
// `scripts/load-test.mjs` was, and nothing in the repository could have said
// so. The scheduler now depends on its exit codes AND on "exactly one file
// appears", so both are pinned here against the real thing rather than a stub.

const REPO = path.resolve(__dirname, '..');

let dataDir: string;
let outDir: string;

/** A real phong.db, built the way tests/db.test.ts builds one. */
function seedDatabase(dir: string, players: number): void {
  fs.mkdirSync(dir, { recursive: true });
  const sql = new DatabaseSync(path.join(dir, 'phong.db'));
  sql.exec('CREATE TABLE players (id TEXT PRIMARY KEY, username TEXT)');
  for (let i = 0; i < players; i++) {
    sql.prepare('INSERT INTO players (id, username) VALUES (?, ?)').run(`dev_${i}`, `P${i}`);
  }
  sql.close();
}

const cfg = (over: Partial<BackupConfig> = {}): BackupConfig => ({
  enabled: true,
  dir: outDir,
  keep: 14,
  intervalMs: 86_400_000,
  scriptPath: null,
  target: null,
  secret: null,
  problems: [],
  ...over,
});

const run = (c: BackupConfig, env: NodeJS.ProcessEnv = {}) =>
  snapshotOnce(c, { cwd: REPO, bundleDir: REPO, env: { PATH: process.env.PATH, DATA_DIR: dataDir, ...env } });

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-backuprun-'));
  dataDir = path.join(root, 'data');
  outDir = path.join(root, 'backups');
  seedDatabase(dataDir, 3);
});

afterEach(() => {
  for (const d of [dataDir, outDir]) fs.rmSync(path.dirname(d), { recursive: true, force: true });
});

describe('resolveBackupScript', () => {
  it('finds the script beside the repo root', () => {
    expect(resolveBackupScript({}, REPO, REPO)).toBe(path.join(REPO, 'scripts', 'backup.mjs'));
  });

  it('finds it one level up from a bundle directory', () => {
    // Production runs `dist/server.cjs`, so __dirname is /app/dist and the
    // script is at /app/scripts. A single hardcoded relative path is wrong in
    // exactly one of dev and prod, which is why this is a candidate list.
    expect(resolveBackupScript({}, path.join(REPO, 'dist'), '/nowhere')).toBe(
      path.join(REPO, 'scripts', 'backup.mjs')
    );
  });

  it('prefers an explicit BACKUP_SCRIPT', () => {
    const explicit = path.join(REPO, 'scripts', 'backup.mjs');
    expect(resolveBackupScript({ BACKUP_SCRIPT: explicit }, '/nowhere', '/nowhere')).toBe(explicit);
  });

  it('returns null when there is nothing to run', () => {
    expect(resolveBackupScript({}, '/nowhere', '/also-nowhere')).toBeNull();
  });
});

describe('snapshotOnce', () => {
  it('produces exactly one snapshot, and it opens and verifies', async () => {
    const res = await run(cfg());
    expect(res.ok).toBe(true);
    expect(res.created).not.toBeNull();

    const made = fs.readdirSync(outDir);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatch(/^phong-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/);
    expect(res.created).toBe(path.join(outDir, made[0]));

    // The snapshot is a real database with the real rows in it — which is what
    // the whole feature is for, and is not implied by an exit code.
    const snap = new DatabaseSync(res.created!, { readOnly: true });
    const verdict = Object.values(snap.prepare('PRAGMA integrity_check').get() ?? {})[0];
    expect(verdict).toBe('ok');
    expect((snap.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number }).n).toBe(3);
    snap.close();
  }, 20_000);

  it('refuses to write inside DATA_DIR, and writes nothing when it does', async () => {
    // The script's own rule, exercised through the wrapper: a backup on the
    // volume it protects is lost with it. Layered deliberately — the scheduler
    // does not duplicate this check, so if the script ever stopped enforcing
    // it, this is what notices.
    const inside = path.join(dataDir, 'backups');
    const res = await run(cfg({ dir: inside }));
    expect(res.ok).toBe(false);
    expect(fs.existsSync(inside)).toBe(false);
  }, 20_000);

  it('fails when there is no database to back up', async () => {
    fs.rmSync(path.join(dataDir, 'phong.db'));
    const res = await run(cfg());
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/no database|DATA_DIR/i);
  }, 20_000);

  it('prunes its own oldest snapshots and leaves a hand-made file alone', async () => {
    // This pins the `MINE` regex the whole before/after diff depends on. The
    // script promises, one line above its prune, to remove only files it made;
    // a `phong-*.db` glob would adopt a hand-made phong-before-upgrade.db,
    // count it toward `keep`, and eventually delete somebody's deliberate copy.
    fs.mkdirSync(outDir, { recursive: true });
    const manual = path.join(outDir, 'phong-before-upgrade.db');
    fs.writeFileSync(manual, 'not a real database, and not ours to delete');

    for (let i = 0; i < 3; i++) {
      const res = await run(cfg({ keep: 2 }));
      expect(res.ok).toBe(true);
      // The stamp has millisecond resolution; three runs inside one millisecond
      // would collide.
      await new Promise((r) => setTimeout(r, 5));
    }

    const left = fs.readdirSync(outDir).sort();
    expect(left).toContain('phong-before-upgrade.db');
    expect(left.filter((f) => /^phong-\d{4}/.test(f))).toHaveLength(2);
    expect(fs.readFileSync(manual, 'utf8')).toContain('not ours to delete');
  }, 40_000);

  it('cleans up a partial file when the child dies, but not when it says to keep one', async () => {
    // A child killed mid-VACUUM leaves a file matching the script's own prune
    // pattern, which would then count as one of the `keep` snapshots — a
    // corrupt backup occupying a slot a good one should have had. Removed on a
    // crash; NOT removed on a verify failure, because the script says "leaving
    // <dest> in place for inspection" and that promise is worth keeping.
    fs.mkdirSync(outDir, { recursive: true });
    const crasher = path.join(path.dirname(outDir), 'crash.mjs');
    fs.writeFileSync(
      crasher,
      `import fs from 'node:fs';\n` +
        `fs.writeFileSync(process.argv[process.argv.indexOf('--out') + 1] + ` +
        `'/phong-2020-01-01T00-00-00-000Z.db', 'partial');\n` +
        `process.exit(1);\n`
    );
    const crashed = await run(cfg(), { BACKUP_SCRIPT: crasher });
    expect(crashed.ok).toBe(false);
    expect(fs.readdirSync(outDir)).toEqual([]);

    const verifier = path.join(path.dirname(outDir), 'verify-fail.mjs');
    fs.writeFileSync(
      verifier,
      `import fs from 'node:fs';\n` +
        `fs.writeFileSync(process.argv[process.argv.indexOf('--out') + 1] + ` +
        `'/phong-2020-01-01T00-00-00-000Z.db', 'partial');\n` +
        `console.error('[backup] the snapshot did not verify: nope');\n` +
        `process.exit(1);\n`
    );
    const unverified = await run(cfg(), { BACKUP_SCRIPT: verifier });
    expect(unverified.ok).toBe(false);
    expect(fs.readdirSync(outDir)).toEqual(['phong-2020-01-01T00-00-00-000Z.db']);
  }, 20_000);

  it('takes the newest when a run somehow leaves two', async () => {
    fs.mkdirSync(outDir, { recursive: true });
    const twin = path.join(path.dirname(outDir), 'twin.mjs');
    fs.writeFileSync(
      twin,
      `import fs from 'node:fs';\n` +
        `const out = process.argv[process.argv.indexOf('--out') + 1];\n` +
        `fs.writeFileSync(out + '/phong-2020-01-01T00-00-00-000Z.db', 'a');\n` +
        `fs.writeFileSync(out + '/phong-2020-01-02T00-00-00-000Z.db', 'b');\n`
    );
    const res = await run(cfg(), { BACKUP_SCRIPT: twin });
    expect(res.ok).toBe(true);
    expect(res.created).toContain('phong-2020-01-02');
    expect(res.detail).toContain('saw 2 new files');
  }, 20_000);

  it('reports a clean run that produced no file, without claiming one', async () => {
    // Reachable only if the clock went far enough backwards that the new stamp
    // sorted oldest and the script's own prune deleted it. The local backup is
    // fine; there is simply nothing to upload, and the tick must not try.
    fs.mkdirSync(outDir, { recursive: true });
    const quiet = path.join(path.dirname(outDir), 'quiet.mjs');
    fs.writeFileSync(quiet, `console.log('[backup] nothing to do');\n`);
    const res = await run(cfg(), { BACKUP_SCRIPT: quiet });
    expect(res.ok).toBe(true);
    expect(res.created).toBeNull();
    expect(res.detail).toContain('no new file seen');
  }, 20_000);

  it('says which paths it tried when the script is missing', async () => {
    const res = await snapshotOnce(cfg(), {
      cwd: '/nowhere',
      bundleDir: '/nowhere',
      env: { PATH: process.env.PATH, DATA_DIR: dataDir },
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('nowhere');
    expect(res.detail).toContain('BACKUP_SCRIPT');
  });

  it('does not hand the child any of the S3 credentials', async () => {
    // A narrowed env, not `...process.env`: a process that never receives a
    // secret cannot leak one through a crash dump or /proc/<pid>/environ. The
    // script has no use for them, so there is no reason for it to hold them.
    //
    // Asserted by asking a stand-in script what it ACTUALLY received. Checking
    // the real script's output instead passes trivially — backup.mjs never
    // prints its environment, so widening the child env to `...process.env` is
    // invisible that way. Verified by widening it and watching this go red.
    const spy = path.join(path.dirname(outDir), 'env-spy.mjs');
    fs.writeFileSync(spy, 'console.log(JSON.stringify(process.env));\n');
    const res = await snapshotOnce(cfg(), {
      cwd: REPO,
      bundleDir: REPO,
      env: {
        PATH: process.env.PATH,
        DATA_DIR: dataDir,
        BACKUP_SCRIPT: spy,
        BACKUP_S3_SECRET_ACCESS_KEY: 'must-not-reach-the-child',
        BACKUP_S3_ACCESS_KEY_ID: 'also-not',
      },
    });
    // It "succeeded" (exit 0) and made no snapshot, which is fine — what is
    // under test is the environment, and the child's stdout is the evidence.
    expect(res.detail).not.toContain('must-not-reach-the-child');
    expect(res.detail).not.toContain('also-not');
    // And it DID receive the two it needs, or this would pass vacuously
    // against a child handed nothing at all.
    expect(res.detail).toContain(dataDir);
    expect(res.detail).toContain(outDir);
  }, 20_000);
});
