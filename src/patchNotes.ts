import { APP_VERSION } from './version';

/**
 * What changed, newest first.
 *
 * DATA, and deliberately English-only — this is the one place in the product
 * that is not localized, and the exception is worth stating rather than
 * discovering.
 *
 * Convention §11 says a user-facing string ships in all seven locales or it
 * does not ship, and `tests/i18n.test.ts` enforces both directions: every
 * locale carries every key, and a key nothing quotes fails the suite. Release
 * notes cannot live under that rule. Each release would add N new keys × 7
 * locales, permanently — the dead-weight check means a key can never be
 * retired while anything still quotes it — so a year of releases would leave
 * hundreds of translated strings describing versions nobody is running.
 *
 * So the line convention §11 is really drawing, made explicit here: PRODUCT
 * CHROME is localized always (the sheet's title, its dates, the note that
 * says the rest is English). AUTHORED CONTENT is not — release notes, and a
 * player's own report text. The sheet says so in the player's language, which
 * is the part that matters.
 *
 * `version` must match a real APP_VERSION for the newest entry, because the
 * "what's new" dot compares the two; tests/patchNotes.test.ts holds that.
 */
export interface PatchNote {
  /** Semver, matching package.json for the newest entry. */
  version: string;
  /** ISO date, YYYY-MM-DD. Rendered in the player's locale. */
  date: string;
  lines: string[];
}

export const PATCH_NOTES: PatchNote[] = [
  {
    version: APP_VERSION,
    date: '2026-09-02',
    lines: [
      'Release notes now show one update per page, so you can page back through everything that changed.',
      'Every update gets its own page from here on, however small it was.',
    ],
  },
  {
    version: '1.0.1',
    date: '2026-09-02',
    lines: [
      'You can sit the AI down at a PvP table now — tap the empty Opponent chair and pick a rung.',
      'Your table stays listed while you play the machine, so somebody can take its seat when the match ends.',
      'A machine match with the watching seats open does not move your rank, the same way the sonar does not.',
      'Fixed: somebody above a room’s bracket could take a watching seat, then sit down in a playing one.',
      'Your account, stats and history are backed up daily, and copies can now be kept off the server.',
      'The privacy notice says so, including that a deleted account sits in those copies for about two weeks.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-09-01',
    lines: [
      'Phong is open to everyone. Anyone can create an account and play.',
      'You can now report a bug, an exploit, or another player from Settings.',
      'These release notes are new — check back here after an update to see what changed.',
      'Unauthenticated endpoints now have rate limits, so a script cannot flood the server with accounts.',
      'Fixed: over a direct peer-to-peer connection, a modified client could put a chat bubble on screen under somebody else’s name.',
    ],
  },
];

/** The newest entry, which is the one the "what's new" dot is about. */
export const latestPatchNote = (): PatchNote => PATCH_NOTES[0];
