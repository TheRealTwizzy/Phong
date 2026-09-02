import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION } from '../src/version';

// A version string that disagrees with the package it ships in is worse than
// no version string: it is the one number a player quotes back in a support
// conversation, and the one patch notes are keyed on.
//
// The duplication is deliberate — the client bundle and the server bundle are
// built by different tools, and resolveJsonModule in the client's would put
// the whole manifest into the browser — so this is what keeps the copies
// honest.

describe('the version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')
    ) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('is a plain semver, so it sorts and reads', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('matches package-lock.json, in both places it is written', () => {
    // The FOURTH file, and the one the rule forgot. Convention §17 named three
    // — package.json, src/version.ts, a PATCH_NOTES entry — and the lockfile
    // carries the version twice more. Nothing caught it: `npm ci` tolerates a
    // mismatched top-level version (it only refuses a lockfile that cannot
    // satisfy the DEPENDENCIES), no test read it, and `lint:notes` scopes
    // itself to shipped code, which a lockfile is not. So it drifted silently
    // through two releases — 1.0.4 in the lock against 1.0.6 in the app —
    // and would have gone on drifting, because the thing that repairs it is
    // an `npm install` somebody happens to run.
    //
    // Harmless today and not obviously harmless later: the lockfile is what a
    // fresh clone and every CI job install from, and a version field that
    // disagrees with the package it locks is the same class of lie
    // src/version.ts's own header refuses.
    const lock = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package-lock.json'), 'utf8')
    ) as { version: string; packages: Record<string, { version?: string }> };
    expect(lock.version, 'package-lock.json root version').toBe(APP_VERSION);
    expect(lock.packages['']?.version, 'package-lock.json root package version').toBe(APP_VERSION);
  });
});
