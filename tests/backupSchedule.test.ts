import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKUP_RETRY_MS,
  DEFAULT_BACKUP_INTERVAL_HOURS,
  DEFAULT_BACKUP_KEEP,
  backupDue,
  onMountedVolume,
  probeBackupDir,
  readBackupConfig,
} from '../server/backup';

// When a backup runs, and whether it has anywhere to go.
//
// Both halves are pure and take their inputs as arguments — `now` into
// backupDue, `env` into readBackupConfig — for the reason server/rateLimit.ts
// gives: a rule you can only observe through a live process is a rule nobody
// tests, and this one decides whether the game has backups at all.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const base = { intervalMs: DAY, retryFloorMs: BACKUP_RETRY_MS };

describe('backupDue', () => {
  it('runs the first time it is ever asked', () => {
    expect(backupDue({ ...base, lastOkAt: null, lastAttemptAt: null, now: 1_000_000 })).toEqual({
      run: true,
      reason: 'first',
    });
  });

  // Both sides of the boundary. An off-by-one here is a whole day of matches,
  // ratings and XP, and it is exactly the kind of thing that reads correct.
  it('does not run one millisecond early', () => {
    const now = 10 * DAY;
    expect(backupDue({ ...base, lastOkAt: now - (DAY - 1), lastAttemptAt: null, now })).toEqual({
      run: false,
      reason: 'not-due',
    });
  });

  it('runs exactly on the interval', () => {
    const now = 10 * DAY;
    expect(backupDue({ ...base, lastOkAt: now - DAY, lastAttemptAt: null, now })).toEqual({
      run: true,
      reason: 'due',
    });
  });

  // The two branches whose absence stops backups SILENTLY AND PERMANENTLY,
  // while the boot line goes on saying the scheduler is armed. Neither is
  // exotic; both are reachable on an ordinary container.

  it('runs when the clock has gone BACKWARDS, instead of waiting forever', () => {
    // NTP correcting a container that booted with a wrong clock leaves a
    // future-dated stamp. `now - lastOkAt` is negative, and a plain
    // `since >= intervalMs` reads that as "not due" — for good.
    const now = 10 * DAY;
    expect(backupDue({ ...base, lastOkAt: now + DAY, lastAttemptAt: null, now })).toEqual({
      run: true,
      reason: 'clock-went-backwards',
    });
  });

  it('runs when the stamp is unreadable, which neither obvious guard catches', () => {
    // A truncated write or a hand-edited row parses to NaN. `NaN >= interval`
    // is false AND `NaN < 0` is false, so an implementation that adds only the
    // backwards-clock guard above still stops dead here.
    const now = 10 * DAY;
    expect(backupDue({ ...base, lastOkAt: Number('abc'), lastAttemptAt: null, now })).toEqual({
      run: true,
      reason: 'stamp-unreadable',
    });
  });

  it('runs once after a huge forward jump, then settles', () => {
    const now = 1000 * DAY;
    expect(backupDue({ ...base, lastOkAt: 1, lastAttemptAt: null, now }).run).toBe(true);
    // ...and having stamped, it is not due again.
    expect(backupDue({ ...base, lastOkAt: now, lastAttemptAt: now, now: now + 1000 })).toEqual({
      run: false,
      reason: 'retry-floor',
    });
  });

  describe('the retry floor', () => {
    it('holds off a failing backup instead of retrying every tick', () => {
      // This is what rate-limits the log: `backup_attempt_at` is stamped before
      // the child runs, so a standing misconfiguration produces at most 24
      // failure lines a day rather than 96.
      const now = 10 * DAY;
      expect(
        backupDue({ ...base, lastOkAt: now - 2 * DAY, lastAttemptAt: now - 5 * 60 * 1000, now })
      ).toEqual({ run: false, reason: 'retry-floor' });
    });

    it('lets it try again once the floor has passed', () => {
      const now = 10 * DAY;
      expect(
        backupDue({ ...base, lastOkAt: now - 2 * DAY, lastAttemptAt: now - 2 * HOUR, now })
      ).toEqual({ run: true, reason: 'due' });
    });

    it('never blocks the very first run', () => {
      expect(backupDue({ ...base, lastOkAt: null, lastAttemptAt: null, now: 5 }).run).toBe(true);
    });

    it('does not trap a future-dated ATTEMPT stamp either', () => {
      // Same clock jump, other stamp. A negative `sinceAttempt` must not read
      // as "inside the floor" or the floor becomes permanent.
      const now = 10 * DAY;
      expect(
        backupDue({ ...base, lastOkAt: now - 2 * DAY, lastAttemptAt: now + DAY, now }).run
      ).toBe(true);
    });
  });
});

