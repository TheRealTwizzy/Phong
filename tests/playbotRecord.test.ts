import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { MatchEndPayload } from '../src/types';
import { isPlaced, PLACEMENT_GAMES, PLACEMENT_SIGMA } from '../src/rating';

// The opponent-type weight and the saturation ladders, as `recordMatch`
// actually applies them.
//
// Every rating assertion here is a RATIO between two matches that differ in
// exactly one way, never a transcribed mu. `updateRating`'s mu step is linear
// in `opts.k` with no cap on the PvP branch, so a ×0.70 weight is exactly a
// 0.70 ratio — and a ratio survives a change to the estimator that a copied
// constant would not.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-playbot-record-'));
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

const ANCHOR = new Date('2026-04-02T12:00:00.000Z');
let seq = 0;

/** An initialized human account. */
const human = (): string => {
  seq += 1;
  const id = `dev_pbrec_${seq}`;
  db.getProfile(id);
  const r = db.initializeProfile(id, `Recorder${seq}`);
  if (!r.ok) throw new Error(`init failed: ${r.code}`);
  return id;
};

/** An initialized account the classifier calls a bot. */
const bot = (): string => {
  const id = human();
  const raw = new DatabaseSync(DB_FILE);
  try {
    raw
      .prepare('INSERT OR IGNORE INTO bot_accounts (botId, createdAt) VALUES (?, ?)')
      .run(id, new Date().toISOString());
  } finally {
    raw.close();
  }
  db.reloadBotAccounts();
  return id;
};

/**
 * Placed and well past placement, so nothing here trips PLACEMENT_UPDATE. The
 * seed is re-applied before EVERY measured match, which is what makes two
 * fixtures comparable — and means a counter read afterwards is relative to
 * this rather than cumulative.
 */
const SEEDED_RANKED_GAMES = 20;
const SEEDED_RANK_MU = 25;

/** Put an account on a known rating, so two fixtures start from one place. */
const seedRating = (id: string, over: Partial<Record<string, number>> = {}) => {
  const raw = new DatabaseSync(DB_FILE);
  try {
    raw
      .prepare(
        'UPDATE players SET mmrMu = ?, mmrSigma = ?, rankMu = ?, rankSigma = ?, rankedGames = ? WHERE id = ?'
      )
      .run(
        over.mmrMu ?? 25,
        over.mmrSigma ?? 3,
        over.rankMu ?? SEEDED_RANK_MU,
        over.rankSigma ?? 3,
        over.rankedGames ?? SEEDED_RANKED_GAMES,
        id
      );
  } finally {
    raw.close();
  }
};

const duel = (playerId: string, over: Partial<MatchEndPayload> = {}): MatchEndPayload =>
  ({
    playerId,
    username: 'Recorder',
    playerScore: 5,
    opponentScore: 2,
    bestStreak: 4,
    endStreak: 0,
    earnedStreak: 4,
    mode: 'multiplayer',
    isWinner: true,
    ...over,
  }) as MatchEndPayload;

/** One duel against `oppId`, from a seeded rating. Returns what the ladder did. */
const play = (
  me: string,
  oppId: string,
  opts: {
    at?: Date;
    ctx?: Record<string, unknown>;
    payload?: Partial<MatchEndPayload>;
    seed?: Partial<Record<string, number>>;
  } = {}
) => {
  seedRating(me, opts.seed);
  const before = db.getProfile(me);
  seq += 1;
  db.recordMatch({ ...duel(me, opts.payload), matchKey: `pbrec:${seq}` } as MatchEndPayload, {
    opponentId: oppId,
    opponentBand: 'ace',
    decidedAt: opts.at ?? ANCHOR,
    // Fixed on both sides of every comparison, so the ONE difference between
    // two fixtures is who the opponent was.
    opponentRating: { mu: 25, sigma: 3 },
    opponentRankRating: { mu: 25, sigma: 3 },
    ...opts.ctx,
  } as never);
  const after = db.getProfile(me);
  return {
    rankMu: after.rankMu - before.rankMu,
    rankSigma: before.rankSigma - after.rankSigma,
    mmrMu: after.mmrMu - before.mmrMu,
    mmrSigma: before.mmrSigma - after.mmrSigma,
    rankedGames: after.rankedGames - before.rankedGames,
    profile: after,
  };
};

