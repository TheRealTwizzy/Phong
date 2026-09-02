// Run scripts/backup.mjs as a child process, and report what it produced.
//
// SPAWNED, NOT IMPORTED, and the first reason is disqualifying on its own:
// `scripts/backup.mjs` is top-level straight-line code with no exports. It
// reads `process.argv` and calls `process.exit(1)` on a missing database, an
// unwritable destination, a failed VACUUM and a failed verify — so
// `await import(...)` inside a running server would execute all of that at
// import time and take the server down with the first failure.
//
// The other two reasons stand even if it were refactored to export a function
// (which is what happened to scripts/load-test.mjs, and answers a different
// question — it made that script testable, not safe on the event loop):
//
//  - `DatabaseSync` is synchronous, and `PRAGMA integrity_check` walks the
//    whole file. On the relay's event loop that is a stall in every live match,
//    and it grows with the player base — so the failure arrives exactly when
//    the game succeeds.
//  - server.ts turns an unhandled rejection into a full shutdown via `onFatal`.
//    Backup work in-process is one short step from a production outage; a child
//    process cannot do that.
//
// The script's exit-code contract ("Exits non-zero on any failure, so cron/CI
// notices") is exactly what this consumes. Nothing about the script changes,
// and `npm run db:backup` stays byte-identical.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BackupConfig, SnapshotResult } from './backup';
import { BACKUP_CHILD_TIMEOUT_MS } from './backup';

/**
 * Where `scripts/backup.mjs` is, from wherever this is running.
 *
 * Mirrors `artifactCandidates()` in server/build.ts, and for the same reason:
 * esbuild bundles server.ts to `dist/server.cjs`, so `__dirname` is `/app/dist`
 * in production and the repo root under `tsx` in dev. A single hardcoded
 * relative path is wrong in exactly one of the two.
 */
export function resolveBackupScript(
  env: NodeJS.ProcessEnv,
  bundleDir: string,
  cwd: string
): string | null {
  const candidates = [
    env.BACKUP_SCRIPT,
    path.join(bundleDir, '..', 'scripts', 'backup.mjs'),
    path.join(bundleDir, 'scripts', 'backup.mjs'),
    path.join(cwd, 'scripts', 'backup.mjs'),
  ].filter((p): p is string => !!p);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      /* not this one — try the next */
    }
  }
  return null;
}

/** The exact shape `scripts/backup.mjs` names its snapshots. */
const SNAPSHOT_RE = /^phong-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;

export interface RunOptions {
  bundleDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Take one snapshot. Never rejects; a failure is `{ok: false}` with a reason.
 */
export async function snapshotOnce(cfg: BackupConfig, opts: RunOptions = {}): Promise<SnapshotResult> {
  const env = opts.env ?? process.env;
  const bundleDir = opts.bundleDir ?? (typeof __dirname !== 'undefined' ? __dirname : process.cwd());
  const cwd = opts.cwd ?? process.cwd();

  const script = resolveBackupScript(env, bundleDir, cwd);
  if (!script) {
    return {
      ok: false,
      created: null,
      detail: `scripts/backup.mjs not found (looked beside ${bundleDir} and ${cwd}; set BACKUP_SCRIPT)`,
    };
  }

  // What was in the directory before. The child prunes as part of its own run,
  // but it only ever removes names that were already here — so anything in the
  // "after" listing that is not in this set is what it just made.
  //
  // A directory diff rather than parsing the child's stdout: the file name is
  // not a contract between us, the format of its success line is not either,
  // and a diff is trivially checkable in a test.
  let before: Set<string>;
  try {
    before = new Set(fs.readdirSync(cfg.dir));
  } catch {
    before = new Set();
  }

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve) => {
      execFile(
        process.execPath, // never the string 'node' — no PATH dependence
        [script, '--out', cfg.dir, '--keep', String(cfg.keep)],
        {
          // A NARROWED env, not `...process.env`. The child needs none of the
          // S3 credentials, and a process that never receives a secret cannot
          // leak one through a crash dump or /proc/<pid>/environ. It also makes
          // the DATA_DIR agreement explicit rather than inherited, which is the
          // only way the child's "no database at …" error can ever be true.
          env: {
            PATH: env.PATH,
            HOME: env.HOME,
            NODE_ENV: env.NODE_ENV,
            DATA_DIR: env.DATA_DIR,
            BACKUP_DIR: cfg.dir,
          } as NodeJS.ProcessEnv,
          timeout: opts.timeoutMs ?? BACKUP_CHILD_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: 1 << 20,
        },
        (err, stdout, stderr) => {
          const timedOut = !!err && (err as NodeJS.ErrnoException).code === 'ETIMEDOUT';
          const code = err ? ((err as unknown as { code?: number }).code ?? 1) : 0;
          resolve({
            code: typeof code === 'number' ? code : 1,
            stdout: String(stdout),
            stderr: String(stderr),
            timedOut,
          });
        }
      );
    }
  );

  let after: string[];
  try {
    after = fs.readdirSync(cfg.dir);
  } catch {
    after = [];
  }
  const created = after.filter((f) => !before.has(f) && SNAPSHOT_RE.test(f)).sort();

  if (result.code !== 0 || result.timedOut) {
    // A child killed mid-VACUUM can leave a partial file that matches the
    // script's own prune pattern and would therefore count as one of the
    // `keep` snapshots. Remove it — but ONLY on a crash or a timeout, never on
    // a verify failure: the script says "leaving <dest> in place for
    // inspection" and that promise is worth keeping.
    const verifyFailed = /did not verify/.test(result.stderr);
    if (!verifyFailed) {
      for (const f of created) {
        try {
          fs.unlinkSync(path.join(cfg.dir, f));
        } catch {
          /* best effort */
        }
      }
    }
    const why = result.timedOut ? 'timed out' : `exit ${result.code}`;
    const said = result.stderr.trim().split('\n').slice(-2).join(' ').trim();
    return { ok: false, created: null, detail: `${why}${said ? `: ${said}` : ''}` };
  }

  if (created.length === 0) {
    // Exit 0 and nothing appeared. Reachable only if the clock went far enough
    // backwards that the new stamp sorted oldest and the script's own prune
    // deleted it. The local backup is fine; there is simply nothing to upload.
    return { ok: true, created: null, detail: `${result.stdout.trim() || 'snapshot ok'} (no new file seen)` };
  }
  if (created.length > 1) {
    // Two snapshots inside one run should not happen; say so rather than pick
    // silently. Newest wins — the stamps sort chronologically.
    return {
      ok: true,
      created: path.join(cfg.dir, created[created.length - 1]),
      detail: `${result.stdout.trim()} (saw ${created.length} new files, took the newest)`,
    };
  }
  return {
    ok: true,
    created: path.join(cfg.dir, created[0]),
    detail: result.stdout.trim() || `wrote ${created[0]}`,
  };
}
