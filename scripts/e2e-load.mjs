#!/usr/bin/env node
// The relay load test, at SMOKE SCALE, as a registered suite.
//
// `scripts/load-test.mjs` silently stopped working when the lobby handshake
// landed — it waited for a `game_start` that no longer follows a join — and
// nothing noticed for however long that was, while a capacity number nobody
// could reproduce sat in two documents. `lint:suites` covers only
// `e2e-*.mjs`, `npm test` never touches it, `tsc` does not check `.mjs`, and
// CI never invoked it.
//
// Repairing the script does not fix that. THIS is the fix: a registered suite
// that drives it against a real server on every CI run, so the next protocol
// change that breaks it breaks a build instead of a claim in a document.
//
// Two rooms and three seconds, deliberately. This is not a capacity
// measurement — it asserts the script still completes a match end to end.
// Real numbers come from running load-test.mjs directly, at a scale worth
// quoting, on hardware worth quoting.

import { runLoadTest } from './load-test.mjs';

const BASE = process.env.E2E_URL || 'http://localhost:3000';
const WS = `${BASE.replace(/^http/, 'ws')}/ws`;

const fail = (m) => {
  console.error('FAIL:', m);
  process.exit(1);
};
const ok = (m) => console.log('  ✓', m);

console.log(`load smoke against ${WS}`);

let result;
try {
  result = await runLoadTest({ rooms: 2, seconds: 3, url: WS, quiet: true });
} catch (e) {
  // The original failure mode, and the one this suite exists to catch: the
  // handshake changed and the script timed out waiting for a message the
  // relay no longer sends unprompted.
  fail(`the load test could not seat a match: ${e.message}`);
}

if (result.rooms !== 2) fail(`expected 2 rooms, ran ${result.rooms}`);
ok('two matches were seated through the real lobby handshake');

// Traffic actually moved. Zero delivered would mean the sockets connected and
// the relay dropped everything — which a "did it throw" check cannot see.
if (result.paddleSent === 0) fail('no paddle updates were sent');
if (result.paddleReceived === 0) fail('no paddle updates were delivered to the opponent');
if (result.crossSent === 0) fail('no net crossings were sent');
if (result.crossReceived === 0) fail('no net crossings were delivered');
ok(`relayed ${result.paddleReceived} paddle updates and ${result.crossReceived} net crossings`);

if (result.errors > 0) fail(`the relay refused ${result.errors} message(s)`);
ok('the relay refused nothing');

// Loss and latency are NOT asserted here. A shared CI runner under a
// concurrency pool is the wrong place to judge either, and a suite that fails
// on someone else's noise gets ignored rather than read.
console.log(`  (p50 ${result.p50}ms, p95 ${result.p95}ms — reported, not asserted)`);
console.log('load smoke passed');
