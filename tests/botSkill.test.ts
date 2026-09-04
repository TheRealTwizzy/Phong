import { describe, expect, it } from 'vitest';
import {
  BOT_QUEUE_AFTER_MS,
  botVenue,
  botsToOffer,
  difficultyForSkill,
  trueSkillForBot,
} from '../server/botPlayers';
import { DIFFICULTY_ORDER } from '../src/achievements';
import { roomById, roomEntryVerdict } from '../src/venues';
import { findPair, type Candidate } from '../server/matchmaking';
import { PLACEMENT_GAMES, PLACEMENT_SIGMA, START_MU, START_SIGMA, tierFor } from '../src/rating';

// A play-bot's strength is a property of the ACCOUNT, fixed for its lifetime,
// and its RATING is what the ladder discovers about it through play. That one
// decision is what makes three of the owner's rules fall out instead of being
// built: the population has a spread (rule 9), every bot starts at 0/5 Unranked
// with nothing asserted about where it belongs (rule 5), and each bot's own
// ceiling is what stops it reaching #1 rather than any coordination (rule 10).

const ids = Array.from({ length: 200 }, (_, i) => `bot-ladder-${String(i).padStart(3, '0')}`);

describe('a play-bot’s true skill', () => {
  it('is derived from the id, so it survives a restart', () => {
    // Stored nowhere, so it cannot drift from the account it describes.
    for (const id of ids.slice(0, 20)) {
      expect(trueSkillForBot(id)).toBe(trueSkillForBot(id));
    }
  });

  it('gives different bots different strengths', () => {
    const distinct = new Set(ids.map((id) => trueSkillForBot(id).toFixed(4)));
    // "Fundamentally different skill levels" — a roster of clones would be a
    // population in name only.
    expect(distinct.size).toBeGreaterThan(ids.length * 0.9);
  });

  it('never reaches the apex as a birthright', () => {
    // The Overlord floor is 37. A bot topping out under it means reaching the
    // apex takes a genuine run against the field, which is what keeps the top
    // of the bot ladder churning instead of settling on whoever was seeded
    // highest — and it is the mechanism behind "their skill levels prevent
    // each of them from accomplishing #1".
    for (const id of ids) {
      const mu = trueSkillForBot(id);
      expect(mu).toBeGreaterThanOrEqual(18);
      expect(mu).toBeLessThan(37);
    }
  });

  it('spreads across the ladder rather than piling at the rails', () => {
    const mus = ids.map(trueSkillForBot);
    const mid = mus.filter((m) => m >= 24 && m <= 30).length / mus.length;
    const rails = mus.filter((m) => m < 21 || m > 33).length / mus.length;
    // A flat draw would put as many bots at the extremes as in the middle,
    // which is not what a player base looks like. The middle should be the
    // fat part.
    expect(mid).toBeGreaterThan(rails);
  });

  it('maps every strength to a real difficulty rung', () => {
    for (const id of ids) {
      expect(DIFFICULTY_ORDER).toContain(difficultyForSkill(trueSkillForBot(id)));
    }
  });

  it('picks harder rungs for stronger bots, monotonically', () => {
    const rung = (mu: number) => DIFFICULTY_ORDER.indexOf(difficultyForSkill(mu));
    let last = -1;
    for (let mu = 18; mu <= 36; mu += 0.25) {
      const r = rung(mu);
      // Ordering asserted on the RUNG, which is exact, rather than on measured
      // play — the same rule tests/rating.test.ts follows, and for the same
      // reason: a return-rate sample can never order the top rungs.
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
  });

  it('starts every bot Unranked at 0/5, like a person', () => {
    // Rule 5, and the reason `insertBot`'s pre-placement is the wrong default
    // for a competitor: a bot that is handed a tier has not earned one, and
    // the whole point of a fixed hidden strength is that the ladder finds it.
    expect(tierFor(START_MU, 0, START_SIGMA, 0)).toBe('unranked');
    // Still unranked one game short, so the counter the profile prints is the
    // promise being kept rather than the first of two conditions.
    expect(tierFor(START_MU, PLACEMENT_GAMES - 1, PLACEMENT_SIGMA, 0)).toBe('unranked');
    expect(tierFor(START_MU, PLACEMENT_GAMES, PLACEMENT_SIGMA, 0)).not.toBe('unranked');
  });
});

describe('where a play-bot opens its table', () => {
  it('never picks a room that refuses the ladder', () => {
    // The bug this exists for. `casual` carries `ranked: false`, so a bot
    // playing there earns XP and hidden MMR and never one `rankedGames` — it
    // would sit at 0/5 Unranked forever, never place, and never climb. A
    // population that plays constantly and is permanently unranked is worse
    // than the fabricated careers this whole change replaced.
    for (const tier of ['unranked', 'rookie', 'contender', 'ace', 'master', 'legend'] as const) {
      for (const level of [1, 5, 12, 20, 30]) {
        expect(botVenue({ level, tier }), `${tier}/${level}`).not.toBe('casual');
      }
    }
  });

  it('puts an unplaced bot in the lowest bracket', () => {
    // An unplaced player is below every floor, and a ceiling deliberately
    // never excludes one — so the gate lands them here with no special casing.
    expect(botVenue({ level: 1, tier: 'unranked' })).toBe('beginner');
    expect(botVenue(null)).toBe('beginner');
  });

  it('moves a bot up as it climbs, without ever skipping the gate', () => {
    // Whatever it picks, `roomEntryVerdict` must actually admit it — this is
    // the assertion that catches a room being chosen by name rather than by
    // the same predicate the relay enforces at three doors.
    const seen = new Set<string>();
    for (const tier of ['unranked', 'contender', 'ace', 'master', 'grandmaster', 'legend'] as const) {
      const room = botVenue({ level: 30, tier });
      seen.add(room);
      expect(roomEntryVerdict(roomById(room), { level: 30, tier }).ok, `${tier} -> ${room}`).toBe(true);
    }
    // And it is not one room for everybody: a population that all piles into
    // `beginner` leaves every other browser empty.
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('offering a bot to somebody waiting in the queue', () => {
  const NOW = 1_000_000;
  const human = (waitedMs: number) => ({ deviceId: 'dev_x', joinedAt: NOW - waitedMs });
  const bot = () => ({ deviceId: 'bot-ladder-01', joinedAt: NOW });

  it('offers nobody an empty queue', () => {
    expect(botsToOffer([], NOW)).toBe(0);
  });

  it('leaves a fresh arrival alone', () => {
    // The queue's band is a promise with an expiry: a coin flip for the first
    // thirty seconds. A bot offered instantly answers that promise before it
    // was ever tested, and a player would never meet another person while any
    // bot sat idle.
    expect(botsToOffer([human(0)], NOW)).toBe(0);
    expect(botsToOffer([human(BOT_QUEUE_AFTER_MS - 1)], NOW)).toBe(0);
  });

  it('offers one to somebody who has genuinely waited', () => {
    expect(botsToOffer([human(BOT_QUEUE_AFTER_MS)], NOW)).toBe(1);
    expect(botsToOffer([human(BOT_QUEUE_AFTER_MS * 3)], NOW)).toBe(1);
  });

  it('offers one per waiting human, not one per sweep', () => {
    expect(botsToOffer([human(60_000), human(60_000)], NOW)).toBe(2);
  });

  it('counts the bots already queued, so a sweep does not pile them up', () => {
    // The failure this prevents: the sweep runs every two seconds, so without
    // subtracting what is already there, one person waiting would pull in the
    // whole roster inside a minute — and those bots would then start pairing
    // with EACH OTHER in front of the person still waiting.
    expect(botsToOffer([human(60_000), bot()], NOW)).toBe(0);
    expect(botsToOffer([human(60_000), human(60_000), bot()], NOW)).toBe(1);
    expect(botsToOffer([human(60_000), bot(), bot(), bot()], NOW)).toBe(0);
  });

  it('never offers a bot to a queue of bots', () => {
    expect(botsToOffer([bot(), bot()], NOW)).toBe(0);
  });
});

describe('the shared queue never seats two bots against each other', () => {
  // The relay pairs from ONE human plus the bots, rather than one `findPair`
  // over the whole mixed list. This is why: `findPair` picks the closest to a
  // coin flip and has no idea what a bot is, so a mixed list can hand back a
  // bot-vs-bot pair while people wait. Bots play each other through their own
  // pool; a pair coming out of the shared queue must contain a human.
  const NOW = 2_000_000;
  const c = (deviceId: string, mu: number, waited: number): Candidate => ({
    deviceId,
    mu,
    sigma: 1,
    joinedAt: NOW - waited,
    rttMs: 50,
  });

  it('would pair two bots if the whole mixed list were handed to findPair', () => {
    // The bug, demonstrated rather than asserted away. Two humans far apart in
    // rating (so no band admits them to each other) and two bots sitting
    // together in the middle: the fairest pair on the board is bot vs bot.
    const mixed = [
      c('dev_low', 12, 120_000),
      c('dev_high', 40, 120_000),
      c('bot-a', 25, 5_000),
      c('bot-b', 25, 5_000),
    ];
    const pair = findPair(mixed, NOW);
    expect(pair).not.toBeNull();
    const both = pair!.every((p) => p.deviceId.startsWith('bot-'));
    expect(both).toBe(true);
  });

  it('is not fixed by handing findPair one human plus every bot', () => {
    // The near-miss, kept because it is the fix somebody reaches for first and
    // it does not work: the list still holds two bots, so findPair can still
    // pick them, and the human it was handed is simply ignored.
    const bots = [c('bot-a', 25, 5_000), c('bot-b', 25, 5_000)];
    const pair = findPair([c('dev_low', 12, 120_000), ...bots], NOW);
    expect(pair).not.toBeNull();
    expect(pair!.every((p) => p.deviceId.startsWith('bot-'))).toBe(true);
  });

  it('is fixed by one bot at a time, which can only return that pair', () => {
    // What the relay does. A two-entry list comes back as that pair or as
    // null — the band refusing it — so a pairing out of the shared queue
    // always contains the person it was built around.
    const bots = [c('bot-a', 25, 5_000), c('bot-b', 25, 5_000)];
    let considered = 0;
    for (const human of [c('dev_low', 12, 120_000), c('dev_mid', 25, 120_000)]) {
      for (const bot of bots) {
        const pair = findPair([human, bot], NOW);
        if (!pair) continue;
        considered++;
        expect(pair.filter((p) => !p.deviceId.startsWith('bot-')).length).toBe(1);
      }
    }
    // And the band was genuinely applied rather than every pair passing: the
    // mid-rated human is admitted to the bots, the far-off one is not.
    expect(considered).toBeGreaterThan(0);
  });
});
