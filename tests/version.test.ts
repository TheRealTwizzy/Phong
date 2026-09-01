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
});
