import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { MatchEndPayload } from '../src/types';

// Match history as the player reads it: one row per match they played, from
// their own side of the table, filterable by mode and by whether the match
// counted for rank, and paged. The bug this suite exists to hold down: every
// seat of a duel files its OWN row, and a history read that matched the
// player2 column as well showed each player their opponent's copy too — the
// winner saw two WIN cards, the loser two LOSS cards.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-history-test-'));
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

const init = (id: string, username: string) => {
  db.getProfile(id);
  const result = db.initializeProfile(id, username);
  if (!result.ok) throw new Error(`init failed: ${result.code}`);
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

describe('one row per player per match', () => {
  it("shows a duel once in each player's history, from their own side", () => {
    const winner = 'dev_hist000000000001';
    const loser = 'dev_hist000000000002';
    init(winner, 'HistWinner');
    init(loser, 'HistLoser');
    // Both seats file their own row under one key, the way the relay does.
    record(winner, {
      mode: 'multiplayer', opponentId: loser, opponentName: 'HistLoser',
      playerScore: 5, opponentScore: 2, isWinner: true, matchKey: 'hist:duel:1',
    });
    record(loser, {
      mode: 'multiplayer', opponentId: winner, opponentName: 'HistWinner',
      playerScore: 2, opponentScore: 5, isWinner: false, matchKey: 'hist:duel:1',
    });

    const winnerHist = db.getMatchHistory(winner);
    expect(winnerHist).toHaveLength(1);
    expect(winnerHist[0].player1Id).toBe(winner);
    expect(winnerHist[0].winnerId).toBe(winner);
    expect(winnerHist[0].scoreP1).toBe(5);
    expect(winnerHist[0].scoreP2).toBe(2);

    // The loser sees ONE loss — not their own row plus the winner's copy.
    const loserHist = db.getMatchHistory(loser);
    expect(loserHist).toHaveLength(1);
    expect(loserHist[0].player1Id).toBe(loser);
    expect(loserHist[0].winnerId).toBe(winner);
    expect(loserHist[0].scoreP1).toBe(2);
    expect(loserHist[0].scoreP2).toBe(5);
  });
});

describe('the ranked column', () => {
  it('stores whether the match actually counted for the ladder', () => {
    const p = 'dev_hist000000000003';
    init(p, 'HistRanks');
    // Rookie never ranks, whatever the rules — it is open from the first
    // match, so rating against it would make the tier badge a formality.
    record(p, { difficulty: 'rookie', matchKey: 'hist:r:1' });
    // Pro on stock rules is an earned difficulty: it rates.
    record(p, { difficulty: 'pro', matchKey: 'hist:r:2' });
    // Pro with a physics rule pushed past its ranked band does not.
    record(p, {
      difficulty: 'pro',
      rules: { paddleScale: 1.5 },
      matchKey: 'hist:r:3',
    } as never);
    // A stock duel rates; the sonar unranks it on its own.
    record(p, { mode: 'multiplayer', difficulty: undefined, matchKey: 'hist:r:4' });
    record(p, {
      mode: 'multiplayer', difficulty: undefined,
      rules: { opponentSonar: true },
      matchKey: 'hist:r:5',
    } as never);

    const byKeyOrder = db.getMatchHistory(p).reverse(); // oldest first
    expect(byKeyOrder.map((m) => m.ranked)).toEqual([0, 1, 0, 1, 0]);
  });

  it('reads a row from before the column existed as un-ranked', () => {
    const p = 'dev_hist000000000004';
    init(p, 'HistLegacy');
    record(p, { difficulty: 'pro', matchKey: 'hist:l:1' });
    // Age the row back to the pre-column shape: NULL, not 0.
    const raw = new DatabaseSync(DB_FILE);
    try {
      raw.prepare('UPDATE matches SET ranked = NULL WHERE player1Id = ?').run(p);
    } finally {
      raw.close();
    }
    expect(db.getMatchHistoryPage(p, { ranked: 'ranked' }).total).toBe(0);
    const unranked = db.getMatchHistoryPage(p, { ranked: 'unranked' });
    expect(unranked.total).toBe(1);
    expect(unranked.matches[0].ranked).toBeNull();
  });
});

describe('filters and paging', () => {
  const p = 'dev_hist000000000005';

  beforeAll(() => {
    init(p, 'HistPager');
    // 12 solo (5 pro = ranked, 7 rookie = not), 3 duels, 1 practice session.
    // bestStreak marks recording order so newest-first is checkable without
    // relying on timestamp resolution.
    let seq = 0;
    for (let i = 0; i < 5; i++) {
      record(p, { difficulty: 'pro', bestStreak: ++seq, matchKey: `hist:p:pro${i}` });
    }
    for (let i = 0; i < 7; i++) {
      record(p, { difficulty: 'rookie', bestStreak: ++seq, matchKey: `hist:p:rk${i}` });
    }
    for (let i = 0; i < 3; i++) {
      record(p, {
        mode: 'multiplayer', difficulty: undefined,
        bestStreak: ++seq, matchKey: `hist:p:mp${i}`,
      });
    }
    db.recordPractice(p, { bestStreak: ++seq, earnedStreak: 3, endStreak: 3 });
  });

  it('pages ten at a time, newest first, and counts the whole filter', () => {
    const page1 = db.getMatchHistoryPage(p);
    expect(page1.total).toBe(16);
    expect(page1.matches).toHaveLength(10);
    // Newest first: the practice session (the last thing recorded) leads.
    expect(page1.matches[0].mode).toBe('practice');
    const page2 = db.getMatchHistoryPage(p, { offset: 10 });
    expect(page2.total).toBe(16);
    expect(page2.matches).toHaveLength(6);
    // No overlap, no gap: together they are the whole history in order.
    const seen = [...page1.matches, ...page2.matches].map((m) => m.id);
    expect(new Set(seen).size).toBe(16);
    const streaks = [...page1.matches, ...page2.matches].map((m) => m.maxRally);
    expect(streaks).toEqual([...streaks].sort((a, b) => b - a));
  });

  it('filters by mode, and by ranked inside a mode', () => {
    expect(db.getMatchHistoryPage(p, { mode: 'multiplayer' }).total).toBe(3);
    expect(db.getMatchHistoryPage(p, { mode: 'solo' }).total).toBe(12);
    expect(db.getMatchHistoryPage(p, { mode: 'practice' }).total).toBe(1);
    expect(db.getMatchHistoryPage(p, { mode: 'solo', ranked: 'ranked' }).total).toBe(5);
    expect(db.getMatchHistoryPage(p, { mode: 'solo', ranked: 'unranked' }).total).toBe(7);
    expect(db.getMatchHistoryPage(p, { mode: 'multiplayer', ranked: 'ranked' }).total).toBe(3);
    const soloRanked = db.getMatchHistoryPage(p, { mode: 'solo', ranked: 'ranked' });
    expect(soloRanked.matches.every((m) => m.mode === 'solo' && m.ranked === 1)).toBe(true);
  });
});

describe('per-player retention', () => {
  it('trims one player past 500 rows without touching anybody else', () => {
    const busy = 'dev_hist000000000006';
    const quiet = 'dev_hist000000000007';
    init(busy, 'HistBusy');
    init(quiet, 'HistQuiet');
    // 509 raw rows for the busy player, then a real insert to fire the trim.
    const raw = new DatabaseSync(DB_FILE);
    try {
      const insert = raw.prepare(
        `INSERT INTO matches (id, player1Id, player1Name, player2Id, player2Name, winnerId, winnerName,
           scoreP1, scoreP2, maxRally, mode, difficulty, timestamp, ranked)
         VALUES (?, ?, 'HistBusy', 'AI-rookie', 'AI (rookie)', ?, 'HistBusy', 5, 2, 3, 'solo', 'rookie', ?, 0)`
      );
      const now = new Date().toISOString();
      for (let i = 0; i < 509; i++) insert.run(`bulk_${i}`, busy, busy, now);
      insert.run('quiet_1', quiet, quiet, now);
    } finally {
      raw.close();
    }
    record(busy, { matchKey: 'hist:trim:1' });

    expect(db.getMatchHistoryPage(busy).total).toBe(500);
    // The newest row survived the trim it triggered.
    expect(db.getMatchHistoryPage(busy).matches[0].id).not.toBe('bulk_0');
    // The old GLOBAL cap would have evicted the quiet player's only match.
    expect(db.getMatchHistoryPage(quiet).total).toBe(1);
  });
});
