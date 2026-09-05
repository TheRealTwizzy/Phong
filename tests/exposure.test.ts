import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { MatchEndPayload } from '../src/types';
import {
  BOT_BAND_SATURATION,
  BOT_DAILY_SATURATION,
  BOT_PAIR_BANDS,
  HUMAN_PAIR_BANDS,
  participantWeights,
} from '../src/playbotRating';

// The exposure store: what the three anti-farming ladders count, and the
// windows they count it over.
//
// Everything here is the DB layer alone. Nothing calls recordMatch: the
// wiring, and with it the eligibility gate that decides whether a row is
// written at all, is a later slice. What this file holds is that a row, once
// written, is counted by the right ladder over the right window — and that
// the current match is never evidence about itself.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-exposure-test-'));
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

const HOUR = 60 * 60 * 1000;

// 02:00 UTC deliberately: it puts the last UTC midnight only two hours back,
// so a row can be a few hours old — inside every rolling window — and still
// belong to YESTERDAY. That is the one fixture where the rolling windows and
// the calendar-day counters disagree, and it is what proves the day counters
// are keyed on the date rather than on elapsed time.
const ANCHOR = new Date('2026-03-05T02:00:00.000Z');
const ago = (ms: number) => new Date(ANCHOR.getTime() - ms);

let seq = 0;
const nextKey = () => `exp:key:${++seq}`;
const nextPlayer = () => `dev_exposure_${++seq}`;

/** One participant's row, with the fields a test does not care about defaulted. */
const put = (o: {
  playerId: string;
  oppId: string;
  at: Date;
  matchKey?: string;
  oppIsBot?: boolean;
  oppBand?: string;
}) => {
  const matchKey = o.matchKey ?? nextKey();
  db.recordExposure({
    playerId: o.playerId,
    oppId: o.oppId,
    matchKey,
    at: o.at,
    oppIsBot: o.oppIsBot ?? false,
    oppBand: o.oppBand ?? 'ace',
  });
  return matchKey;
};

/** The counts a match between these two, decided at `at`, would be judged on. */
const countsFor = (o: {
  playerId: string;
  oppId: string;
  at: Date;
  matchKey?: string;
  oppBand?: string;
  humanVsBot?: boolean;
}) =>
  db.exposureCounts({
    playerId: o.playerId,
    oppId: o.oppId,
    matchKey: o.matchKey ?? 'exp:not-yet-recorded',
    at: o.at,
    oppBand: o.oppBand ?? 'ace',
    humanVsBot: o.humanVsBot ?? true,
  });

const rawRows = (matchKey: string): number => {
  const raw = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    return (
      raw
        .prepare('SELECT COUNT(*) AS n FROM competitive_exposure WHERE matchKey = ?')
        .get(matchKey) as { n: number }
    ).n;
  } finally {
    raw.close();
  }
};