describe('A — a trusted, ranked human-vs-bot duel', () => {
  it('moves the human 0.70 of what the same result against a human moves', () => {
    // ×0.70 in BOTH directions: beating a bot is worth less than beating an
    // equal human, losing to one costs less, and a human performing exactly to
    // rating against bots neither inflates nor deflates.
    const vsHuman = play(human(), human());
    const vsBot = play(human(), bot());
    expect(vsBot.rankMu / vsHuman.rankMu).toBeCloseTo(0.7, 10);
    expect(vsBot.mmrMu / vsHuman.mmrMu).toBeCloseTo(0.7, 10);

    const loseHuman = play(human(), human(), { payload: { isWinner: false } });
    const loseBot = play(human(), bot(), { payload: { isWinner: false } });
    expect(loseBot.rankMu / loseHuman.rankMu).toBeCloseTo(0.7, 10);
    expect(loseBot.mmrMu / loseHuman.mmrMu).toBeCloseTo(0.7, 10);
  });

  it('sheds less confidence, and by the same factor either way', () => {
    // §2.2: a fixed EVIDENCE factor, never outcome-dependent. Sigma is not
    // linear in `sigmaScale` — `updateRating` takes a square root — so this is
    // asserted as "the same reduction for a win and for a loss, and less than
    // a human match's", which is what a fixed factor means.
    const win = play(human(), bot());
    const loss = play(human(), bot(), { payload: { isWinner: false } });
    expect(win.rankSigma).toBeCloseTo(loss.rankSigma, 10);
    expect(win.rankSigma).toBeGreaterThan(0);
    expect(win.rankSigma).toBeLessThan(play(human(), human()).rankSigma);
  });

  it('leaves the BOT side at full weight', () => {
    // A bot always takes ×1.00, so bot-vs-bot progresses exactly like the
    // equivalent human duel and the population keeps levelling with no humans
    // present.
    const vsHuman = play(human(), human());
    const botVsBot = play(bot(), bot());
    const botVsHuman = play(bot(), human());
    expect(botVsBot.rankMu / vsHuman.rankMu).toBeCloseTo(1, 10);
    expect(botVsHuman.rankMu / vsHuman.rankMu).toBeCloseTo(1, 10);
  });

  it('applies the same-pair band on top of it', () => {
    // The 4th match against one bot is the first at ×0.90, so it moves
    // 0.70 × 0.90 of what a human duel moves — the composition, end to end,
    // rather than the two factors asserted apart.
    const vsHuman = play(human(), human());
    const me = human();
    const theBot = bot();
    for (let i = 0; i < 3; i += 1) play(me, theBot, { at: new Date(ANCHOR.getTime() - (i + 1) * 3600_000) });
    const fourth = play(me, theBot);
    expect(fourth.rankMu / vsHuman.rankMu).toBeCloseTo(0.7 * 0.9, 10);
  });
});

describe('B — a trusted CASUAL human-vs-bot duel', () => {
  it('carries the ×0.70 into HIDDEN MMR while the visible ladder stands still', () => {
    // Casual gates `ranksThisMatch`, never `ranked`, so hidden MMR learns from
    // the match and the pre-match odds stay honest. The base weight is a fact
    // about WHO was played, so it applies to every estimator that legitimately
    // updates — conditional on eligibility, hidden MMR would treat a bot duel
    // as a full-value human duel, which is the divergence §2.1 forbids.
    const casualHuman = play(human(), human(), { ctx: { venueRoomId: 'casual' } });
    const casualBot = play(human(), bot(), { ctx: { venueRoomId: 'casual' } });
    expect(casualBot.mmrMu / casualHuman.mmrMu).toBeCloseTo(0.7, 10);
    expect(casualBot.rankMu).toBe(0);
    expect(casualBot.rankedGames).toBe(0);
  });

  it('writes no exposure row, so it consumes no saturation count', () => {
    const me = human();
    const theBot = bot();
    for (let i = 0; i < 5; i += 1) {
      play(me, theBot, {
        ctx: { venueRoomId: 'casual' },
        at: new Date(ANCHOR.getTime() - (i + 1) * 3600_000),
      });
    }
    // Six Casual duels later the pair is still on its FIRST rated match, so
    // the ranked one that follows is at full weight rather than ×0.90.
    const vsHuman = play(human(), human());
    const rated = play(me, theBot);
    expect(rated.rankMu / vsHuman.rankMu).toBeCloseTo(0.7, 10);
  });
});

