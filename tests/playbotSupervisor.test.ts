import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  PlaybotSupervisor,
  liveStateFrom,
  defaultPlaybotName,
  type PlaybotAccountStore,
} from '../server/playbotSupervisor';
import { seedTraits, type PlaybotTraits } from '../server/playbotTraits';
import { MIN_AI_COMPETENCE } from '../src/game/physics';
import { PATIENCE_MS, targetActivation } from '../server/playbotPopulation';
import { sleep, startRelay, type Relay } from './helpers/relay';

// Step 22's other half: "the population starts with the process".
//
// The lifecycle suite next door owns what happens at the END -- SIGTERM
// charges nobody an abandon, a stand-down waits for the whistle -- driving
// drivers by hand. Nothing owned the beginning, so the drivers only ever
// existed inside a test file and the shipped server had no population at all.
//
// The supervisor is glue and nothing more: it reads live server state, asks
// `server/playbotPopulation.ts` which bots should be on, and starts or stands
// down drivers. §4.13's rule is that it SELECTS and never steers, so it writes
// no trait, no rating and no result -- asserted by reading the source, because
// a rule about what cannot exist has to be checked where the thing would be
// written (step 17's lesson, where a `setBotSkill` in `db.ts` was invisible to
// a test that only read the trait module).
//
// IT RUNS IN THE SERVER PROCESS, and that is not incidental. The marker row is
// what makes an account a bot, and `isBotAccount` reads an in-memory cache: a
// supervisor writing through a second connection would leave THIS process
// still classifying its own bots as humans -- rating them at full stakes,
// badging them as people, counting them in a human's ladder lane -- with
// nothing anywhere to see. So the suite boots a real server with the feature
// flag on and asserts from outside, which is also how a deployment runs it.

let relay: Relay | null = null;
let leftovers: string[] = [];

afterEach(async () => {
  await relay?.stop();
  relay = null;
  for (const dir of leftovers) fs.rmSync(dir, { recursive: true, force: true });
  leftovers = [];
});

const readDb = <T>(dir: string, fn: (h: DatabaseSync) => T): T => {
  const h = new DatabaseSync(path.join(dir, 'phong.db'), { readOnly: true });
  try {
    return fn(h);
  } finally {
    h.close();
  }
};

/**
 * Every account the supervisor could drive: a marker row WITH a credential.
 *
 * The curated roster is excluded by the cookie being null rather than by an id
 * shape -- those rows are furniture with no driver, and asking about the `bot-`
 * prefix here would be the classifier D26 retired.
 */
const playbots = (dir: string): string[] =>
  readDb(dir, (h) =>
    (
      h
        .prepare('SELECT botId FROM bot_accounts WHERE deviceCookie IS NOT NULL ORDER BY botId')
        .all() as Array<{ botId: string }>
    ).map((r) => r.botId)
  );

/** Usernames burned out of the pool by accounts that are NOT the roster. */
const playbotNames = (dir: string): string[] =>
  readDb(dir, (h) =>
    (
      h
        .prepare(
          `SELECT p.username AS username
             FROM players p JOIN bot_accounts b ON b.botId = p.id
            WHERE b.deviceCookie IS NOT NULL ORDER BY p.username`
        )
        .all() as Array<{ username: string }>
    ).map((r) => r.username)
  );

/** Wait until the supervisor's provisioning has settled, or give up. */
const settle = async (dir: string, want: number): Promise<string[]> => {
  for (let i = 0; i < 100; i++) {
    const ids = playbots(dir);
    if (ids.length >= want) return ids;
    await sleep(200);
  }
  return playbots(dir);
};

/**
 * Players sitting at a public table, across EVERY venue a bot may open one in.
 *
 * Both rooms, deliberately: `chooseVenue` picks between them on the bot's own
 * `rankedBias` against an independent roll, so a suite that counted `casual`
 * alone would be measuring the coin flip. It read only `casual` while the
 * roll was the bias itself and the answer was therefore always Casual —
 * green for a reason it did not name, and red the moment the choice worked.
 */
const seatedAtTables = async (base: string): Promise<number> => {
  let n = 0;
  for (const room of ['casual', 'beginner']) {
    const body = await (await fetch(`${base}/api/rooms/${room}/tables`)).json();
    n += ((body?.tables ?? []) as Array<{ playerCount: number }>).reduce(
      (t, x) => t + x.playerCount,
      0
    );
  }
  return n;
};