describe('the same-pair count', () => {
  it('counts this pair over the rolling 24 hours and nothing older', () => {
    const me = nextPlayer();
    const you = nextPlayer();
    put({ playerId: me, oppId: you, at: ago(1 * HOUR) });
    put({ playerId: me, oppId: you, at: ago(12 * HOUR) });
    put({ playerId: me, oppId: you, at: ago(23 * HOUR) });
    put({ playerId: me, oppId: you, at: ago(25 * HOUR) });

    expect(countsFor({ playerId: me, oppId: you, at: ANCHOR }).priorPairCount).toBe(3);
  });

  it('counts only THIS pair', () => {
    const me = nextPlayer();
    const you = nextPlayer();
    const someoneElse = nextPlayer();
    put({ playerId: me, oppId: you, at: ago(1 * HOUR) });
    put({ playerId: me, oppId: someoneElse, at: ago(1 * HOUR) });

    expect(countsFor({ playerId: me, oppId: you, at: ANCHOR }).priorPairCount).toBe(1);
    expect(countsFor({ playerId: me, oppId: someoneElse, at: ANCHOR }).priorPairCount).toBe(1);
  });

  it('is anchored on the match decided-at it is given, never on the wall clock', () => {
    // The whole both-seats-agree rule rests on this: the anchor is supplied
    // ONCE by the vouching room and both seats read the same window from it.
    // A per-seat `new Date()` would be within milliseconds of it in the
    // ordinary case and would come apart at exactly the boundary a farming
    // client sits on — so the window is asserted from an anchor hours away
    // from the real clock, which a wall-clock implementation cannot satisfy
    // at all.
    //
    // Mutation check: read `Date.now()` instead of the supplied `at` and both
    // assertions below go red.
    const me = nextPlayer();
    const you = nextPlayer();
    put({ playerId: me, oppId: you, at: ago(23 * HOUR) });

    expect(countsFor({ playerId: me, oppId: you, at: ANCHOR }).priorPairCount).toBe(1);
    // The same row, judged by a match decided two hours later, is 25h old.
    const later = new Date(ANCHOR.getTime() + 2 * HOUR);
    expect(countsFor({ playerId: me, oppId: you, at: later }).priorPairCount).toBe(0);
  });

  it('gives both seats of one match the identical count', () => {
    // Each seat writes its own row, mirrored, sharing the match's anchor —
    // so the pair reads the same from either side and neither can be at a
    // different point on the ladder from the other.
    const a = nextPlayer();
    const b = nextPlayer();
    for (let i = 0; i < 4; i += 1) {
      const key = nextKey();
      const at = ago((i + 1) * HOUR);
      put({ playerId: a, oppId: b, matchKey: key, at });
      put({ playerId: b, oppId: a, matchKey: key, at });
    }

    const seatA = countsFor({ playerId: a, oppId: b, at: ANCHOR });
    const seatB = countsFor({ playerId: b, oppId: a, at: ANCHOR });
    expect(seatA.priorPairCount).toBe(4);
    expect(seatB.priorPairCount).toBe(seatA.priorPairCount);
  });

  it('counts one persisted match once, however long the match ran', () => {
    // The unit is a completed match, not a point, a rally or a round: the row
    // is keyed on matchKey, so a first-to-15 contributes exactly what a
    // first-to-3 does.
    const me = nextPlayer();
    const you = nextPlayer();
    const shortMatch = put({ playerId: me, oppId: you, at: ago(2 * HOUR) });
    const longMatch = put({ playerId: me, oppId: you, at: ago(1 * HOUR) });

    expect(countsFor({ playerId: me, oppId: you, at: ANCHOR }).priorPairCount).toBe(2);
    expect(rawRows(shortMatch)).toBe(1);
    expect(rawRows(longMatch)).toBe(1);
  });

  it('advances nothing when a matchKey is replayed', () => {
    const me = nextPlayer();
    const you = nextPlayer();
    const key = nextKey();
    put({ playerId: me, oppId: you, matchKey: key, at: ago(1 * HOUR) });
    put({ playerId: me, oppId: you, matchKey: key, at: ago(1 * HOUR) });
    put({ playerId: me, oppId: you, matchKey: key, at: ANCHOR });

    expect(countsFor({ playerId: me, oppId: you, at: ANCHOR }).priorPairCount).toBe(1);
    expect(rawRows(key)).toBe(1);
  });

  it('closes the window ON the anchor, so the exclusion is the only thing hiding the row', () => {
    // Not a stylistic choice: `at < anchor` would hide the current row on its
    // own, which makes the matchKey exclusion redundant — and a redundant
    // guard is one a later tidy-up removes with every test still green, right
    // up until the daily counters, which have no `at` predicate at all and are
    // excluded by nothing else. Measured: with the strict comparison the test
    // below passes whether the exclusion exists or not.
    const me = nextPlayer();
    const you = nextPlayer();
    const key = put({ playerId: me, oppId: you, at: ANCHOR });

    // Visible to anyone else asking about this pair at this instant...
    expect(countsFor({ playerId: me, oppId: you, at: ANCHOR }).priorPairCount).toBe(1);
    // ...and hidden from the match it belongs to, by the exclusion alone.
    expect(
      countsFor({ playerId: me, oppId: you, at: ANCHOR, matchKey: key }).priorPairCount
    ).toBe(0);
  });

  it('never counts the current match as prior evidence about itself', () => {
    // The row is inserted BEFORE the counts are read — that is what makes both
    // seats read the same window — so the exclusion is what keeps it honest.
    //
    // Mutation check: drop the `matchKey <> ?` clause and this goes red. It is
    // the only thing excluding the row: the window is `at <= anchor`, not
    // `at < anchor`, deliberately, or this test would pass whether the
    // exclusion existed or not.
    const me = nextPlayer();
    const you = nextPlayer();
    put({ playerId: me, oppId: you, at: ago(1 * HOUR) });

    const current = nextKey();
    put({ playerId: me, oppId: you, matchKey: current, at: ANCHOR });
    expect(
      countsFor({ playerId: me, oppId: you, at: ANCHOR, matchKey: current }).priorPairCount
    ).toBe(1);
  });
});