describe('C — no trusted opponent identity', () => {
  it('weights nothing and classifies nothing', () => {
    // A ×1.00 weight is what a correctly-classified human-vs-human match
    // produces too, so the number alone cannot tell the two apart. The
    // structural assertion below is what actually holds this; these are the
    // consequences that would follow if it were violated.
    const control = play(human(), human());
    const me = human();
    seedRating(me);
    const before = db.getProfile(me);
    db.recordMatch({ ...duel(me), matchKey: 'pbrec:untrusted' } as MatchEndPayload, {
      opponentRating: { mu: 25, sigma: 3 },
      opponentRankRating: { mu: 25, sigma: 3 },
    } as never);
    const moved = db.getProfile(me).rankMu - before.rankMu;
    expect(moved / control.rankMu).toBeCloseTo(1, 10);
  });

  it('consults the bot classifier only inside the trusted-opponent branch', () => {
    // ASSERTED STRUCTURALLY, and the reason is worth stating because a spy is
    // the obvious instrument and cannot work here. There is no `vi.mock` or
    // `vi.spyOn` anywhere in this repository, and `isBotAccount` is called
    // from inside `server/db.ts` where it is also defined — so a spy on the
    // export cannot observe those calls and would report zero consultations
    // whatever the code did. A test that cannot fail is worse than no test.
    // Nor is there a runtime observable: the self lookup is a pure Set read
    // with no effect, so hoisting it out of the branch changes no number.
    //
    // This is the same source-reading idiom `tests/legal.test.ts` and
    // `tests/botIdentity.test.ts` already use to hold a claim against code.
    //
    // What it prevents: reaching `pairKindFor` with a defaulted `oppIsBot`
    // would let a bot's own solo or unvouched result classify as `human-bot`.
    // That happens to weight ×1.00 today and stops being harmless the moment
    // any rule keys on the kind.
    const src = fs.readFileSync(path.join(process.cwd(), 'server', 'db.ts'), 'utf8');
    const body = src.slice(src.indexOf('  public recordMatch('));
    const end = body.indexOf('\n  }\n');
    const recordMatch = body.slice(0, end);

    const branch = recordMatch.indexOf('const pairing = context.opponentId');
    expect(branch).toBeGreaterThan(-1);
    const branchEnd = recordMatch.indexOf('const w: ParticipantWeights =', branch);
    expect(branchEnd).toBeGreaterThan(branch);
    const inside = recordMatch.slice(branch, branchEnd);
    const outside = recordMatch.slice(0, branch) + recordMatch.slice(branchEnd);

    // `recordAndCountExposure` is on the list because it consults the
    // classifier twice itself, so a call to it from outside the branch would
    // reintroduce exactly what the other two names forbid.
    for (const call of ['isBotAccount(', 'pairKindFor(', 'recordAndCountExposure(']) {
      expect({ call, inside: inside.includes(call) }).toEqual({ call, inside: true });
      expect({ call, outside: outside.includes(call) }).toEqual({ call, outside: false });
    }
  });
});

