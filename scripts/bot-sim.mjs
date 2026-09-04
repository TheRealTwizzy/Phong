#!/usr/bin/env node
// What a play-bot population actually COSTS, measured rather than guessed.
//
// The play-bot design rested on one assumption — that simulating N matches
// server-side is affordable next to the relay traffic they generate — and that
// assumption turned out to be wrong in the useful direction. This script is
// what says so, and what will say it again when somebody changes the physics.
//
// It measures the three things that could plausibly bind, in the order they
// were suspected:
//
//   1. PHYSICS   — stepping N BotMatch instances at 60Hz.
//   2. WIRE      — the JSON a bot's paddle stream costs the relay.
//   3. PAIRING   — findPair, which is O(n^2) in the queue length.
//
// The finding, on a 4-core box: physics and wire are both under half a percent
// of one core at 200 concurrent matches, and PAIRING is the only one with a
// knee in it. That is why the bot-vs-bot scheduler keeps its own small pool
// instead of putting bots into the shared matchmaking queue — see
// `server/botPlayers.ts`. Re-run this before changing that decision.
//
// Usage:
//   node scripts/bot-sim.mjs                 # the full sweep
//   node scripts/bot-sim.mjs --quick         # smoke scale, for the suite
//
// It compiles `server/botMatch.ts` with esbuild on the way in, because `node`
// does not read TypeScript and this has to be runnable as a registered suite.
// That is also how the module reaches production — esbuild bundles it into
// dist/server.cjs — so the thing measured here is the thing that ships.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Compile the TS we need into one ESM file and import it. */
async function loadModules() {
  const esbuild = await import('esbuild');
  const dir = mkdtempSync(join(tmpdir(), 'phong-bot-sim-'));
  const out = join(dir, 'bundle.mjs');
  await esbuild.build({
    stdin: {
      contents: `
        export { BotMatch } from ${JSON.stringify(join(ROOT, 'server/botMatch.ts'))};
        export { findPair } from ${JSON.stringify(join(ROOT, 'server/matchmaking.ts'))};
        export { DEFAULT_MATCH_RULES } from ${JSON.stringify(join(ROOT, 'src/matchRules.ts'))};
      `,
      resolveDir: ROOT,
      sourcefile: 'entry.mjs',
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
  });
  const mod = await import(out);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const DT = 1 / 60;
const pct = (msPerSec) => `${(msPerSec / 10).toFixed(2)}% of a core`;

export async function runBotSim({ quick = false, quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  const { mod, cleanup } = await loadModules();
  const { BotMatch, findPair, DEFAULT_MATCH_RULES } = mod;

  const mkMatches = (n) =>
    Array.from({ length: n }, () => new BotMatch({
      difficulties: ['pro', 'pro'],
      trueSkillMu: [24, 27],
      winningScore: 11,
      rules: DEFAULT_MATCH_RULES,
    }));

  const matchSizes = quick ? [5, 20] : [10, 25, 50, 100, 200];
  const queueSizes = quick ? [10, 50] : [10, 50, 100, 200, 500, 1000];
  const simSeconds = quick ? 5 : 60;

  // A cold V8 reports the first size as the slowest whatever it is, which
  // reads as "cost falls as N rises" and is pure noise. Warm it properly.
  {
    const w = mkMatches(20);
    const warmTicks = quick ? 2000 : 20000;
    for (let i = 0; i < warmTicks; i++) for (const m of w) m.tick(DT);
  }

  const results = { physics: [], wire: [], pairing: [] };

  // --- 1. physics --------------------------------------------------------
  log('\nPHYSICS — stepping N concurrent BotMatch instances at 60Hz');
  for (const n of matchSizes) {
    const ms = mkMatches(n);
    const ticks = Math.round(simSeconds / DT);
    let live = 0;
    let ballUp = 0;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ticks; i++) {
      for (const m of ms) {
        m.tick(DT);
        if (!m.matchOver) {
          live++;
          if (m.halves[0].ball || m.halves[1].ball) ballUp++;
        }
      }
    }
    const t1 = process.hrtime.bigint();
    const totalMs = Number(t1 - t0) / 1e6;
    const perMatchTickNs = Number(t1 - t0) / (ticks * n);
    const msPerSec = totalMs / simSeconds;
    results.physics.push({ n, perMatchTickNs, msPerSec });
    log(
      `  ${String(n).padStart(4)} matches  ${perMatchTickNs.toFixed(0).padStart(4)}ns/match-tick` +
      `  ${msPerSec.toFixed(2).padStart(6)}ms per wall second  (${pct(msPerSec)})` +
      `  ball live ${((ballUp / Math.max(1, live)) * 100).toFixed(0)}% of ticks`
    );
  }

  // --- 2. wire -----------------------------------------------------------
  log('\nWIRE — JSON for a bot paddle stream at 20Hz per seat');
  const paddle = { type: 'paddle_move', x: 0.4812345 };
  for (let i = 0; i < 200_000; i++) JSON.parse(JSON.stringify(paddle));
  const reps = quick ? 200_000 : 2_000_000;
  const w0 = process.hrtime.bigint();
  for (let i = 0; i < reps; i++) JSON.parse(JSON.stringify(paddle));
  const w1 = process.hrtime.bigint();
  const perMsgNs = Number(w1 - w0) / reps;
  log(`  stringify+parse of one paddle_move: ${perMsgNs.toFixed(0)}ns`);
  for (const n of matchSizes) {
    const msgsPerSec = n * 2 * 20; // two seats, BOT_PADDLE_HZ
    const msPerSec = (msgsPerSec * perMsgNs) / 1e6;
    results.wire.push({ n, msgsPerSec, msPerSec });
    log(
      `  ${String(n).padStart(4)} matches  ${String(msgsPerSec).padStart(6)} msg/s` +
      `  ${msPerSec.toFixed(2).padStart(6)}ms per wall second  (${pct(msPerSec)})`
    );
  }

  // --- 3. pairing --------------------------------------------------------
  //
  // The one with a knee in it. findPair is O(n^2) and sweepQueue calls it once
  // per pair it makes, so a sweep is O(n^3)-ish in the queue length — and it
  // runs SYNCHRONOUSLY on the loop that is relaying paddle_move for every live
  // match. This is the measurement that decided bots keep their own pool.
  log('\nPAIRING — findPair over a queue of N, and the sweep that drains it');
  const now = Date.now();
  const mkQueue = (n) =>
    Array.from({ length: n }, (_, i) => ({
      deviceId: `d${i}`,
      mu: 18 + Math.random() * 16,
      sigma: 2 + Math.random() * 4,
      joinedAt: now - Math.random() * 60_000,
      rttMs: 40 + Math.random() * 60,
    }));
  { const w = mkQueue(50); for (let i = 0; i < 2000; i++) findPair(w, now); }
  for (const n of queueSizes) {
    const q = mkQueue(n);
    const r = n > 200 ? 20 : 500;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < r; i++) findPair(q, now);
    const t1 = process.hrtime.bigint();
    const perCallMs = Number(t1 - t0) / 1e6 / r;
    const sweepMs = perCallMs * Math.floor(n / 2);
    results.pairing.push({ n, perCallMs, sweepMs });
    log(
      `  queue ${String(n).padStart(4)}  findPair ${perCallMs.toFixed(3)}ms` +
      `  →  a full sweep blocks the event loop for ${sweepMs.toFixed(0)}ms`
    );
  }

  cleanup();
  return results;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const quick = process.argv.includes('--quick');
  const r = await runBotSim({ quick });
  const worstPhysics = r.physics[r.physics.length - 1];
  const worstWire = r.wire[r.wire.length - 1];
  console.log(
    `\nAt ${worstPhysics.n} concurrent bot matches: physics ${pct(worstPhysics.msPerSec)},` +
    ` wire ${pct(worstWire.msPerSec)}.`
  );
  console.log(
    'Neither binds. The queue does — keep total queue occupancy (humans AND bots)\n' +
    'under a couple of hundred, which is why bot-vs-bot pairing uses its own pool.'
  );
}
