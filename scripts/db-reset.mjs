#!/usr/bin/env node
// Manual full database reset: permanently deletes every player profile,
// match, avatar, and device identity so the game starts over with 0 players.
// The next server boot recreates a fresh schema (and a fresh auth secret, so
// all previously issued device cookies are retired and every device
// re-onboards).
//
// Usage:  DATA_DIR=/data npm run db:reset -- --yes
//
// Stop the Phong server before running this — deleting the SQLite file (and
// its WAL sidecars) under a live connection can corrupt the new database.

import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const TARGETS = ['phong.db', 'phong.db-wal', 'phong.db-shm', 'game_database.json'];

if (!process.argv.includes('--yes')) {
  console.error(`This PERMANENTLY deletes all player data in ${DATA_DIR}:
  ${TARGETS.join(', ')}

Stop the Phong server first, then confirm with:

  npm run db:reset -- --yes
`);
  process.exit(1);
}

// "Stop the server first" was an instruction in a comment and in the refusal
// message, and nothing checked it. Deleting the SQLite file and its WAL
// sidecars under a live connection is exactly the case that corrupts the new
// database — and the live server keeps writing to a file that no longer has a
// directory entry, so the damage is silent until the next boot.
//
// A `-shm` file is only present while a connection is open, which makes it a
// cheap and accurate liveness signal. Overridable, because a crashed server
// can leave one behind and somebody has to be able to get past it.
const shm = path.join(DATA_DIR, 'phong.db-shm');
if (fs.existsSync(shm) && !process.argv.includes('--force')) {
  console.error(`${shm} exists, which means something has ${path.join(DATA_DIR, 'phong.db')} OPEN.

Deleting the database under a live connection corrupts the one that replaces
it. Stop the Phong server, then run this again.

If the server is definitely stopped and this file is left over from a crash:

  npm run db:reset -- --yes --force
`);
  process.exit(1);
}

let removed = 0;
for (const name of TARGETS) {
  const file = path.join(DATA_DIR, name);
  if (fs.existsSync(file)) {
    fs.rmSync(file);
    console.log(`deleted ${file}`);
    removed++;
  }
}

console.log(
  removed > 0
    ? 'Database reset complete — the next boot starts with 0 players.'
    : `Nothing to delete in ${DATA_DIR} — already clean.`
);
