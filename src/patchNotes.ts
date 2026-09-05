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
    date: '2026-09-05',
    lines: [
      'The ladder has players on it around the clock. Quick Match finds you a game even when nobody else is online.',
      'They are real opponents with real records \u2014 they win, lose, level up and climb past you while you sleep.',
      'A match against one counts for rank, at about two thirds of what the same result against a person would move.',
      'Play the same one again and again and it counts for less each time, then stops. Nobody can farm a tier out of it.',
      'Tap their name anywhere and their profile opens like anyone else\u2019s, marked BOT, with the record they earned.',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-09-03',
    lines: [
      'Cyber Overlord now takes 25 ranked duels as well as the rating. Until then you hold Legend, and your profile counts the way there.',
      'The Cyber AI now tops out at Grandmaster. Only Chaos carries a solo player as far as Legend.',
      'A finished daily task deals a fresh one for free three times a day, and an elite task once. After that the slot rests until tomorrow.',
      '28 new daily tasks and 10 new elite tasks, with five new kinds: close wins, dominant wins, long matches, win streaks and wall returns.',
      '22 new trophies deepen every branch \u2014 1,000 matches, 10,000 points, 50 Chaos wins, 100 duel wins, level 100 and more.',
      'Titles are a second kind of permanent reward: earn one from an elite task or a deep trophy and wear it beside your name.',
      'Five new looks for the whole app \u2014 four from elite tasks, one for reaching Cyber Overlord.',
    ],
  },
  {
    version: '1.0.6',
    date: '2026-09-02',
    lines: [
      'Watching someone play the computer? When their match ends you can take its chair yourself.',
      'The seat you take is a real one \u2014 ready up and the next match starts, with no waiting around.',
    ],
  },
  {
    version: '1.0.5',
    date: '2026-09-02',
    lines: [
      'You can now walk up to a table where somebody is playing the computer and take its chair.',
      'A table like that shows who is in the other seat, and opens up the moment its match ends.',
      'Sitting down no longer strands either of you \u2014 everyone goes back to the lobby for the next match.',
      'Sitting down to watch between matches shows you the table instead of an empty court.',
    ],
  },
  {
    version: '1.0.4',
    date: '2026-09-02',
    lines: [
      'Nobody can take the computer\u2019s chair in the middle of your match any more \u2014 only once it has ended.',
      'Being turned away from a table you are not ranked for no longer removes the computer from it.',
    ],
  },
  {
    version: '1.0.3',
    date: '2026-09-02',
    lines: [
      'Watching a machine match now ends when the match does, instead of leaving you on a court nobody is playing on.',
      'Leaving a table closes it, so nobody is left watching an empty one.',
      'Play Again at a table starts a real second match, and anyone watching comes with you.',
      'Your rally run at a table is your solo run again — it was opening on your PvP one.',
      'A machine match with the watching seats open really does leave your rank alone now, as the badge always said.',
    ],
  },
  {
    version: '1.0.2',
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
