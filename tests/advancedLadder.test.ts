import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { MatchEndPayload } from '../src/types';

// Three history columns, three different questions, none derivable from
// another — and the recount that reads the right one.
//
//   ranked              played under ranked conditions?
//   advancedLadder      actually moved the visible ladder?
//   rankedDuelCredited  credited a rankedDuel?
//
// They were one column until an anti-farming ladder could zero an update and a
// daily allowance could withhold a credit from a match that really did move
// the ladder.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-advanced-ladder-'));
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

const DAY = new Date('2026-06-08T09:00:00.000Z');
let seq = 0;

const human = (): string => {
  seq += 1;
  const id = `dev_adv_${seq}`;
  db.getProfile(id);
  const r = db.initializeProfile(id, `Advanced${seq}`);
  if (!r.ok) throw new Error(`init failed: ${r.code}`);
  return id;
};

const bot = (): string => {
  const id = human();
  const raw = new DatabaseSync(DB_FILE);
  try {
    raw.prepare('INSERT OR IGNORE INTO bot_accounts (botId, createdAt) VALUES (?, ?)')
      .run(id, new Date().toISOString());
  } finally {
    raw.close();
  }
  db.reloadBotAccounts();
  return id;
};

const duel = (playerId: string, over: Partial<MatchEndPayload> = {}): MatchEndPayload =>
  ({
    playerId,
    username: 'Advanced',
    playerScore: 5,
    opponentScore: 2,
    bestStreak: 4,
    endStreak: 0,
    earnedStreak: 4,
    mode: 'multiplayer',
    isWinner: true,
    ...over,
  }) as MatchEndPayload;

/** One duel, and the three columns its history row ends up carrying. */
const playAndRead = (me: string, oppId: string, at: Date = DAY) => {
  seq += 1;
  db.recordMatch({ ...duel(me), matchKey: `adv:${seq}` } as MatchEndPayload, {
    opponentId: oppId,
    opponentBand: 'ace',
    decidedAt: at,
    opponentRating: { mu: 25, sigma: 3 },
    opponentRankRating: { mu: 25, sigma: 3 },
  } as never);
  const raw = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    return raw
      .prepare(
        `SELECT ranked, advancedLadder, rankedDuelCredited FROM matches
          WHERE player1Id = ? ORDER BY rowid DESC LIMIT 1`
      )
      .get(me) as { ranked: number; advancedLadder: number; rankedDuelCredited: number };
  } finally {
    raw.close();
  }
};

describe('the three columns come apart', () => {
  it('an ordinary rated duel sets all three', () => {
    expect(playAndRead(human(), human())).toEqual({
      ranked: 1, advancedLadder: 1, rankedDuelCredited: 1,
    });
  });

  it('a hard-capped duel is ranked, advanced nothing, credited nothing', () => {
    // §2.6: the match still happens, is persisted in history, KEEPS its real
    // ranked classification, pays normal XP — and moves nothing.
    const me = human();
    const theBot = bot();
    for (let i = 0; i < 12; i += 1) {
      seq += 1;
      db.recordExposure({
        playerId: me, oppId: theBot, matchKey: `adv:cap:${seq}`,
        at: new Date(DAY.getTime() - (i + 1) * 60_000), oppIsBot: true, oppBand: 'ace',
      });
    }
    expect(playAndRead(me, theBot)).toEqual({
      ranked: 1, advancedLadder: 0, rankedDuelCredited: 0,
    });
  });

  it('a 6th bot duel of the day is ranked, DID advance, and credited nothing', () => {
    // The row that proves the third column is not derivable from the second.
    // Any recount over `advancedLadder` over-counts by exactly the capped
    // duels — and backfillRankedDuels applies its result with MAX, so the
    // over-count would be permanent.
    const me = human();
    for (let i = 0; i < 5; i += 1) {
      playAndRead(me, bot(), new Date(DAY.getTime() + i * 60_000));
    }
    expect(playAndRead(me, bot(), new Date(DAY.getTime() + 5 * 60_000))).toEqual({
      ranked: 1, advancedLadder: 1, rankedDuelCredited: 0,
    });
  });

  it('an unrated duel sets none of them', () => {
    const me = human();
    seq += 1;
    db.recordMatch({ ...duel(me), matchKey: `adv:casual:${seq}` } as MatchEndPayload, {
      opponentId: human(), opponentBand: 'ace', decidedAt: DAY, venueRoomId: 'casual',
    } as never);
    const raw = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      expect(
        raw
          .prepare(
            `SELECT ranked, advancedLadder, rankedDuelCredited FROM matches
              WHERE player1Id = ? ORDER BY rowid DESC LIMIT 1`
          )
          .get(me)
      ).toEqual({ ranked: 0, advancedLadder: 0, rankedDuelCredited: 0 });
    } finally {
      raw.close();
    }
  });
});

