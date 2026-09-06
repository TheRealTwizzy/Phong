import { describe, expect, it } from 'vitest';
import fs from 'fs';
import { humanTablesFirst } from '../server/playbotSupervisor';
import { OPEN_VENUES } from '../server/playbotPopulation';
import { roomById, roomEntryVerdict } from '../src/venues';
import { BOT_PAIR_FULL_VALUE } from '../src/playbotRating';
import { PLACEMENT_GAMES } from '../src/rating';
import { TIER_ORDER } from '../src/rating';
import path from 'path';
import { DEFAULT_TRAITS, seedTraits, type PlaybotTraits } from '../server/playbotTraits';
import {
  acceptsRematch,
  chooseOpponent,
  chooseVenue,
  type PolicyCandidate,
} from '../server/playbotPolicy';

// What an autonomous bot CHOOSES — which opponent, which venue, whether to
// play again — and, more importantly, what it can never choose.
//
// §2.11: diversity is a PREFERENCE, not a prohibition. Where comparably
// suitable opponents are available a bot prefers the less recently played one,
// so the same-pair ladder is a safeguard rather than the mechanism that
// normally controls pairing. It is never a refusal: a bot with no comparable
// alternative plays the opponent it has, low population is a legitimate reason
// to repeat one, and an explicit human Rematch is legitimate play that nothing
// here may block or decline.

const traits = (over: Partial<PlaybotTraits> = {}): PlaybotTraits => ({ ...DEFAULT_TRAITS, ...over });

const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);

const candidate = (over: Partial<PolicyCandidate> & { id: string }): PolicyCandidate => ({
  isBot: true,
  mu: 25,
  sigma: 2,
  recentPairCount: 0,
  lastPlayedAt: null,
  ...over,
});

const self = { id: 'bot-self', mu: 25, sigma: 2, traits: traits() };

