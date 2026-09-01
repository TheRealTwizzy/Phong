/**
 * Privacy, terms, and how to reach a person.
 *
 * DATA and English-only, for the reason src/patchNotes.ts gives at length:
 * this is authored content, not product chrome. Convention §11 keeps every
 * label around it in seven locales, and the sheet says — in the player's own
 * language — that the text itself is English. That last part is the condition
 * on the exception, not a detail.
 *
 * There is a second reason here that does not apply to patch notes: a
 * mistranslated release note is a curiosity, and a mistranslated privacy
 * notice is a false statement about what a server does with somebody's data.
 * English with a clear marker beats six translations nobody checked.
 *
 * EVERY CLAIM BELOW IS CHECKED AGAINST THE CODE, and must stay that way — a
 * privacy notice that drifts from the implementation is worse than none,
 * because it is relied on. The IP line in particular: `req.ip` appears in
 * exactly two places in server.ts, both of them rate-limit keys in in-memory
 * maps, and it is never written to the database.
 */

/**
 * Where a person can be reached about the things a form cannot handle — a
 * privacy request, a legal notice, an account nobody can recover.
 *
 * OPERATOR: set this before you open the doors. Null is honest rather than
 * broken — the sheet points at the in-app report form instead, which is a real
 * channel — but a privacy notice with no address behind it is thin, and some
 * requests genuinely cannot go through a game's bug form.
 */
export const CONTACT_EMAIL: string | null = null;

export interface LegalSection {
  /** Locale key for the heading — chrome, so this IS translated. */
  titleKey: string;
  /** English. See the note above. */
  paragraphs: string[];
}

export const PRIVACY: LegalSection = {
  titleKey: 'legal_privacy',
  paragraphs: [
    'There is no sign-up, no email address and no password. When you first open Phong the server gives your browser a signed cookie, and that cookie is your account. It is set before you type anything, because it is what the game uses to tell one browser from another.',
    'What is stored: the username you choose, an avatar if you upload one, the results of matches you play, and the XP, rating and achievements those produce. Nothing else about you is collected.',
    'Your IP address is used only to rate-limit abusive traffic. It is held in memory for a few minutes and is never written to the database, never logged, and never used to locate you.',
    'There is no analytics service, no advertising, and no third-party tracking of any kind. The game counts a handful of totals per day — how many people opened it, how many matches were played — and those are plain numbers with nobody attached to them.',
    'If you send a report, we receive what you wrote plus the diagnostics shown to you on that screen before you send it.',
    'Everything lives in a single database file on the server that runs this game. It is not shared with anyone.',
    'You can delete your account at any time from your profile. It is complete: your profile, avatar, stats, achievements and history are erased and your username goes back into the pool. Matches you played against other people stay in THEIR history, with your name removed, because that game happened to them too.',
  ],
};

export const TERMS: LegalSection = {
  titleKey: 'legal_terms',
  paragraphs: [
    'Phong is a game, offered as-is and with no warranty of any kind. It can go down, lose a match, or change without notice.',
    'Be decent to the people you play. Do not choose a username, or upload an avatar, that is abusive, hateful, sexual, illegal, or impersonates somebody else.',
    'Do not modify the client to cheat, and do not attack the server or other players. If you find a way to do either, the report form has an "exploit" category — telling us is welcome and will not cost you your account.',
    'The operator can rename an account or remove an avatar that breaks these rules, and can refuse service. That is the whole enforcement mechanism; there is no appeals process, because there is no company here.',
    'You keep whatever you upload. You give the operator permission to store and show it inside the game, which is the only thing it is used for.',
  ],
};
