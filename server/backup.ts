// When a backup is due, whether it can go anywhere, and what to say about it
// at boot.
//
// Pure or dependency-injected throughout, like server/rateLimit.ts: `now`, the
// meta accessors, the child runner and the uploader all arrive as arguments, so
// every failure path DEPLOYMENT.md describes is a fast unit test rather than
// something you can only see on a live server at 4am.
//
// `scripts/backup.mjs` already takes a correct snapshot — VACUUM INTO, reopen,
// integrity_check, count players, prune — and exits non-zero on any failure.
// What was missing is that nothing ran it, and it ships nothing anywhere by
// explicit design. This is the thing that runs it.

import fs from 'node:fs';

import type { S3Target } from './s3';

/**
 * How often the tick FIRES, which is not how often a backup happens.
 *
 * The distinction is the whole design. A `setInterval(…, 24h)` may never fire
 * once: this project force-refreshes every session on every deployment
 * (server/build.ts), deployments restart the process, and a 24-hour timer that
 * is restarted every few hours never elapses. So the schedule is persisted and
 * the timer only asks "is it due yet".
 */
export const BACKUP_CHECK_MS = 15 * 60 * 1000;

/**
 * How long after boot the first check happens.
 *
 * Not zero: boot is when migrations run, the bot roster seeds and the reconnect
 * stampede lands. Two minutes is still well inside the window an operator
 * watches a deploy, which is the point — a misconfiguration should be visible
 * while they are still looking.
 */
export const BACKUP_BOOT_DELAY_MS = 2 * 60 * 1000;

/**
 * The floor between two ATTEMPTS, which is what rate-limits the log.
 *
 * `backup_attempt_at` is stamped before the child runs, so a standing
 * misconfiguration produces at most 24 failure lines a day rather than 96, and
 * a container crash-looping every 30 seconds attempts at most hourly. That is
 * why there is no de-duplicating log suppression anywhere below: this is it.
 */
export const BACKUP_RETRY_MS = 60 * 60 * 1000;

/** A vacuum that outlives this is not going to finish. */
export const BACKUP_CHILD_TIMEOUT_MS = 10 * 60 * 1000;

export const DEFAULT_BACKUP_KEEP = 14;
export const DEFAULT_BACKUP_INTERVAL_HOURS = 24;

export const META_ATTEMPT = 'backup_attempt_at';
export const META_OK = 'backup_ok_at';
export const META_UPLOAD_OK = 'backup_upload_ok_at';

export interface BackupConfig {
  enabled: boolean;
  dir: string;
  keep: number;
  intervalMs: number;
  scriptPath: string | null;
  /** Null when offsite is off. The secret is NOT here — see below. */
  target: S3Target | null;
  /**
   * Kept apart from `target` on purpose, and it is not cosmetic.
   *
   * A `toJSON()` that hides a field does NOT hide it from
   * `console.error('…', obj)`, which goes through `util.inspect` and ignores
   * `toJSON` entirely. The only reliable way for a secret not to appear in a
   * logged object is for it not to be in the object.
   */
  secret: string | null;
  /** Shape problems found at boot. Printed once; the uploader stays off. */
  problems: string[];
}

export interface DueInput {
  lastOkAt: number | null;
  lastAttemptAt: number | null;
  now: number;
  intervalMs: number;
  retryFloorMs: number;
}

export type DueVerdict =
  | { run: true; reason: 'first' | 'due' | 'clock-went-backwards' | 'stamp-unreadable' }
  | { run: false; reason: 'not-due' | 'retry-floor' };

/**
 * Should a backup run right now?
 *
 * Returns a REASON rather than a boolean, which is what makes the tests worth
 * having: `run === true` cannot tell "the interval elapsed" from "the clock
 * jumped backwards", and those are different bugs.
 *
 * Two of these branches exist because their absence stops backups silently and
 * PERMANENTLY, which is the worst failure this file can have — worse than not
 * shipping the feature, because the boot line would go on claiming it is armed:
 *
 *  - **A backward clock jump** makes `now - lastOkAt` negative, and a plain
 *    `since >= intervalMs` reads that as *never due* forever after. NTP
 *    correcting a container that booted with a wrong clock is the ordinary way
 *    in.
 *  - **An unreadable stamp** (a truncated write, a hand-edited row) parses to
 *    `NaN`, and `NaN >= interval` is false *and* `NaN < 0` is false — so an
 *    implementation that adds only the backward-jump guard still stops dead.
 */