describe('one decision, written twice', () => {
  it('agrees between the exposure row and the match row, always', () => {
    // The live twin and the durable copy are written from ONE boolean in one
    // transaction and must never be independently recomputed — a second
    // derivation is a second chance to disagree, and the two are pruned on
    // different schedules, so the disagreement would surface long after the
    // match.
    //
    // Mutation check: recompute the match-row value from the allowance instead
    // of copying the decision, and the refused-by-cap rows diverge.
    const me = human();
    // Credited, refused-by-cap and hard-capped in one run.
    for (let i = 0; i < 7; i += 1) {
      playAndRead(me, bot(), new Date(DAY.getTime() + i * 60_000));
    }
    const theBot = bot();
    for (let i = 0; i < 12; i += 1) {
      seq += 1;
      db.recordExposure({
        playerId: me, oppId: theBot, matchKey: `adv:mix:${seq}`,
        at: new Date(DAY.getTime() - (i + 1) * 60_000), oppIsBot: true, oppBand: 'legend',
      });
    }
    playAndRead(me, theBot, new Date(DAY.getTime() + 8 * 60_000));

    const raw = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      // The two tables cannot be JOINED: `matches.id` is a minted
      // `match_<time>_<rand>` and the exposure row is keyed on the matchKey.
      // They are written in the same transaction in the same order, though, so
      // the two sequences in write order line up — and only the ELIGIBLE
      // matches have an exposure row at all, which `ranked = 1` selects.
      const exposure = (
        raw
          .prepare(
            // The twelve hand-seeded prior rows have no match row of their
            // own and are excluded, or the sequences cannot line up.
            `SELECT duelCredited FROM competitive_exposure
              WHERE playerId = ? AND matchKey NOT LIKE 'adv:mix:%' ORDER BY rowid`
          )
          .all(me) as unknown as Array<{ duelCredited: number }>
      ).map((r) => r.duelCredited);
      const matches = (
        raw
          .prepare(
            `SELECT rankedDuelCredited FROM matches
              WHERE player1Id = ? AND ranked = 1 ORDER BY rowid`
          )
          .all(me) as unknown as Array<{ rankedDuelCredited: number }>
      ).map((r) => r.rankedDuelCredited);

      expect(exposure.length).toBeGreaterThan(0);
      // BOTH states present, or the comparison is trivially satisfiable — five
      // credited, three refused by the allowance, one hard-capped.
      expect(new Set(exposure)).toEqual(new Set([0, 1]));
      expect(matches).toEqual(exposure);
    } finally {
      raw.close();
    }
  });
});

describe('reconstruction, and what it can actually promise', () => {
  const recount = (me: string, column: 'rankedDuelCredited' | 'advancedLadder'): number => {
    const raw = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      return (
        raw
          .prepare(
            `SELECT COUNT(*) AS n FROM matches
              WHERE player1Id = ? AND mode = 'multiplayer' AND ${column} = 1`
          )
          .get(me) as { n: number }
      ).n;
    } finally {
      raw.close();
    }
  };

  it('is EXACT over untrimmed history, and only from the right column', () => {
    const me = human();
    // Five credited bot duels, then three refused by the daily allowance.
    for (let i = 0; i < 8; i += 1) {
      playAndRead(me, bot(), new Date(DAY.getTime() + i * 60_000));
    }
    const durable = db.getProfile(me).rankedDuels;
    expect(durable).toBe(5);
    expect(recount(me, 'rankedDuelCredited')).toBe(durable);
    // And the reason the third column exists, asserted rather than argued:
    // a recount over advancedLadder over-counts by exactly the capped duels.
    expect(recount(me, 'advancedLadder')).toBe(8);
  });

  it('is monotonic REPAIR once history has been trimmed, never reconstruction', () => {
    // insertMatch trims `matches` to the newest 500 rows per player, so after
    // that the evidence is deleted and no column can bring it back. What the
    // recount provides is MAX(existing, retained recount): it raises a counter
    // that is behind and can never lower one that is ahead.
    const me = human();
    const raw = new DatabaseSync(DB_FILE);
    try {
      raw.prepare('UPDATE players SET rankedDuels = ? WHERE id = ?').run(400, me);
    } finally {
      raw.close();
    }
    for (let i = 0; i < 3; i += 1) {
      playAndRead(me, human(), new Date(DAY.getTime() + i * 60_000));
    }
    const ahead = db.getProfile(me).rankedDuels;
    expect(ahead).toBe(403);
    expect(recount(me, 'rankedDuelCredited')).toBe(3);
    // A recount that ASSIGNED would rob this account of 400 duels. MAX cannot.
    expect(Math.max(ahead, recount(me, 'rankedDuelCredited'))).toBe(ahead);
  });
});

