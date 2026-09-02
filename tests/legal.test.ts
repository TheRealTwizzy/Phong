import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CONTACT_EMAIL, PRIVACY, TERMS } from '../src/legal';
import { PLAYER_KEYED_TABLES } from '../server/db';
import { DEFAULT_BACKUP_KEEP } from '../server/backup';

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
/**
 * Prose is not a use: the files below discuss the very things being asserted.
 *
 * The line-comment rule deliberately refuses to fire on `://`. A naive
 * `\/\/[^\n]*` eats the rest of any line containing a URL, which made the
 * "no hardcoded endpoint" assertion below unable to fail at all — the mutant
 * `'https://s3.amazonaws.com'` was stripped to `'https:` before the regex ever
 * saw it. Verified by re-running that mutation against this version.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

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
    const code = stripComments(SERVER);
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

// The claims offsite backups made false, and the one they did not.
//
// This suite stayed GREEN through that change, which is exactly the hazard
// src/legal.ts's own header names: the claims that broke are prose, and prose
// is what nothing checks. These are the checks.
describe('the privacy notice is right about backups', () => {
  // TESTING.md §5: copy that quotes a threshold is checked against the
  // threshold. A number in a privacy notice is a promise — the daily copies
  // really are kept for `--keep` snapshots at one a day, so if that constant
  // moves the sentence has to move with it.
  const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };

  it('is right about how long a copy of the database is kept', () => {
    const text = PRIVACY.paragraphs.join(' ');
    expect(text).toMatch(/copy of that file is taken each day/i);
    const said = /kept for about (\w+) weeks?/.exec(text);
    expect(said, 'the notice no longer states a retention window').not.toBeNull();
    expect(WORDS[said![1]] * 7).toBe(DEFAULT_BACKUP_KEEP);
  });

  it('says copies exist AND that deletion does not reach inside them', () => {
    // The conjunction, not either half. Saying backups exist without the
    // retention consequence leaves "deletion is complete" reading as true of
    // the whole system, which is the claim that actually became false.
    const text = PRIVACY.paragraphs.join(' ');
    expect(text).toMatch(/brought back if the server is lost/i);
    expect(text).toMatch(/erased account can still sit inside one/i);
  });

  it('does not overclaim the encryption, and names no provider', () => {
    // v1 does not encrypt the object at rest — whoever holds the bucket
    // credentials can read it — so the honest phrasing is about the
    // connection. A bare "encrypted" would be a false statement about what
    // the server does with somebody's data. The provider is the operator's
    // choice, so naming one would be false on most deployments.
    const text = PRIVACY.paragraphs.join(' ');
    expect(text).toContain('over an encrypted connection');
    expect(text).not.toMatch(/\bAWS\b|\bS3\b|Backblaze|Cloudflare|\bR2\b/);
  });

  it('hardcodes no destination — the operator chooses one, or there is none', () => {
    // The notice says WHERE copies go is set by whoever runs this instance.
    // A default endpoint or bucket in the uploader would make that false for
    // everybody who never set one, and would ship the player database to a
    // host nobody chose.
    const code = stripComments(read('server/s3.ts'));
    expect(code).not.toMatch(/https?:\/\/[a-z0-9.-]+/i);
    expect(code).not.toMatch(/amazonaws|backblazeb2|r2\.cloudflarestorage|wasabisys|digitaloceanspaces/i);
  });

  it('still makes the strong claim, which offsite backups do not weaken', () => {
    // A storage provider holding a database file is not an analytics service,
    // an advertiser or a tracker. This sentence survives intact, and must not
    // be softened by anyone reconciling the paragraphs above with it.
    const text = PRIVACY.paragraphs.join(' ');
    expect(text).toContain('no analytics service, no advertising, and no third-party tracking of any kind');
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