export function backupDue(input: DueInput): DueVerdict {
  const { lastOkAt, lastAttemptAt, now, intervalMs, retryFloorMs } = input;

  // The attempt floor is checked FIRST, so a failing backup cannot be retried
  // every tick — including on the very first run, where lastOkAt is null and
  // every other branch below would say "go".
  if (lastAttemptAt !== null && Number.isFinite(lastAttemptAt)) {
    const sinceAttempt = now - lastAttemptAt;
    if (sinceAttempt >= 0 && sinceAttempt < retryFloorMs) return { run: false, reason: 'retry-floor' };
  }

  if (lastOkAt === null) return { run: true, reason: 'first' };
  if (!Number.isFinite(lastOkAt)) return { run: true, reason: 'stamp-unreadable' };

  const since = now - lastOkAt;
  if (since < 0) return { run: true, reason: 'clock-went-backwards' };
  return since >= intervalMs ? { run: true, reason: 'due' } : { run: false, reason: 'not-due' };
}

const flag = (v: string | undefined): boolean => v === '1' || v === 'true' || v === 'yes';

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * Read the whole configuration out of an environment, reporting what is wrong.
 *
 * Takes `env` as a parameter and never touches `process.env`, for the same
 * reason `rateLimit.ts` takes `now`: a rule you can only observe through a
 * live process is a rule nobody tests.
 *
 * Deliberately NOT falling back to `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`:
 * a CI runner or a host that happens to carry ambient AWS credentials would
 * otherwise silently begin uploading the player database somewhere.
 */
export function readBackupConfig(env: NodeJS.ProcessEnv): BackupConfig {
  const problems: string[] = [];
  const enabled = flag(env.BACKUP_ENABLED);

  const dir = env.BACKUP_DIR || '';
  if (enabled && !dir) problems.push('BACKUP_ENABLED is set but BACKUP_DIR is empty.');

  const keepRaw = Number(env.BACKUP_KEEP);
  const keep = Number.isFinite(keepRaw) && keepRaw >= 1 ? Math.floor(keepRaw) : DEFAULT_BACKUP_KEEP;

  const hoursRaw = Number(env.BACKUP_INTERVAL_HOURS);
  let hours = DEFAULT_BACKUP_INTERVAL_HOURS;
  if (env.BACKUP_INTERVAL_HOURS !== undefined && env.BACKUP_INTERVAL_HOURS !== '') {
    // Zero would back up on every tick, which is not a configuration anybody
    // wants and is an easy typo. Refused rather than clamped, so it is said out
    // loud instead of silently becoming something else.
    if (!Number.isFinite(hoursRaw) || hoursRaw <= 0) {
      problems.push(`BACKUP_INTERVAL_HOURS must be a positive number (got "${env.BACKUP_INTERVAL_HOURS}").`);
    } else {
      hours = hoursRaw;
    }
  }

  const endpoint = env.BACKUP_S3_ENDPOINT || '';
  const bucket = env.BACKUP_S3_BUCKET || '';
  const accessKeyId = env.BACKUP_S3_ACCESS_KEY_ID || '';
  const secretAccessKey = env.BACKUP_S3_SECRET_ACCESS_KEY || '';

  let target: S3Target | null = null;
  let secret: string | null = null;

  if (endpoint) {
    let url: URL | null = null;
    try {
      url = new URL(endpoint);
    } catch {
      problems.push(`BACKUP_S3_ENDPOINT is not a URL (got "${endpoint}").`);
    }
    if (url && url.protocol !== 'https:' && !flag(env.BACKUP_S3_ALLOW_INSECURE)) {
      // SigV4 never puts the secret on the wire, so this is not about the
      // credential — the OBJECT is the entire player database, and over plain
      // HTTP it crosses the network in the clear.
      problems.push('BACKUP_S3_ENDPOINT must be https: (set BACKUP_S3_ALLOW_INSECURE=1 only for a local test server).');
      url = null;
    }
    if (!bucket) problems.push('BACKUP_S3_ENDPOINT is set but BACKUP_S3_BUCKET is empty.');
    else if (!BUCKET_RE.test(bucket)) problems.push(`BACKUP_S3_BUCKET is not a valid bucket name (got "${bucket}").`);
    // Named individually, because "credentials are wrong" sends an operator
    // looking at the wrong one half the time.
    if (!accessKeyId) problems.push('BACKUP_S3_ENDPOINT is set but BACKUP_S3_ACCESS_KEY_ID is empty.');
    if (!secretAccessKey) problems.push('BACKUP_S3_ENDPOINT is set but BACKUP_S3_SECRET_ACCESS_KEY is empty.');

    if (url && bucket && BUCKET_RE.test(bucket) && accessKeyId && secretAccessKey) {
      const prefix = env.BACKUP_S3_PREFIX === undefined ? 'phong/' : env.BACKUP_S3_PREFIX;
      target = {
        endpoint: url.origin,
        bucket,
        region: env.BACKUP_S3_REGION || 'us-east-1',
        prefix,
        accessKeyId,
        sessionToken: env.BACKUP_S3_SESSION_TOKEN || null,
        virtualHost: flag(env.BACKUP_S3_VIRTUAL_HOST),
        unsignedPayload: flag(env.BACKUP_S3_UNSIGNED_PAYLOAD),
        sse: env.BACKUP_S3_SSE || null,
      };
      secret = secretAccessKey;
    }
  }

  return {
    enabled,
    dir,
    keep,
    intervalMs: hours * 60 * 60 * 1000,
    scriptPath: env.BACKUP_SCRIPT || null,
    target,
    secret,
    problems,
  };
}