describe('the two one-shot backfills', () => {
  it('copy the right predecessor onto legacy rows, in order', async () => {
    // Before these columns existed the three questions had one answer, so each
    // copy is exact for history and the new behaviour applies only forward.
    // advanced_ladder_backfill_v1 copies `ranked`; ranked_duel_credited_backfill_v1
    // copies `advancedLadder` and only for multiplayer rows, so a solo match —
    // which never credited a duel — is left at 0 rather than inheriting one.
    const raw = new DatabaseSync(DB_FILE);
    try {
      const legacy = (id: string, mode: string, ranked: number | null) => {
        raw
          .prepare(
            `INSERT INTO matches (id, player1Id, player1Name, player2Id, player2Name,
               winnerId, winnerName, scoreP1, scoreP2, maxRally, mode, difficulty,
               timestamp, ranked, advancedLadder, rankedDuelCredited)
             VALUES (?, 'dev_legacy', 'Legacy', 'dev_other', 'Other', 'dev_legacy',
               'Legacy', 5, 2, 4, ?, NULL, ?, ?, NULL, NULL)`
          )
          .run(id, mode, DAY.toISOString(), ranked);
      };
      legacy('legacy-pvp-ranked', 'multiplayer', 1);
      legacy('legacy-pvp-unranked', 'multiplayer', 0);
      legacy('legacy-pvp-null', 'multiplayer', null);
      legacy('legacy-solo-ranked', 'solo', 1);
      // Un-stamp both keys so the next boot re-runs them.
      raw.prepare("DELETE FROM meta WHERE key IN ('advanced_ladder_backfill_v1', 'ranked_duel_credited_backfill_v1')").run();
    } finally {
      raw.close();
    }

    // A fresh module instance, or the constructor -- which is where every
    // one-shot migration runs -- never fires again.
    vi.resetModules();
    const { db: booted } = await import('../server/db');
    void booted;
    const check = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      const rows = check
        .prepare(
          `SELECT id, ranked, advancedLadder, rankedDuelCredited FROM matches
            WHERE id LIKE 'legacy-%' ORDER BY id`
        )
        .all() as unknown as Array<{
          id: string; ranked: number | null;
          advancedLadder: number | null; rankedDuelCredited: number | null;
        }>;
      expect(rows).toEqual([
        // A NULL `ranked` stays NULL through both copies: it cannot be
        // reconstructed honestly and already reads as un-ranked.
        { id: 'legacy-pvp-null', ranked: null, advancedLadder: null, rankedDuelCredited: null },
        { id: 'legacy-pvp-ranked', ranked: 1, advancedLadder: 1, rankedDuelCredited: 1 },
        { id: 'legacy-pvp-unranked', ranked: 0, advancedLadder: 0, rankedDuelCredited: 0 },
        // Solo: advancedLadder copied, but no duel credit — a solo match never
        // credited one, whatever it did to the ladder.
        { id: 'legacy-solo-ranked', ranked: 1, advancedLadder: 1, rankedDuelCredited: null },
      ]);
    } finally {
      check.close();
    }
  });
});

describe('the recount reads the third column', () => {
  it('counts credited duels and not advanced ones', async () => {
    // The production repoint of backfillRankedDuels, driven for real rather
    // than recomputed in the test. Without this the SQL could go on reading
    // `advancedLadder` with every other assertion here green — measured, and
    // it is why this exists as its own case.
    //
    // The fixture is the one row where the two columns disagree: eight bot
    // duels in a UTC day, five credited and three advanced-but-refused by
    // §2.7's allowance.
    const me = human();
    for (let i = 0; i < 8; i += 1) {
      playAndRead(me, bot(), new Date(DAY.getTime() + i * 60_000));
    }
    expect(db.getProfile(me).rankedDuels).toBe(5);

    const raw = new DatabaseSync(DB_FILE);
    try {
      // Behind where the evidence stands, which is the state the repair is for.
      raw.prepare('UPDATE players SET rankedDuels = 0 WHERE id = ?').run(me);
      raw.prepare("DELETE FROM meta WHERE key = 'ranked_duels_backfill_v1'").run();
    } finally {
      raw.close();
    }

    vi.resetModules();
    const { db: booted } = await import('../server/db');
    // Five, not eight: the three duels the daily allowance refused really did
    // move the visible ladder and credited nothing, so a recount over
    // `advancedLadder` would hand this account three duels it never earned —
    // permanently, because the recount applies MAX.
    expect(booted.getProfile(me).rankedDuels).toBe(5);
  });
});