describe('the bot rank-band count', () => {
  it('counts bot matches in one band and no other', () => {
    const me = nextPlayer();
    put({ playerId: me, oppId: nextPlayer(), at: ago(1 * HOUR), oppIsBot: true, oppBand: 'master' });
    put({ playerId: me, oppId: nextPlayer(), at: ago(2 * HOUR), oppIsBot: true, oppBand: 'master' });
    put({ playerId: me, oppId: nextPlayer(), at: ago(3 * HOUR), oppIsBot: true, oppBand: 'ace' });

    expect(
      countsFor({ playerId: me, oppId: nextPlayer(), at: ANCHOR, oppBand: 'master' })
        .priorBotBandCount
    ).toBe(2);
    expect(
      countsFor({ playerId: me, oppId: nextPlayer(), at: ANCHOR, oppBand: 'ace' }).priorBotBandCount
    ).toBe(1);
  });

  it('counts BOT opponents only, whatever band a human was in', () => {
    // §2.4 is repeated exposure to one BOT skill band. A human sitting in the
    // same band is an ordinary opponent and belongs to §2.3 alone.
    const me = nextPlayer();
    put({ playerId: me, oppId: nextPlayer(), at: ago(1 * HOUR), oppIsBot: false, oppBand: 'master' });
    put({ playerId: me, oppId: nextPlayer(), at: ago(2 * HOUR), oppIsBot: true, oppBand: 'master' });

    expect(
      countsFor({ playerId: me, oppId: nextPlayer(), at: ANCHOR, oppBand: 'master' })
        .priorBotBandCount
    ).toBe(1);
  });

  it('rolls over 24 hours like the pair count', () => {
    const me = nextPlayer();
    put({ playerId: me, oppId: nextPlayer(), at: ago(23 * HOUR), oppIsBot: true, oppBand: 'legend' });
    put({ playerId: me, oppId: nextPlayer(), at: ago(25 * HOUR), oppIsBot: true, oppBand: 'legend' });

    expect(
      countsFor({ playerId: me, oppId: nextPlayer(), at: ANCHOR, oppBand: 'legend' })
        .priorBotBandCount
    ).toBe(1);
  });
});

describe('the daily bot count', () => {
  it('counts every bot match of the current UTC day, at any hour of it', () => {
    const me = nextPlayer();
    // 00:30 and 01:30 UTC — both today, both bots.
    put({ playerId: me, oppId: nextPlayer(), at: ago(90 * 60 * 1000), oppIsBot: true });
    put({ playerId: me, oppId: nextPlayer(), at: ago(30 * 60 * 1000), oppIsBot: true });

    expect(countsFor({ playerId: me, oppId: nextPlayer(), at: ANCHOR }).priorBotDailyCount).toBe(2);
  });

  it('is a CALENDAR day, so a row hours old can belong to yesterday', () => {
    // The load-bearing fixture: four hours before a 02:00 UTC anchor is
    // 22:00 the previous day. It is inside every rolling window and outside
    // the day counter, which is the only arrangement that tells a date-keyed
    // counter from an elapsed-time one.
    const me = nextPlayer();
    const you = nextPlayer();
    put({ playerId: me, oppId: you, at: ago(4 * HOUR), oppIsBot: true, oppBand: 'ace' });

    const counts = countsFor({ playerId: me, oppId: you, at: ANCHOR, oppBand: 'ace' });
    expect(counts.priorPairCount).toBe(1);
    expect(counts.priorBotBandCount).toBe(1);
    expect(counts.priorBotDailyCount).toBe(0);
  });

  it('counts BOT opponents only', () => {
    const me = nextPlayer();
    put({ playerId: me, oppId: nextPlayer(), at: ago(30 * 60 * 1000), oppIsBot: false });
    put({ playerId: me, oppId: nextPlayer(), at: ago(30 * 60 * 1000), oppIsBot: true });

    expect(countsFor({ playerId: me, oppId: nextPlayer(), at: ANCHOR }).priorBotDailyCount).toBe(1);
  });
});

