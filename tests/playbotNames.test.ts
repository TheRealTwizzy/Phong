import { describe, expect, it } from 'vitest';
import { PLAYBOT_NAMES, defaultPlaybotName } from '../server/playbotNames';
import { USERNAME_MAX, validateUsername } from '../src/profileRules';

// The names a play-bot account is created under.
//
// They used to be `Rally01Bot`...`RallyNNBot`, which disclosed in the name
// itself, everywhere the name rendered — the in-match opponent label, the
// lobby, the result strip, and the denormalized rows in match history. A
// human-looking handle does not, and none of those surfaces carries the BOT
// badge. That is why the shared robot avatar ships in the same commit: after
// this, the avatar is the visual tell beside the name, and §4.11's disclosure
// requirement rests on the pair rather than on the spelling.

describe('the play-bot name list', () => {
  it('is every one a username the product would accept', () => {
    for (const name of PLAYBOT_NAMES) {
      expect({ name, ok: validateUsername(name).ok }).toEqual({ name, ok: true });
    }
  });

  it('has no two names the unique index would collide', () => {
    // players.username is COLLATE NOCASE, so two entries differing only in
    // case are one name — and the provisioning loop would spend an attempt on
    // each, silently ending a name short.
    const lower = PLAYBOT_NAMES.map((n) => n.toLowerCase());
    expect(new Set(lower).size).toBe(PLAYBOT_NAMES.length);
  });

  it('reads as a person rather than as machinery', () => {
    for (const name of PLAYBOT_NAMES) {
      expect({ name, machine: /bot|cpu|npc|rally|phong|player\d/i.test(name) }).toEqual({
        name,
        machine: false,
      });
      // `paddle-` is reserved for the placeholder an uninitialized profile
      // carries, and validateUsername refuses it — asserted separately so a
      // failure names the reason rather than only the verdict.
      expect(name.toLowerCase().startsWith('paddle-')).toBe(false);
    }
  });

  it('leaves room for the overflow suffix', () => {
    // `defaultPlaybotName` appends a lap number past the end of the list, and
    // USERNAME_MAX is 16. A 15-character base plus "2" is a name the server
    // would refuse, which is one bot the roster never gets.
    for (const name of PLAYBOT_NAMES) {
      expect({ name, len: name.length <= 14 }).toEqual({ name, len: true });
    }
  });

  it('is long enough for the documented roster, with slack', () => {
    // The provisioning loop spends up to `rosterSize + NAME_ATTEMPT_SLACK`
    // attempts and DEPLOYMENT.md documents headroom past 60. The overflow
    // rule below means running out is survivable rather than fatal, but a list
    // that turns over inside the ordinary roster hands out `name2` to people
    // who would read it as a second account of the same person.
    expect(PLAYBOT_NAMES.length).toBeGreaterThanOrEqual(128);
  });
});

describe('naming the nth bot', () => {
  it('is TOTAL — it never answers undefined', () => {
    // The silent one, and the reason this has its own test. A bare
    // `PLAYBOT_NAMES[n]` past the end is `undefined`, which stringifies to
    // "undefined" — a name that PASSES the username regex. The first bot over
    // the edge would claim it, burn it out of the pool for good, and every
    // later one would collide with it forever, with nothing in a log to say
    // so. `defaultPlaybotName` was total when it was a counter, and losing
    // that in the move to a list is a change nothing else would notice.
    for (const n of [0, 1, PLAYBOT_NAMES.length - 1, PLAYBOT_NAMES.length, 5000]) {
      const name = defaultPlaybotName(n);
      expect({ n, name, ok: typeof name === 'string' && validateUsername(name).ok }).toEqual({
        n,
        name,
        ok: true,
      });
      expect(name.length).toBeLessThanOrEqual(USERNAME_MAX);
    }
  });

  it('does not repeat inside four laps of the list', () => {
    const n = PLAYBOT_NAMES.length * 4;
    const seen = new Set(Array.from({ length: n }, (_, i) => defaultPlaybotName(i).toLowerCase()));
    expect(seen.size).toBe(n);
  });

  it('gives the first bots the bare names', () => {
    // A deployment inside the list length should never show a suffix at all.
    expect(defaultPlaybotName(0)).toBe(PLAYBOT_NAMES[0]);
    expect(defaultPlaybotName(PLAYBOT_NAMES.length - 1)).toBe(PLAYBOT_NAMES.at(-1));
  });
});
