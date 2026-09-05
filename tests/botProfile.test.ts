import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { MatchEndPayload, PublicProfile } from '../src/types';
import { isLinkableId, DELETED_PLAYER_ID } from '../src/profileRules';

// Step 25 / §4.11 / D27. A play-bot is a persistent participant with a real
// record -- it beats people and climbs past them -- so its public profile is
// VIEWABLE, in the same sanitized shape a human's is, labelled BOT.
//
// The one thing that is not the same is a field with no meaningful bot
// equivalent, neutralised INDIVIDUALLY rather than by withholding the card.
// The daily-streak flame is that field: it means "came back every day", which
// is a claim about a habit, and a scheduled process does not have one.
//
// A CORRECTION TO THE PLAN, recorded rather than dropped. §4.11 justifies the
// neutralisation as "insertBot seeds dailyStreak: 1 and nothing advances it,
// so it would render a lie". That is true of the ROSTER (which records no
// matches) and false of a play-bot: recordMatch calls getProfile, which calls
// updatePlayerStreak, so a bot playing on consecutive days advances the
// counter exactly as a human does. The number is real; it is the MEANING that
// is not, and it measures the deployment rather than a person. The decision
// stands on the stronger reason, and both kinds are covered below.
//
// A LIMITATION, stated because neutralising the field does not neutralise its
// consequences: daily_3 / streak_7 / daily_30 / daily_100 are granted from
// profile.dailyStreak inside recordMatch, so a long-running play-bot banks
// them like any account and they land in the achievement COUNT the card
// renders. Suppressing those would be a bot-specific branch in the shared
// achievement path, which §4.11 does not ask for and this step does not take.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-botprofile-test-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const raw = <T>(fn: (h: DatabaseSync) => T): T => {
  const h = new DatabaseSync(DB_FILE);
  try {
    return fn(h);
  } finally {
    h.close();
  }
};

const init = (id: string, username: string) => {
  db.getProfile(id);
  const r = db.initializeProfile(id, username);
  if (!r.ok) throw new Error(`init failed: ${r.code}`);
};

/**
 * A PLAY-bot: an ordinary account, onboarded through the ordinary doors and
 * holding an ordinary ISSUED id, marked in `bot_accounts` afterwards. The
 * marker is the one step with no HTTP route behind it, deliberately -- a
 * client that could declare itself a bot could take the reduced stakes with
 * it -- so the fixture writes the row the way the driver's callback does.
 */
const markAsBot = (id: string) => {
  raw((h) =>
    h
      .prepare('INSERT OR IGNORE INTO bot_accounts (botId, createdAt) VALUES (?, ?)')
      .run(id, new Date().toISOString())
  );
  db.reloadBotAccounts();
};

const record = (playerId: string, over: Partial<MatchEndPayload> = {}) =>
  db.recordMatch({
    playerId,
    username: 'Ignored',
    playerScore: 5,
    opponentScore: 2,
    bestStreak: 6,
    endStreak: 0,
    earnedStreak: 6,
    mode: 'solo',
    difficulty: 'rookie',
    isWinner: true,
    ...over,
  } as MatchEndPayload);

/** The wire shape: what actually reaches the client, undefined keys dropped. */
const onTheWire = (p: PublicProfile | null): Record<string, unknown> | null =>
  p === null ? null : (JSON.parse(JSON.stringify(p)) as Record<string, unknown>);

const setStoredStreak = (id: string, streak: number) => {
  raw((h) => h.prepare('UPDATE players SET dailyStreak = ? WHERE id = ?').run(streak, id));
};

const storedStreak = (id: string): number =>
  raw(
    (h) =>
      (h.prepare('SELECT dailyStreak AS s FROM players WHERE id = ?').get(id) as { s: number }).s
  );

const HUMAN = 'dev_botprof0000000a1';
const PLAYBOT = 'dev_botprof0000000b1';