describe('the human-only ladders', () => {
  it('are not counted for a participant who is not a human facing a bot', () => {
    // §2.4 and §2.5 are the HUMAN's alone. A bot keeps its ×1.00 progression
    // and its own counters, subject only to §2.3 — so a bot seat asks the
    // pair query and neither of the other two.
    const me = nextPlayer();
    put({ playerId: me, oppId: nextPlayer(), at: ago(30 * 60 * 1000), oppIsBot: true, oppBand: 'ace' });
    const you = nextPlayer();
    put({ playerId: me, oppId: you, at: ago(30 * 60 * 1000), oppIsBot: true, oppBand: 'ace' });

    const counts = countsFor({
      playerId: me, oppId: you, at: ANCHOR, oppBand: 'ace', humanVsBot: false,
    });
    expect(counts.priorPairCount).toBe(1);
    expect(counts.priorBotBandCount).toBe(0);
    expect(counts.priorBotDailyCount).toBe(0);
  });
});

describe('oppBand', () => {
  it('is the opponent start tier on every row, including the pair kinds §2.4 never reads', () => {
    // One meaning everywhere, and no sentinel: a column that means "the
    // opponent's start tier" on some rows and "which kind of thing this was"
    // on others is a column that gets read wrong the first time a second
    // query wants it. oppIsBot already answers the kind question.
    const humanVsHuman = put({
      playerId: nextPlayer(), oppId: nextPlayer(), at: ago(1 * HOUR),
      oppIsBot: false, oppBand: 'vanguard',
    });
    const botVsBot = put({
      playerId: nextPlayer(), oppId: nextPlayer(), at: ago(1 * HOUR),
      oppIsBot: true, oppBand: 'grandmaster',
    });

    const raw = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      const read = (key: string) =>
        raw.prepare('SELECT oppBand FROM competitive_exposure WHERE matchKey = ?').get(key) as
          | { oppBand: string }
          | undefined;
      expect(read(humanVsHuman)?.oppBand).toBe('vanguard');
      expect(read(botVsBot)?.oppBand).toBe('grandmaster');
      // NOT NULL, so the sentinel cannot creep back in by omission either.
      const cols = raw
        .prepare('PRAGMA table_info(competitive_exposure)')
        .all() as unknown as Array<{ name: string; notnull: number }>;
      expect(cols.find((c) => c.name === 'oppBand')?.notnull).toBe(1);
    } finally {
      raw.close();
    }
  });
});

describe('the pair history a preference reads FORWARD', () => {
  // `exposureCounts` answers "what is this match judged on", asked at record
  // time with the match's own row already inserted. `pairHistory` asks the
  // other direction -- "how much of this pair has been played, and when" --
  // because §2.11's diversity preference decides who a bot walks up to BEFORE
  // there is a match to judge. Same table, same rolling window, no writes.

  it('counts the pair inside the window and reports when it last was', () => {
    const me = nextPlayer();
    const them = nextPlayer();
    const recent = ago(2 * HOUR);
    put({ playerId: me, oppId: them, at: ago(20 * HOUR) });
    put({ playerId: me, oppId: them, at: recent });
    // Outside the 24h window: retained for the pruner, invisible to this.
    put({ playerId: me, oppId: them, at: ago(30 * HOUR) });

    const seen = db.pairHistory(me, them, ANCHOR);
    expect(seen.count).toBe(2);
    expect(seen.lastAt).toBe(recent.getTime());
  });

  it('is about ONE pair, not about either player’s other matches', () => {
    // The failure this guards is a query missing its `oppId`: a bot with a
    // busy evening would then look like somebody it had played all night, and
    // the preference would send it away from the one opponent it had not met.
    const me = nextPlayer();
    const them = nextPlayer();
    const other = nextPlayer();
    put({ playerId: me, oppId: other, at: ago(1 * HOUR) });
    put({ playerId: other, oppId: them, at: ago(1 * HOUR) });

    expect(db.pairHistory(me, them, ANCHOR)).toEqual({ count: 0, lastAt: null });
  });

  it('is DIRECTED, because a row names its own participant', () => {
    // Every participant files their own row, so `(me, them)` is my record of
    // us and `(them, me)` is theirs. A preference asks about the pair from the
    // seat that is choosing.
    const me = nextPlayer();
    const them = nextPlayer();
    put({ playerId: them, oppId: me, at: ago(1 * HOUR) });
    expect(db.pairHistory(me, them, ANCHOR).count).toBe(0);
    expect(db.pairHistory(them, me, ANCHOR).count).toBe(1);
  });

  it('reports a pair never played as never played, not as just now', () => {
    // `lastAt` feeds a sort where "longer ago" wins, so a null read as 0 would
    // make a stranger the LEAST preferred opponent in the room -- the exact
    // reverse of the rule.
    expect(db.pairHistory(nextPlayer(), nextPlayer(), ANCHOR)).toEqual({
      count: 0,
      lastAt: null,
    });
  });
});