describe('placement still completes against bots', () => {
  // §3.3, asserted as the two structural properties and never as a transcribed
  // sigma. The previous spelling of this pinned two constants, one of which was
  // simply wrong against the live estimator — so a CORRECT implementation would
  // have failed it, and even corrected the pair would say nothing about why the
  // two are equal.
  const placementRun = (pattern: boolean[]) => {
    const me = human();
    const theBot = bot();
    seedRating(me, { rankedGames: 0, rankSigma: 8.3333, mmrSigma: 8.3333 });
    pattern.forEach((won, i) => {
      seq += 1;
      db.recordMatch(
        { ...duel(me, { isWinner: won }), matchKey: `pbrec:place:${seq}` } as MatchEndPayload,
        {
          opponentId: theBot,
          opponentBand: 'ace',
          decidedAt: new Date(ANCHOR.getTime() - (pattern.length - i) * 3600_000),
          opponentRating: { mu: 25, sigma: 1 },
          opponentRankRating: { mu: 25, sigma: 1 },
        } as never
      );
    });
    return db.getProfile(me);
  };

  const patterns: Array<[string, boolean[]]> = [
    ['all wins', [true, true, true, true, true]],
    ['all losses', [false, false, false, false, false]],
    ['alternating', [true, false, true, false, true]],
    ['one win', [false, false, true, false, false]],
  ];

  it.each(patterns)('completes for %s', (_name, pattern) => {
    expect(pattern).toHaveLength(PLACEMENT_GAMES);
    const profile = placementRun(pattern);
    expect(profile.rankedGames).toBe(PLACEMENT_GAMES);
    // Through the repository's OWN predicate rather than a hand-copied
    // `σ < PLACEMENT_SIGMA`, which is the condition this code path is judged
    // by and the one that could drift from a transcribed threshold.
    expect(isPlaced(profile.rankedGames, profile.rankSigma)).toBe(true);
    expect(profile.rankSigma).toBeLessThan(PLACEMENT_SIGMA);
  });

  it('lands all-win and all-loss on the SAME sigma', () => {
    // `updateRating` takes `t` as the standardised margin from the WINNER's
    // point of view, so from an equal start a win and a loss produce the same
    // |t| and therefore the same shrink. Sigma cannot differ between them —
    // which is the property, where a pair of constants would only be a
    // coincidence to be re-transcribed the next time the estimator moves.
    const wins = placementRun([true, true, true, true, true]);
    const losses = placementRun([false, false, false, false, false]);
    expect(wins.rankSigma).toBeCloseTo(losses.rankSigma, 10);
  });
});

