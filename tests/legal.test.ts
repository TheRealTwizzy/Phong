import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CONTACT_EMAIL, PRIVACY, TERMS } from '../src/legal';
import { PLAYER_KEYED_TABLES } from '../server/db';

// A privacy notice is RELIED ON, so the failure mode is not that it looks
// wrong — it is that it says something true today and false after the next
// change, with nobody noticing. These are the claims in src/legal.ts that can
// be checked against the code, checked against the code.
//
// It reads the server source rather than running it, the way
// tests/protocolParity.test.ts does, because the question is "does this
// statement still describe the implementation" and that is a property of the
// text, not of a request.

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const SERVER = read('server.ts');
const DB = read('server/db.ts');

describe('the privacy notice still describes the code', () => {
  it('is right that an IP is never stored', () => {
    // The claim: "held in memory for a few minutes and is never written to the
    // database, never logged".
    //
    // Comments are stripped first, and that is not a convenience — the file
    // discusses req.ip at length (why `trust proxy` is a hop count and not
    // `true`, why loopback is exempt) and counting prose would make this
    // assertion fail on a paragraph. What is left is every place the value is
    // actually READ, and each one has to be a use the notice permits.
    const code = SERVER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const reads = [...code.matchAll(/req\.ip/g)].length;
    // The two permitted uses: a rate-limit key, and the loopback comparison
    // that decides whether to count at all. Both are in-memory and neither
    // outlives the request.
    const asLimitKey = [...code.matchAll(/`i:\$\{req\.ip\}`/g)].length;
    const asLoopbackCheck = [...code.matchAll(/LOOPBACK\.has\(String\(req\.ip \|\| ''\)\)/g)].length;
    expect(
      reads,
      'req.ip is read somewhere the privacy notice does not allow — it says an IP is never stored or logged'
    ).toBe(asLimitKey + asLoopbackCheck);
    expect(asLimitKey).toBeGreaterThan(0);

    // And nothing anywhere writes one.
    expect(/\bip\b\s+TEXT/i.test(DB), 'the schema has an ip column').toBe(false);
    expect(/remoteAddress/.test(SERVER + DB)).toBe(false);
  });

  it('is right that there is no third-party analytics', () => {
    // The claim: "no analytics service, no advertising, and no third-party
    // tracking of any kind". Runtime dependencies are the place that would
    // change first.
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['express', 'ws']);
  });

  it('is right that deletion is complete', () => {
    // The claim: "your profile, avatar, stats, achievements and history are
    // erased and your username goes back into the pool". deleteAccount walks
    // PLAYER_KEYED_TABLES, and tests/identity.test.ts holds that the list
    // matches the schema — so what this adds is that the notice names things
    // the list actually covers.
    expect(PLAYER_KEYED_TABLES).toContain('avatars');
    expect(PLAYER_KEYED_TABLES).toContain('player_mode_stats');
    expect(DB).toMatch(/DELETE FROM players WHERE id = \?/);
  });

  it('is right that matches you played stay in the other player’s history', () => {
    // The claim, and the one people find surprising: the row stays with the
    // name scrubbed. This is the line that does it.
    expect(DB).toMatch(/UPDATE matches SET player2Id = \?, player2Name = \?/);
  });
});

describe('the notice is shippable', () => {
  it('says something in every section', () => {
    for (const section of [PRIVACY, TERMS]) {
      expect(section.paragraphs.length).toBeGreaterThan(2);
      for (const p of section.paragraphs) expect(p.trim().length).toBeGreaterThan(30);
    }
  });

  it('leads somewhere for contact', () => {
    // Null is legitimate — the sheet offers the report form instead — but a
    // malformed address is not, because it renders as a dead mailto.
    if (CONTACT_EMAIL !== null) expect(CONTACT_EMAIL).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  });
});