describe('retention and eligibility', () => {
  it('are different questions, and a retained row can be eligible for nothing', () => {
    // Retention is set by the rolling windows plus a margin; eligibility is
    // each counter's own predicate. They do not nest the way they look like
    // they do, and two assertions that read plausibly are simply impossible:
    // nothing 25 hours old can be in the current UTC day (at 23:59:59 UTC the
    // day is at most 24 hours old), and nothing 47 hours old is inside a
    // 24-hour window.
    const me = nextPlayer();
    const you = nextPlayer();
    const yesterday = put({ playerId: me, oppId: you, at: ago(4 * HOUR), oppIsBot: true });
    const h25 = put({ playerId: me, oppId: you, at: ago(25 * HOUR), oppIsBot: true });
    const h47 = put({ playerId: me, oppId: you, at: ago(47 * HOUR), oppIsBot: true });
    const h49 = put({ playerId: me, oppId: you, at: ago(49 * HOUR), oppIsBot: true });

    // Writing at the anchor is what sweeps: >48h relative to this match's own
    // decided-at, never relative to the wall clock, so a replayed match
    // cannot prune the window it is about to read.
    const current = put({ playerId: me, oppId: you, at: ANCHOR, oppIsBot: true });

    expect({ yesterday: rawRows(yesterday), h25: rawRows(h25), h47: rawRows(h47), h49: rawRows(h49) })
      .toEqual({ yesterday: 1, h25: 1, h47: 1, h49: 0 });

    // Retained and eligible for nothing is the normal state of the back half
    // of the retention period. Only `yesterday` and the anchor row itself are
    // inside any window, and the anchor row is excluded as the current match.
    const counts = countsFor({ playerId: me, oppId: you, at: ANCHOR, matchKey: current });
    expect(counts.priorPairCount).toBe(1);
    expect(counts.priorBotDailyCount).toBe(0);
  });

  it('leaves every currently valid lookup unmoved when the sweeper runs', () => {
    // Asserted as "no counter's answer changes", computed before and after,
    // rather than by claiming any particular old row still counts.
    const me = nextPlayer();
    const you = nextPlayer();
    put({ playerId: me, oppId: you, at: ago(2 * HOUR), oppIsBot: true, oppBand: 'ace' });
    put({ playerId: me, oppId: you, at: ago(20 * HOUR), oppIsBot: true, oppBand: 'ace' });
    put({ playerId: me, oppId: you, at: ago(47 * HOUR), oppIsBot: true, oppBand: 'ace' });
    put({ playerId: me, oppId: you, at: ago(60 * HOUR), oppIsBot: true, oppBand: 'ace' });

    const before = countsFor({ playerId: me, oppId: you, at: ANCHOR, oppBand: 'ace' });
    db.pruneExposure(ANCHOR);
    const after = countsFor({ playerId: me, oppId: you, at: ANCHOR, oppBand: 'ace' });
    expect(after).toEqual(before);
  });
});