describe("a play-bot's public profile is the same card a human gets", () => {
  beforeAll(() => {
    init(HUMAN, 'ProfHuman');
    init(PLAYBOT, 'ProfPlaybot');
    markAsBot(PLAYBOT);
    // IDENTICAL records, so any difference in the card is attributable to
    // bot-ness and to nothing else. Both are solo matches with no opponent
    // account, so §4.5's pairing branch is never entered for either and the
    // weights are ×1.00 on both sides -- the two profiles really are the same
    // profile with two ids.
    for (const id of [HUMAN, PLAYBOT]) {
      record(id, { matchKey: `botprof:${id}:1` });
      record(id, { matchKey: `botprof:${id}:2`, isWinner: false, playerScore: 2, opponentScore: 5 });
    }
    // AFTER the matches: recordMatch goes through getProfile, which advances
    // the streak, so seeding it first would be overwritten. 42 rather than a
    // default, so a test that passes because the field happens to be absent
    // for everybody is not mistaken for one that passes because it was
    // neutralised (§7's subject-not-over-the-threshold shape).
    setStoredStreak(HUMAN, 42);
    setStoredStreak(PLAYBOT, 42);
  });

  it('stores a real streak on both, which is the precondition for the rest', () => {
    expect(storedStreak(HUMAN)).toBe(42);
    expect(storedStreak(PLAYBOT)).toBe(42);
  });

  it('serves the bot, rather than withholding the profile', () => {
    expect(onTheWire(db.getPublicProfile(PLAYBOT))).not.toBeNull();
  });

  it('carries isBot, and only for the bot', () => {
    expect(onTheWire(db.getPublicProfile(PLAYBOT))!.isBot).toBe(true);
    expect(onTheWire(db.getPublicProfile(HUMAN))).not.toHaveProperty('isBot');
  });

  it('renders no daily streak for a bot, and the human keeps theirs', () => {
    // Neutralised INDIVIDUALLY: the field is absent from the wire, not zeroed
    // -- a 0 is still a rendered value, and the flame would print it.
    expect(onTheWire(db.getPublicProfile(PLAYBOT))).not.toHaveProperty('dailyStreak');
    expect(onTheWire(db.getPublicProfile(HUMAN))!.dailyStreak).toBe(42);
  });

  it('differs from the human card in exactly the badge and the streak', () => {
    // The strongest form available: identical records, so the two cards must
    // be the same object modulo identity, the one neutralised field and the
    // one added one. A second neutralisation therefore has to be a deliberate
    // edit here rather than something that slips in.
    const human = onTheWire(db.getPublicProfile(HUMAN))!;
    const bot = onTheWire(db.getPublicProfile(PLAYBOT))!;
    for (const k of ['id', 'username', 'createdAt']) {
      delete human[k];
      delete bot[k];
    }
    expect(human).toHaveProperty('dailyStreak');
    delete human.dailyStreak;
    delete bot.isBot;
    expect(bot).toEqual(human);
    // And the card is a real card rather than an empty one, or the equality
    // above would hold over two blanks.
    expect(human.matchesPlayed).toBe(2);
    expect(human.matchesWon).toBe(1);
    expect((human.xp as number) > 0).toBe(true);
  });

  it('serves a play-bot its match history, which is the record it earned', () => {
    // §4.11 names match history among what a bot's profile shows. The route
    // gates on getPublicProfile alone, so serving the profile serves the
    // history -- asserted here because the two are one promise.
    const page = db.getMatchHistoryPage(PLAYBOT, { limit: 10, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.matches.every((m) => m.player1Id === PLAYBOT)).toBe(true);
  });
});

describe('a roster bot is neutralised the same way', () => {
  const ROSTER = 'bot-profile-roster-1';

  beforeAll(() => {
    db.insertBot({ id: ROSTER, username: 'RosterProf', mu: 25, dailyStreak: 9 });
  });

  it('seeds a streak that no match will ever advance, and hides it', () => {
    // The plan's original premise, kept as its own case: the roster records
    // no matches, so whatever insertBot seeds is what the flame would print
    // forever. 9 rather than the default 1, so the assertion cannot pass on
    // an absent-because-falsy value.
    expect(storedStreak(ROSTER)).toBe(9);
    const card = onTheWire(db.getPublicProfile(ROSTER))!;
    expect(card.isBot).toBe(true);
    expect(card).not.toHaveProperty('dailyStreak');
  });
});

describe('a bot name stays a tap target', () => {
  it('links an ISSUED play-bot id and a roster id, and refuses the synthetics', () => {
    // Step 26 opens a bot's profile by tapping its name, which is only
    // reachable if this says yes. A play-bot's id is issued by the server
    // like any other account's, so it is `dev_`-shaped -- the `bot-` arm is
    // the roster's, and neither is a bot CLASSIFIER (§4.10, D26).
    expect(isLinkableId(PLAYBOT)).toBe(true);
    expect(isLinkableId('bot-profile-roster-1')).toBe(true);
    // The plan's step 25 says this "still refuses DELETED_PLAYER_ID and
    // `dev_`". The second half is wrong and always was -- §4.10's own prose
    // one paragraph earlier says "`dev_` and `bot-` yes" -- so the true
    // behaviour is asserted: `dev_` is exactly what an account id looks like.
    expect(isLinkableId(DELETED_PLAYER_ID)).toBe(false);
    expect(isLinkableId('p_1755771234')).toBe(false);
    expect(isLinkableId('AI-cyber')).toBe(false);
  });
});