describe('the hard caps', () => {
  // Prior exposure is SEEDED rather than played, because the fixtures need
  // twelve, thirty-two and seventy-five prior matches and the thing under test
  // is what `recordMatch` does with a count, not how the count got there.
  // `recordExposure` is the store's own writer and is pinned by
  // tests/exposure.test.ts.

  const HOUR = 3600_000;
  const BANDS = ['ace', 'master', 'grandmaster', 'legend'];

  /** `n` prior rows against one opponent — drives the SAME-PAIR ladder. */
  const seedPair = (me: string, opp: string, n: number, oppIsBot: boolean) => {
    for (let i = 0; i < n; i += 1) {
      seq += 1;
      db.recordExposure({
        playerId: me,
        oppId: opp,
        matchKey: `cap:pair:${seq}`,
        at: new Date(ANCHOR.getTime() - (i + 1) * 60_000),
        oppIsBot,
        oppBand: 'ace',
      });
    }
  };

  /** `n` prior rows against DISTINCT bots, all in `band` — the RANK-BAND ladder. */
  const seedBand = (me: string, n: number, band: string) => {
    for (let i = 0; i < n; i += 1) {
      seq += 1;
      db.recordExposure({
        playerId: me,
        oppId: `dev_cap_band_opp_${seq}`,
        matchKey: `cap:band:${seq}`,
        at: new Date(ANCHOR.getTime() - (i + 1) * 60_000),
        oppIsBot: true,
        oppBand: band,
      });
    }
  };

  /**
   * `n` prior bot matches today against distinct bots, SPREAD across bands —
   * the DAILY ladder. Spread deliberately: seventy-five rows in one band would
   * trip the rank-band cap at thirty-three and report `band`, so the fixture
   * would be testing the wrong ladder while looking right.
   */
  const seedDaily = (me: string, n: number) => {
    for (let i = 0; i < n; i += 1) {
      seq += 1;
      db.recordExposure({
        playerId: me,
        oppId: `dev_cap_daily_opp_${seq}`,
        matchKey: `cap:daily:${seq}`,
        at: new Date(ANCHOR.getTime() - (i + 1) * 60_000),
        oppIsBot: true,
        oppBand: BANDS[i % BANDS.length],
      });
    }
  };

  /** Everything a capped participant must be able to say about its own match. */
  const outcome = (me: string, oppId: string, band = 'ace') => {
    seedRating(me);
    const before = db.getProfile(me);
    seq += 1;
    const key = `cap:play:${seq}`;
    const result = db.recordMatch({ ...duel(me), matchKey: key } as MatchEndPayload, {
      opponentId: oppId,
      opponentBand: band,
      decidedAt: ANCHOR,
      opponentRating: { mu: 25, sigma: 3 },
      opponentRankRating: { mu: 25, sigma: 3 },
    } as never);
    const after = db.getProfile(me);
    const raw = new DatabaseSync(DB_FILE, { readOnly: true });
    let row: { ranked: number } | undefined;
    try {
      // `matches` has no matchKey column — every seat files its own row and
      // the newest one for this player is the match just recorded.
      row = raw
        .prepare('SELECT ranked FROM matches WHERE player1Id = ? ORDER BY rowid DESC LIMIT 1')
        .get(me) as { ranked: number } | undefined;
    } finally {
      raw.close();
    }
    return {
      rankMu: after.rankMu - before.rankMu,
      rankSigma: before.rankSigma - after.rankSigma,
      mmrMu: after.mmrMu - before.mmrMu,
      mmrSigma: before.mmrSigma - after.mmrSigma,
      rankedGames: after.rankedGames - before.rankedGames,
      rankedDuels: after.rankedDuels - before.rankedDuels,
      earnedXp: result.earnedXp,
      historyRanked: row?.ranked,
    };
  };

  /** Nothing moved, everything was still paid, and history tells the truth. */
  const expectCapped = (o: ReturnType<typeof outcome>) => {
    expect({
      rankMu: o.rankMu,
      rankSigma: o.rankSigma,
      mmrMu: o.mmrMu,
      mmrSigma: o.mmrSigma,
      rankedGames: o.rankedGames,
      rankedDuels: o.rankedDuels,
    }).toEqual({
      rankMu: 0, rankSigma: 0, mmrMu: 0, mmrSigma: 0, rankedGames: 0, rankedDuels: 0,
    });
    // Anti-exploit, not punishment: once repeated play stops being valid
    // competitive evidence, continuing to apply LOSSES would be a one-way
    // drain — measured at −0.1223 mu a match at σ2.0, a full tier band every
    // 25 matches, with no floor. Both directions are zeroed instead.
    expect(o.earnedXp).toBeGreaterThan(0);
    // And the match keeps its REAL classification: it was played under ranked
    // conditions, and History's Ranked filter is about that rather than about
    // whether the ladder happened to move.
    expect(o.historyRanked).toBe(1);
  };

  it('zeroes BOTH seats on the 13th match of a bot-involved pair', () => {
    const me = human();
    const theBot = bot();
    seedPair(me, theBot, 12, true);
    seedPair(theBot, me, 12, false);
    expectCapped(outcome(me, theBot));
    // The same-pair ladder is the one that applies to both participants
    // whatever the pair kind, so the bot is capped by its own count.
    expectCapped(outcome(theBot, me));
  });

  it('zeroes BOTH seats on the 25th match of a human pair', () => {
    const a = human();
    const b = human();
    seedPair(a, b, 24, false);
    seedPair(b, a, 24, false);
    expectCapped(outcome(a, b));
    expectCapped(outcome(b, a));
    // ...and the 24th still rates, so the fixture is sitting on the boundary
    // rather than somewhere past it.
    const c = human();
    const d = human();
    seedPair(c, d, 23, false);
    expect(outcome(c, d).rankMu).toBeGreaterThan(0);
  });

  it('zeroes the HUMAN only on the 33rd match against one bot rank band', () => {
    const me = human();
    const theBot = bot();
    seedBand(me, 32, 'master');
    expectCapped(outcome(me, theBot, 'master'));
    // The bot keeps its ×1.00 progression and its own counters: §2.4 is the
    // human's ladder alone, so the bot in the same match still moves.
    expect(outcome(theBot, me, 'master').rankMu).toBeGreaterThan(0);
    // And band 32 still rates — the boundary, not somewhere past it.
    const other = human();
    seedBand(other, 31, 'master');
    expect(outcome(other, bot(), 'master').rankMu).toBeGreaterThan(0);
  });

  it('zeroes the HUMAN only on the 76th bot match of a UTC day', () => {
    const me = human();
    const theBot = bot();
    seedDaily(me, 75);
    expectCapped(outcome(me, theBot));
    expect(outcome(theBot, me).rankMu).toBeGreaterThan(0);
    const other = human();
    seedDaily(other, 74);
    expect(outcome(other, bot()).rankMu).toBeGreaterThan(0);
  });

  it('never subjects a BOT to the two human-only ladders', () => {
    // The discriminating fixture, and the first version of this was VACUOUS —
    // it asserted "the bot still moves" about a bot with no band history at
    // all, so removing the human-only guard reddened nothing. The bot has to
    // be over the threshold itself, which means its prior rows must be
    // bot-vs-bot: the band and daily queries filter on `oppIsBot = 1`, so a
    // bot's matches against HUMANS are invisible to them either way.
    //
    // Two guards have to be defeated for this to move, and they are NOT
    // duplicates — which is why mutating either alone leaves this green and
    // that is the right answer rather than a gap. `participantWeights`
    // returning before the two ladders is the POLICY. `recordAndCountExposure`
    // not asking the two queries at all unless `!selfIsBot && oppIsBot` is a
    // COST guard, and §5 names its consequence: at bot-vs-bot scale a bot seat
    // has to cost one read rather than four, on the same single-threaded loop
    // that relays paddle_move for every human match. Removing it changes no
    // behaviour and triples the query cost of the most common match in the
    // game — a performance regression, not a correctness one, so a test is the
    // wrong instrument for it.
    const overBand = bot();
    seedBand(overBand, 32, 'master');
    expect(outcome(overBand, bot(), 'master').rankMu).toBeGreaterThan(0);

    const overDaily = bot();
    seedDaily(overDaily, 75);
    expect(outcome(overDaily, bot()).rankMu).toBeGreaterThan(0);

    // ...and a HUMAN with the identical history is capped by both, so the
    // difference really is who was playing and not the fixture.
    const humanBand = human();
    seedBand(humanBand, 32, 'master');
    expectCapped(outcome(humanBand, bot(), 'master'));
    const humanDaily = human();
    seedDaily(humanDaily, 75);
    expectCapped(outcome(humanDaily, bot()));
  });

  it('reports which ladder fired, so a failing test names one', () => {
    // The pair ladder is checked first, so a participant over several
    // thresholds at once is attributed to the most specific one.
    const me = human();
    const theBot = bot();
    seedPair(me, theBot, 12, true);
    seedDaily(me, 75);
    seedRating(me);
    const before = db.getProfile(me);
    seq += 1;
    db.recordMatch({ ...duel(me), matchKey: `cap:order:${seq}` } as MatchEndPayload, {
      opponentId: theBot, opponentBand: 'ace', decidedAt: ANCHOR,
      opponentRating: { mu: 25, sigma: 3 }, opponentRankRating: { mu: 25, sigma: 3 },
    } as never);
    expect(db.getProfile(me).rankMu).toBe(before.rankMu);
  });
});