describe('choosing an opponent', () => {
  it('prefers the LESS recently played of two comparably suitable ones', () => {
    // The whole of §2.11's preference. Both are the same rating, so nothing
    // separates them but how much they have already been played.
    const fresh = candidate({ id: 'bot-fresh', recentPairCount: 0 });
    const played = candidate({ id: 'bot-played', recentPairCount: 4, lastPlayedAt: NOW - 60_000 });
    expect(chooseOpponent({ self, candidates: [played, fresh], now: NOW })?.id).toBe('bot-fresh');
    // ...and the order they arrive in decides nothing.
    expect(chooseOpponent({ self, candidates: [fresh, played], now: NOW })?.id).toBe('bot-fresh');
  });

  it('breaks a tie on WHEN, once the counts agree', () => {
    // The ids are chosen so ALPHABETICAL order is the opposite of the right
    // answer. Written the obvious way round ('bot-older' vs 'bot-recent') the
    // final id tiebreak produced the same winner, so removing the recency
    // comparison entirely reddened nothing — measured.
    const older = candidate({ id: 'bot-zulu', recentPairCount: 2, lastPlayedAt: NOW - 3_600_000 });
    const recent = candidate({ id: 'bot-alpha', recentPairCount: 2, lastPlayedAt: NOW - 60_000 });
    expect(chooseOpponent({ self, candidates: [recent, older], now: NOW })?.id).toBe('bot-zulu');
    expect(chooseOpponent({ self, candidates: [older, recent], now: NOW })?.id).toBe('bot-zulu');
  });

  it('prefers somebody never played over somebody played long ago', () => {
    const never = candidate({ id: 'bot-zeta', recentPairCount: 0, lastPlayedAt: null });
    const ancient = candidate({ id: 'bot-abel', recentPairCount: 0, lastPlayedAt: NOW - 86_400_000 });
    expect(chooseOpponent({ self, candidates: [ancient, never], now: NOW })?.id).toBe('bot-zeta');
  });

  it('picks SUITABILITY first — a fresh but hopeless opponent is not preferred', () => {
    // Diversity is a preference between COMPARABLY suitable opponents, never a
    // reason to play somebody the match would be meaningless against. A bot at
    // mu 25 against one at mu 45 is not a game.
    const mismatched = candidate({ id: 'bot-far', mu: 45, recentPairCount: 0 });
    const suitable = candidate({ id: 'bot-near', mu: 25, recentPairCount: 3, lastPlayedAt: NOW - 60_000 });
    expect(chooseOpponent({ self, candidates: [mismatched, suitable], now: NOW })?.id).toBe('bot-near');
  });

  it('NEVER refuses: one suitable opponent is played again, however often', () => {
    // Low population is a legitimate reason to repeat an opponent. A
    // preference that becomes a refusal is a bot that stops playing on a quiet
    // server, which is the opposite of what the population is for.
    const only = candidate({ id: 'bot-only', recentPairCount: 40, lastPlayedAt: NOW - 1_000 });
    expect(chooseOpponent({ self, candidates: [only], now: NOW })?.id).toBe('bot-only');
    // Even past the same-pair hard cap, where the match rates nothing at all.
    expect(chooseOpponent({ self, candidates: [only], now: NOW })?.id).toBe('bot-only');
  });

  it('returns null only when there is nobody at all', () => {
    expect(chooseOpponent({ self, candidates: [], now: NOW })).toBeNull();
  });

  it('never picks the bot itself', () => {
    const me = candidate({ id: self.id });
    const other = candidate({ id: 'bot-other', recentPairCount: 9, lastPlayedAt: NOW - 1_000 });
    expect(chooseOpponent({ self, candidates: [me, other], now: NOW })?.id).toBe('bot-other');
    expect(chooseOpponent({ self, candidates: [me], now: NOW })).toBeNull();
  });

  it('spreads its play evenly over the opponents it finds suitable', () => {
    // The preference compounding: play somebody, and they become less
    // preferred than the people you have not.
    //
    // The roster is deliberately all COMPARABLE (mu 24-26 against a self at
    // 25), because "spread" is a claim about the suitable set and not about
    // the roster. A wider roster tests the other rule instead — the first
    // version of this used mu 20-25.5 and failed at 7 of 12 played, which was
    // suitability-first doing exactly its job: a bot at 25 should not be
    // playing one at 20, and asserting it did would have asserted the bug.
    const roster = Array.from({ length: 12 }, (_, i) =>
      candidate({ id: `bot-r${i}`, mu: 24 + i * (2 / 11) })
    );
    const counts = new Map<string, number>(roster.map((c) => [c.id, 0]));
    let clock = NOW;
    for (let i = 0; i < 60; i += 1) {
      clock += 60_000;
      const pick = chooseOpponent({ self, candidates: roster, now: clock });
      expect(pick).not.toBeNull();
      counts.set(pick!.id, (counts.get(pick!.id) ?? 0) + 1);
      pick!.recentPairCount += 1;
      pick!.lastPlayedAt = clock;
    }
    const played = [...counts.values()];
    // Every one of them gets a turn, and none is played more than twice as
    // often as the least — which a clustering picker cannot satisfy.
    expect(played.filter((n) => n === 0)).toHaveLength(0);
    expect(Math.max(...played) / Math.min(...played)).toBeLessThanOrEqual(2);
  });

  it('leaves an opponent it is badly matched against ALONE over a run', () => {
    // The other half, and the one the wider roster is really about: a
    // hopeless mismatch stays unplayed however fresh it is, because
    // suitability is asked first.
    const roster = [
      candidate({ id: 'bot-even', mu: 25 }),
      candidate({ id: 'bot-hopeless', mu: 45 }),
    ];
    let clock = NOW;
    for (let i = 0; i < 20; i += 1) {
      clock += 60_000;
      const pick = chooseOpponent({ self, candidates: roster, now: clock })!;
      expect(pick.id).toBe('bot-even');
      pick.recentPairCount += 1;
      pick.lastPlayedAt = clock;
    }
  });
});