/** Wait for the population to actually be PLAYING, not merely to exist. */
const waitForSeated = async (base: string, tries = 60): Promise<number> => {
  let seated = 0;
  for (let i = 0; i < tries; i++) {
    seated = await seatedAtTables(base);
    if (seated > 0) return seated;
    await sleep(500);
  }
  return seated;
};

const withPopulation = (size: number, dataDir?: string, extra: Record<string, string> = {}) =>
  startRelay('playbot-sup', {
    dataDir,
    env: { PLAYBOT_ROSTER_SIZE: String(size), PLAYBOT_TICK_MS: '600000', ...extra },
  });

describe('the population starts with the process', () => {
  it('provisions its roster once and REUSES it across a restart', async () => {
    relay = await withPopulation(2, undefined, { PLAYBOT_TICK_MS: '1000' });
    const dir = relay.dataDir;
    leftovers.push(dir);

    const born = await settle(dir, 2);
    expect(born).toHaveLength(2);
    const names = playbotNames(dir);
    expect(names).toHaveLength(2);

    // SIGTERM rather than SIGKILL: the directory has to survive, and this is
    // the signal a deploy sends.
    await relay.terminate();

    // A second boot on the SAME database. Same accounts, same usernames, and
    // nothing new minted -- which is the whole reason the credential is
    // stored. A play-bot's id is ISSUED, so re-provisioning would not find its
    // way back: it would burn a second username out of the pool for good and
    // strand the first account's rating and history under an id nothing holds
    // a credential for.
    relay = await withPopulation(2, dir, { PLAYBOT_TICK_MS: '1000' });
    await sleep(1500);
    expect(playbots(dir)).toEqual(born);
    expect(playbotNames(dir)).toEqual(names);

    // AND THE POPULATION IS ALIVE ON THEM, which is the half that makes this
    // test able to fail. The names are deterministic, so a supervisor that
    // never loads its stored accounts re-provisions, is refused USERNAME_TAKEN
    // by its own first boot, logs, and carries on with NO bots -- leaving the
    // two assertions above green over a server running an empty population.
    // Measured: without this, dropping the load entirely reddened nothing.
    expect(await waitForSeated(relay.base)).toBeGreaterThan(0);
  }, 180_000);

  it('lets the configured size bound the pool it will DRIVE, not just create', async () => {
    // `targetActiveCount` clamps against `snapshot.roster.length`, so loading
    // every stored account made the env var a creation-time setting rather
    // than an operational bound: a deployment turned down from many to one
    // went on activating the old many under demand.
    relay = await withPopulation(3, undefined, { PLAYBOT_TICK_MS: '1000' });
    const dir = relay.dataDir;
    leftovers.push(dir);
    expect(await settle(dir, 3)).toHaveLength(3);
    await relay.terminate();

    // Same database, turned down. The three accounts survive -- they are
    // dormant rows and come back if the size is raised -- and at most one is
    // driven.
    relay = await withPopulation(1, dir, { PLAYBOT_TICK_MS: '1000' });
    await sleep(3000);
    expect(playbots(dir)).toHaveLength(3);
    expect(await waitForSeated(relay.base, 20)).toBeLessThanOrEqual(1);
  }, 180_000);

  it('walks past a name a human already holds', async () => {
    // The name index used to start at `managed.length`, so one permanent
    // collision left the roster permanently short: index 0 fails, index 1
    // makes the second name, and every later boot loads one account, starts at
    // 1, and retries the name that account already holds. It never reaches the
    // third name and the pool never fills.
    relay = await withPopulation(0);
    const dir = relay.dataDir;
    leftovers.push(dir);
    // A HUMAN takes the first name the population would have asked for.
    const squatter = await relay.newDevice(defaultPlaybotName(0));
    expect(squatter.id).toBeTruthy();
    await relay.terminate();

    relay = await withPopulation(2, dir, { PLAYBOT_TICK_MS: '1000' });
    const born = await settle(dir, 2);
    expect(born).toHaveLength(2);
    // Two accounts, and neither wearing the name the human holds.
    expect(playbotNames(dir)).not.toContain(defaultPlaybotName(0));
  }, 180_000);

  it('starts nothing at all when the roster size is zero', async () => {
    // §5: the population is a tunable with a measured ceiling, not a constant,
    // and nothing ships a default before step 27 has run the load test. Zero
    // provisions nothing and burns no usernames.
    relay = await withPopulation(0);
    await sleep(2000);
    expect(playbots(relay.dataDir)).toHaveLength(0);
  }, 60_000);

  it('marks every account it provisions as a bot, in THIS process', async () => {
    relay = await withPopulation(1);
    const [botId] = await settle(relay.dataDir, 1);
    expect(botId).toBeTruthy();
    // Asked over HTTP, so the answer comes from the running server's own
    // classifier cache rather than from the file -- which is the failure a
    // second connection would produce and nothing else here could see.
    const { profile } = await (
      await fetch(`${relay!.base}/api/profile/${encodeURIComponent(botId)}`)
    ).json();
    expect(profile.isBot).toBe(true);
    // And step 25's neutralisation reaches a supervisor-born bot, which is the
    // point of deriving it from bot_accounts rather than from an id shape.
    expect(profile).not.toHaveProperty('dailyStreak');
  }, 60_000);

  it('puts its bots on the court, where a human can meet one', async () => {
    // The idle baseline is what keeps a ladder alive on an empty server, so a
    // population with nobody about should end up playing each other.
    relay = await withPopulation(2, undefined, { PLAYBOT_TICK_MS: '1000' });
    await settle(relay.dataDir, 2);
    expect(await waitForSeated(relay.base)).toBeGreaterThan(0);
  }, 90_000);
});

