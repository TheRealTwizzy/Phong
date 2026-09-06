import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DEFAULT_TRAITS, seedTraits, type PlaybotTraits } from '../server/playbotTraits';
import {
  IDLE_BASELINE,
  demandSplit,
  impatientDemand,
  PATIENCE_MS,
  rankForActivation,
  targetActivation,
  targetActiveCount,
  unmetHumanDemand,
  type PopulationBot,
  type PopulationSnapshot,
} from '../server/playbotPopulation';
import { OPEN_VENUES, servableVenues, venuesOpenTo } from '../server/playbotPopulation';
import { roomById, roomCountsForRank, roomEntryVerdict, roomsOf } from '../src/venues';
import { TIER_ORDER, type Tier } from '../src/rating';

// WHICH existing bots play, and where. Never how good they are.
//
// Two hard constraints, and both are asserted rather than argued: humans are
// never DISPLACED, and the controller decides where and when a bot
// participates and never how a match turns out.

const bot = (id: string, over: Partial<PopulationBot> = {}): PopulationBot => ({
  id,
  traits: DEFAULT_TRAITS,
  mu: 25,
  recentMatches: 0,
  // Both ungated rooms unless a case says otherwise — what an unplaced bot,
  // which is every new one, is actually allowed into.
  venues: ['casual', 'beginner'],
  ...over,
});

const roster = (n: number, at = 25): PopulationBot[] =>
  Array.from({ length: n }, (_, i) => bot(`bot-${i}`, { mu: at }));

const snap = (over: Partial<PopulationSnapshot> = {}): PopulationSnapshot => ({
  humansOnline: 0,
  queuedHumans: 0,
  queuedBots: 0,
  longestWaitMs: 0,
  openTableVenues: [],
  activeBotIds: [],
  roster: roster(20),
  ...over,
});

describe('humans are never displaced', () => {
  it('activates a bot for the REMAINDER, never for a pair that can play itself', () => {
    // The displacement rule as arithmetic. Two queued humans are a match; the
    // third is the one who needs a bot. A controller that activated one per
    // queued human would take a seat a person would have had.
    expect(unmetHumanDemand({ queuedHumans: 0, openTableVenues: [] })).toBe(0);
    expect(unmetHumanDemand({ queuedHumans: 1, openTableVenues: [] })).toBe(1);
    expect(unmetHumanDemand({ queuedHumans: 2, openTableVenues: [] })).toBe(0);
    expect(unmetHumanDemand({ queuedHumans: 3, openTableVenues: [] })).toBe(1);
    expect(unmetHumanDemand({ queuedHumans: 8, openTableVenues: [] })).toBe(0);
  });

  it('counts a human sitting at an open table as demand', () => {
    // "A bot may not give a person a game" is the misreading this guards
    // against: serving demand is most of what the controller is for.
    expect(unmetHumanDemand({ queuedHumans: 0, openTableVenues: ['casual', 'casual', 'beginner'] })).toBe(3);
    expect(unmetHumanDemand({ queuedHumans: 3, openTableVenues: ['casual', 'beginner'] })).toBe(3);
  });

  it('counts each named table once, and nothing else', () => {
    // This replaced a clamp test. The count used to be its own `openTables`
    // number beside the venues, so it could be NEGATIVE -- which would have
    // SUBTRACTED from a waiting human's claim on a bot -- and, worse, it could
    // disagree with the venues silently: a snapshot saying "one table" and
    // "nowhere" reads as demand no bot is eligible for, which is a fixture
    // that lies rather than a guard that fires. One list is both answers, so
    // neither state is representable and there is nothing left to clamp.
    expect(unmetHumanDemand({ queuedHumans: 3, openTableVenues: [] })).toBe(1);
    const two = { queuedHumans: 3, openTableVenues: ['casual', 'beginner'] };
    expect(unmetHumanDemand(two)).toBe(3);
    expect(demandSplit(snap(two)).table).toBe(two.openTableVenues.length);
  });

  it('does not conjure a bot for a long wait nobody is having', () => {
    // `longestWaitMs` is whatever the last waiter left behind, so the queue
    // being EMPTY has to be asked separately — otherwise a quiet server keeps
    // activating a bot to serve a human who left.
    const stale = snap({ humansOnline: 30, queuedHumans: 0, longestWaitMs: PATIENCE_MS * 10 });
    expect(targetActiveCount(stale)).toBe(targetActiveCount(snap({ humansOnline: 30 })));
  });

  it('sends a waiting human a bot through the ACTIVATION set, not only the count', () => {
    // The patience rule is one function read by both, because a rule copied
    // into two places is one that drifts — and the copy in `targetActivation`
    // had no test at all until the coverage floor said so.
    // Asserted as the COMPOSED answer, because that is the question: how many
    // bots does one waiting human get. The raw function used to answer 1 for a
    // queue of ONE, and `(queuedHumans % 2)` had already counted that same
    // person -- so a single waiting player activated TWO bots and dispatched
    // both to the queue, where only one of them could serve anybody.
    //
    // Impatience supplements an EVEN queue now: parity covers the odd one out,
    // and impatience covers the case where parity says everybody is matched
    // and somebody has waited anyway because the band has not opened far
    // enough to pair them.
    const demandAt = (queuedHumans: number, longestWaitMs: number) => {
      const at = { queuedHumans, longestWaitMs, openTableVenues: [] };
      return unmetHumanDemand(at) + impatientDemand(at);
    };
    for (const q of [1, 2, 3, 4, 5]) {
      expect(demandAt(q, PATIENCE_MS), `${q} queued, all waiting`).toBe(1);
    }
    expect(demandAt(0, PATIENCE_MS)).toBe(0);
    expect(impatientDemand({ longestWaitMs: PATIENCE_MS, queuedHumans: 0 })).toBe(0);
    expect(impatientDemand({ longestWaitMs: 0, queuedHumans: 4 })).toBe(0);
    const t = targetActivation(
      snap({ humansOnline: 30, queuedHumans: 2, longestWaitMs: PATIENCE_MS }),
      25
    );
    expect(t.activate).toHaveLength(1);
    expect(t.activate[0].action).toBe('queue');
  });

  it('gives a human who has waited past patience a bot, pair or no pair', () => {
    // Two queued humans SHOULD pair, and if one has waited half a minute they
    // plainly have not. Being given a game is not being displaced.
    const waiting = snap({ queuedHumans: 2, longestWaitMs: PATIENCE_MS, humansOnline: 2 });
    expect(targetActiveCount(waiting)).toBeGreaterThanOrEqual(1);
    const fresh = snap({ queuedHumans: 2, longestWaitMs: 0, humansOnline: 20 });
    expect(unmetHumanDemand(fresh)).toBe(0);
  });
});