describe('a prior count and the match number it indexes', () => {
  // Every count here is a PRIOR count and every table in src/playbotRating is
  // indexed by the CURRENT match number, which is one more. This is where an
  // off-by-one would hide: it would shift a whole ladder by one match and
  // look entirely plausible doing it.
  //
  // Mutation check: drop one `+ 1` in playbotRating and exactly one column of
  // one ladder goes red.
  const bandFor = (o: {
    kind: 'human-human' | 'human-bot';
    priorPairCount?: number;
    priorBotBandCount?: number;
    priorBotDailyCount?: number;
  }) =>
    participantWeights({
      kind: o.kind,
      selfIsBot: false,
      won: true,
      counts: {
        priorPairCount: o.priorPairCount ?? 0,
        priorBotBandCount: o.priorBotBandCount ?? 0,
        priorBotDailyCount: o.priorBotDailyCount ?? 0,
      },
    });

  const HUMAN_VS_BOT_BASE = 0.7;

  it('opens the bot-involved pair ladder on the 4th match and caps on the 13th', () => {
    expect(BOT_PAIR_BANDS[0].through).toBe(3);
    // prior 2 → match #3 → full weight; prior 3 → match #4 → ×0.90.
    expect(bandFor({ kind: 'human-bot', priorPairCount: 2 }).mu).toBeCloseTo(HUMAN_VS_BOT_BASE, 10);
    expect(bandFor({ kind: 'human-bot', priorPairCount: 3 }).mu)
      .toBeCloseTo(HUMAN_VS_BOT_BASE * 0.9, 10);
    // prior 11 → match #12 → still rated; prior 12 → match #13 → hard cap.
    expect(bandFor({ kind: 'human-bot', priorPairCount: 11 }).hardCapped).toBe(false);
    expect(bandFor({ kind: 'human-bot', priorPairCount: 12 })).toEqual({
      mu: 0, sigma: 0, hardCapped: true, cappedBy: 'pair',
    });
  });

  it('opens the human pair ladder on the 9th match and caps on the 25th', () => {
    expect(HUMAN_PAIR_BANDS[0].through).toBe(8);
    expect(bandFor({ kind: 'human-human', priorPairCount: 7 }).mu).toBeCloseTo(1, 10);
    expect(bandFor({ kind: 'human-human', priorPairCount: 8 }).mu).toBeCloseTo(0.9, 10);
    expect(bandFor({ kind: 'human-human', priorPairCount: 23 }).hardCapped).toBe(false);
    expect(bandFor({ kind: 'human-human', priorPairCount: 24 })).toEqual({
      mu: 0, sigma: 0, hardCapped: true, cappedBy: 'pair',
    });
  });

  it('opens the bot rank-band ladder on the 13th match and caps on the 33rd', () => {
    expect(BOT_BAND_SATURATION[0].through).toBe(12);
    expect(bandFor({ kind: 'human-bot', priorBotBandCount: 11 }).mu)
      .toBeCloseTo(HUMAN_VS_BOT_BASE, 10);
    expect(bandFor({ kind: 'human-bot', priorBotBandCount: 12 }).mu)
      .toBeCloseTo(HUMAN_VS_BOT_BASE * 0.9, 10);
    expect(bandFor({ kind: 'human-bot', priorBotBandCount: 31 }).hardCapped).toBe(false);
    expect(bandFor({ kind: 'human-bot', priorBotBandCount: 32 }).cappedBy).toBe('band');
  });

  it('opens the daily bot ladder on the 26th match and caps on the 76th', () => {
    expect(BOT_DAILY_SATURATION[0].through).toBe(25);
    expect(bandFor({ kind: 'human-bot', priorBotDailyCount: 24 }).mu)
      .toBeCloseTo(HUMAN_VS_BOT_BASE, 10);
    expect(bandFor({ kind: 'human-bot', priorBotDailyCount: 25 }).mu)
      .toBeCloseTo(HUMAN_VS_BOT_BASE * 0.9, 10);
    expect(bandFor({ kind: 'human-bot', priorBotDailyCount: 74 }).hardCapped).toBe(false);
    expect(bandFor({ kind: 'human-bot', priorBotDailyCount: 75 }).cappedBy).toBe('daily');
  });

  it('reads a stored run of matches at the match number the next one really is', () => {
    // The composition end to end: three recorded matches against one bot are
    // three PRIOR matches, so the fourth is the one the ladder first reduces.
    const me = nextPlayer();
    const bot = nextPlayer();
    for (let i = 0; i < 3; i += 1) {
      put({ playerId: me, oppId: bot, at: ago((i + 1) * HOUR), oppIsBot: true, oppBand: 'ace' });
    }
    const counts = countsFor({ playerId: me, oppId: bot, at: ANCHOR, oppBand: 'ace' });
    expect(counts.priorPairCount).toBe(3);
    expect(
      participantWeights({ kind: 'human-bot', selfIsBot: false, won: true, counts }).mu
    ).toBeCloseTo(HUMAN_VS_BOT_BASE * 0.9, 10);
  });
});