describe('what the supervisor tells the controller', () => {
  const bots = new Set(['bot_a', 'bot_b']);
  const isBot = (id: string) => bots.has(id);

  it('counts HUMANS in the queue, never its own bots', () => {
    // The supervisor's own bots sit in that same queue, so counting entries
    // would make every bot it activates look like another waiting human
    // asking for one more -- a population growing on its own appetite, which
    // is the opposite of `unmetHumanDemand`'s arithmetic. Three bots and ONE
    // human deliberately: an implementation counting entries reads 4 (even,
    // so no unmet demand) where the truth is 1 (odd, so exactly one).
    const state = liveStateFrom({
      connectedIds: ['bot_a', 'bot_b', 'human_1'],
      queue: [
        { playerId: 'bot_a', joinedAt: 0 },
        { playerId: 'bot_b', joinedAt: 0 },
        { playerId: 'human_1', joinedAt: 0 },
      ],
      openTableVenues: [],
      now: 1000,
      isBot,
    });
    expect(state.queuedHumans).toBe(1);
    expect(state.humansOnline).toBe(1);
  });

  it('measures the longest wait from a HUMAN, never from a bot', () => {
    // `impatientDemand` reads this as somebody who has plainly not found
    // anybody, and a bot that has been queuing for a minute is not that
    // person. The bot waits far longer than the human here, and far past
    // PATIENCE_MS, so an implementation reading the whole queue reports an
    // impatient human who does not exist.
    const now = 10 * PATIENCE_MS;
    const state = liveStateFrom({
      connectedIds: ['bot_a', 'human_1'],
      queue: [
        { playerId: 'bot_a', joinedAt: 0 },
        { playerId: 'human_1', joinedAt: now - 1000 },
      ],
      openTableVenues: [],
      now,
      isBot,
    });
    expect(state.longestWaitMs).toBe(1000);
    expect(state.longestWaitMs).toBeLessThan(PATIENCE_MS);
  });

  it('reports no wait at all when only bots are queued', () => {
    // `longestWaitMs` is whatever the last waiter left behind, so a quiet
    // server must not go on activating a bot for somebody who has gone.
    const state = liveStateFrom({
      connectedIds: ['bot_a'],
      queue: [{ playerId: 'bot_a', joinedAt: 0 }],
      openTableVenues: [],
      now: 10 * PATIENCE_MS,
      isBot,
    });
    expect(state.queuedHumans).toBe(0);
    expect(state.longestWaitMs).toBe(0);
  });

  it('carries the venue of every open table through, unchanged', () => {
    // This replaced a "never reports a negative table count" clamp. The count
    // was its own number, so it could be negative -- SUBTRACTING from a
    // waiting human's claim on a bot -- and could disagree with the venues
    // silently. It is one list now: its length is the count, so neither state
    // exists, and what is left to assert is that the venues reach the
    // controller, since it is the controller that has to ask whether any bot
    // may enter them.
    const state = liveStateFrom({
      connectedIds: [],
      queue: [],
      openTableVenues: ['beginner', 'casual', 'beginner'],
      now: 0,
      isBot,
    });
    expect(state.openTableVenues).toEqual(['beginner', 'casual', 'beginner']);
  });
});