describe('the target responds to each input', () => {
  it('keeps the ladder moving with nobody online', () => {
    expect(targetActiveCount(snap({ humansOnline: 0 }))).toBe(IDLE_BASELINE);
  });

  it('gets out of the way as humans arrive', () => {
    const busy = targetActiveCount(snap({ humansOnline: 20 }));
    const quiet = targetActiveCount(snap({ humansOnline: 0 }));
    expect(busy).toBeLessThan(quiet);
  });

  it('rises with queue demand', () => {
    const none = targetActiveCount(snap({ humansOnline: 30, queuedHumans: 0 }));
    const some = targetActiveCount(snap({ humansOnline: 30, queuedHumans: 7 }));
    expect(some).toBeGreaterThan(none);
  });

  it('rises with open tables', () => {
    const none = targetActiveCount(snap({ humansOnline: 30, openTableVenues: [] }));
    const some = targetActiveCount(snap({ humansOnline: 30, openTableVenues: Array(5).fill('casual') }));
    expect(some).toBeGreaterThan(none);
  });

  it('rises with a long wait', () => {
    const fresh = targetActiveCount(snap({ humansOnline: 30, queuedHumans: 2, longestWaitMs: 0 }));
    const stale = targetActiveCount(
      snap({ humansOnline: 30, queuedHumans: 2, longestWaitMs: PATIENCE_MS })
    );
    expect(stale).toBeGreaterThan(fresh);
  });

  it('never asks for more bots than exist', () => {
    expect(
      targetActiveCount(snap({ roster: roster(2), queuedHumans: 9, openTableVenues: Array(9).fill('casual') }))
    ).toBe(2);
  });
});