export interface SnapshotResult {
  ok: boolean;
  /** Absolute path of the file that appeared, when one did. */
  created: string | null;
  detail: string;
}

export interface UploadResult {
  ok: boolean;
  status: number | null;
  code: string | null;
  detail: string;
}

export interface BackupDeps {
  now: () => number;
  getMeta: (key: string) => string | null;
  setMeta: (key: string, value: string) => void;
  runSnapshot: (cfg: BackupConfig) => Promise<SnapshotResult>;
  upload: (file: string, target: S3Target, secret: string) => Promise<UploadResult>;
  log: (line: string) => void;
  warn: (line: string) => void;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/** Guards against a vacuum that outlives a tick being started twice. */
let running = false;

/** Test-only: the module-level guard would otherwise leak between cases. */
export function resetBackupTickGuard(): void {
  running = false;
}

/**
 * One check. Takes a snapshot if one is due, ships it if there is anywhere to
 * ship it, and records what happened.
 *
 * **This function may never reject.** `server.ts` registers
 * `process.on('unhandledRejection', onFatal)`, and `onFatal` closes every
 * socket and exits — so an uncaught throw in here is a production outage caused
 * by a backup. Everything is wrapped, and the tests assert that a `runSnapshot`
 * or `upload` which REJECTS (rather than resolving false) still leaves this
 * resolved.
 */
export async function runBackupTick(cfg: BackupConfig, deps: BackupDeps): Promise<void> {
  if (!cfg.enabled || running) return;

  const verdict = backupDue({
    lastOkAt: num(deps.getMeta(META_OK)),
    lastAttemptAt: num(deps.getMeta(META_ATTEMPT)),
    now: deps.now(),
    intervalMs: cfg.intervalMs,
    retryFloorMs: BACKUP_RETRY_MS,
  });
  if (!verdict.run) return;

  running = true;
  try {
    // Stamped BEFORE the work, so a failure cannot be retried every tick.
    deps.setMeta(META_ATTEMPT, String(deps.now()));

    let snapshot: SnapshotResult;
    try {
      snapshot = await deps.runSnapshot(cfg);
    } catch (e) {
      deps.warn(`[backup] snapshot threw: ${(e as Error)?.message ?? e}`);
      return;
    }
    if (!snapshot.ok) {
      deps.warn(`[backup] snapshot failed: ${snapshot.detail}`);
      return;
    }

    // A verified snapshot on disk IS a successful backup. Stamped here, before
    // any upload is attempted, because a broken bucket must not make the
    // scheduler re-run a vacuum it cannot fix — and must not make the boot line
    // claim there is no local backup when there is one.
    deps.setMeta(META_OK, String(deps.now()));
    deps.log(`[backup] ${snapshot.detail}`);

    if (!cfg.target || !cfg.secret || !snapshot.created) return;

    let upload: UploadResult;
    try {
      upload = await deps.upload(snapshot.created, cfg.target, cfg.secret);
    } catch (e) {
      deps.warn(
        `[backup] offsite upload threw: ${(e as Error)?.message ?? e} — ` +
          `snapshot is on disk at ${snapshot.created}`
      );
      return;
    }
    if (!upload.ok) {
      deps.warn(
        `[backup] offsite upload failed (${upload.status ?? 'no response'}${upload.code ? ` ${upload.code}` : ''}) — ` +
          `snapshot is on disk at ${snapshot.created}`
      );
      return;
    }
    deps.setMeta(META_UPLOAD_OK, String(deps.now()));
    deps.log(`[backup] offsite ${upload.detail}`);
  } finally {
    running = false;
  }
}

export interface DirProbe {
  /** Whether BACKUP_DIR could be created and written. */
  dirWritable: boolean;
  dirError: string | null;
  /**
   * Whether BACKUP_DIR sits on the same filesystem as DATA_DIR.
   *
   * The check that actually catches the primary deployment. The Dockerfile does
   * `mkdir -p /backups && chown node`, so an UNMOUNTED /backups is writable in
   * the image layer: the backup appears to work and is thrown away on every
   * deploy. A path comparison cannot see that — `scripts/backup.mjs` only
   * refuses paths inside DATA_DIR — but device numbers can.
   */
  sameDeviceAsData: boolean;
}

/**
 * Can we write there, and is it the same disk as the data?
 *
 * The only impure function in this file, and it is here rather than in
 * server.ts so the check that actually catches the primary deployment is a
 * fast test instead of something only a live container can show.
 */
export function probeBackupDir(dir: string, dataDir: string): DirProbe {
  let dirWritable = false;
  let dirError: string | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    dirWritable = true;
  } catch (e) {
    dirError = (e as Error)?.message ?? String(e);
  }

