#!/usr/bin/env node
/**
 * Take a consistent backup of the player database, and prove it is readable.
 *
 * `VACUUM INTO` is the right primitive and is why this is safe against a
 * running server: it takes a read transaction, so WAL readers never block the
 * writer and the copy is a single consistent snapshot with the WAL already
 * folded in. Copying phong.db with `cp` is NOT equivalent — it races the WAL
 * and can produce a file that opens but is missing the most recent writes.
 *
 * The destination defaults OUTSIDE DATA_DIR, and that is the point rather than
 * a detail: a backup written next to the database it protects is lost with the
 * volume it sits on, which is the failure it exists for. On Render that volume
 * is also 1GB with no retention, so accumulating snapshots there eventually
 * takes the live database down too.
 *
 *   node scripts/backup.mjs [--out DIR] [--keep N]
 *
 * DATA_DIR   where phong.db lives          (default ./data)
 * BACKUP_DIR where snapshots are written   (default ./backups)
 *
 * Exits non-zero on any failure, so cron/CI notices. Run it from a scheduler
 * and copy the result off the host — this script does not ship anything
 * anywhere, deliberately: where your backups belong is a deployment decision.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const dbFile = path.join(dataDir, 'phong.db');
const outDir = path.resolve(arg('--out', process.env.BACKUP_DIR || path.join(process.cwd(), 'backups')));
const keep = Math.max(1, parseInt(arg('--keep', '14'), 10) || 14);

if (!fs.existsSync(dbFile)) {
  console.error(`[backup] no database at ${dbFile} — is DATA_DIR right?`);
  process.exit(1);
}
// Equality as well as descent. `startsWith(dataDir + sep)` alone is false when
// --out resolves to DATA_DIR ITSELF, which is the likeliest way to get this
// wrong by hand and the one that lands the snapshot directly beside phong.db —
// the exact outcome the check exists to refuse.
const dataAbs = path.resolve(dataDir);
if (outDir === dataAbs || outDir.startsWith(dataAbs + path.sep)) {
  console.error(`[backup] refusing to write inside DATA_DIR (${dataDir}).`);
  console.error('[backup] a backup on the volume it protects is lost with it. Pass --out.');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(outDir, `phong-${stamp}.db`);

let src;
try {
  src = new DatabaseSync(dbFile, { readOnly: true });
  // Bound as a value would be simpler, but VACUUM INTO takes a literal.
  src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
} catch (e) {
  console.error('[backup] VACUUM INTO failed:', e?.message);
  process.exit(1);
} finally {
  try { src?.close(); } catch {}
}

// A backup nobody has opened is a backup nobody knows is good. This is the
// step the documented manual procedure never had.
let players = 0;
try {
  const check = new DatabaseSync(dest, { readOnly: true });
  const integrity = check.prepare('PRAGMA integrity_check').get();
  const verdict = Object.values(integrity ?? {})[0];
  if (verdict !== 'ok') throw new Error(`integrity_check said: ${verdict}`);
  players = check.prepare('SELECT COUNT(*) AS n FROM players').get().n;
  check.close();
} catch (e) {
  console.error('[backup] the snapshot did not verify:', e?.message);
  console.error(`[backup] leaving ${dest} in place for inspection.`);
  process.exit(1);
}

const bytes = fs.statSync(dest).size;
console.log(`[backup] ${dest} — ${(bytes / 1024).toFixed(0)}KB, ${players} player row(s), integrity ok`);

// Prune oldest-first, and only ever files this script made.
const mine = fs.readdirSync(outDir).filter((f) => /^phong-.*\.db$/.test(f)).sort();
for (const stale of mine.slice(0, Math.max(0, mine.length - keep))) {
  fs.unlinkSync(path.join(outDir, stale));
  console.log(`[backup] pruned ${stale}`);
}
