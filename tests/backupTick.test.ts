import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_RETRY_MS,
  type BackupConfig,
  type BackupDeps,
  META_ATTEMPT,
  META_OK,
  META_UPLOAD_OK,
  readinessLines,
  resetBackupTickGuard,
  runBackupTick,
} from '../server/backup';
import type { S3Target } from '../server/s3';

// The orchestration, with every dependency injected.
//
// That seam is the point of the module: it turns each failure path
// DEPLOYMENT.md describes into a fast unit test with no child process, no
// socket and no timer. What it is really guarding is one rule — a backup must
// never take the server down — which is not paranoia here: server.ts registers
// `process.on('unhandledRejection', onFatal)` and onFatal closes every socket.

const SECRET = 'secret-value-a1b2c3';
const DAY = 24 * 60 * 60 * 1000;

const target: S3Target = {
  endpoint: 'https://s3.example.com',
  bucket: 'phong-backups',
  region: 'us-east-1',
  prefix: 'phong/',
  accessKeyId: 'AKIAEXAMPLE',
  sessionToken: null,
  virtualHost: false,
  unsignedPayload: false,
  sse: null,
};

function harness(over: Partial<BackupConfig> = {}) {
  const meta = new Map<string, string>();
  const logs: string[] = [];
  const warns: string[] = [];
  let clock = 100 * DAY;
  const calls = { snapshot: 0, upload: 0 };

  const cfg: BackupConfig = {
    enabled: true,
    dir: '/backups',
    keep: 14,
    intervalMs: DAY,
    scriptPath: null,
    target: null,
    secret: null,
    problems: [],
    ...over,
  };

  const deps: BackupDeps = {
    now: () => clock,
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => void meta.set(k, v),
    runSnapshot: async () => {
      calls.snapshot++;
      return { ok: true, created: '/backups/phong-2026-09-02T00-00-00-000Z.db', detail: 'snapshot ok' };
    },
    upload: async () => {
      calls.upload++;
      return { ok: true, status: 200, code: null, detail: 'uploaded' };
    },
    log: (l) => void logs.push(l),
    warn: (l) => void warns.push(l),
  };

  return {
    cfg,
    deps,
    meta,
    logs,
    warns,
    calls,
    advance: (ms: number) => (clock += ms),
    at: () => clock,
    all: () => [...logs, ...warns].join('\n'),
  };
}

beforeEach(() => resetBackupTickGuard());

