import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { LADDER_TOP_N, OVERLORD_MIN_DUELS } from '../src/rating';
import type { MatchEndPayload } from '../src/types';

/**
 * The number the top rung renders instead of its name.
 *
 * Cyber Overlord is the one rung with nothing above it, so it reads as a
 * position — `#1` through `#100` — rather than as a word every player up there
 * shares. Reaching it is still `rankMu >= 37` plus that player's own
 * `OVERLORD_MIN_DUELS` ranked duels, and nothing else: making the
 * headcount DECIDE the tier would put every other player's activity inside
 * `tierFor`, and on a server with fewer than a hundred ranked players it would
 * promote everyone placed.
 *
 * The assertion that carries this suite is not the count in isolation, it is
 * AGREEMENT WITH THE BOARD. `getLeaderboard`'s `rank` is not a count at all —
 * it is a dense JS counter over a filtered, ordered scan — so a naive
 * `COUNT(*) WHERE rankMu > ?` would silently let uninitialized profiles,
 * players with no ranked game and the seeded bots push every human down. A
 * badge reading #12 beside a Ranks page reading #7 for the same player is
 * worse than no badge at all, and nothing else in the suite would catch it.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-ladder-test-'));
const DB_FILE = path.join(TMP, 'phong.db');
process.env.DATA_DIR = TMP;

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

/**
 * Force a rating onto a row directly, the way tests/placementRescue.test.ts
 * does: `upsertProfile` is private, and widening it so a fixture can reach it
 * would be a worse trade than a scoped raw handle. Climbing to mu 45 through
 * `recordMatch` would take hundreds of matches and still not land on a
 * chosen number, which is what these assertions are about.
 */
function setRating(id: string, rankMu: number, rankedGames = 10) {
  const raw = new DatabaseSync(DB_FILE);
  // The apex asks for OVERLORD_MIN_DUELS ranked duels beyond the rating, so a
  // fixture standing somebody at mu 45 has to give them the duels too, or
  // every Overlord these assertions are about reads Legend and holds no
  // position at all.
  raw
    .prepare('UPDATE players SET rankMu = ?, rankSigma = ?, rankedGames = ?, rankedDuels = ? WHERE id = ?')
    .run(rankMu, 2, rankedGames, Math.max(rankedGames, OVERLORD_MIN_DUELS), id);
  raw.close();
}

/** An initialized profile, placed, at a chosen rating. */
function seat(id: string, username: string, rankMu: number) {
  db.getProfile(id);
  db.initializeProfile(id, username);
  setRating(id, rankMu);
  return db.getProfile(id);
}