describe('the roster the controller is shown', () => {
  const row = (
    botId: string,
    over: { mu: number; level: number; tier: 'unranked' | 'ace' }
  ) => ({
    botId,
    username: botId,
    deviceCookie: `cookie-${botId}`,
    traits: seedTraits(botId),
    recentMatches: 0,
    ...over,
  });

  it('tells it which venues each bot may actually enter', async () => {
    // The controller has to spend a TABLE slot on somebody the relay will let
    // in, and it can only do that if the roster it is shown says so. The pure
    // side of that is tested next door; what can only be caught here is the
    // composition -- `roster()` handing every bot the same raw list makes the
    // filter true of everybody and the failure comes straight back, with the
    // pure test still green.
    //
    // No relay: the store already holds the roster, so `start()` provisions
    // nothing and `snapshot()` reaches no socket. The base URLs below are
    // never dialled for the same reason.
    const store: PlaybotAccountStore = {
      // `ace` is above `beginner`'s tierMax of Contender, which is the state a
      // bot reaches by winning -- and mu 25 is the Ace FLOOR, so this is also
      // the bot sitting nearest a band centre that has fallen back to
      // START_MU, which is what happens whenever the waiting human is at a
      // table rather than in the queue.
      load: () => [
        row('bot-placed', { mu: 25, level: 10, tier: 'ace' }),
        row('bot-open', { mu: 18, level: 1, tier: 'unranked' }),
      ],
      save: () => {
        throw new Error('nothing in this test provisions');
      },
    };
    const sup = new PlaybotSupervisor({
      base: 'http://127.0.0.1:1',
      wsUrl: 'ws://127.0.0.1:1',
      rosterSize: 2,
      tickMs: 3_600_000,
      store,
      live: () => ({
        humansOnline: 8,
        queuedHumans: 0,
        longestWaitMs: 0,
        openTableVenues: ['beginner'],
      }),
    });
    await sup.start();
    try {
      const snapshot = sup.snapshot();
      const venuesOf = (id: string) => snapshot.roster.find((b) => b.id === id)!.venues;
      expect(venuesOf('bot-placed')).toEqual(['casual']);
      expect(venuesOf('bot-open')).toEqual(['casual', 'beginner']);
      // And therefore the one slot this demand buys goes to the bot that can
      // sit down, not to the one nearest the band.
      expect(targetActivation(snapshot, 25).activate).toEqual([
        { id: 'bot-open', action: 'join' },
      ]);
    } finally {
      await sup.stop();
    }
  });
});

describe('§4.13: the controller selects, it never steers', () => {
  it('writes no trait, no rating and no result', () => {
    // Asserted where the writes would BE. This is the layer holding a handle
    // to both the roster and the database, so it is the one place a
    // "nudge this bot toward the thin band" could be written without anything
    // else noticing.
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'server', 'playbotSupervisor.ts'),
      'utf8'
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/UPDATE\s+bot_accounts/i);
    expect(code).not.toMatch(/rankMu|mmrMu|recordMatch|updateRating|setBot/);
    // It may READ a rating and select on it -- that is what it is for.
    expect(code).toMatch(/targetActivation/);
  });
});

