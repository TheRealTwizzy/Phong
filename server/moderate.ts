/**
 * Moderation CLI. `node /app/dist/moderate.cjs <command>` inside the container.
 *
 * SEPARATE from `admin.cjs`, and that separation is the point. That tool opens
 * the database `readOnly` and says so in its own header — every statement is a
 * SELECT and it is safe to run against a live server while someone waits on
 * the phone. Making it writable to add these three commands would have thrown
 * that guarantee away for every existing use of it. Two binaries, two
 * postures: one answers questions, this one changes things.
 *
 * Absolute path throughout, for the reason admin.ts gives: a shell exec'd into
 * the container starts at `/`, not at WORKDIR, so a relative path reports
 * MODULE_NOT_FOUND and reads as the tool being missing.
 *
 * Like admin.ts, it opens the SQLite file directly rather than importing
 * `server/db.ts`, whose constructor runs migrations and seeds the bot roster
 * as a side effect of being loaded. A moderation command must not reshape the
 * database as a condition of clearing one avatar.
 *
 * Why this exists at all: before it, there was NO way to clear a bad avatar,
 * rename an impersonating account, or read a report — `admin.cjs` is read-only
 * by construction, and the only avatar-removal path in the whole product was
 * the offender's own hands. Avatars are arbitrary player-supplied images
 * served unauthenticated and cached immutable for a year, and a username is
 * locked for 365 days with no override, so "we will fix it later" meant "never".
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { USERNAME_LOCK_DAYS, validateUsername } from '../src/profileRules';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'phong.db');

const db = new DatabaseSync(DB_FILE);

interface PlayerRow {
  id: string;
  username: string;
}

interface ReportRow {
  id: string;
  playerId: string;
  username: string;
  category: string;
  text: string;
  subjectId: string | null;
  context: string;
  createdAt: string;
  readAt: string | null;
}

const find = (needle: string): PlayerRow | undefined => {
  const rows = db
    .prepare(
      `SELECT p.id, p.username FROM players p
        WHERE NOT EXISTS (SELECT 1 FROM bot_accounts b WHERE b.botId = p.id)`
    )
    .all() as unknown as PlayerRow[];
  return (
    rows.find((p) => p.id === needle) ||
    rows.find((p) => p.username.toLowerCase() === needle.toLowerCase())
  );
};

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

/**
 * Drop a player's avatar.
 *
 * Deleting the row is the whole job, and it is worth saying why no cache bust
 * is needed beside it — the first version of this bumped a column that does
 * not exist. `avatarVersion` is not stored: it is DERIVED from
 * `avatars.updatedAt` (server/db.ts), so removing the row makes `hasAvatar`
 * false and the field undefined. Nothing then renders an
 * `/api/avatar/:id?v=…` URL at all, so the copy a browser cached for a year
 * under the old `?v=` is simply never asked for again, and the route itself
 * 404s. The same DELETE the player's own button runs (db.deleteAvatar).
 */
function clearAvatar(needle: string): void {
  const player = find(needle);
  if (!player) fail(`no account matches ${needle}`);
  const removed = db.prepare('DELETE FROM avatars WHERE playerId = ?').run(player!.id);
  console.log(
    removed.changes > 0
      ? `cleared the avatar for ${player!.username} (${player!.id})`
      : `${player!.username} (${player!.id}) had no avatar`
  );
}

/**
 * Rename an account, bypassing the 365-day lock.
 *
 * The lock exists so a name is stable enough to be worth recognising, and it
 * is exactly what makes an impersonating or abusive name unfixable by the
 * player OR by support. This is the override, and it is deliberately here
 * rather than behind a route: a player must not be able to reach it.
 *
 * The old name goes straight back into the pool, which falls out of the unique
 * index covering initialized rows only — the same thing account deletion
 * already relies on.
 */
function rename(needle: string, next: string): void {
  const player = find(needle);
  if (!player) fail(`no account matches ${needle}`);

  const verdict = validateUsername(next);
  if (!verdict.ok) fail(`"${next}" is not a valid username (${verdict.reason})`);

  const taken = db
    .prepare('SELECT id FROM players WHERE lower(username) = lower(?) AND id <> ?')
    .get(next, player!.id);
  if (taken) fail(`"${next}" is already taken`);

  // usernameChangedAt is reset, so the new name gets its own full lock rather
  // than inheriting the remainder of the one being overridden.
  db.prepare('UPDATE players SET username = ?, usernameChangedAt = ? WHERE id = ?')
    .run(next, new Date().toISOString(), player!.id);
  console.log(
    `${player!.username} -> ${next} (${player!.id})\n` +
      `"${player!.username}" is back in the pool; the new name is locked for ${USERNAME_LOCK_DAYS} days.`
  );
}

/** What players have told us, newest first. */
function reports(unreadOnly: boolean, limit: number): void {
  const where = unreadOnly ? 'WHERE readAt IS NULL' : '';
  const rows = db
    .prepare(
      `SELECT id, playerId, username, category, text, subjectId, context, createdAt, readAt
       FROM reports ${where} ORDER BY createdAt DESC LIMIT ?`
    )
    .all(limit) as unknown as ReportRow[];

  if (rows.length === 0) {
    console.log(unreadOnly ? 'no unread reports' : 'no reports');
    return;
  }
  for (const r of rows) {
    console.log(`\n─── ${r.category.toUpperCase()}  ${r.createdAt}  ${r.readAt ? '' : '(unread)'}`);
    console.log(`id       ${r.id}`);
    console.log(`from     ${r.username} (${r.playerId})`);
    if (r.subjectId) console.log(`about    ${r.subjectId}`);
    console.log(`context  ${r.context}`);
    console.log(`\n${r.text}\n`);
  }
  console.log(`${rows.length} report(s). Mark one read: moderate.cjs read <id>`);
}

function markRead(id: string): void {
  const done = db.prepare('UPDATE reports SET readAt = ? WHERE id = ?').run(new Date().toISOString(), id);
  console.log(done.changes > 0 ? `marked ${id} read` : `no report with id ${id}`);
}

const [command, a, b] = process.argv.slice(2);
switch (command) {
  case 'clear-avatar':
    if (!a) fail('usage: node /app/dist/moderate.cjs clear-avatar <username|deviceId>');
    clearAvatar(a);
    break;
  case 'rename':
    if (!a || !b) fail('usage: node /app/dist/moderate.cjs rename <username|deviceId> <newName>');
    rename(a, b);
    break;
  case 'reports':
    reports(a === '--unread', Number(b) > 0 ? Math.min(200, Number(b)) : 20);
    break;
  case 'read':
    if (!a) fail('usage: node /app/dist/moderate.cjs read <reportId>');
    markRead(a);
    break;
  default:
    console.log(`Phong moderation CLI — this one WRITES. See admin.cjs for read-only support.

  node /app/dist/moderate.cjs clear-avatar <username|deviceId>
  node /app/dist/moderate.cjs rename <username|deviceId> <newName>
  node /app/dist/moderate.cjs reports [--unread] [limit]
  node /app/dist/moderate.cjs read <reportId>

Writing to ${DB_FILE} (override with DATA_DIR or DB_FILE).

Safe against a live server: SQLite is in WAL mode, so this does not block it.
An avatar cleared here is gone from the database; the version bump is what
expires the copies browsers already cached for a year.`);
}
db.close();
