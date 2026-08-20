#!/usr/bin/env node
// Relay load test: N concurrent matches, each with two clients exchanging
// paddle updates at ~30Hz plus periodic net crossings and points, for a
// fixed duration. Reports delivery counts and relay latency percentiles.
//
// Usage: node scripts/load-test.mjs [rooms] [seconds] [url]
//   defaults: 10 rooms, 20 seconds, ws://localhost:3000/ws

import WebSocket from 'ws';

const ROOMS = Number(process.argv[2]) || 10;
const SECONDS = Number(process.argv[3]) || 20;
const URL = process.argv[4] || 'ws://localhost:3000/ws';

const PADDLE_HZ = 30;
const CROSS_EVERY_MS = 900; // one net crossing per ~rally beat
const POINT_EVERY_MS = 7000;

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

console.log(`Starting ${ROOMS} concurrent matches for ${SECONDS}s against ${URL}`);

const pairs = [];
for (let i = 0; i < ROOMS; i++) {
  const a = await open();
  a.sendJ({ type: 'create_room', playerId: `load_a_${i}`, playerName: `HostBot${i}` });
  const { roomId } = await waitFor(a, 'room_created');
  const b = await open();
  b.sendJ({ type: 'join_room', roomId, playerId: `load_b_${i}`, playerName: `JoinBot${i}` });
  await waitFor(b, 'room_joined');
  await waitFor(a, 'game_start');
  pairs.push({ a, b, roomId });
}
console.log(`All ${ROOMS} rooms running.`);

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

console.log('--- results ---');
console.log(`paddle msgs:  sent ${paddleSent}, delivered ${paddleReceived} (${paddleLoss}% loss)`);
console.log(`net crossings: sent ${crossSent}, delivered ${crossReceived} (${crossLoss}% loss)`);
console.log(`ping samples: ${latencies.length}, p50 ${pct(50)}ms, p95 ${pct(95)}ms, max ${latencies[latencies.length - 1] ?? 0}ms`);
console.log(`server errors: ${errors}`);

for (const { a, b } of pairs) {
  a.close();
  b.close();
}

const ok = Number(crossLoss) === 0 && Number(paddleLoss) < 1 && pct(95) < 100 && errors === 0;
console.log(ok ? 'LOAD TEST PASSED' : 'LOAD TEST FAILED');
process.exit(ok ? 0 : 1);