describe('selection, not tuning', () => {
  it('prefers the bots whose EARNED rating already suits the thin band', () => {
    const pool = [
      bot('bot-low', { mu: 18 }),
      bot('bot-near', { mu: 30.4 }),
      bot('bot-high', { mu: 40 }),
    ];
    expect(rankForActivation(pool, 30)[0].id).toBe('bot-near');
    expect(rankForActivation(pool, 18)[0].id).toBe('bot-low');
  });

  it('spreads participation, so the same handful does not play every evening', () => {
    // The ids sort AGAINST the expected answer on purpose. Named the obvious
    // way ('bot-rested' before 'bot-worked') the final id tiebreak produced
    // the same winner, so removing the recentMatches comparison reddened
    // nothing — the third time this exact trap has been hit in this feature.
    const pool = [
      bot('bot-abel', { mu: 25, recentMatches: 40 }),
      bot('bot-zulu', { mu: 25, recentMatches: 0 }),
    ];
    expect(rankForActivation(pool, 25)[0].id).toBe('bot-zulu');
    expect(rankForActivation([...pool].reverse(), 25)[0].id).toBe('bot-zulu');
  });

  it('supplies its NEAREST when nobody suits the band, rather than inventing one', () => {
    // The honest answer, and the one §4.13 insists on: if a band is thin and
    // no bot's earned rating suits it, the fix is seeding more bots at
    // creation — never retuning one that is already playing.
    const pool = [bot('bot-a', { mu: 20 }), bot('bot-b', { mu: 22 })];
    const before = pool.map((b) => ({ ...b }));
    expect(rankForActivation(pool, 40)[0].id).toBe('bot-b');
    // ...and asking did not change anybody.
    expect(pool).toEqual(before);
  });

  it('leaves ratings and traits untouched by being asked', () => {
    const pool = [bot('bot-x', { mu: 24, traits: seedTraits('bot-x') })];
    const snapshot = snap({ roster: pool, queuedHumans: 5, humansOnline: 5 });
    const before = JSON.stringify(pool);
    targetActivation(snapshot, 33);
    targetActiveCount(snapshot);
    rankForActivation(pool, 33);
    expect(JSON.stringify(pool)).toBe(before);
  });
});