describe('readBackupConfig', () => {
  it('is off, and NOT an error, when nothing is set', () => {
    const cfg = readBackupConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.problems).toEqual([]);
    expect(cfg.target).toBeNull();
  });

  it('does not arm itself just because credentials are present', () => {
    // An operator pasting keys in to test them must not start a schedule.
    const cfg = readBackupConfig({
      BACKUP_DIR: '/backups',
      BACKUP_S3_ENDPOINT: 'https://s3.example.com',
      BACKUP_S3_BUCKET: 'b',
      BACKUP_S3_ACCESS_KEY_ID: 'k',
      BACKUP_S3_SECRET_ACCESS_KEY: 's',
    });
    expect(cfg.enabled).toBe(false);
  });

  it('takes the defaults the docs promise', () => {
    const cfg = readBackupConfig({ BACKUP_ENABLED: '1', BACKUP_DIR: '/backups' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.keep).toBe(DEFAULT_BACKUP_KEEP);
    expect(cfg.intervalMs).toBe(DEFAULT_BACKUP_INTERVAL_HOURS * HOUR);
    expect(cfg.target).toBeNull();
    expect(cfg.problems).toEqual([]);
  });

  it('says so when enabled with nowhere to write', () => {
    const cfg = readBackupConfig({ BACKUP_ENABLED: '1' });
    expect(cfg.problems.join(' ')).toContain('BACKUP_DIR');
  });

  // Each of these names the variable that is wrong. Asserting only
  // `problems.length > 0` is the vacuous version — "credentials are wrong"
  // sends an operator looking at the wrong one half the time.
  it('names the missing half of a credential pair', () => {
    const withoutSecret = readBackupConfig({
      BACKUP_ENABLED: '1', BACKUP_DIR: '/b',
      BACKUP_S3_ENDPOINT: 'https://s3.example.com', BACKUP_S3_BUCKET: 'bucket',
      BACKUP_S3_ACCESS_KEY_ID: 'k',
    });
    expect(withoutSecret.target).toBeNull();
    expect(withoutSecret.problems.join(' ')).toContain('BACKUP_S3_SECRET_ACCESS_KEY');

    const withoutKey = readBackupConfig({
      BACKUP_ENABLED: '1', BACKUP_DIR: '/b',
      BACKUP_S3_ENDPOINT: 'https://s3.example.com', BACKUP_S3_BUCKET: 'bucket',
      BACKUP_S3_SECRET_ACCESS_KEY: 's',
    });
    expect(withoutKey.problems.join(' ')).toContain('BACKUP_S3_ACCESS_KEY_ID');
  });

  it('refuses a plaintext endpoint, because the object is the whole database', () => {
    const cfg = readBackupConfig({
      BACKUP_ENABLED: '1', BACKUP_DIR: '/b',
      BACKUP_S3_ENDPOINT: 'http://s3.example.com', BACKUP_S3_BUCKET: 'bucket',
      BACKUP_S3_ACCESS_KEY_ID: 'k', BACKUP_S3_SECRET_ACCESS_KEY: 's',
    });
    expect(cfg.target).toBeNull();
    expect(cfg.problems.join(' ')).toMatch(/https/);
  });

  it('allows a plaintext endpoint only when explicitly asked, for a local test server', () => {
    const cfg = readBackupConfig({
      BACKUP_ENABLED: '1', BACKUP_DIR: '/b',
      BACKUP_S3_ENDPOINT: 'http://127.0.0.1:9000', BACKUP_S3_BUCKET: 'bucket',
      BACKUP_S3_ACCESS_KEY_ID: 'k', BACKUP_S3_SECRET_ACCESS_KEY: 's',
      BACKUP_S3_ALLOW_INSECURE: '1',
    });
    expect(cfg.target?.endpoint).toBe('http://127.0.0.1:9000');
    expect(cfg.problems).toEqual([]);
  });

  it('rejects a bucket name that is not one', () => {
    const cfg = readBackupConfig({
      BACKUP_ENABLED: '1', BACKUP_DIR: '/b',
      BACKUP_S3_ENDPOINT: 'https://s3.example.com', BACKUP_S3_BUCKET: 'Not A Bucket',
      BACKUP_S3_ACCESS_KEY_ID: 'k', BACKUP_S3_SECRET_ACCESS_KEY: 's',
    });
    expect(cfg.target).toBeNull();
    expect(cfg.problems.join(' ')).toContain('BACKUP_S3_BUCKET');
  });

  it('clamps keep and falls back on junk', () => {
    expect(readBackupConfig({ BACKUP_KEEP: '0' }).keep).toBe(DEFAULT_BACKUP_KEEP);
    expect(readBackupConfig({ BACKUP_KEEP: 'abc' }).keep).toBe(DEFAULT_BACKUP_KEEP);
    expect(readBackupConfig({ BACKUP_KEEP: '3' }).keep).toBe(3);
  });

  it('refuses a zero interval rather than silently substituting one', () => {
    // Zero would back up on every tick. Said out loud, because a clamp here
    // means an operator's typo becomes a different configuration than the one
    // they wrote.
    const cfg = readBackupConfig({ BACKUP_ENABLED: '1', BACKUP_DIR: '/b', BACKUP_INTERVAL_HOURS: '0' });
    expect(cfg.problems.join(' ')).toContain('BACKUP_INTERVAL_HOURS');
    expect(cfg.intervalMs).toBe(DEFAULT_BACKUP_INTERVAL_HOURS * HOUR);
  });

  it('accepts a positive non-default interval', () => {
    expect(readBackupConfig({ BACKUP_ENABLED: '1', BACKUP_DIR: '/b', BACKUP_INTERVAL_HOURS: '6' }).intervalMs)
      .toBe(6 * HOUR);
  });

  it('says so when the endpoint is not a URL at all', () => {
    const cfg = readBackupConfig({
      BACKUP_ENABLED: '1', BACKUP_DIR: '/b',
      BACKUP_S3_ENDPOINT: 'not a url', BACKUP_S3_BUCKET: 'bucket',
      BACKUP_S3_ACCESS_KEY_ID: 'k', BACKUP_S3_SECRET_ACCESS_KEY: 's',
    });
    expect(cfg.target).toBeNull();
    expect(cfg.problems.join(' ')).toContain('not a URL');
  });

  it('does NOT read ambient AWS credentials', () => {
    // A CI runner or a host carrying AWS_* would otherwise silently begin
    // uploading the player database somewhere nobody chose.
    const cfg = readBackupConfig({
      BACKUP_ENABLED: '1', BACKUP_DIR: '/b',
      BACKUP_S3_ENDPOINT: 'https://s3.example.com', BACKUP_S3_BUCKET: 'bucket',
      AWS_ACCESS_KEY_ID: 'ambient', AWS_SECRET_ACCESS_KEY: 'ambient',
    });
    expect(cfg.target).toBeNull();
    expect(cfg.secret).toBeNull();
  });

  it('keeps the secret out of the target, so no logged config can carry it', () => {
    const SECRET = 'super-secret-value-9f3a';
    const cfg = readBackupConfig({
      BACKUP_ENABLED: '1', BACKUP_DIR: '/b',
      BACKUP_S3_ENDPOINT: 'https://s3.example.com', BACKUP_S3_BUCKET: 'bucket',
      BACKUP_S3_ACCESS_KEY_ID: 'k', BACKUP_S3_SECRET_ACCESS_KEY: SECRET,
    });
    expect(cfg.secret).toBe(SECRET);
    // The structural guarantee: it is not reachable from the object the
    // uploader and every log line pass around.
    expect(JSON.stringify(cfg.target)).not.toContain(SECRET);
  });
});