  // Device numbers, not a path comparison. `scripts/backup.mjs` already
  // refuses a destination INSIDE DATA_DIR, and that is a different question:
  // /backups and /data are different paths on the same disk whenever the mount
  // is missing, which is precisely the case that looks like it is working.
  let sameDeviceAsData = false;
  try {
    sameDeviceAsData = fs.statSync(dir).dev === fs.statSync(dataDir).dev;
  } catch {
    /* one of them does not exist — nothing to compare, and the writability
       line above already says so if it is the backup directory. */
  }

  return { dirWritable, dirError, sameDeviceAsData };
}

export interface ReadinessFacts extends DirProbe {
  lastOkAt: number | null;
  lastUploadOkAt: number | null;
}

const ago = (at: number | null, now: number): string => {
  if (at === null || !Number.isFinite(at)) return 'never';
  const mins = Math.max(0, Math.round((now - at) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

/**
 * What to print at boot, so an operator learns backups are off or broken while
 * they are watching the deploy — rather than on the day they need a restore.
 *
 * Deliberately NOT exposed on `/api/health`: that route is unauthenticated and
 * unmetered, and the bucket name plus the time of the last backup is free
 * reconnaissance. `server/admin.ts` is the place for a machine-readable
 * version, and it is already read-only by design.
 */
export function readinessLines(
  cfg: BackupConfig,
  facts: ReadinessFacts,
  now: number
): { info: string[]; warn: string[] } {
  const info: string[] = [];
  const warn: string[] = [];

  for (const p of cfg.problems) warn.push(`[backup] ${p}`);

  if (!cfg.enabled) {
    warn.push('[backup] scheduler OFF (BACKUP_ENABLED unset). Snapshots are manual: npm run db:backup.');
    return { info, warn };
  }

  if (!facts.dirWritable) {
    warn.push(`[backup] cannot write to ${cfg.dir}${facts.dirError ? `: ${facts.dirError}` : ''} — no snapshots will be taken.`);
  } else {
    const hours = Math.round(cfg.intervalMs / 3600000);
    info.push(
      `[backup] on: ${cfg.dir}, keep ${cfg.keep}, every ${hours}h. ` +
        `First check in ${Math.round(BACKUP_BOOT_DELAY_MS / 60000)}m.`
    );
    if (facts.sameDeviceAsData) {
      warn.push(
        '[backup] WARNING: BACKUP_DIR is on the same filesystem as DATA_DIR — a volume loss takes both, ' +
          'and an unmounted /backups is thrown away on every deploy.'
      );
    }
  }

  if (cfg.target) {
    const style = cfg.target.virtualHost ? 'virtual-host' : 'path-style';
    info.push(
      `[backup] offsite: s3://${cfg.target.bucket}/${cfg.target.prefix} @ ` +
        `${cfg.target.endpoint} (${style}, ${cfg.target.region})`
    );
  } else {
    warn.push(
      '[backup] offsite: OFF (BACKUP_S3_ENDPOINT unset) — a backup that never leaves the host is not a backup.'
    );
  }

  info.push(
    `[backup] last verified snapshot ${ago(facts.lastOkAt, now)}; ` +
      `last offsite upload ${ago(facts.lastUploadOkAt, now)}.`
  );
  return { info, warn };
}