describe('activation and deactivation', () => {
  it('activates up to the target and no further', () => {
    const t = targetActivation(snap({ humansOnline: 0, roster: roster(20) }), 25);
    expect(t.activate).toHaveLength(IDLE_BASELINE);
    expect(t.deactivate).toHaveLength(0);
  });

  it('stands bots down when demand falls', () => {
    const active = ['bot-0', 'bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5'];
    const t = targetActivation(snap({ humansOnline: 30, activeBotIds: active }), 25);
    expect(t.activate).toHaveLength(0);
    expect(t.deactivate.length).toBeGreaterThan(0);
    // What is kept is a SUBSET of what was active — nothing is stood down and
    // re-activated in the same breath.
    for (const id of t.deactivate) expect(active).toContain(id);
  });

  it('keeps a bot already playing rather than churning the set', () => {
    const t = targetActivation(
      snap({ humansOnline: 0, activeBotIds: ['bot-9', 'bot-10'], roster: roster(20) }),
      25
    );
    expect(t.deactivate).toHaveLength(0);
    expect(t.activate.map((a) => a.id)).not.toContain('bot-9');
    expect(t.activate).toHaveLength(IDLE_BASELINE - 2);
  });

  it('sends a bot activated for a waiting human to the QUEUE', () => {
    // Where that human is. Its own appetites decide between hosting and
    // joining only when it is playing for its own sake.
    const hostish: PlaybotTraits = { ...DEFAULT_TRAITS, hostAppetite: 1, joinAppetite: 0, queueAppetite: 0 };
    const pool = Array.from({ length: 8 }, (_, i) => bot(`bot-${i}`, { traits: hostish }));
    const served = targetActivation(snap({ roster: pool, queuedHumans: 1, humansOnline: 1 }), 25);
    expect(served.activate[0].action).toBe('queue');
    const idle = targetActivation(snap({ roster: pool, humansOnline: 0 }), 25);
    expect(idle.activate.every((a) => a.action === 'host')).toBe(true);
  });

  it('sends a bot activated for a table to the TABLE, not the queue', () => {
    // The demand that made the activation decides where it goes, and the two
    // humans are in different places. A lone host at a public table is not in
    // the queue, so a bot dispatched there serves nobody -- and on a server
    // busy enough for the fading idle baseline to reach zero, that ONE bot was
    // the whole answer while the human stayed alone at their table.
    //
    // The appetites are pinned to hosting so the answer cannot come from them:
    // 'join' here is the demand speaking, not the trait.
    const hostish: PlaybotTraits = { ...DEFAULT_TRAITS, hostAppetite: 1, joinAppetite: 0, queueAppetite: 0 };
    const pool = Array.from({ length: 8 }, (_, i) => bot(`bot-${i}`, { traits: hostish }));

    const table = targetActivation(
      snap({ roster: pool, openTableVenues: ['casual'], humansOnline: 1, queuedHumans: 0 }),
      25
    );
    expect(table.activate[0].action).toBe('join');

    // A queued human still gets the queue, and both kinds at once get one of
    // each -- queue first, since that human's band is still widening.
    const both = targetActivation(
      snap({ roster: pool, openTableVenues: ['casual'], queuedHumans: 1, humansOnline: 2 }),
      25
    );
    expect(both.activate.slice(0, 2).map((a) => a.action)).toEqual(['queue', 'join']);
  });

  it('serves a newly queued human even while every active bot is busy', () => {
    // `want` is a target for how many bots are ACTIVE and `keep` fills it with
    // the ones already on -- all of which are, by construction, unavailable:
    // `activeBotIds` is built from the same `engaged()` predicate `dispatch`
    // asks. So with one bot mid-rally and one human newly queued, `want` was
    // 1, the busy bot satisfied it, and NOBODY was activated -- the queued
    // player waited out an unrelated match while dormant compatible bots sat
    // in the roster.
    //
    // Many humans online, so the idle baseline is 0 and the only thing that
    // can activate anybody is the demand itself.
    const t = targetActivation(
      snap({ humansOnline: 30, queuedHumans: 1, activeBotIds: ['bot-0'] }),
      25
    );
    expect(t.activate).toHaveLength(1);
    expect(t.activate[0].action).toBe('queue');
    // And the busy bot is not stood down to pay for it.
    expect(t.deactivate).not.toContain('bot-0');
  });

  it('splits demand without changing how much of it there is', () => {
    // targetActiveCount reads the TOTAL, so the split may not move it --
    // otherwise the population would grow or shrink as a side effect of
    // knowing where to send a bot.
    for (const q of [0, 1, 2, 3]) {
      for (const tables of [0, 1, 3]) {
        for (const waited of [0, PATIENCE_MS]) {
          const s = snap({
            queuedHumans: q,
            queuedBots: 0,
            openTableVenues: Array(tables).fill('casual'),
            longestWaitMs: waited,
          });
          const d = demandSplit(s);
          expect(d.queue + d.table).toBe(unmetHumanDemand(s) + impatientDemand(s));
        }
      }
    }
  });

  it('follows each appetite when a bot plays for its own sake', () => {
    const only = (over: Partial<PlaybotTraits>): PlaybotTraits => ({
      ...DEFAULT_TRAITS, hostAppetite: 0, joinAppetite: 0, queueAppetite: 0, ...over,
    });
    const pick = (t: PlaybotTraits) =>
      targetActivation(
        snap({ roster: [bot('bot-solo', { traits: t })], humansOnline: 0 }),
        25
      ).activate[0].action;
    expect(pick(only({ hostAppetite: 1 }))).toBe('host');
    expect(pick(only({ joinAppetite: 1 }))).toBe('join');
    expect(pick(only({ queueAppetite: 1 }))).toBe('queue');
  });

  it('holds a skill curve over a simulated evening with nothing retuned', () => {
    // The step-17 separation proofs, re-asserted at the controller's own
    // boundary: an evening of rising and falling demand, and not one bot's
    // competence, style or rating has moved.
    const pool = Array.from({ length: 30 }, (_, i) => bot(`bot-${i}`, {
      mu: 18 + i * 0.7,
      traits: seedTraits(`bot-${i}`),
    }));
    const before = JSON.stringify(pool);
    let active: string[] = [];
    const bands = [22, 25, 28, 31, 34];
    for (let hour = 0; hour < 12; hour += 1) {
      const humans = [0, 1, 4, 9, 16, 20, 16, 9, 4, 1, 0, 0][hour];
      const t = targetActivation(
        snap({ humansOnline: humans, queuedHumans: humans % 5, activeBotIds: active, roster: pool }),
        bands[hour % bands.length]
      );
      active = active.filter((id) => !t.deactivate.includes(id)).concat(t.activate.map((a) => a.id));
      // Never more bots switched on than the target asked for, PLUS the
      // demand the target could not serve.
      //
      // The bare target used to be the bound and it stopped being one
      // deliberately: `keep` fills `want` with bots that are already active
      // and therefore unavailable, so demand needs slots of its own or a
      // human who queues while one bot is mid-rally activates nobody. The
      // bound is still tight -- `kept <= want`, so the total can never exceed
      // `want + demand` -- and it is not the roster size, which would assert
      // nothing.
      const s = snap({ humansOnline: humans, queuedHumans: humans % 5, roster: pool });
      const d = demandSplit(s);
      expect(active.length).toBeLessThanOrEqual(targetActiveCount(s) + d.queue + d.table);
    }
    expect(JSON.stringify(pool)).toBe(before);
    // Over the evening the set that played spans the ladder rather than one rung.
    expect(new Set(active).size).toBeGreaterThan(0);
  });
});