describe('the daily bot-derived rankedDuels credit cap', () => {
  // §2.7. A QUALIFICATION counter, not a fourth saturation layer: it
  // multiplies no mu and no sigma and appears nowhere in §2.6's chain. The 6th
  // bot duel of a day rates exactly like the 5th and simply banks no credit.

  const DAY = new Date('2026-05-11T09:00:00.000Z');

  /** `n` duels against a FRESH opponent each time, all inside one UTC day. */
  const playRun = (
    me: string,
    n: number,
    makeOpponent: () => string,
    over: Partial<Record<string, number>> = {}
  ) => {
    for (let i = 0; i < n; i += 1) {
      seedRating(me, { rankedDuels: undefined, ...over });
      seq += 1;
      db.recordMatch(
        { ...duel(me), matchKey: `credit:${seq}` } as MatchEndPayload,
        {
          opponentId: makeOpponent(),
          opponentBand: 'ace',
          // Distinct minutes inside one UTC day: distinct opponents keep every
          // same-pair count at 1, so nothing here is hard-capped and the only
          // thing being measured is the allowance.
          decidedAt: new Date(DAY.getTime() + i * 60_000),
          opponentRating: { mu: 25, sigma: 3 },
          opponentRankRating: { mu: 25, sigma: 3 },
        } as never
      );
    }
    return db.getProfile(me);
  };

  const creditedRows = (me: string): number => {
    const raw = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      return (
        raw
          .prepare('SELECT COALESCE(SUM(duelCredited), 0) AS n FROM competitive_exposure WHERE playerId = ?')
          .get(me) as { n: number }
      ).n;
    } finally {
      raw.close();
    }
  };

  it('grants the 5th bot duel of the day and refuses the 6th', () => {
    const me = human();
    const before = db.getProfile(me).rankedDuels;
    playRun(me, 5, bot);
    expect(db.getProfile(me).rankedDuels - before).toBe(5);
    // The 6th still rates and still counts as a ranked GAME — only the
    // qualification credit is withheld.
    const beforeSixth = db.getProfile(me);
    playRun(me, 1, bot);
    const afterSixth = db.getProfile(me);
    expect(afterSixth.rankedDuels).toBe(beforeSixth.rankedDuels);
    // rankedGames is re-seeded before the match, so this reads "the 6th duel
    // still counted as a ranked game" rather than a cumulative total.
    expect(afterSixth.rankedGames).toBe(SEEDED_RANKED_GAMES + 1);
    // Against the SEED rather than against the previous match: the seed is
    // re-applied before each one, so two identically-seeded duels land on the
    // identical rating and comparing them would assert nothing.
    expect(afterSixth.rankMu).not.toBe(SEEDED_RANK_MU);
  });

  it('counts GRANTED credits, never attempted bot duels', () => {
    // The current row is inserted at duelCredited = 0 and the allowance is read
    // before it is stamped, so a match can never consume its own allowance —
    // and a refused attempt spends nothing, so it cannot push a later duel out.
    //
    // Two mutation checks, and only one of them is about the ORDER. Reading
    // the allowance as attempted bot duels — COUNT(*) rather than
    // SUM(duelCredited) — reddens this and the hard-capped case, because a
    // refused attempt would then push a later duel out of the allowance.
    // Dropping the `matchKey <> ?` exclusion reddens this one, because the
    // current row would count itself.
    //
    // Stamping the credit BEFORE reading the allowance reddens NOTHING, and
    // that is worth recording rather than pretending otherwise: the exclusion
    // already hides the current row, so §4.5's insert-then-stamp ordering is
    // belt-and-braces here and the exclusion is the actual defence. The order
    // is kept because it is normative and because it is what makes the
    // exclusion's job legible, not because a test holds it.
    const me = human();
    playRun(me, 4, bot);
    expect(creditedRows(me)).toBe(4);
    const before = db.getProfile(me).rankedDuels;
    playRun(me, 1, bot);
    expect(db.getProfile(me).rankedDuels - before).toBe(1);
    expect(creditedRows(me)).toBe(5);
  });

  it('leaves a hard-capped match at zero and spends no allowance', () => {
    const me = human();
    const theBot = bot();
    // Twelve prior matches with this one bot, so the next is the 13th.
    for (let i = 0; i < 12; i += 1) {
      seq += 1;
      db.recordExposure({
        playerId: me, oppId: theBot, matchKey: `credit:cap:${seq}`,
        at: new Date(DAY.getTime() - (i + 1) * 60_000), oppIsBot: true, oppBand: 'ace',
      });
    }
    const before = db.getProfile(me);
    playRun(me, 1, () => theBot);
    expect(db.getProfile(me).rankedDuels).toBe(before.rankedDuels);
    expect(creditedRows(me)).toBe(0);
    // ...and the allowance is untouched, so five real credits still follow.
    playRun(me, 5, bot);
    expect(db.getProfile(me).rankedDuels - before.rankedDuels).toBe(5);
  });

  describe('the decision table — all four pair kinds', () => {
    // The cap condition is `!selfIsBot && oppIsBot`, NEVER `oppIsBot` alone: in
    // a bot-vs-bot match every participant's opponent is a bot, so the looser
    // spelling throttles a BOT's own credits to five a day and bot-vs-bot stops
    // progressing like the equivalent human duel — which is exactly what §2.7
    // promises it does.
    it('credits a human 25 of 25 against humans', () => {
      const me = human();
      const before = db.getProfile(me).rankedDuels;
      playRun(me, 25, human);
      expect(db.getProfile(me).rankedDuels - before).toBe(25);
    });

    it('credits a human 5 of 25 against bots', () => {
      const me = human();
      const before = db.getProfile(me).rankedDuels;
      playRun(me, 25, bot);
      expect(db.getProfile(me).rankedDuels - before).toBe(5);
    });

    it('credits a bot 25 of 25 against humans', () => {
      const me = bot();
      const before = db.getProfile(me).rankedDuels;
      playRun(me, 25, human);
      expect(db.getProfile(me).rankedDuels - before).toBe(25);
    });

    it('credits a bot 25 of 25 against bots, and the 25th is the apex', () => {
      // 25 and not a smaller number deliberately: 25 is OVERLORD_MIN_DUELS, so
      // with sufficient rating the 25th credit is what satisfies the apex duel
      // requirement. A 20-duel fixture would show the counter exceeding five
      // and say nothing about the threshold the counter exists for.
      const me = bot();
      const seed = { rankMu: 40, rankSigma: 1, mmrMu: 40, mmrSigma: 1, rankedGames: 40, rankedDuels: 0 };
      playRun(me, 24, bot, seed);
      const at24 = db.getProfile(me);
      expect(at24.rankedDuels).toBe(24);
      expect(at24.tier).not.toBe('overlord');

      playRun(me, 1, bot, seed);
      const at25 = db.getProfile(me);
      expect(at25.rankedDuels).toBe(25);
      expect(at25.rankMu).toBeGreaterThanOrEqual(37);
      expect(at25.tier).toBe('overlord');
    });
  });

  it('cannot reach the apex on one day of bot play, at any win rate', () => {
    // §3.4's simulation as an assertion: at a 90% win rate one UTC day of bot
    // matches carried 36 of 40 simulated players past mu 37 AND 25 duels. The
    // cap is what stops that being a one-day route to Cyber Overlord — and it
    // is a THROTTLE rather than a wall: five a day still reaches 25 in five
    // days, so no assertion here claims the apex is unreachable.
    const me = human();
    const seed = { rankMu: 40, rankSigma: 1, mmrMu: 40, mmrSigma: 1, rankedGames: 40, rankedDuels: 0 };
    playRun(me, 52, bot, seed);
    const after = db.getProfile(me);
    expect(after.rankedDuels).toBe(5);
    expect(after.rankMu).toBeGreaterThanOrEqual(37);
    // The rating is there and the duels are not, which is the whole mechanism.
    expect(after.tier).not.toBe('overlord');
  });
});