describe('onMountedVolume', () => {
  // The four shapes, over a fake device map rather than a real filesystem,
  // because describing a mount in a test must not require making one: no
  // privileges, no /proc, and the same answer on every machine. What a real
  // filesystem would add is the confidence that `statSync().dev` behaves the
  // way this assumes, which the last case here takes from the actual root.
  const fs_ = (devs: Record<string, number>) => (p: string) => {
    if (!(p in devs)) throw new Error(`no such path ${p}`);
    return devs[p];
  };

  it('sees a directory mounted straight in', () => {
    // /backups is a bind mount: crossing into / changes device.
    expect(onMountedVolume('/backups', fs_({ '/backups': 42, '/': 1 }))).toBe(true);
  });

  it('sees a directory INSIDE a mount, which is why parents are walked', () => {
    // Testing the directory against its own parent alone would call this
    // false: /backups/phong and /backups share a device. The boundary is one
    // level further up.
    expect(
      onMountedVolume('/backups/phong', fs_({ '/backups/phong': 42, '/backups': 42, '/': 1 }))
    ).toBe(true);
  });

  it('sees an UNMOUNTED directory in the image layer', () => {
    // The case the old check could not catch, and the whole reason for this
    // one. Nothing is crossed on the way to the root.
    expect(onMountedVolume('/backups', fs_({ '/backups': 1, '/': 1 }))).toBe(false);
  });

  it('says nothing at all when a path cannot be walked', () => {
    // null is "cannot tell". The alarm it feeds is loud, and firing it on a
    // stat failure is the false positive this check exists to remove.
    expect(onMountedVolume('/gone', fs_({ '/': 1 }))).toBeNull();
  });

  it('follows a symlink before walking, or every device is the target’s', () => {
    // The walk climbs the PATH while the devices come from wherever it points.
    // Unfollowed, /link would be compared against / and read as unmounted.
    const devs = { '/backups': 42, '/': 1 };
    expect(onMountedVolume('/link', fs_(devs), () => '/backups')).toBe(true);
  });

  it('agrees with the real filesystem that the root is not a mounted volume', () => {
    // The one case that is the same everywhere and needs no privileges:
    // dirname('/') is '/', so the walk reaches the top having crossed nothing.
    expect(onMountedVolume('/', (p) => fs.statSync(p).dev, (p) => fs.realpathSync(p))).toBe(false);
  });
});