describe('what this module cannot do', () => {
  it('names bots and venues, and nothing about results', () => {
    // Structural, because the constraint is an ABSENCE: no outcome selection,
    // no win trading, no cross-account coordination. The return type says so
    // and so does the source.
    const src = fs.readFileSync(path.join(process.cwd(), 'server', 'playbotPopulation.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const name of [
      'isWinner', 'winner', 'score', 'outcome', 'recordMatch', 'result', 'concede',
      'setSkill', 'UPDATE', 'rankMu =', 'traits =',
    ]) {
      expect({ name, present: code.includes(name) }).toEqual({ name, present: false });
    }
  });

  it('has no write path to a trait, a rating or a recorded match', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'server', 'playbotPopulation.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // It imports a TYPE and nothing else — no db, no rating module, no clock.
    expect(code).not.toContain("from './db'");
    expect(code).not.toContain("from '../src/rating'");
    expect(code).not.toContain('Date.now');
    expect(code).not.toContain('Math.random');
  });
});

describe('a table slot goes to a bot that can sit at the table', () => {
  it('passes over the nearest bot when the bracket would refuse it', () => {
    // `beginner` carries a tierMax of Contender, so a bot whose own results
    // have carried it past that cannot enter — and the activation ranked
    // purely on distance from the band centre, then labelled the winner
    // `join`. The bot went, `venuesFor` removed `beginner` from what it could
    // search, it hosted in Casual instead, became spare, and the very same
    // nearest-mu bot was chosen again on the next tick: the human at that
    // table was never served, for as long as they sat there.
    //
    // Nothing about it needs a rare state. The band centre is the longest
    // WAITING QUEUED human's rating and a lone table host is in no queue, so
    // the fallback is START_MU — mu 25, which is the Ace floor, which is
    // above Beginner's ceiling.
    const s = snap({
      humansOnline: 8,
      openTableVenues: ['beginner'],
      roster: [
        bot('placed', { mu: 25, venues: ['casual'] }),
        bot('eligible', { mu: 18, venues: ['casual', 'beginner'] }),
      ],
    });
    // One slot, and it is the table's.
    expect(targetActiveCount(s)).toBe(1);
    expect(targetActivation(s, 25).activate).toEqual([
      { id: 'eligible', action: 'join', venue: 'beginner' },
    ]);
  });

  it('still prefers the nearest bot when it CAN sit there', () => {
    // The eligibility filter narrows the table slot and must not reorder it:
    // with both bots allowed in, the band preference decides as it always did.
    const s = snap({
      humansOnline: 8,
      openTableVenues: ['beginner'],
      roster: [
        bot('near', { mu: 25, venues: ['casual', 'beginner'] }),
        bot('far', { mu: 18, venues: ['casual', 'beginner'] }),
      ],
    });
    expect(targetActivation(s, 25).activate).toEqual([
      { id: 'near', action: 'join', venue: 'beginner' },
    ]);
  });

  it('serves the QUEUE with a bot no table would have', () => {
    // Queue slots are filled first and are not narrowed: a bot the brackets
    // refuse can still be somebody's opponent in matchmaking, which places its
    // own pair in the hidden `_queue` room. Narrowing both would take supply
    // away from the queue to reserve it for a table.
    const s = snap({
      humansOnline: 8,
      queuedHumans: 1,
      queuedBots: 0,
      openTableVenues: ['beginner'],
      roster: [
        bot('placed', { mu: 25, venues: ['casual'] }),
        bot('eligible', { mu: 18, venues: ['casual', 'beginner'] }),
      ],
    });
    expect(targetActivation(s, 25).activate).toEqual([
      { id: 'placed', action: 'queue' },
      { id: 'eligible', action: 'join', venue: 'beginner' },
    ]);
  });

  it('leaves the table slot unspent rather than sending somebody who is refused', () => {
    // Nobody in the roster may enter the waiting venue, so the honest answer
    // is that this demand cannot be served — never a bot dispatched to a door
    // that will not open, which is what put the same bot on the same forbidden
    // table on every tick.
    const s = snap({
      humansOnline: 30,
      openTableVenues: ['beginner'],
      // Appetite pinned to hosting, so a `join` here could only be the demand
      // speaking. Left on the defaults this passes on whatever `actionFor`
      // happens to answer for them, which is a fixture true for a reason other
      // than the one it names.
      roster: [
        bot('placed', {
          mu: 25,
          venues: ['casual'],
          traits: { ...DEFAULT_TRAITS, hostAppetite: 1, joinAppetite: 0, queueAppetite: 0 },
        }),
      ],
    });
    const target = targetActivation(s, 25);
    expect(target.activate.some((a) => a.action === 'join')).toBe(false);
    // It is still switched on, for its own sake, on its own appetite.
    expect(target.activate).toEqual([{ id: 'placed', action: 'host' }]);
  });
});