describe('choosing a venue', () => {
  it('follows the bot’s own rankedBias', () => {
    const opts = { roll: 0.5, pick: 0, allowed: ['casual', 'beginner'] };
    const rankedish = chooseVenue({ traits: traits({ rankedBias: 1 }), ...opts });
    const casualish = chooseVenue({ traits: traits({ rankedBias: 0 }), ...opts });
    expect(rankedish).toBe('beginner');
    expect(casualish).toBe('casual');
  });

  it('only ever names a venue it was told it may enter', () => {
    // The bracket gate is the relay's, and this must never propose a room the
    // relay would refuse — a bot repeatedly asking for a room it cannot have
    // is a bot that never plays.
    for (const roll of [0, 0.25, 0.5, 0.75, 0.99]) {
      for (const bias of [0, 0.3, 0.7, 1]) {
        const v = chooseVenue({ traits: traits({ rankedBias: bias }), roll, pick: roll, allowed: ['casual'] });
        expect(v).toBe('casual');
      }
    }
  });


  // The SECOND draw, and why one roll cannot do both jobs.
  //
  // `roll` answers "ranked or Casual" against the bias, and `pick` answers
  // "which ranked room". Spent as one number they are not independent: a bot
  // that wants ranked has, by construction, rolled BELOW its own bias, so
  // `Math.floor(roll * n)` can only ever reach the first `ceil(bias * n)`
  // entries of the pool. With two brackets open and a bias of 0.4 the second
  // one needs `roll >= 0.5` and the branch needs `roll < 0.4`, so it is
  // unreachable -- for every bot on the roster, permanently, with nothing to
  // see. That is the same shape as the bias-as-its-own-roll defect below, one
  // step along, and it was invisible until OPEN_VENUES could hold two ranked
  // rooms at once: both pools were length <= 1, so the index never chose
  // anything.
  it('reaches every ranked room it may enter, not just the first', () => {
    const allowed = ['casual', 'beginner', 'intermediate', 'advanced'];
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const v = chooseVenue({
        traits: traits({ rankedBias: 0.4 }),
        roll: 0.1,
        pick: i / 100,
        allowed,
      });
      if (v) seen.add(v);
    }
    expect([...seen].sort()).toEqual(['advanced', 'beginner', 'intermediate']);
  });

  it('does not let the ranked/casual draw bias WHICH ranked room', () => {
    // The tail of the pool has to be reachable at every appetite, including
    // the low ones. Spelled as a loop over biases because the unreachable
    // range is a function of the bias: at 0.4 the defect hides `advanced`, at
    // 0.9 it hides nothing, and a single-bias test would pass on the wrong one.
    const allowed = ['casual', 'beginner', 'intermediate', 'advanced'];
    for (const bias of [0.1, 0.4, 0.6, 0.9, 1]) {
      const last = chooseVenue({
        traits: traits({ rankedBias: bias }),
        roll: 0,
        pick: 0.99,
        allowed,
      });
      expect(last, `rankedBias ${bias} could not reach the last ranked room`).toBe('advanced');
    }
  });

  it('returns null when it may enter nowhere', () => {
    expect(chooseVenue({ traits: traits(), roll: 0.5, pick: 0.5, allowed: [] })).toBeNull();
  });

  // The function above is right and was right throughout. What shipped wrong
  // was the CALL SITE, which is why this pair exists and why one half of it
  // reads source -- the same shape §12 uses for `unrankedReasons`, and for the
  // same reason: an arm a caller can never reach is invisible to every test of
  // the function that owns it.
  it('cannot choose ranked at all when the roll IS the bias', () => {
    // The arithmetic of the defect, stated so it can never come back quietly:
    // the comparison is `roll < rankedBias`, so handing it the bias is `x < x`
    // -- false at every appetite, including 1. Every table the population
    // opened was therefore Casual, and a Casual table moves no visible ladder
    // (RoomDef.ranked), so no table-based bot match could rate.
    for (const bias of [0, 0.1, 0.5, 0.9, 1]) {
      const v = chooseVenue({
        traits: traits({ rankedBias: bias }),
        roll: bias,
        pick: 0.5,
        allowed: ['casual', 'beginner'],
      });
      expect(v, `rankedBias ${bias} passed as its own roll`).toBe('casual');
    }
  });

  it('is not called with the bias as its own roll', () => {
    // Mutation check: put `roll: m.traits.rankedBias` back and this reddens.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'playbotSupervisor.ts'),
      'utf8'
    );
    const call = /chooseVenue\(\{([\s\S]*?)\}\)/.exec(src);
    expect(call, 'the supervisor no longer calls chooseVenue').toBeTruthy();
    const roll = /roll:([^,\n]*)/.exec(call![1]);
    expect(roll, 'the chooseVenue call passes no roll').toBeTruthy();
    expect(roll![1]).not.toMatch(/rankedBias/);

    // ...and `pick` is a SECOND draw, not the same one under another name.
    // `pick: roll` type-checks, reads as deliberate, and silently restores the
    // defect the two tests above measure.
    //
    // The property asserted is that each field INVOKES for itself, not that
    // the two expressions differ textually: `draw()` and `draw()` are the same
    // text and are two independent numbers, which is the correct shape, while
    // `pick: roll` is different text and is one number used twice, which is
    // the bug. A bare identifier is a value already drawn; a call is a draw.
    const pick = /pick:([^,\n]*)/.exec(call![1]);
    expect(pick, 'the chooseVenue call passes no pick').toBeTruthy();
    expect(pick![1]).not.toMatch(/rankedBias/);
    for (const [name, m] of [['roll', roll!], ['pick', pick!]] as const) {
      expect(m[1], `${name} reuses a value instead of drawing one`).toMatch(/\(\s*\)/);
    }
  });
});

