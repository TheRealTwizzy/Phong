import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { MatchEndPayload } from '../src/types';
import { CROSS_KIND_K_SCALE, PLACEMENT_GAMES } from '../src/rating';
import { isBotId } from '../src/profileRules';

// What a match against a play-bot is WORTH.
//
// A bot is a real opponent on a real court under the same rules, so the match
// counts — but at a reduced weight, for BOTH sides. The rule has to hold in
// four combinations and only two are reduced, so this walks all four rather
// than checking the reduced case alone: a bug that scaled EVERY PvP match
// would satisfy a one-sided check while quietly halving the whole ladder.
//
// Asserted as a RATIO against the same match played human-vs-human, never as a
// literal mu. The absolute step depends on sigma, the performance weight and
// whether the reporter is still placing, none of which this rule is about — so
// every duel below is handed an IDENTICAL opponent rating through the context,
// leaving `kindScale` as the only thing that differs.

// db.ts resolves DATA_DIR at import time, so point it at a temp dir first.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-botrating-test-'));
process.env.DATA_DIR = TMP;

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** The same opponent, every time, so only the KIND of the pairing differs. */
const CONTEXT = {
  opponentRating: { mu: 25, sigma: 2 },
  opponentRankRating: { mu: 25, sigma: 2 },
};

/**
 * A placed account sitting at a known rating.
 *
 * The rating is seeded with direct SQL, the same way `tests/duelRecord.test.ts`
 * does it — `upsertProfile` is private, and a fixture should not be the reason
 * it stops being. A silent no-op here would leave every duel below at the
 * default mu and every ratio asking about a ladder nobody is on, so the write
 * is checked.
 */
function seat(id: string, username: string, opts: { bot?: boolean } = {}): void {
  if (opts.bot) {
    db.insertBot({ id, username, mu: 25 });
  } else {
    db.getProfile(id);
    const r = db.initializeProfile(id, username);
    if (!r.ok) throw new Error(`could not initialize ${username}: ${r.code}`);
  }
  const sql = new DatabaseSync(path.join(TMP, 'phong.db'));
  try {
    const changed = sql
      .prepare(
        `UPDATE players
            SET rankMu = 25, rankSigma = 2, mmrMu = 25, mmrSigma = 2, rankedGames = ?
          WHERE id = ?`
      )
      .run(PLACEMENT_GAMES + 10, id).changes;
    if (changed !== 1) throw new Error(`seat matched ${changed} rows for ${username}`);
  } finally {
    sql.close();
  }
}

const payload = (me: string, them: string, key: string): MatchEndPayload => ({
  playerId: me,
  username: db.getProfile(me).username,
  opponentId: them,
  opponentName: db.getProfile(them).username,
  playerScore: 5,
  opponentScore: 3,
  bestStreak: 4,
  endStreak: 4,
  earnedStreak: 4,
  mode: 'multiplayer',
  isWinner: true,
  matchKey: key,
});

/** Record one decided duel and report how far the reporter's ladder moved. */
function duelDelta(me: string, them: string, key: string): number {
  const before = db.getProfile(me).rankMu;
  db.recordMatch(payload(me, them, key), CONTEXT);
  return db.getProfile(me).rankMu - before;
}