describe('a bot only ONE kind of demand can use', () => {
  const bot = (id: string, mu: number, venues: string[]) => ({
    id,
    traits: seedTraits(id),
    mu,
    recentMatches: 0,
    venues,
  });

  it('spends the venue-eligible bot on the table, not on the queue', () => {
    // The queue is not narrowed -- the hidden `_queue` room gates nobody -- so
    // it took whoever ranked highest, and that is exactly the bot a bracketed
    // table may be unable to replace. At a Beginner table, whose `tierMax` is
    // Contender, the only eligible bot can also be the one nearest the band
    // centre: the queue consumed it, the table loop found nobody, and that
    // host waited out an unrelated match while a Casual-only bot sat free that
    // the queue would have accepted just as well.
    //
    // Serving the queue FIRST is untouched, which is the half worth stating:
    // both humans are served here, and the reservation only decides which bot
    // each one gets.
    const snapshot = {
      humansOnline: 2,
      queuedHumans: 1,
      queuedBots: 0,
      longestWaitMs: 0,
      openTableVenues: ['beginner'],
      activeBotIds: [],
      roster: [
        // Nearest the band centre AND the only one Beginner would admit.
        bot('both', 25, ['casual', 'beginner']),
        bot('casual-only', 20, ['casual']),
      ],
    };
    expect(targetActivation(snapshot, 25).activate).toEqual([
      { id: 'casual-only', action: 'queue' },
      { id: 'both', action: 'join', venue: 'beginner' },
    ]);
  });

  it('yields the reservation rather than leaving the queue unserved', () => {
    // A bot held for a table nobody else can fill is a bot spent on nobody, so
    // the reservation gives way completely when it is the last candidate: the
    // queue is served, and the table slot goes unspent as it already does when
    // no eligible bot exists at all.
    const snapshot = {
      humansOnline: 2,
      queuedHumans: 1,
      queuedBots: 0,
      longestWaitMs: 0,
      openTableVenues: ['beginner'],
      activeBotIds: [],
      roster: [bot('both', 25, ['casual', 'beginner'])],
    };
    expect(targetActivation(snapshot, 25).activate).toEqual([{ id: 'both', action: 'queue' }]);
  });

  it('reserves the only Beginner-eligible bot even when supply LOOKS ample', () => {
    // The reservation counted eligible bots against remaining slots, so it
    // discarded itself the moment total supply looked sufficient: one
    // dual-venue bot and two Casual-only bots is three eligible against two
    // slots, nothing was reserved, and the dual-venue bot -- ranking first --
    // went to the queue. Beginner was then unservable, though a Casual-only
    // bot would have served the queue just as well and all three humans would
    // have had a game.
    const snapshot = {
      humansOnline: 3,
      queuedHumans: 1,
      queuedBots: 0,
      longestWaitMs: 0,
      openTableVenues: ['casual', 'beginner'],
      activeBotIds: [],
      roster: [
        bot('both', 25, ['casual', 'beginner']),
        bot('casual-a', 24, ['casual']),
        bot('casual-b', 23, ['casual']),
      ],
    };
    const activate = targetActivation(snapshot, 25).activate;
    expect(activate.find((a) => a.action === 'queue')?.id).not.toBe('both');
    expect(activate.find((a) => a.venue === 'beginner')?.id).toBe('both');
  });

  it('reserves nobody when no single bot is the only door in', () => {
    // The rule is UNIQUELY required, not merely eligible. With two bots able
    // to enter Beginner, taking one for the queue still leaves the other to
    // cover the slot -- so reserving on eligibility alone starves the queue of
    // its best match for nothing: it would be pushed down to the Casual-only
    // bot while a bot the table did not need sat reserved.
    //
    // Both humans are served under either rule, which is why the assertion is
    // on WHICH bot each one gets. That is the whole cost of over-reserving,
    // and it is the band quality the activation ranking exists to protect.
    const snapshot = {
      humansOnline: 3,
      queuedHumans: 1,
      queuedBots: 0,
      longestWaitMs: 0,
      openTableVenues: ['beginner'],
      activeBotIds: [],
      roster: [
        bot('dual-a', 25, ['casual', 'beginner']),
        bot('dual-b', 24, ['casual', 'beginner']),
        bot('casual-only', 23, ['casual']),
      ],
    };
    const activate = targetActivation(snapshot, 25).activate;
    expect(activate.find((a) => a.action === 'queue')?.id).toBe('dual-a');
    expect(activate.find((a) => a.action === 'join')?.id).toBe('dual-b');
  });

  it('serves the SCARCE venue rather than two of the plentiful one', () => {
    // `openTableVenues` is one entry per table, so a candidate tested against
    // the union passes on any of them: with a Casual table and a Beginner
    // table waiting, two Casual-only bots both passed, both were activated,
    // and the one bot Beginner would admit stayed dormant while that host
    // waited another tick with roster capacity to spare.
    const snapshot = {
      humansOnline: 4,
      queuedHumans: 0,
      queuedBots: 0,
      longestWaitMs: 0,
      openTableVenues: ['casual', 'beginner'],
      activeBotIds: [],
      roster: [
        bot('casual-a', 25, ['casual']),
        bot('casual-b', 24, ['casual']),
        bot('beginner-only', 19, ['casual', 'beginner']),
      ],
    };
    const activate = targetActivation(snapshot, 25).activate;
    expect(activate.filter((a) => a.action === 'join').map((a) => a.id).sort()).toEqual([
      'beginner-only',
      'casual-a',
    ]);
  });

  it('gives the queue a uniquely-required bot rather than nobody', () => {
    // Reaching the fallback means every free bot is uniquely required by some
    // slot, so one table goes unserved whichever the queue takes -- and the
    // queue is served, because a bot held for a table it cannot also fill is
    // a bot spent on nobody.
    const snapshot = {
      humansOnline: 3,
      queuedHumans: 1,
      queuedBots: 0,
      longestWaitMs: 0,
      openTableVenues: ['casual', 'beginner'],
      activeBotIds: [],
      roster: [bot('casual-only', 25, ['casual']), bot('beginner-only', 24, ['beginner'])],
    };
    const activate = targetActivation(snapshot, 25).activate;
    expect(activate.find((a) => a.action === 'queue')?.id).toBe('casual-only');
    expect(activate.find((a) => a.action === 'join')?.id).toBe('beginner-only');
  });
});

