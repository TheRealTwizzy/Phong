/**
 * Read-only support CLI. `node dist/admin.cjs <command>` inside the container.
 *
 * Device-bound identity means "I lost my account" is a permanent category of
 * support request, not a bug that gets fixed once. A browser clears its
 * cookies, a player buys a phone, Safari evicts the jar, someone opens an
 * invitation link in a webview and never goes back — in every case the account
 * is intact and simply unreachable, and the recovery code is the only thing
 * that reunites them. Getting at that code used to mean hand-writing SQL
 * against a live database, which is not a thing to be improvising while
 * someone waits.
 *
 * Deliberately opens the SQLite file directly rather than importing
 * `server/db.ts`. That module's constructor runs migrations and seeds the bot
 * roster as a side effect of being loaded — reasonable for a server booting,
 * indefensible for a support command someone runs to answer a question. This
 * tool has no write path at all: every statement is a SELECT, the handle is
 * opened `readOnly`, and it is safe to run against a live server (SQLite is in
 * WAL mode, so readers never block the writer).
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'phong.db');

/** A row is only ever read; nothing here may write. */
interface PlayerRow {
  id: string;
  username: string;
  recoveryCode: string | null;
  createdAt: string;
  initializedAt: string | null;
  lastActive: string;
  matchesPlayed: number;
  level: number;
  activeSessionId: string | null;
}

const db = new DatabaseSync(DB_FILE, { readOnly: true });
const all = <T>(sql: string, ...args: string[]): T[] => db.prepare(sql).all(...args) as T[];

const PLAYER_COLUMNS =
  'id, username, recoveryCode, createdAt, initializedAt, lastActive, matchesPlayed, level, activeSessionId';

/** Everyone except the curated bot roster, which is not a support concern. */
const humans = (): PlayerRow[] =>
  all<PlayerRow>(`SELECT ${PLAYER_COLUMNS} FROM players`).filter((p) => !p.id.startsWith('bot-'));

const seconds = (a: string, b: string): number => Math.abs((+new Date(a) - +new Date(b)) / 1000);

function find(needle: string): PlayerRow | undefined {
  const people = humans();
  return (
    people.find((p) => p.id === needle) ||
    people.find((p) => p.username.toLowerCase() === needle.toLowerCase())
  );
}

function whois(needle: string): void {
  const p = find(needle);
  if (!p) {
    console.log(`No account matches "${needle}". The username is free.`);
    return;
  }
  const released = all<{ deviceId: string; movedToPlayerId: string; releasedAt: string }>(
    'SELECT deviceId, movedToPlayerId, releasedAt FROM released_devices WHERE deviceId = ? OR movedToPlayerId = ?',
    p.id,
    p.id
  );
  console.log(`${p.username}`);
  console.log(`  device id     ${p.id}`);
  console.log(`  recovery code ${p.recoveryCode ?? '(none)'}`);
  console.log(`  created       ${p.createdAt}`);
  console.log(`  onboarded     ${p.initializedAt ?? 'never — this profile has no username of its own'}`);
  console.log(`  last write    ${p.lastActive}`);
  console.log(`  level ${p.level} · ${p.matchesPlayed} matches`);
  console.log(`  holds session ${p.activeSessionId ? 'yes' : 'no (nobody is playing it right now)'}`);
  console.log(
    `  transfers     ${released.length ? JSON.stringify(released) : 'none — never moved between devices'}`
  );

  // `lastActive` is written by matches, practice, mission claims and renames —
  // never by a read. Equal to `initializedAt` means the account has done
  // nothing at all since the second it was created.
  const untouched = p.initializedAt !== null && p.lastActive === p.initializedAt;
  const siblings = humans()
    .filter((o) => o.id !== p.id && seconds(o.createdAt, p.createdAt) <= 30)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (siblings.length) {
    console.log(`\n  Minted within 30s of this row (${siblings.length}):`);
    for (const s of siblings) {
      console.log(
        `    ${s.id}  ${s.username.padEnd(18)} ${String(Math.round(seconds(s.createdAt, p.createdAt))).padStart(3)}s  ${
          s.initializedAt ? 'onboarded' : 'placeholder, never onboarded'
        }`
      );
    }
  }
  if (untouched && siblings.length) {
    console.log(
      '\n  LIKELY STRANDED: minted alongside other identities and never written to since.\n' +
        '  Give the player the recovery code above; they enter it under "Have a\n' +
        '  recovery code from another device?" in onboarding.'
    );
  }
}

function orphans(): void {
  const people = humans();
  const candidates = people
    .filter((p) => p.initializedAt && p.lastActive === p.initializedAt && p.matchesPlayed === 0)
    .filter((p) => people.some((o) => o.id !== p.id && seconds(o.createdAt, p.createdAt) <= 30))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const placeholders = people.filter((p) => !p.initializedAt);
  console.log(`${people.length} human profiles · ${people.length - placeholders.length} onboarded · ${placeholders.length} never onboarded`);
  console.log(`released devices: ${all<{ n: number }>('SELECT COUNT(*) AS n FROM released_devices')[0].n}\n`);

  if (!candidates.length) {
    console.log('No stranded-looking accounts.');
    return;
  }
  console.log(`${candidates.length} account(s) that look stranded — onboarded, never written to since, and`);
  console.log('minted alongside another identity:\n');
  for (const p of candidates) {
    console.log(`  ${p.username.padEnd(18)} ${p.recoveryCode ?? '(no code)'}  ${p.id}  created ${p.createdAt}`);
  }
  console.log(
    '\nThis is circumstantial, not proof: a player who onboarded and never came back\n' +
      'looks identical from here. The server cannot see which cookie a browser holds.\n' +
      'Confirm with the player before handing a code over — it transfers the account.'
  );
}

const [command, argument] = process.argv.slice(2);
switch (command) {
  case 'whois':
    if (!argument) {
      console.error('usage: node dist/admin.cjs whois <username|deviceId>');
      process.exit(2);
    }
    whois(argument);
    break;
  case 'orphans':
    orphans();
    break;
  default:
    console.log(`Phong support CLI — read-only, safe to run against a live server.

  node dist/admin.cjs whois <username|deviceId>   one account: recovery code, history, verdict
  node dist/admin.cjs orphans                     accounts that look unreachable

Reading from ${DB_FILE} (override with DATA_DIR or DB_FILE).

A recovery code transfers the account to whoever enters it, so treat one like a
password: confirm who you are talking to, and send it over a channel you trust.`);
}
db.close();