describe('a match against a play-bot', () => {
  it('identifies a bot by its id and nothing else', () => {
    expect(isBotId('bot-ladder-01')).toBe(true);
    expect(isBotId('dev_abc')).toBe(false);
    // The AI pseudo-opponent a SOLO match names is not a bot account, and must
    // not trip the cross-kind arm — solo has its own lighter step and its cap.
    expect(isBotId('AI-pro')).toBe(false);
    expect(isBotId('deleted')).toBe(false);
    expect(isBotId(null)).toBe(false);
  });

  it('moves the human ladder less than the same duel against a human', () => {
    seat('dev_h1', 'HumanOne');
    seat('dev_h2', 'HumanTwo');
    seat('bot-r1', 'BotRatingOne', { bot: true });

    const vsHuman = duelDelta('dev_h1', 'dev_h2', 'r-hh');
    // A fresh human on the same rating, so both are measured from the same
    // starting point rather than from wherever the first match left it.
    seat('dev_h3', 'HumanThree');
    const vsBot = duelDelta('dev_h3', 'bot-r1', 'r-hb');

    expect(vsHuman).toBeGreaterThan(0);
    expect(vsBot).toBeGreaterThan(0);
    expect(vsBot / vsHuman).toBeCloseTo(CROSS_KIND_K_SCALE, 3);
  });

  it('moves the BOT ladder less too — the reduction is not the human alone', () => {
    seat('dev_h4', 'HumanFour');
    seat('bot-r2', 'BotRatingTwo', { bot: true });
    seat('bot-r3', 'BotRatingThree', { bot: true });

    // Bot beats bot: same kind, full weight.
    const botVsBot = duelDelta('bot-r2', 'bot-r3', 'r-bb');
    // A fresh bot at the same rating beats a human: cross kind, reduced.
    seat('bot-r4', 'BotRatingFour', { bot: true });
    const botVsHuman = duelDelta('bot-r4', 'dev_h4', 'r-bh');

    expect(botVsBot).toBeGreaterThan(0);
    expect(botVsHuman).toBeGreaterThan(0);
    expect(botVsHuman / botVsBot).toBeCloseTo(CROSS_KIND_K_SCALE, 3);
  });

  it('leaves a human-vs-human duel at full weight', () => {
    seat('dev_h5', 'HumanFive');
    seat('dev_h6', 'HumanSix');
    const full = duelDelta('dev_h5', 'dev_h6', 'r-hh2');

    seat('dev_h7', 'HumanSeven');
    seat('bot-r5', 'BotRatingFive', { bot: true });
    const reduced = duelDelta('dev_h7', 'bot-r5', 'r-hb2');

    // The arm that goes wrong if `crossKind` is inverted — the reduced cases
    // above would still look right, so this is not redundant with them.
    expect(reduced).toBeLessThan(full);
  });

  it('still counts the match — reduced is not unranked', () => {
    seat('dev_h8', 'HumanEight');
    seat('bot-r6', 'BotRatingSix', { bot: true });
    const before = db.getProfile('dev_h8');
    const beforeXp = before.xp;
    const beforeGames = before.rankedGames;
    const beforeDuels = before.rankedDuels;
    const beforeWins = before.multiplayerWins;

    db.recordMatch(payload('dev_h8', 'bot-r6', 'r-counts'), CONTEXT);

    const after = db.getProfile('dev_h8');
    // Rule 7: a human-vs-bot match counts for the PvP gates. XP is paid, the
    // duel counters move, and the ladder is engaged — the weight is reduced,
    // the match is not discounted. Getting this wrong would make bot matches
    // invisible to tasks and achievements, which is the opposite of the ask.
    expect(after.xp).toBeGreaterThan(beforeXp);
    expect(after.rankedGames).toBe(beforeGames + 1);
    expect(after.rankedDuels).toBe(beforeDuels + 1);
    expect(after.multiplayerWins).toBe(beforeWins + 1);
  });

  it('does not touch a solo match', () => {
    seat('dev_h9', 'HumanNine');
    const before = db.getProfile('dev_h9').mmrMu;
    db.recordMatch(
      {
        playerId: 'dev_h9',
        username: 'HumanNine',
        opponentId: 'AI-pro',
        opponentName: 'AI (pro)',
        playerScore: 5,
        opponentScore: 1,
        bestStreak: 3,
        endStreak: 3,
        earnedStreak: 3,
        mode: 'solo',
        difficulty: 'pro',
        isWinner: true,
        matchKey: 'r-solo',
      },
      {}
    );
    expect(db.getProfile('dev_h9').mmrMu).not.toBe(before);
  });
});