describe('runBackupTick', () => {
  it('does nothing at all when the scheduler is off', async () => {
    const h = harness({ enabled: false });
    await runBackupTick(h.cfg, h.deps);
    expect(h.calls.snapshot).toBe(0);
    expect(h.meta.size).toBe(0);
  });

  it('does not take a snapshot that is not due', async () => {
    const h = harness();
    h.meta.set(META_OK, String(h.at() - 1000));
    await runBackupTick(h.cfg, h.deps);
    expect(h.calls.snapshot).toBe(0);
  });

  it('stamps the local success and leaves the upload stamp alone when there is nowhere to ship', async () => {
    const h = harness();
    await runBackupTick(h.cfg, h.deps);
    expect(h.calls.snapshot).toBe(1);
    expect(h.meta.get(META_OK)).toBe(String(h.at()));
    expect(h.meta.has(META_UPLOAD_OK)).toBe(false);
  });

  it('stamps the attempt BEFORE the work, so a failure is not retried every tick', async () => {
    const h = harness();
    h.deps.runSnapshot = async () => {
      h.calls.snapshot++;
      return { ok: false, created: null, detail: 'exit 1: cannot write to /backups' };
    };
    await runBackupTick(h.cfg, h.deps);
    expect(h.meta.get(META_ATTEMPT)).toBe(String(h.at()));
    expect(h.meta.has(META_OK)).toBe(false);
    expect(h.warns.join(' ')).toContain('cannot write');

    // Five minutes later it must NOT try again — this is what rate-limits the
    // log for a standing misconfiguration.
    h.advance(5 * 60 * 1000);
    await runBackupTick(h.cfg, h.deps);
    expect(h.calls.snapshot).toBe(1);

    // Past the floor, it does.
    h.advance(BACKUP_RETRY_MS);
    await runBackupTick(h.cfg, h.deps);
    expect(h.calls.snapshot).toBe(2);
  });

  it('ships the snapshot when there is a target', async () => {
    const h = harness({ target, secret: SECRET });
    await runBackupTick(h.cfg, h.deps);
    expect(h.calls.upload).toBe(1);
    expect(h.meta.get(META_UPLOAD_OK)).toBe(String(h.at()));
  });

  // The pairing matters. Asserting only that META_OK is set would pass against
  // an implementation that stamps everything unconditionally, which is exactly
  // the bug that makes the boot line claim an offsite copy exists when it does
  // not.
  it('a failed upload still counts as a successful LOCAL backup, and only that', async () => {
    const h = harness({ target, secret: SECRET });
    h.deps.upload = async () => {
      h.calls.upload++;
      return { ok: false, status: 403, code: 'SignatureDoesNotMatch', detail: 'HTTP 403' };
    };
    await runBackupTick(h.cfg, h.deps);
    expect(h.meta.get(META_OK)).toBe(String(h.at()));
    expect(h.meta.has(META_UPLOAD_OK)).toBe(false);
    const said = h.warns.join(' ');
    expect(said).toContain('403');
    expect(said).toContain('SignatureDoesNotMatch');
    // And it says where the good copy is, because that is what an operator
    // reading this line at 4am actually needs to know.
    expect(said).toContain('/backups/phong-2026-09-02T00-00-00-000Z.db');
  });

  it('keeps its cadence after a failed upload rather than re-vacuuming hourly', async () => {
    // A broken bucket is not something a VACUUM can fix, so it must not cause
    // one every hour.
    const h = harness({ target, secret: SECRET });
    h.deps.upload = async () => ({ ok: false, status: 403, code: 'AccessDenied', detail: 'HTTP 403' });
    await runBackupTick(h.cfg, h.deps);
    h.advance(2 * BACKUP_RETRY_MS);
    await runBackupTick(h.cfg, h.deps);
    expect(h.calls.snapshot).toBe(1); // still not due — META_OK was stamped
  });

  // Both of these assert the standing rule directly: a REJECTED promise from a
  // dependency, not a resolved-false one, must still leave the tick resolved.
  it('survives runSnapshot REJECTING', async () => {
    const h = harness();
    h.deps.runSnapshot = async () => {
      throw new Error('spawn EACCES');
    };
    await expect(runBackupTick(h.cfg, h.deps)).resolves.toBeUndefined();
    expect(h.warns.join(' ')).toContain('spawn EACCES');
    expect(h.meta.has(META_OK)).toBe(false);
  });

  it('survives upload REJECTING', async () => {
    const h = harness({ target, secret: SECRET });
    h.deps.upload = async () => {
      throw new Error('socket hang up');
    };
    await expect(runBackupTick(h.cfg, h.deps)).resolves.toBeUndefined();
    expect(h.warns.join(' ')).toContain('socket hang up');
    // Local backup still succeeded.
    expect(h.meta.get(META_OK)).toBe(String(h.at()));
    expect(h.meta.has(META_UPLOAD_OK)).toBe(false);
  });

  it('does not start a second snapshot while one is still running', async () => {
    // A vacuum can outlive a 15-minute tick on a large database.
    //
    // The clock is advanced past the retry floor between the two calls ON
    // PURPOSE. Without that, the second tick is refused by the floor rather
    // than by the re-entrancy guard, and the test passes with the guard
    // deleted — verified by deleting it.
    const h = harness();
    let release!: () => void;
    h.deps.runSnapshot = () =>
      new Promise((resolve) => {
        h.calls.snapshot++;
        release = () => resolve({ ok: true, created: null, detail: 'slow snapshot' });
      });
    const first = runBackupTick(h.cfg, h.deps);
    h.advance(2 * BACKUP_RETRY_MS);
    await runBackupTick(h.cfg, h.deps); // overlapping, and otherwise due
    expect(h.calls.snapshot).toBe(1);
    release();
    await first;
  });

  it('does not upload when the snapshot produced no file', async () => {
    const h = harness({ target, secret: SECRET });
    h.deps.runSnapshot = async () => ({ ok: true, created: null, detail: 'no new file seen' });
    await runBackupTick(h.cfg, h.deps);
    expect(h.calls.upload).toBe(0);
    expect(h.meta.get(META_OK)).toBe(String(h.at()));
  });

  it('never writes the secret into anything it logs, on ANY path', async () => {
    for (const upload of [
      async () => ({ ok: false, status: 403, code: 'SignatureDoesNotMatch', detail: 'HTTP 403' }),
      async () => {
        throw new Error('boom');
      },
      async () => ({ ok: true, status: 200, code: null, detail: 'uploaded' }),
    ]) {
      resetBackupTickGuard();
      const h = harness({ target, secret: SECRET });
      h.deps.upload = upload as BackupDeps['upload'];
      await runBackupTick(h.cfg, h.deps);
      expect(h.all()).not.toContain(SECRET);
    }
  });
});

