import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// Nothing writes a `released_devices` row, and the match queue was simplified
// on the strength of that.
//
// A row here is the ONLY thing that makes `resolveSession` (server/auth.ts)
// answer `status: 'released'`. That status is the only thing that renders
// SessionGuard's "start as a new player" wall, which is the only caller of
// `startFreshIdentity` (src/App.tsx), which is the only caller of
// `clearPendingMatches` (src/net/matchRecord.ts). The whole chain hangs off
// one INSERT that does not exist: the table is created, read by the support
// CLI, deleted from, and dropped by every wipe — never inserted into.
// `moveAccount` signs a browser IN rather than moving an account away from
// one, so it DELETES from this table and records membership in `device_links`
// instead; `released` survives only for databases carrying rows from before
// that rework.
//
// A generation counter guarding the on-device match queue against an identity
// change was built over four review rounds and then removed again, because
// the identity change it defended against cannot occur. This test is what
// tells whoever reintroduces device release that the removal was conditional
// on their absence — so the queue hardening comes back deliberately, with it,
// rather than being rediscovered as a bug once players are on the new path.

const SERVER_ROOT = 'server';
const SERVER_FILES = ['server.ts'];

/** Every server-side source file — the only place raw SQL can be written. */
function serverSources(): string[] {
  const out: string[] = [...SERVER_FILES];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name)) out.push(p);
    }
  };
  walk(SERVER_ROOT);
  return out;
}

/**
 * The two verbs that can bring a row into existence, with SQL's whitespace
 * rules rather than a fixed spacing: `INSERT INTO`, `INSERT OR IGNORE INTO`,
 * `INSERT OR REPLACE INTO`, and a bare `REPLACE INTO`. Deliberately not
 * UPDATE — updating a row that is never created still changes nothing.
 */
const ROW_CREATING = /\b(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into)\s+released_devices\b/is;

describe('device release has no writer', () => {
  it.each(serverSources())('%s creates no released_devices row', (file) => {
    expect(ROW_CREATING.test(fs.readFileSync(file, 'utf8'))).toBe(false);
  });

  it('would notice if one were added', () => {
    // The check is only worth having if it can fail, and a regex over source
    // is exactly the kind of assertion that quietly stops matching. Each
    // spelling the real code could use is proved to trip it.
    for (const sql of [
      "INSERT INTO released_devices (deviceId) VALUES (?)",
      "insert into released_devices(deviceId) values (?)",
      "INSERT OR REPLACE INTO released_devices (deviceId) VALUES (?)",
      "INSERT OR IGNORE INTO\n        released_devices (deviceId)",
      "REPLACE INTO released_devices (deviceId) VALUES (?)",
    ]) {
      expect(ROW_CREATING.test(sql)).toBe(true);
    }
    // ...and that the statements the server really does run are not caught.
    for (const sql of [
      'SELECT movedToPlayerId FROM released_devices WHERE deviceId = ?',
      'DELETE FROM released_devices WHERE deviceId = ?',
      'CREATE TABLE IF NOT EXISTS released_devices (',
      'DROP TABLE IF EXISTS released_devices',
    ]) {
      expect(ROW_CREATING.test(sql)).toBe(false);
    }
  });
});