describe('a bot plays more than one match', () => {
  it('sends a bot somewhere again once its match is over', async () => {
    // WITHOUT this the population plays exactly ONE match for the life of the
    // process: a driver sitting on a finished court still holds a room and a
    // socket, so `activeBotIds` counted it, `targetActivation` kept it, and
    // nothing ever dispatched it anywhere. The consequence that matters is not
    // the idle bots — it is the human who queues while every bot is mid-match
    // and waits forever, because the controller sees a full active set and
    // activates nobody for them.
    //
    // Driven from the TEST process rather than through the flag, because this
    // is about the supervisor's own dispatch and needs the tick under the
    // test's hand. Classification is irrelevant here, so no marker row is
    // written and none is asserted -- the suite above owns that.
    relay = await startRelay('playbot-redispatch');
    const dir = relay.dataDir;
    // Typed from the store's own contract, so a field added there is a
    // compile error here rather than a fixture that has quietly drifted.
    const rows = new Map<string, ReturnType<PlaybotAccountStore['load']>[number]>();
    const sup = new PlaybotSupervisor({
      base: relay.base,
      wsUrl: relay.wsUrl,
      rosterSize: 2,
      tickMs: 3_600_000,
      // The idle-lobby window is what makes the FIRST pairing happen when both
      // bots' seeded appetites say host, and waiting one out is thirty seconds
      // of CI for something this test does not assert. Shortened here; the
      // production constants are what ship, and the jitter is kept because
      // WITHOUT a stagger the two come free on the same tick and deadlock,
      // which is the bug the jitter exists for and would fail this test.
      idleLobbyMs: 1_500,
      idleLobbyJitterMs: 1_500,
      // Barely-there opponents, so a first-to-3 match is over in seconds.
      // `tests/playbotTraits.test.ts` owns how good a bot is; what is under
      // test here is that a finished one is sent somewhere again.
      traitsFor: (u) => ({ ...seedTraits(u), skill: MIN_AI_COMPETENCE }),
      store: {
        load: () => [...rows.values()],
        save: (botId, deviceCookie, traits) => {
          rows.set(botId, {
            botId,
            username: botId,
            deviceCookie,
            traits,
            mu: 25,
            recentMatches: 0,
            // A fresh account, which is what the bracket gate judges an
            // unplayed bot as — and what makes every OPEN_VENUES room
            // enterable, since `beginner` carries a ceiling and no floor.
            level: 1,
            tier: 'unranked' as const,
          });
        },
      },
      live: () => ({ humansOnline: 0, queuedHumans: 0, longestWaitMs: 0, openTableVenues: [] }),
    });
    await sup.start();
    // The usernames are issued names, so read them back off the accounts.
    for (const [botId] of rows) {
      const row = rows.get(botId)!;
      row.username = readDb(dir, (h) =>
        (h.prepare('SELECT username FROM players WHERE id = ?').get(botId) as { username: string })
          .username
      );
    }

    const played = (): number =>
      readDb(dir, (h) =>
        Math.max(
          0,
          ...[...rows.keys()].map(
            (id) =>
              (
                h.prepare('SELECT matchesPlayed AS n FROM players WHERE id = ?').get(id) as {
                  n: number;
                }
              ).n
          )
        )
      );

    let best = 0;
    for (let i = 0; i < 120 && best < 2; i++) {
      sup.tick();
      await sleep(1000);
      best = played();
    }
    await sup.stop();
    expect(best).toBeGreaterThanOrEqual(2);
  }, 180_000);
});

describe('a driver the controller has stopped naming', () => {
  it('closes a driver the controller has stopped naming', async () => {
    // `deactivate` is `s.activeBotIds.filter((id) => !kept.has(id))` and
    // `activeBotIds` IS the engaged set, so the two states a bot ends a job in
    // -- a finished court, and an empty lobby past its window -- are exactly
    // the states in which it can never be named. Not named means never
    // `retiring`, and the reap loop opened with `m.retiring &&`, so nothing
    // ever let that driver go: it kept its socket, its seat and its 16ms
    // timer while the controller ranked other dormant accounts above it.
    //
    // The bot is dispatched with nobody about, then the server fills up: at
    // twenty humans online the idle baseline rounds to zero, so the target is
    // zero and the controller names NOBODY. That is the case under test --
    // not a stand-down, which was always reaped, but a bot the controller has
    // simply stopped mentioning.
    relay = await startRelay('playbot-reap');
    const rows = new Map<string, ReturnType<PlaybotAccountStore['load']>[number]>();
    // Flipped between the two ticks, so one supervisor sees both worlds.
    let crowded = false;
    const sup = new PlaybotSupervisor({
      base: relay.base,
      wsUrl: relay.wsUrl,
      rosterSize: 1,
      tickMs: 3_600_000,
      // Short, so the lone bot's own empty lobby stops counting as engagement
      // inside the test rather than after twenty seconds of it.
      idleLobbyMs: 500,
      idleLobbyJitterMs: 0,
      traitsFor: (u) => ({ ...seedTraits(u), skill: MIN_AI_COMPETENCE }),
      store: {
        load: () => [...rows.values()],
        save: (botId, deviceCookie, traits) => {
          rows.set(botId, {
            botId,
            username: botId,
            deviceCookie,
            traits,
            mu: 25,
            recentMatches: 0,
            level: 1,
            tier: 'unranked' as const,
          });
        },
      },
      live: () => ({
        humansOnline: crowded ? 20 : 0,
        queuedHumans: 0,
        longestWaitMs: 0,
        openTableVenues: [],
      }),
    });
    await sup.start();

    sup.tick();
    for (let i = 0; i < 60 && sup.connectedBotIds().length === 0; i++) await sleep(250);
    // The precondition, asserted rather than assumed: without a driver in hand
    // there is nothing to reap and the assertion below would pass on an empty
    // set for the wrong reason.
    expect(sup.connectedBotIds()).toHaveLength(1);

    // Past the idle-lobby window, so the driver is genuinely not engaged.
    await sleep(1_000);
    expect(sup.activeBotIds()).toHaveLength(0);

    crowded = true;
    sup.tick();
    await sleep(500);

    expect(sup.connectedBotIds()).toHaveLength(0);
    await sup.stop();
  }, 60_000);
});