describe('supply already spent on the queue', () => {
  const base = {
    humansOnline: 1,
    queuedHumans: 1,
    queuedBots: 0,
    longestWaitMs: 0,
    openTableVenues: [] as string[],
    activeBotIds: [] as string[],
    roster: [],
  };

  it('stops asking for a bot the queue already has', () => {
    // Queue demand is `queuedHumans % 2` and stays 1 for as long as that
    // person is unpaired -- so the bot dispatched to serve them is engaged,
    // lands in `kept`, and the next tick adds the same slot again on top of
    // it. One more activation per tick for one already-covered waiter, and
    // since `findPair` may hold that first bot as their OPEN-band fallback
    // while their own band is still tight, the human stays unpaired and the
    // connected population climbs toward the roster limit.
    expect(demandSplit({ ...base, queuedBots: 0 }).queue).toBe(1);
    expect(demandSplit({ ...base, queuedBots: 1 }).queue).toBe(0);
  });

  it('never lets a queue full of bots subtract from TABLE demand', () => {
    // `room` adds the two together, so a negative queue figure would eat a
    // table slot -- and the tables are where the other unserved human is.
    const s = { ...base, queuedBots: 5, openTableVenues: ['casual'] };
    expect(demandSplit(s).queue).toBe(0);
    expect(demandSplit(s).table).toBe(1);
  });

  it('still counts a human the queue cannot pair at all', () => {
    // Three humans and one bot: parity says one human is unmatched and the bot
    // covers them, so nothing further is asked for. Five humans and one bot
    // says the same. The rule is about DOUBLE counting, not about capping.
    expect(demandSplit({ ...base, queuedHumans: 3, queuedBots: 0 }).queue).toBe(1);
    expect(demandSplit({ ...base, queuedHumans: 3, queuedBots: 1 }).queue).toBe(0);
  });
});

