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
      'You can now sit the AI down at a PvP table: tap the empty Opponent chair and pick a difficulty. The table stays in the room’s list, so somebody can take the machine’s seat when the match ends — and can watch, if you have opened the watching seats.',
      'A machine match with the watching seats open does not move your rank. Somebody watching sees the half you are not allowed to, which is the same trade the Opponent Sonar makes.',
      'Fixed: a player above a room’s skill bracket could take a watching seat and then sit down in a playing one. The bracket is checked at that door now too.',
      'Your account, stats and match history are backed up every day, and the server can copy each backup off the machine it runs on — so losing that machine no longer loses the game.',
      'The privacy notice now says those daily copies exist, where they may be kept, and that a deleted account can still sit inside one for about two weeks until it ages out.',
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
