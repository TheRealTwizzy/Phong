#!/usr/bin/env node
// Every browser suite that exists is registered with the runner.
//
// `scripts/e2e-run.mjs` holds the list of suites `npm run test:e2e` executes.
// A file named `scripts/e2e-<name>.mjs` that is missing from that list is not
// a skipped test — it is a test nobody knows is not running. It passes review
// as a new suite, sits in the repo looking like coverage, and never executes
// in CI or locally.
//
// Nothing else notices. `npm test` does not touch these files, the typechecker
// does not read them, and the runner cannot report a suite it was never told
// about. That asymmetry is the whole reason this exists: the failure is
// silent by construction, and it costs one directory listing to close.
//
// The reverse direction — a name in SUITES with no file behind it — is caught
// too, since the runner would fail at spawn time but only if something asked
// for that suite by name.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');

const runner = fs.readFileSync(path.join(SCRIPTS, 'e2e-run.mjs'), 'utf8');
const rawBlock = runner.slice(runner.indexOf('const SUITES = ['), runner.indexOf('];', runner.indexOf('const SUITES = [')));

// Comments are cut before anything is matched. A commented-out entry is the
// single most likely way a suite stops running on purpose and stays stopped by
// accident — somebody disables a flaky one to get a branch green and it is
// never restored — and reading the comment as a live registration would make
// this check report full coverage at exactly the moment coverage was lost.
// Cutting at `//` is safe here because a suite name is `[a-z-]+` and cannot
// contain one.
const block = rawBlock
  .split('\n')
  .map((line) => {
    const at = line.indexOf('//');
    return at === -1 ? line : line.slice(0, at);
  })
  .join('\n');

const registered = [...block.matchAll(/name:\s*'([a-z-]+)'/g)].map((m) => m[1]);

if (!registered.length) {
  console.error('could not parse SUITES out of scripts/e2e-run.mjs — has its shape changed?');
  process.exit(2);
}

const onDisk = fs
  .readdirSync(SCRIPTS)
  .filter((f) => /^e2e-.+\.mjs$/.test(f) && f !== 'e2e-run.mjs')
  .map((f) => f.slice('e2e-'.length, -'.mjs'.length));

const unregistered = onDisk.filter((n) => !registered.includes(n));
const missing = registered.filter((n) => !onDisk.includes(n));

for (const n of unregistered) {
  console.error(`scripts/e2e-${n}.mjs exists but is not in SUITES — it never runs`);
}
for (const n of missing) {
  console.error(`SUITES names "${n}" but scripts/e2e-${n}.mjs does not exist`);
}

if (unregistered.length || missing.length) process.exit(1);
console.log(`${registered.length} browser suites, all registered and all present.`);