beforeAll(async () => {
  ({ db } = await import('../server/db'));

  // Bots are pre-placed and rated, so a count that forgets them puts the whole
  // curated roster above every human. Two of them sit ABOVE the apex on
  // purpose, which is the case that would be invisible with a weaker fixture.
  // `rankedDuels` is explicit because a bot obeys the apex duel gate like
  // anybody: at mu 41 with none played, `tierFor` walks it down to Legend.
  // That is the gate working, and it used to be invisible here because the
  // roster seeded a fabricated career that happened to satisfy it.
  db.insertBot({ id: 'bot-apex-1', username: 'BotApexOne', xp: 9000, mu: 41, rankedDuels: 40 });
  db.insertBot({ id: 'bot-apex-2', username: 'BotApexTwo', xp: 9000, mu: 39, rankedDuels: 40 });

  seat('dev_overlord_aaaaaaaaa', 'ApexAlpha', 42);
  seat('dev_overlord_bbbbbbbbb', 'ApexBravo', 40);
  seat('dev_overlord_ccccccccc', 'ApexCharlie', 38);
  seat('dev_legend_ddddddddddd', 'LegendDelta', 35);

  // Initialized, placed, but never played a ranked game — off the elo board by
  // its own progress filter, and so off the ladder too. Rated absurdly high so
  // it would land at #1 if the filter were forgotten.
  const ghostId = 'dev_ghost_eeeeeeeeeeee';
  db.getProfile(ghostId);
  db.initializeProfile(ghostId, 'GhostEcho');
  setRating(ghostId, 99, 0);

  // Four placement games in, and rated above the apex. This one is ON the
  // board — `rankedGames > 0` is the board's progress filter — but sorted
  // BELOW every placed player, because the board's primary key is placed-ness
  // and not rating. So "above me in mu" and "above me on the board" are
  // different sets, which a count on rating alone cannot see.
  const risingId = 'dev_rising_gggggggggg';
  db.getProfile(risingId);
  db.initializeProfile(risingId, 'RisingFox');
  setRating(risingId, 50, 4);

  // Uninitialized: never finished onboarding, invisible everywhere.
  const strayId = 'dev_stray_fffffffffff';
  db.getProfile(strayId);
  setRating(strayId, 98);
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// Placed BEFORE the top-N suite below, deliberately: that one seeds past
// LADDER_TOP_N to prove position 101 is no position, which pushes every human
// here off the ladder. A later block reading absolute positions would see
// `undefined` and look like this feature was broken.
describe('a play-bot races other play-bots, never the people', () => {
  it('numbers a bot against bots and leaves every human number alone', () => {
    // Two ladders. `tierFor` is a pure function of a rating and has never
    // asked whose it is, so a bot at the apex holds Cyber Overlord like
    // anybody — what must never happen is a bot taking a human's NUMBER.
    const humansBefore = [
      db.getProfile('dev_overlord_aaaaaaaaa').ladderPosition,
      db.getProfile('dev_overlord_bbbbbbbbb').ladderPosition,
      db.getProfile('dev_overlord_ccccccccc').ladderPosition,
    ];
    expect(humansBefore).toEqual([1, 2, 3]);

    // These two bots sit at mu 41 and 39 — ABOVE two of those humans — and
    // still do not displace one. They are numbered among themselves instead.
    const top = db.getProfile('bot-apex-1');
    const second = db.getProfile('bot-apex-2');
    expect(top.tier).toBe('overlord');
    expect(top.ladderPosition).toBe(1);
    expect(second.ladderPosition).toBe(2);

    // And a bot and a human hold the SAME placement at once, which is the
    // whole point: #1 of the people and #1 of the machines are two answers to
    // two questions, not a contradiction.
    expect(db.getProfile('dev_overlord_aaaaaaaaa').ladderPosition).toBe(1);
  });
});

describe('the ladder position the top rung renders', () => {
  it('agrees with the number the leaderboard prints, player for player', () => {
    const board = db.getLeaderboard('elo', 100);
    const overlords = board.filter((e) => e.tier === 'overlord');
    expect(overlords.length).toBeGreaterThan(0);
    for (const entry of overlords) {
      const profile = db.getProfile(entry.id);
      expect(profile.ladderPosition).toBe(entry.rank);
    }
  });

  it('counts humans only, so the seeded bots consume no position', () => {
    // Two bots outrank ApexAlpha, and neither may cost it the top spot: the
    // board hides them by default and never gives them a rank at all.
    expect(db.getProfile('dev_overlord_aaaaaaaaa').ladderPosition).toBe(1);
    expect(db.getProfile('dev_overlord_bbbbbbbbb').ladderPosition).toBe(2);
    expect(db.getProfile('dev_overlord_ccccccccc').ladderPosition).toBe(3);
  });

  it('ignores a player who has never played a ranked game', () => {
    // GhostEcho is rated 99 and would be #1 if the count copied the board's
    // filters incompletely — but the elo board only lists rankedGames > 0.
    const ghost = db.getProfile('dev_ghost_eeeeeeeeeeee');
    expect(ghost.ladderPosition).toBeUndefined();
    expect(db.getProfile('dev_overlord_aaaaaaaaa').ladderPosition).toBe(1);
  });

  it('ignores an unplaced player, however high their rating has climbed', () => {
    // RisingFox is rated 50 — above every Overlord here — with four placement
    // games played. The board lists them LAST, under all the placed rows, so a
    // count keyed on rating alone put every Overlord one position lower than
    // the Ranks page did, for exactly the players the number exists for.
    const rising = db.getProfile('dev_rising_gggggggggg');
    expect(rising.tier).toBe('unranked');
    expect(rising.ladderPosition).toBeUndefined();
    expect(db.getProfile('dev_overlord_aaaaaaaaa').ladderPosition).toBe(1);

    const board = db.getLeaderboard('elo', 100);
    const risingRank = board.find((e) => e.id === 'dev_rising_gggggggggg')!.rank;
    const apexRank = board.find((e) => e.id === 'dev_overlord_aaaaaaaaa')!.rank;
    expect(risingRank).toBeGreaterThan(apexRank!);
  });

  it('ignores a profile that never finished onboarding', () => {
    const stray = db.getProfile('dev_stray_fffffffffff');
    expect(stray.initialized).toBe(false);
    expect(stray.ladderPosition).toBeUndefined();
  });

  it('is absent below the top rung, where the tier name is the answer', () => {
    const legend = db.getProfile('dev_legend_ddddddddddd');
    expect(legend.tier).toBe('legend');
    expect(legend.ladderPosition).toBeUndefined();
  });

  it('is stable across repeated reads, including on a tie', () => {
    // Two players on exactly the same rating sort arbitrarily without a
    // tiebreak, so the board could reorder them between two refreshes of the
    // same page and the badge could disagree with itself. `p.id ASC` under
    // every sort key is what gives both one answer.
    seat('dev_tie_1111111111111', 'TieOne', 39.5);
    seat('dev_tie_2222222222222', 'TieTwo', 39.5);
    const first = db.getProfile('dev_tie_1111111111111').ladderPosition;
    const second = db.getProfile('dev_tie_2222222222222').ladderPosition;
    expect(first).not.toBe(second);
    for (let i = 0; i < 5; i++) {
      expect(db.getProfile('dev_tie_1111111111111').ladderPosition).toBe(first);
      expect(db.getProfile('dev_tie_2222222222222').ladderPosition).toBe(second);
      const board = db.getLeaderboard('elo', 100);
      expect(board.find((e) => e.id === 'dev_tie_1111111111111')!.rank).toBe(first);
      expect(board.find((e) => e.id === 'dev_tie_2222222222222')!.rank).toBe(second);
    }
  });

  it('stops at the top N: position 101 is no position at all', () => {
    // Everyone below the cap reads as an Overlord by NAME again, which is the
    // deliberate fallback — a countdown that ran past its own end would be
    // saying "#137 of 100".
    for (let i = 0; i < LADDER_TOP_N + 4; i++) {
      seat(`dev_crowd_${String(i).padStart(11, '0')}`, `Crowd${i}`, 45 - i * 0.01);
    }
    const board = db.getLeaderboard('elo', 200);
    const ranked = board.filter((e) => e.rank !== null);
    expect(ranked.length).toBeGreaterThan(LADDER_TOP_N);
    for (const entry of ranked) {
      const profile = db.getProfile(entry.id);
      if (entry.tier !== 'overlord') continue;
      if (entry.rank! <= LADDER_TOP_N) expect(profile.ladderPosition).toBe(entry.rank);
      else expect(profile.ladderPosition).toBeUndefined();
    }
  });
});

describe('the narrow rating read the relay pairs and predicts on', () => {
  // `queueCandidate` and `sendMatchPrediction` used to ask for a whole profile
  // and keep two floats out of it. That was merely wasteful until the ladder
  // position landed inside `getProfile`, at which point a queued Overlord cost
  // a full unindexed COUNT over `players` — N+1 times per queued entry per
  // two-second sweep, synchronously, on the relay's event loop. These pin that
  // the substitution is FAITHFUL; that it is faster is not something a test
  // states better than the absent call does.
  it('returns exactly what getProfile would have reported', () => {
    for (const id of ['dev_overlord_aaaaaaaaa', 'dev_legend_ddddddddddd', 'dev_rising_gggggggggg']) {
      const full = db.getProfile(id);
      expect(db.matchmakingRating(id)).toEqual({ mu: full.mmrMu, sigma: full.mmrSigma });
    }
  });

  it('reports nothing for an id with no row, rather than minting one', () => {
    // The difference from `getProfile`, which lazy-mints. Both call sites fall
    // back to `newRating()` — byte-for-byte what that mint produced — so an
    // account deleted mid-queue still pairs exactly as it did, and the sweep no
    // longer creates a player row as a side effect of looking at the queue.
    expect(db.matchmakingRating('dev_nobody_00000000000')).toBeNull();
    expect(db.matchmakingRating('dev_nobody_00000000000')).toBeNull();
  });
});

describe('a match that changes the rating changes the number with it', () => {
  it('reports the POST-match position, not the one it was loaded with', () => {
    // recordMatch loads the profile BEFORE applying the match, mutates it in
    // place and hands that same object back as MatchEndResult.profile — which
    // App installs verbatim and the relay pushes as `match_recorded`. Left to
    // readProfile alone the number would be the pre-match one, and the win that
    // carries somebody up the ladder is the exact moment anyone is looking.
    const climberId = 'dev_climber_999999999';
    seat(climberId, 'Climber', 44.995);
    const before = db.getProfile(climberId).ladderPosition;
    expect(before).toBeGreaterThan(1);

    const result = db.recordMatch({
      playerId: climberId,
      username: 'Climber',
      playerScore: 5,
      opponentScore: 0,
      bestStreak: 3,
      endStreak: 0,
      earnedStreak: 3,
      mode: 'multiplayer',
      isWinner: true,
    } as MatchEndPayload);

    expect(result.profile.tier).toBe('overlord');
    expect(result.profile.ladderPosition).toBe(db.getProfile(climberId).ladderPosition);
    // And it is the number the board would print at this instant.
    const entry = db.getLeaderboard('elo', 200).find((e) => e.id === climberId)!;
    expect(result.profile.ladderPosition).toBe(entry.rank);
  });

  it('does not count the player against their own pre-match row on a loss', () => {
    // recordMatch mutates the profile in memory and does not persist it until
    // the end, so mid-flight the player's STORED row still holds the higher
    // pre-match rating. After a loss that stored self satisfies `rankMu > ?`
    // and the player was counted as standing above themselves: one position
    // too low, or none at all at the top-100 boundary.
    const fallerId = 'dev_faller_888888888';
    seat(fallerId, 'Faller', 44.99);
    const before = db.getProfile(fallerId).ladderPosition!;

    const result = db.recordMatch({
      playerId: fallerId,
      username: 'Faller',
      playerScore: 0,
      opponentScore: 5,
      bestStreak: 1,
      endStreak: 0,
      earnedStreak: 1,
      mode: 'multiplayer',
      isWinner: false,
    } as MatchEndPayload);

    // The rating fell, so the position may legitimately be the same or worse —
    // what it may not be is a number nobody else agrees with.
    expect(result.profile.ladderPosition).toBe(db.getProfile(fallerId).ladderPosition);
    const entry = db.getLeaderboard('elo', 200).find((e) => e.id === fallerId)!;
    expect(result.profile.ladderPosition).toBe(entry.rank);
    expect(result.profile.ladderPosition).toBeGreaterThanOrEqual(before);
  });
});