describe('rematching', () => {
  it('ACCEPTS a human request at any pair count, including past the hard cap', () => {
    // "An explicit human Rematch is legitimate play that nothing here may
    // block or decline." Past the cap the match simply rates nothing — which
    // is a rating decision, not a reason to refuse the game.
    for (const count of [0, 3, 12, 13, 40]) {
      expect(
        acceptsRematch({ traits: traits({ rematchAppetite: 0 }), fromHuman: true, recentPairCount: count, roll: 0.99 })
      ).toBe(true);
    }
  });

  it('leaves a BOT’s own offer to its appetite and its diversity', () => {
    // Between two bots there is nobody to disappoint, so the preference
    // applies: an eager bot plays again, a reluctant one moves on.
    expect(
      acceptsRematch({ traits: traits({ rematchAppetite: 1 }), fromHuman: false, recentPairCount: 0, roll: 0.5 })
    ).toBe(true);
    expect(
      acceptsRematch({ traits: traits({ rematchAppetite: 0 }), fromHuman: false, recentPairCount: 0, roll: 0.5 })
    ).toBe(false);
  });

  it('makes a bot less eager the more it has already played that opponent', () => {
    const t = traits({ rematchAppetite: 0.6 });
    const early = acceptsRematch({ traits: t, fromHuman: false, recentPairCount: 0, roll: 0.5 });
    const late = acceptsRematch({ traits: t, fromHuman: false, recentPairCount: 11, roll: 0.5 });
    expect(early).toBe(true);
    expect(late).toBe(false);
  });

  it('stops offering before a pair could cover a PLACEMENT', () => {
    // The taper ran to the pair ladder's hard cap at 12, on the reasoning
    // that a bot should stop offering at about the point the ladder stops
    // rating. That is right about the RATING and wrong about the LADDER:
    // placement is five ranked games and the first moves 4.21 mu, so a pair
    // with a dozen rematches in it can carry a bot from unranked to
    // Grandmaster without either of them meeting anybody else.
    //
    // Measured on a live roster of 96 after the queue fix: rotation was
    // working -- 46 of 96 accounts had played -- and the busiest still had
    // FOUR matches against ONE opponent, because they met at a table and
    // then rematched. The queue path was fixed and this one was not.
    //
    // It tapers over the ladder's FULL-VALUE rung instead, so a pair plays
    // about two and moves on, and five placement games need at least three
    // opponents. Nothing about a HUMAN's request changes: that is accepted
    // unconditionally at any count, which the case above pins.
    const eager = traits({ rematchAppetite: 1 });
    // Even maximum appetite is spent by the first rung, at every roll.
    for (const roll of [0, 0.5, 0.99]) {
      expect(
        acceptsRematch({ traits: eager, fromHuman: false, recentPairCount: BOT_PAIR_FULL_VALUE, roll })
      ).toBe(false);
      // ...and a human still gets their game there.
      expect(
        acceptsRematch({ traits: eager, fromHuman: true, recentPairCount: BOT_PAIR_FULL_VALUE, roll })
      ).toBe(true);
    }
    // The rung is well under what placement needs, which is the whole point.
    expect(BOT_PAIR_FULL_VALUE).toBeLessThan(PLACEMENT_GAMES);
  });
});

