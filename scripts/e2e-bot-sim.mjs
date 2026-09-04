#!/usr/bin/env node
// The play-bot cost measurement, at SMOKE SCALE, as a registered suite.
//
// `scripts/bot-sim.mjs` produces the numbers quoted in DEPLOYMENT.md, and the
// lesson this repo already learned the hard way with `scripts/load-test.mjs` is
// that a measurement script nothing runs is a measurement that rots while the
// number it produced sits in a document looking authoritative. `lint:suites`
// covers only `e2e-*.mjs`, `npm test` never touches these, `tsc` does not read
// `.mjs`, and CI would never invoke it.
//
// So this drives it tiny on every CI run. It is NOT a capacity measurement and
// asserts no timing — a shared runner under a concurrency pool is the wrong
// place to judge microseconds, and a suite that fails on someone else's noise
// gets ignored rather than read. It asserts that the thing still RUNS: that
// `server/botMatch.ts` still compiles and steps, that `findPair` still takes
// the shape the sweep hands it, and that the harness still reports numbers.
//
// It owns its server because it needs none: this is pure computation.

import { runBotSim } from './bot-sim.mjs';

const fail = (m) => {
  console.error('FAIL:', m);
  process.exit(1);
};
const ok = (m) => console.log('  ✓', m);

console.log('bot-sim smoke');

let r;
try {
  r = await runBotSim({ quick: true, quiet: true });
} catch (e) {
  // The original failure mode this guards: botMatch.ts stops compiling, or an
  // import it needs moves, and the number in DEPLOYMENT.md silently stops
  // being reproducible.
  fail(`the bot simulation could not run: ${e.message}`);
}

if (!r.physics.length) fail('no physics measurements were produced');
ok(`stepped ${r.physics.map((p) => p.n).join(' and ')} concurrent bot matches`);

// A match-tick that costs nothing at all means the loop compiled away or the
// matches ended instantly — either way the number would be a lie.
for (const p of r.physics) {
  if (!(p.perMatchTickNs > 0)) fail(`match-tick cost at N=${p.n} measured as ${p.perMatchTickNs}`);
}
ok('every match-tick did measurable work');

if (!r.wire.length) fail('no wire measurements were produced');
ok('the paddle-stream wire cost was measured');

if (!r.pairing.length) fail('no pairing measurements were produced');
// findPair is O(n^2): a bigger queue must cost more per call. If this ever
// inverts, the sweep is not doing what the pool-sizing decision assumed.
const small = r.pairing[0];
const large = r.pairing[r.pairing.length - 1];
if (!(large.perCallMs >= small.perCallMs)) {
  fail(`findPair got cheaper on a bigger queue (${small.n}: ${small.perCallMs}ms, ${large.n}: ${large.perCallMs}ms)`);
}
ok('findPair still costs more on a longer queue, as the pool sizing assumes');

console.log('bot-sim smoke passed');