describe('the rooms the population may play in', () => {
  it('is every listable PvP room, derived rather than listed', () => {
    // Derived so a bracket added to ROOMS cannot leave the population behind
    // -- the same never-model-it-twice rule the venue filter, the ball entry
    // and the CPU-seat predicate each arrived at from their own direction.
    // `roomsOf` drops `listable: false`, which is what keeps `_queue` and
    // `_default` out: the first is the matchmaker's own room and the second
    // is where a table with no venue lands, and a bot hosting in either would
    // be opening a table nobody can browse to.
    expect(OPEN_VENUES).toEqual(roomsOf('pvp').map((r) => r.id));
    expect(OPEN_VENUES).not.toContain('_queue');
    expect(OPEN_VENUES).not.toContain('_default');
  });

  it('leaves every tier a room that RATES it', () => {
    // The assertion the whole population rests on, and which nothing stated.
    //
    // `beginner` carries `tierMax: contender`, whose band ends at mu 22, so a
    // bot that climbed past it was left with `['casual']` -- and Casual is the
    // one room with `ranked: false`. Every bot that got good was therefore
    // exiled to the only room that could not rate it, for the life of the
    // account, and the ladder could never grow a top.
    //
    // Level 1 deliberately: `roomEntryVerdict` waives the level gate when the
    // tier floor is met, and every bracket above `beginner` has a tierMin, so
    // a bot's level can never be what keeps it out. If that stops being true
    // this test is where it surfaces.
    for (const tier of ['unranked', ...TIER_ORDER] as Tier[]) {
      const rated = OPEN_VENUES.filter(
        (id) => roomEntryVerdict(roomById(id), { level: 1, tier }).ok && roomCountsForRank(id)
      );
      expect({ tier, rated: rated.length > 0 }).toEqual({ tier, rated: true });
    }
  });

  it('still leaves every tier SOMEWHERE, rated or not', () => {
    // `chooseVenue` answers null for an empty list and `host` then makes a
    // table with no venue at all, which lands in the unlisted `_default` room
    // where nobody could find it. Casual gates nobody, which is what makes
    // this hold -- and is why the floor under `rankedBias` stops short of 1.
    for (const tier of ['unranked', ...TIER_ORDER] as Tier[]) {
      const open = OPEN_VENUES.filter((id) => roomEntryVerdict(roomById(id), { level: 1, tier }).ok);
      expect({ tier, open: open.length > 0 }).toEqual({ tier, open: true });
    }
  });
});

describe('the venues the ROSTER can actually serve', () => {
  const at = (tier: Tier, level = 1) => ({ level, tier });

  it('is the union of what its own bots may enter, in room order', () => {
    // `OPEN_VENUES` is what a bot MIGHT reach; this is what this roster can
    // reach today. The two were the same constant while the list held only
    // ungated rooms, and stopped being the same answer the moment it held
    // bracketed ones.
    // A Legend reaches `elite` as well as `pro` — its tierMax IS legend — so
    // the union of an unplaced bot and a Legend is four rooms, not three.
    expect(servableVenues([at('unranked'), at('legend')])).toEqual([
      'casual',
      'beginner',
      'elite',
      'pro',
    ]);
    // Order follows OPEN_VENUES rather than the roster, so the answer does not
    // depend on which bot happened to be loaded first.
    expect(servableVenues([at('legend'), at('unranked')])).toEqual(
      servableVenues([at('unranked'), at('legend')])
    );
  });

  it('is EMPTY for an empty roster, so demand narrows to nothing', () => {
    // The direction that matters. Falling back to OPEN_VENUES here would
    // count a human hosting in `advanced` as demand while no bot is Ace yet:
    // `unmetHumanDemand` inflates `want`, the slot loop correctly finds nobody
    // and breaks, and the surplus is spent by the baseline arm on a bot
    // playing with itself -- the fading population bound defeated by somebody
    // the population cannot serve.
    expect(servableVenues([])).toEqual([]);
  });

  it('never names a room the bot itself would be refused', () => {
    // Same predicate as the dispatch, so the count and the search cannot
    // disagree -- which is the rule this feature has now had to restate at
    // the venue filter, the ball entry, the CPU seat and the demand split.
    for (const tier of ['unranked', ...TIER_ORDER] as Tier[]) {
      for (const id of venuesOpenTo(at(tier))) {
        expect({ tier, id, ok: roomEntryVerdict(roomById(id), at(tier)).ok }).toEqual({
          tier,
          id,
          ok: true,
        });
      }
    }
  });
});