describe('what writes an exposure row', () => {
  // §2.9: a match that was not eligible to move competitive rating consumes
  // no pair, band or daily count. Eligibility is EXACTLY the repository's
  // existing `ranksThisMatch` — the whole expression, reused rather than
  // re-derived — so every exclusion it already makes is inherited unchanged.
  //
  // The near-copy this rule exists to prevent is `ranked && venueRates &&
  // !forceUnrankedLadder`: it reads as equivalent and silently drops the SOLO
  // arm, so a Rookie match and a rung the player has outgrown would both start
  // writing rows. Mutation check: substitute it and the two solo cases redden
  // while every other case here stays green.

  let seat = 0;
  const nextSeat = () => {
    seat += 1;
    const id = `dev_eligible_${seat}`;
    db.getProfile(id);
    const r = db.initializeProfile(id, `Eligible${seat}`);
    if (!r.ok) throw new Error(`init failed: ${r.code}`);
    return id;
  };

  const duel = (playerId: string, over: Partial<MatchEndPayload> = {}): MatchEndPayload => ({
    playerId,
    username: 'Eligible',
    playerScore: 5,
    opponentScore: 2,
    bestStreak: 6,
    endStreak: 0,
    earnedStreak: 6,
    mode: 'multiplayer',
    isWinner: true,
    ...over,
  } as MatchEndPayload);

  /** Record one match with a trusted opponent, and say whether a row appeared. */
  const wroteRow = (
    payload: MatchEndPayload,
    context: Record<string, unknown> = {}
  ): boolean => {
    const matchKey = nextKey();
    db.recordMatch({ ...payload, matchKey } as MatchEndPayload, {
      opponentId: 'dev_eligible_opponent',
      opponentBand: 'ace',
      decidedAt: ANCHOR,
      ...context,
    } as never);
    return rawRows(matchKey) > 0;
  };

  it('writes one for an ordinary ranked duel', () => {
    // The positive control. Without it every assertion below passes against an
    // implementation that never writes a row at all.
    expect(wroteRow(duel(nextSeat()))).toBe(true);
  });

  it('writes none for a Casual duel — the venue rates nothing', () => {
    expect(wroteRow(duel(nextSeat()), { venueRoomId: 'casual' })).toBe(false);
  });

  it('writes none for rules outside the ranked band', () => {
    expect(
      wroteRow(duel(nextSeat(), { rules: { paddleScale: 1.6 } } as Partial<MatchEndPayload>))
    ).toBe(false);
  });

  it('writes none with the opponent sonar on', () => {
    expect(
      wroteRow(duel(nextSeat(), { rules: { opponentSonar: true } } as Partial<MatchEndPayload>))
    ).toBe(false);
  });

  it('writes none for a forgiven abandon', () => {
    expect(wroteRow(duel(nextSeat()), { forceUnranked: true })).toBe(false);
  });

  it('writes none for a watched machine match', () => {
    expect(wroteRow(duel(nextSeat()), { forceUnrankedLadder: true })).toBe(false);
  });

  it('writes none for a Rookie solo match', () => {
    // Rookie is open from the first match, so placing against it would be a
    // formality. It feeds hidden MMR and nothing else.
    expect(
      wroteRow(duel(nextSeat(), { mode: 'solo', difficulty: 'rookie' } as Partial<MatchEndPayload>))
    ).toBe(false);
  });

  it('writes none for a rung the player has outgrown', () => {
    // Above a rung's ceiling that rung moves nothing in either direction, so
    // it does not rate — and a match that does not rate is not evidence about
    // anything either.
    const me = nextSeat();
    const raw = new DatabaseSync(DB_FILE);
    try {
      // Past Pro's SOLO_MU_CAPS ceiling of 30.9.
      raw.prepare('UPDATE players SET rankMu = ? WHERE id = ?').run(34, me);
    } finally {
      raw.close();
    }
    expect(
      wroteRow(duel(me, { mode: 'solo', difficulty: 'pro' } as Partial<MatchEndPayload>))
    ).toBe(false);
    // ...and the control: the same rung, below its ceiling, does write one.
    expect(
      wroteRow(duel(nextSeat(), { mode: 'solo', difficulty: 'pro' } as Partial<MatchEndPayload>))
    ).toBe(true);
  });

  it('writes none without a trusted opponent id, payload or no payload', () => {
    // §4.4: the pair comes from the ROOM, never from the payload. A client
    // sending a fresh opponent id every match would otherwise never leave
    // band 1 — and an unvouched multiplayer payload is already forceUnranked
    // with a device-scoped key, so there is no rating here to protect.
    //
    // The second half is the assertion that took two goes. Written with no
    // payload field at all it proved only that the CONTEXT field is required,
    // so falling back to `payload.opponentId` passed it — which is the whole
    // exploit. `MatchEndPayload.opponentId` exists and is client-supplied, so
    // the fixture has to send one and watch it be ignored.
    const bare = nextKey();
    db.recordMatch({ ...duel(nextSeat()), matchKey: bare } as MatchEndPayload, {
      opponentBand: 'ace', decidedAt: ANCHOR,
    } as never);
    expect(rawRows(bare)).toBe(0);

    const forged = nextKey();
    db.recordMatch(
      { ...duel(nextSeat()), matchKey: forged, opponentId: 'dev_forged_opponent' } as MatchEndPayload,
      { opponentBand: 'ace', decidedAt: ANCHOR } as never
    );
    expect(rawRows(forged)).toBe(0);
  });

  it('takes the pair from the context when the payload names somebody else', () => {
    // The sharper half of the same rule: with a trusted opponent present, a
    // payload naming a DIFFERENT one changes nothing — otherwise the count is
    // keyed on a value the farming client chooses.
    const me = nextSeat();
    const trusted = 'dev_trusted_opponent';
    const key = nextKey();
    db.recordMatch(
      { ...duel(me), matchKey: key, opponentId: 'dev_forged_opponent_2' } as MatchEndPayload,
      { opponentId: trusted, opponentBand: 'ace', decidedAt: ANCHOR } as never
    );
    expect(countsFor({ playerId: me, oppId: trusted, at: ANCHOR }).priorPairCount).toBe(1);
    expect(
      countsFor({ playerId: me, oppId: 'dev_forged_opponent_2', at: ANCHOR }).priorPairCount
    ).toBe(0);
  });

  it('consumes no count from any of them', () => {
    // The row is the mechanism; the count is what it is for. One eligible
    // match against this opponent, then one of every exclusion — and the pair
    // still reads a single prior match.
    const me = nextSeat();
    const opp = 'dev_eligible_ineligible_opp';
    const eligible = (over: Partial<MatchEndPayload>, ctx: Record<string, unknown> = {}) => {
      db.recordMatch({ ...duel(me, over), matchKey: nextKey() } as MatchEndPayload, {
        opponentId: opp, opponentBand: 'ace', decidedAt: ANCHOR, ...ctx,
      } as never);
    };
    eligible({});
    eligible({}, { venueRoomId: 'casual' });
    eligible({ rules: { paddleScale: 1.6 } } as Partial<MatchEndPayload>);
    eligible({ rules: { opponentSonar: true } } as Partial<MatchEndPayload>);
    eligible({}, { forceUnranked: true });
    eligible({}, { forceUnrankedLadder: true });
    eligible({ mode: 'solo', difficulty: 'rookie' } as Partial<MatchEndPayload>);

    expect(
      countsFor({ playerId: me, oppId: opp, at: ANCHOR, oppBand: 'ace' }).priorPairCount
    ).toBe(1);
  });
});