describe('what this module cannot do', () => {
  it('names opponents and venues, and nothing about results', () => {
    // The structural half of "no win-trading, no outcome coordination, no
    // opponent selection whose purpose is farming". The controller decides
    // where and when a bot participates, never how a match turns out — so
    // there must be nothing here that takes or returns a score, a winner or an
    // outcome, and no way for one bot's choice to be conditioned on another's
    // result.
    const src = fs.readFileSync(path.join(process.cwd(), 'server', 'playbotPolicy.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const name of [
      'isWinner', 'winner', 'score', 'concede', 'throwMatch', 'outcome', 'recordMatch', 'result',
    ]) {
      expect({ name, present: code.includes(name) }).toEqual({ name, present: false });
    }
  });

  it('is a pure function of what it is handed', () => {
    // Same inputs, same answer, and no reach into a database, a clock or a
    // random source — so nothing it decides can depend on state a test cannot
    // see, and two bots cannot coordinate through a shared one.
    const src = fs.readFileSync(path.join(process.cwd(), 'server', 'playbotPolicy.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const name of ['Math.random', 'Date.now', 'new Date', "from './db'", 'process.env']) {
      expect({ name, present: code.includes(name) }).toEqual({ name, present: false });
    }
    const roster = [candidate({ id: 'a', mu: 24 }), candidate({ id: 'b', mu: 26 })];
    const once = chooseOpponent({ self: { ...self, traits: seedTraits('bot-pure') }, candidates: roster, now: NOW });
    const twice = chooseOpponent({ self: { ...self, traits: seedTraits('bot-pure') }, candidates: roster, now: NOW });
    expect(once?.id).toBe(twice?.id);
  });
});

describe('which table to walk up to, and which venues may be tried', () => {
  it('prefers a human’s table found in ANY venue, not just the first', () => {
    // The gathered list is searched as a whole. Returning inside the first
    // venue that held any free table meant a bot table in `casual` was taken
    // while a human sat waiting in `beginner` — the preference applied within
    // a venue and not across them, so the activation that existed to serve
    // that person served a bot.
    //
    // The bot table is FIRST in the list deliberately: it is the one a
    // first-match rule returns, so the fixture fails against that rule rather
    // than passing on the order it happened to be given.
    const bots = new Set(['bot-a', 'bot-b']);
    const free = [
      { id: 'CASU', seatedIds: ['bot-a'] },
      { id: 'BEGN', seatedIds: ['dev_human000000000001'] },
    ];
    expect(humanTablesFirst(free, bots).map((t) => t.id)).toEqual(['BEGN']);
  });

  it('sees a human who is not in the host’s chair', () => {
    // A table outlives its host, so seat 0 empties and seat 1 stays -- and the
    // listing then names a live table whose `hostId` is null. Judged on the
    // host, that person was invisible and the bot activated to serve them took
    // the bot table listed above them instead. The bot table is FIRST for the
    // same reason it is above: a first-match rule has to fail this.
    const bots = new Set(['bot-a']);
    const free = [
      { id: 'CASU', seatedIds: ['bot-a'] },
      // Exactly the row the relay produces for a table whose host has left:
      // no seat 0, one human in seat 1.
      { id: 'BEGN', seatedIds: ['dev_human000000000001'] },
    ];
    expect(humanTablesFirst(free, bots).map((t) => t.id)).toEqual(['BEGN']);
  });

  it('still takes a bot’s table when that is all there is', () => {
    // The preference is never a refusal — a bot with only bots to play plays
    // them, which is §2.11's rule one level down.
    const bots = new Set(['bot-a']);
    // The partition falls back to ALL of them rather than to none, so the
    // preference downstream still has something to choose between.
    expect(humanTablesFirst([{ id: 'CASU', seatedIds: ['bot-a'] }], bots).map((t) => t.id))
      .toEqual(['CASU']);
    expect(humanTablesFirst([], bots)).toEqual([]);
    // A table nobody is sitting at is not preferred as a human's.
    expect(humanTablesFirst([{ id: 'X', seatedIds: [] }], bots).map((t) => t.id)).toEqual(['X']);
  });

  it('leaves every bot somewhere it may play, at every tier it can reach', () => {
    // `chooseVenue`'s `allowed` is the set the bracket gate permits, and the
    // caller handed it the raw list — so a bot that had climbed past Contender
    // was sent at `beginner`, which carries a tierMax, and refused. A refused
    // HOST fell back; a refused JOIN had nowhere to fall back to and retried
    // the same forbidden table every tick while its human waited.
    //
    // The filter is only safe because it can never empty: this is that
    // property, over every tier a bot's own results can reach.
    for (const tier of TIER_ORDER) {
      for (const level of [1, 5, 20, 100]) {
        const open = OPEN_VENUES.filter((id: string) => roomEntryVerdict(roomById(id), { level, tier }).ok);
        expect(open, `${tier} at level ${level} may enter nowhere`).not.toHaveLength(0);
      }
    }
    // And it genuinely NARROWS, or it is not a filter. A Master loses both
    // ends of the ladder — `beginner` (tierMax contender) below it and
    // `elite`/`pro` (tierMin grandmaster/legend) above — and keeps the middle.
    //
    // This used to expect `['casual']`, which was the whole bug rather than
    // the property: with OPEN_VENUES holding only the two ungated rooms, a bot
    // past Contender kept nothing but the one room that cannot rate it. What
    // is asserted now is that the filter still refuses in BOTH directions,
    // which is what makes it a bracket rather than a floor.
    const climbed = OPEN_VENUES.filter(
      (id: string) => roomEntryVerdict(roomById(id), { level: 20, tier: 'master' }).ok
    );
    expect(climbed).toEqual(['casual', 'intermediate', 'advanced']);
    expect(climbed).not.toContain('beginner');
    expect(climbed).not.toContain('pro');
  });
});
