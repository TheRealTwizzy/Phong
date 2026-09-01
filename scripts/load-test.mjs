#!/usr/bin/env node
// Relay load test: N concurrent matches, each with two clients exchanging
// paddle updates at ~30Hz plus periodic net crossings and points, for a
// fixed duration. Reports delivery counts and relay latency percentiles.
//
// Usage: node scripts/load-test.mjs [rooms] [seconds] [url]
//   defaults: 10 rooms, 20 seconds, ws://localhost:3000/ws
//
// This script silently STOPPED WORKING when the lobby handshake landed: it
// waited for a `game_start` that no longer follows a join, having sent neither
// `player_ready` nor `start_match`, so it died on the first pair. Nothing
// noticed, for however long that was, while a capacity number nobody could
// reproduce sat in two documents — `lint:suites` covers only `e2e-*.mjs`,
// `npm test` never touches this file, `tsc` does not check `.mjs`, and CI
// never invoked it.
//
// So it is now exercised at SMOKE SCALE by `scripts/e2e-load.mjs`, which is a
// registered suite. That is the part that matters: a repaired script with
// nothing running it is a script that will rot again.

import WebSocket from 'ws';

const isMain = import.meta.url === `file://${process.argv[1]}`;

const PADDLE_HZ = 30;
const CROSS_EVERY_MS = 900; // one net crossing per ~rally beat
const POINT_EVERY_MS = 7000;

export async function runLoadTest({ rooms: ROOMS, seconds: SECONDS, url: URL, quiet = false } = {}) {
const log = quiet ? () => {} : console.log;
const latencies = [];
let paddleSent = 0;
let paddleReceived = 0;
let crossSent = 0;
let crossReceived = 0;
let errors = 0;

const open = () =>
  new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => res(ws));
    ws.on('error', (e) => rej(e));
    ws.messages = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      ws.messages.push(m);
      if (m.type === 'opponent_paddle') paddleReceived++;
      if (m.type === 'ball_incoming') {
        crossReceived++;
        // sender stashed a timestamp in speedMultiplier's fraction? No —
        // measure via ping instead; ball payload stays realistic.
      }
      if (m.type === 'pong') latencies.push(Date.now() - m.timestamp);
      if (m.type === 'error') errors++;
    });
    ws.sendJ = (o) => ws.send(JSON.stringify(o));
  });

const waitFor = (ws, type, ms = 5000) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = ws.messages.find((x) => x.type === type);
      if (m) {
        clearInterval(iv);
        res(m);
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        rej(new Error(`timeout waiting for ${type}`));
      }
    }, 20);
  });

log(`Starting ${ROOMS} concurrent matches for ${SECONDS}s against ${URL}`);

const pairs = [];
for (let i = 0; i < ROOMS; i++) {
  const a = await open();
  // No `playerName`: the relay resolves display names from the device cookie
  // and stopped reading a client-sent one. Sending it was harmless and stale.
  a.sendJ({ type: 'create_room', playerId: `load_a_${i}` });
  const { roomId } = await waitFor(a, 'room_created');
  const b = await open();
  b.sendJ({ type: 'join_room', roomId, playerId: `load_b_${i}` });
  await waitFor(b, 'room_joined');
  // A duel starts by HANDSHAKE: the guest readies, then the host starts, and
  // the server-broadcast `game_start` is what closes both lobbies. Joining has
  // not started a match since that landed, which is what broke this script.
  b.sendJ({ type: 'player_ready', ready: true });
  await waitFor(a, 'ready_state');
  a.sendJ({ type: 'start_match' });
  await waitFor(a, 'game_start');
  await waitFor(b, 'game_start');
  pairs.push({ a, b, roomId });
}
log(`All ${ROOMS} rooms running.`);

const timers = [];
for (const { a, b } of pairs) {
  for (const ws of [a, b]) {
    timers.push(
      setInterval(() => {
        ws.sendJ({ type: 'paddle_move', x: Math.random() });
        paddleSent++;
      }, 1000 / PADDLE_HZ)
    );
    timers.push(
      setInterval(() => {
        ws.sendJ({
          type: 'ball_cross_net',
          ball: { x: Math.random(), vx: 0.3, vy: -0.9, spin: 0.1, speedMultiplier: 1.2 },
        });
        crossSent++;
      }, CROSS_EVERY_MS)
    );
    timers.push(setInterval(() => ws.sendJ({ type: 'ping', timestamp: Date.now() }), 1000));
  }
  timers.push(
    setInterval(() => {
      a.sendJ({ type: 'point_scored', scorer: Math.random() < 0.5 ? 'p1' : 'p2' });
    }, POINT_EVERY_MS)
  );
}

await new Promise((r) => setTimeout(r, SECONDS * 1000));
timers.forEach(clearInterval);
await new Promise((r) => setTimeout(r, 500)); // drain in-flight messages

latencies.sort((x, y) => x - y);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0;
const paddleLoss = paddleSent ? (((paddleSent - paddleReceived) / paddleSent) * 100).toFixed(2) : '0';
const crossLoss = crossSent ? (((crossSent - crossReceived) / crossSent) * 100).toFixed(2) : '0';

log('--- results ---');
log(`paddle msgs:  sent ${paddleSent}, delivered ${paddleReceived} (${paddleLoss}% loss)`);
log(`net crossings: sent ${crossSent}, delivered ${crossReceived} (${crossLoss}% loss)`);
log(`ping samples: ${latencies.length}, p50 ${pct(50)}ms, p95 ${pct(95)}ms, max ${latencies[latencies.length - 1] ?? 0}ms`);
log(`server errors: ${errors}`);

for (const { a, b } of pairs) {
  a.close();
  b.close();
}

const ok = Number(crossLoss) === 0 && Number(paddleLoss) < 1 && pct(95) < 100 && errors === 0;
log(ok ? 'LOAD TEST PASSED' : 'LOAD TEST FAILED');
return {
  ok,
  rooms: ROOMS,
  paddleSent,
  paddleReceived,
  crossSent,
  crossReceived,
  errors,
  p50: pct(50),
  p95: pct(95),
};
}

if (isMain) {
  const result = await runLoadTest({
    rooms: Number(process.argv[2]) || 10,
    seconds: Number(process.argv[3]) || 20,
    url: process.argv[4] || 'ws://localhost:3000/ws',
  });
  process.exit(result.ok ? 0 : 1);
}