describe('probeBackupDir', () => {
  const made: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-probe-'));
    made.push(d);
    return d;
  };
  afterEach(() => {
    while (made.length) fs.rmSync(made.pop()!, { recursive: true, force: true });
  });

  it('creates the directory and reports it writable', () => {
    const root = tmp();
    const dir = path.join(root, 'backups', 'nested');
    expect(fs.existsSync(dir)).toBe(false);
    const probe = probeBackupDir(dir, path.join(root, 'data'));
    expect(probe.dirWritable).toBe(true);
    expect(probe.dirError).toBeNull();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('says why, rather than throwing, when it cannot', () => {
    // A file where a directory should be: mkdir -p fails with EEXIST/ENOTDIR.
    // The boot line has to survive this — a server that will not start because
    // its BACKUP_DIR is wrong is a worse outcome than one that says so.
    const root = tmp();
    const blocked = path.join(root, 'not-a-dir');
    fs.writeFileSync(blocked, 'in the way');
    const probe = probeBackupDir(blocked, root);
    expect(probe.dirWritable).toBe(false);
    expect(probe.dirError).toBeTruthy();
  });

  // The check that actually catches the primary deployment, and the only one
  // that can: the Dockerfile mkdirs /backups, so an UNMOUNTED /backups is
  // writable in the image layer and the paths still differ. Device numbers are
  // what distinguishes "on its own volume" from "about to be thrown away on
  // the next deploy".
  it('notices when the backup directory shares a filesystem with the data', () => {
    const root = tmp();
    const probe = probeBackupDir(path.join(root, 'backups'), root);
    expect(probe.sameDeviceAsData).toBe(true);
  });

  it('reports whether the directory is on a mounted volume', () => {
    // Through the real filesystem this time. A temp directory is on whatever
    // /tmp is on, which differs by machine — so this asserts the field is
    // ANSWERED rather than which way, and the four shapes are pinned above
    // where they can be stated deterministically.
    const root = tmp();
    const probe = probeBackupDir(path.join(root, 'backups'), root);
    expect(probe.onMountedVolume === true || probe.onMountedVolume === false).toBe(true);
  });

  it('does not claim a shared filesystem when DATA_DIR does not exist yet', () => {
    // A first boot: the data directory has not been created. Nothing to
    // compare, and the honest answer is not to raise the warning — it would
    // fire on every fresh install and stop meaning anything.
    const root = tmp();
    const probe = probeBackupDir(path.join(root, 'backups'), path.join(root, 'no-such-data'));
    expect(probe.dirWritable).toBe(true);
    expect(probe.sameDeviceAsData).toBe(false);
  });
});
