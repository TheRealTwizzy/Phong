#!/usr/bin/env node
// Play-bots actually PLAY: the claim the whole feature rests on, end to end.
//
// Two bots sit down at one table through the real lobby handshake, run their
// own halves, cross the net over the wire, and the relay records the result
// onto both accounts like any other duel. Nothing about that can be asserted
// from the fast layer — `wss` lives inside `startServer`, so a bot is
// observable only the way a player observes one — and it takes about a minute
// of wall clock, because a first-to-5 between two bots is a real match.
//
// A minute is why this is here rather than in tests/: the fast layer runs on
// every change, and the e2e job exists precisely for the checks that cost
// minutes. tests/botPlayers.test.ts keeps the parts that are instant (tables
// appear, a control server with the population off shows none, the caps hold).
//
// This suite OWNS ITS SERVER, because the runner's shared one is started
// without PLAY_BOTS and the population is off unless asked for.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => {
  console.error('FAIL:', m);
  process.exit(1);
};
const ok = (m) => console.log('  ✓', m);

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-e2e-bots-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const server = spawn('node', ['dist/server.cjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'production', PLAY_BOTS: '4' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

const stop = () => {
  try { process.kill(-server.pid, 'SIGKILL'); } catch { try { server.kill('SIGKILL'); } catch {} }
  fs.rmSync(dataDir, { recursive: true, force: true });
};
process.on('exit', stop);

console.log(`play-bots against ${base}`);

let healthy = false;
for (let i = 0; i < 120 && !healthy; i++) {
  try { healthy = (await fetch(`${base}/api/health`)).ok; } catch { /* still booting */ }
  if (!healthy) await sleep(500);
}
if (!healthy) fail(`server never became healthy\n--- server ---\n${log.slice(-3000)}`);

if (!log.includes('[bots]')) fail(`the population never started\n--- server ---\n${log.slice(-3000)}`);
ok('the play-bot population started');

/** Every bot row on the board, which is where a player would see them move. */
async function botRows() {
  const res = await fetch(`${base}/api/leaderboard?sort=level&limit=50&bots=1`);
  if (!res.ok) throw new Error(`leaderboard: ${res.status}`);
  const body = await res.json();
  return (body.leaderboard ?? []).filter((e) => e.isBot);
}

// A DELTA, never an absolute. The roster is seeded with a career, so "this bot
// has played matches" is true the instant the database exists and would pass
// without a single ball being struck.
const before = new Map((await botRows()).map((r) => [r.id, r.matchesPlayed]));
if (before.size === 0) fail('no bot rows on the board at all');

let moved = [];
for (let i = 0; i < 150 && moved.length < 2; i++) {
  await sleep(2000);
  moved = (await botRows()).filter((r) => (before.get(r.id) ?? 0) < r.matchesPlayed);
}

if (moved.length < 2) {
  fail(
    `bots never completed a match: ${moved.length} of ${before.size} rows moved\n` +
    `--- server ---\n${log.slice(-3000)}`
  );
}
// Two, not one: a duel writes a row for BOTH seats, so one moving alone would
// mean the relay recorded half a match.
ok(`${moved.length} bots completed and recorded a match`);

const winners = moved.filter((r) => r.matchesWon > 0);
if (winners.length === 0) fail('a match was recorded but nobody won it');
ok('the result named a winner');

// Nothing threw on the way. A bot handler that throws is caught and logged
// rather than taking the relay down, which is right — and would otherwise make
// this suite pass while the population quietly did nothing useful.
if (log.includes('[bots] handler threw')) {
  fail(`a bot message handler threw:\n${log.split('\n').filter((l) => l.includes('threw')).slice(0, 5).join('\n')}`);
}
ok('no bot handler threw');

console.log('play-bots passed');