describe('readinessLines', () => {
  const facts = {
    dirWritable: true,
    dirError: null,
    sameDeviceAsData: false,
    lastOkAt: null,
    lastUploadOkAt: null,
  };
  const cfg = (over: Partial<BackupConfig> = {}): BackupConfig => ({
    enabled: true, dir: '/backups', keep: 14, intervalMs: DAY,
    scriptPath: null, target: null, secret: null, problems: [], ...over,
  });

  it('WARNS when the scheduler is off, rather than saying nothing', () => {
    // The same shape as the existing "[db] WARNING: no accounts in this
    // database" line, and for the same class of silent failure.
    const { warn } = readinessLines(cfg({ enabled: false }), facts, 0);
    expect(warn.join(' ')).toContain('scheduler OFF');
    expect(warn.join(' ')).toContain('db:backup');
  });

  it('warns that a local-only backup is not really a backup', () => {
    const { warn } = readinessLines(cfg(), facts, 0);
    expect(warn.join(' ')).toContain('never leaves the host');
  });

  it('warns when BACKUP_DIR shares a filesystem with DATA_DIR', () => {
    // The check that actually catches the primary deployment: an unmounted
    // /backups is writable in the image layer, so the backup appears to work
    // and is discarded on every deploy.
    const { warn } = readinessLines(cfg(), { ...facts, sameDeviceAsData: true }, 0);
    expect(warn.join(' ')).toContain('same filesystem');
    expect(warn.join(' ')).toContain('thrown away on every deploy');
  });

  it('says when the destination cannot be written at all', () => {
    const { warn } = readinessLines(
      cfg(), { ...facts, dirWritable: false, dirError: 'EACCES' }, 0
    );
    expect(warn.join(' ')).toContain('cannot write to /backups');
    expect(warn.join(' ')).toContain('EACCES');
  });

  it('answers "am I covered?" in one line', () => {
    const now = 100 * DAY;
    const { info } = readinessLines(
      cfg({ target, secret: SECRET }),
      { ...facts, lastOkAt: now - 3 * 60 * 60 * 1000, lastUploadOkAt: null },
      now
    );
    const joined = info.join('\n');
    expect(joined).toContain('last verified snapshot 3h ago');
    expect(joined).toContain('last offsite upload never');
  });

  it('describes the target without ever printing the secret', () => {
    const { info, warn } = readinessLines(cfg({ target, secret: SECRET }), facts, 0);
    const all = [...info, ...warn].join('\n');
    expect(all).toContain('phong-backups');
    expect(all).toContain('path-style');
    expect(all).not.toContain(SECRET);
  });

  it('renders every age the way an operator reads it', () => {
    // The line that answers "am I covered?" — so its three shapes are pinned.
    // Minutes for a recent one, hours for today's, days once it is old enough
    // that hours stop being legible.
    const now = 100 * DAY;
    const line = (ok: number | null) =>
      readinessLines(cfg(), { ...facts, lastOkAt: ok }, now).info.join('\n');
    expect(line(now - 20 * 60 * 1000)).toContain('snapshot 20m ago');
    expect(line(now - 5 * 60 * 60 * 1000)).toContain('snapshot 5h ago');
    expect(line(now - 5 * DAY)).toContain('snapshot 5d ago');
    expect(line(null)).toContain('snapshot never');
    // A future-dated stamp is clamped rather than rendered as a negative age.
    expect(line(now + DAY)).toContain('snapshot 0m ago');
  });

  it('says the destination is unwritable even when there is no errno to quote', () => {
    const { warn } = readinessLines(cfg(), { ...facts, dirWritable: false, dirError: null }, 0);
    expect(warn.join(' ')).toContain('cannot write to /backups');
    expect(warn.join(' ')).not.toContain('undefined');
  });

  it('names the addressing style, because it is the thing providers disagree about', () => {
    const virt = readinessLines(
      cfg({ target: { ...target, virtualHost: true }, secret: SECRET }), facts, 0
    );
    expect(virt.info.join(' ')).toContain('virtual-host');
  });

  it('surfaces config problems at boot rather than at the first tick', () => {
    const { warn } = readinessLines(
      cfg({ problems: ['BACKUP_S3_BUCKET is not a valid bucket name (got "Nope").'] }),
      facts, 0
    );
    expect(warn.join(' ')).toContain('BACKUP_S3_BUCKET');
  });
});
