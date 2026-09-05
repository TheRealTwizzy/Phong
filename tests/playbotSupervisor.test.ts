import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  PlaybotSupervisor,
  liveStateFrom,
  bandCentreFor,
  defaultPlaybotName,
  type PlaybotAccountStore,
} from '../server/playbotSupervisor';
import { seedTraits, type PlaybotTraits } from '../server/playbotTraits';
import { MIN_AI_COMPETENCE } from '../src/game/physics';
import { PATIENCE_MS, targetActivation } from '../server/playbotPopulation';
import { START_MU } from '../src/rating';
import { Phone, sleep, startRelay, type Relay } from './helpers/relay';

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

/**
 * A store's pairing view for suites that are NOT testing the preference: an
 * even rating and no shared history, so `chooseOpponent` falls through to its
 * id tiebreak and which table a bot walks up to stays deterministic.
 */
const flatPairingView = (_selfId: string, ids: string[]) => ({
  self: { mu: 25, sigma: 8.333 },
  candidates: ids.map((id) => ({
    id,
    isBot: false,
    mu: 25,
    sigma: 8.333,
    recentPairCount: 0,
    lastPlayedAt: null,
  })),
});

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
      // START_MU, which is now only what happens when nobody is waiting
      // anywhere the controller can see (`bandCentreFor` reads the tables as
      // well as the queue; this fixture passes 25 by hand).
      load: () => [
        row('bot-placed', { mu: 25, level: 10, tier: 'ace' }),
        row('bot-open', { mu: 18, level: 1, tier: 'unranked' }),
      ],
      save: () => {
        throw new Error('nothing in this test provisions');
      },
      pairingView: () => {
        throw new Error('nothing in this test dispatches');
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

describe('§2.11: which of two comparable tables a bot walks up to', () => {
  it('prefers the opponent it has played less, not the first one listed', async () => {
    // `chooseOpponent` had no caller in the shipped server: a repository-wide
    // search found it in its own unit tests and nowhere else, so the diversity
    // preference existed, was tested, and did nothing. `openTable` took the
    // first free listing entry, so the same bots repeated the same pairings
    // while fresher comparable opponents sat free -- spending the same-pair
    // rating allowance on matches that then counted for nothing.
    //
    // Both tables are hosted by HUMANS, so the §4.13 partition keeps both and
    // this is the preference deciding on its own. The one listed FIRST is the
    // one with the history, so a first-entry rule fails here rather than
    // passing on the order it happened to be given.
    relay = await startRelay('playbot-prefer');
    const dir = relay.dataDir;

    const seen = await relay.newDevice('PreferSeen');
    const fresh = await relay.newDevice('PreferFresh');
    const seenPhone = await relay.openPhone(seen);
    const freshPhone = await relay.openPhone(fresh);
    seenPhone.send({
      type: 'create_room',
      playerId: seen.id,
      venueRoomId: 'casual',
      visibility: 'public',
    });
    await seenPhone.await('room_created');
    freshPhone.send({
      type: 'create_room',
      playerId: fresh.id,
      venueRoomId: 'casual',
      visibility: 'public',
    });
    await freshPhone.await('room_created');

    const rows = new Map<string, ReturnType<typeof rowFor>>();
    const rowFor = (botId: string, deviceCookie: string, traits: PlaybotTraits) => ({
      botId,
      username: botId,
      deviceCookie,
      traits,
      mu: 25,
      recentMatches: 0,
      level: 1,
      tier: 'unranked' as const,
    });

    let asked: string[] = [];
    const sup = new PlaybotSupervisor({
      base: relay.base,
      wsUrl: relay.wsUrl,
      rosterSize: 1,
      tickMs: 3_600_000,
      store: {
        load: () => [...rows.values()],
        save: (botId, deviceCookie, traits) => {
          rows.set(botId, rowFor(botId, deviceCookie, traits));
        },
        // Identical ratings, so the two are comparable by construction and
        // nothing but the history can separate them. This is the store's job
        // in production too: the listing carries an id and the ratings and the
        // pair history come from the database beside it.
        pairingView: (_selfId, ids) => {
          asked = ids;
          return {
            self: { mu: 25, sigma: 8.333 },
            candidates: ids.map((id) => ({
              id,
              isBot: false,
              mu: 25,
              sigma: 8.333,
              recentPairCount: id === seen.id ? 5 : 0,
              lastPlayedAt: id === seen.id ? Date.now() - 1000 : null,
            })),
          };
        },
      },
      // Two tables waiting and nobody in the queue, so the one bot is
      // activated for a TABLE and dispatched to join one of them.
      live: () => ({
        humansOnline: 8,
        queuedHumans: 0,
        longestWaitMs: 0,
        openTableVenues: ['casual', 'casual'],
      }),
    });
    await sup.start();
    sup.tick();

    await freshPhone.await('opponent_joined', 20_000);
    // And it is not that BOTH were joined in turn: the bot holds one seat.
    expect(seenPhone.last('opponent_joined')).toBeUndefined();
    // The policy was asked about the people at the tables, not about tables.
    expect([...asked].sort()).toEqual([fresh.id, seen.id].sort());

    await sup.stop();
    seenPhone.close();
    freshPhone.close();
    expect(fs.existsSync(path.join(dir, 'phong.db'))).toBe(true);
  }, 60_000);
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
        pairingView: flatPairingView,
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
        pairingView: flatPairingView,
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

/**
 * One bot hosting one table, a human seated opposite, and a match under way.
 *
 * Returned with the knob the two tests below turn: `crowd(true)` puts twenty
 * humans online, so the idle baseline rounds to zero, the target is zero, and
 * the controller names the bot for deactivation. `crowd(false)` puts the
 * server back to empty, where the target is six and the bot is KEPT.
 */
const seatedAgainstOneBot = async (
  label: string,
  rematchGraceMs?: number
): Promise<{
  sup: PlaybotSupervisor;
  phone: Awaited<ReturnType<Relay['openPhone']>>;
  botId: string;
  crowd: (on: boolean) => void;
  queue: (n: number) => void;
  seat: 'p1' | 'p2';
}> => {
  relay = await startRelay(label);
  const rows = new Map<string, ReturnType<PlaybotAccountStore['load']>[number]>();
  let crowded = false;
  let queued = 0;
  const sup = new PlaybotSupervisor({
    base: relay.base,
    wsUrl: relay.wsUrl,
    rosterSize: 1,
    tickMs: 3_600_000,
    rematchGraceMs,
    traitsFor: (u) => ({
      ...seedTraits(u),
      skill: MIN_AI_COMPETENCE,
      // One table, in one venue, so the listing below finds it in one place:
      // `chooseVenue` picks on `rankedBias` against an independent roll, and a
      // bias of 0 makes `roll < bias` false at every roll.
      rankedBias: 0,
      hostAppetite: 1,
      joinAppetite: 0,
      queueAppetite: 0,
    }),
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
      pairingView: flatPairingView,
    },
    live: () => ({
      humansOnline: crowded ? 20 : 0,
      queuedHumans: queued,
      longestWaitMs: 0,
      openTableVenues: [],
    }),
  });
  await sup.start();

  sup.tick();
  for (let i = 0; i < 60 && sup.connectedBotIds().length === 0; i++) await sleep(250);
  expect(sup.connectedBotIds()).toHaveLength(1);

  let roomId: string | null = null;
  for (let i = 0; i < 60 && !roomId; i++) {
    const body = await (await fetch(`${relay.base}/api/rooms/casual/tables`)).json();
    roomId = ((body?.tables ?? []) as Array<{ id: string }>)[0]?.id ?? null;
    if (!roomId) await sleep(250);
  }
  expect(roomId).not.toBeNull();

  const human = await relay.newDevice(`${label.slice(0, 10)}Human`);
  const phone = await relay.openPhone(human);
  phone.send({ type: 'join_room', roomId: roomId!, playerId: human.id });
  const joined = await phone.await('room_joined');
  phone.send({ type: 'player_ready', ready: true });
  await phone.await('game_start', 20_000);

  return {
    sup,
    phone,
    botId: sup.connectedBotIds()[0],
    crowd: (on: boolean) => {
      crowded = on;
    },
    queue: (n: number) => {
      queued = n;
    },
    seat: joined.playerIndex === 0 ? 'p1' : 'p2',
  };
};

/** Three points from the human's own seat, which is the whistle. */
const playOut = async (phone: Phone, seat: 'p1' | 'p2'): Promise<void> => {
  for (let i = 1; i <= 3; i += 1) {
    phone.send({ type: 'point_scored', scorer: seat });
    await phone.awaitCount('score_update', i);
  }
};

describe('a stand-down is derived from the controller, never latched', () => {
  it('puts a RETAINED bot back in service, not only a re-activated one', async () => {
    // The fourteenth round's fix reached one of the two paths and read as
    // though it reached both. `backInService` was called from the ACTIVATE
    // loop, and `targetActivation` builds `activate` out of the bots that are
    // NOT active (`available = ordered.filter((b) => !active.has(b.id))`) --
    // so a bot asked to stand down during an occupied lobby or a rally, and
    // wanted again before the whistle, is named by NEITHER array. It is
    // simply KEPT: its latch never cleared, it goes on leaving at the final
    // score, and it refuses the human's rematch, which §2.11 says nothing may
    // do -- while the controller has just decided to keep it.
    //
    // Driven through the SUPERVISOR and not the driver, because the driver's
    // half is already right and already covered: `tests/playbotDuel.test.ts`
    // calls `standDown` and `backInService` by hand and passes whatever the
    // supervisor does. What is under test here is whether anything ever makes
    // the second call.
    //
    // The stand-down lands MID-MATCH rather than in the occupied lobby the
    // report names. Both are the same retention path and the same latch, and
    // a rally is the half with no race in it: `standDown`'s lobby arm turns on
    // the driver's own `opponentPresent`, which is set by a message still in
    // flight when the human's `room_joined` returns, so a lobby fixture could
    // stand the bot down from what it still believed was an EMPTY lobby --
    // which leaves at once, and would be a green test of a different rule.
    const { sup, phone, botId, crowd, seat } = await seatedAgainstOneBot('playbot-retain');

    // Demand falls. The precondition is asserted rather than assumed: a
    // fixture in which the controller never asked for a stand-down would pass
    // with nothing cleared and nothing to clear.
    crowd(true);
    expect(targetActivation(sup.snapshot(), START_MU).deactivate).toEqual([botId]);
    sup.tick();

    // Demand recovers, and the bot is KEPT -- named by neither array, which is
    // the path under test. Asserted too, because a fixture that quietly
    // re-ACTIVATED it would be exercising the loop that was already right.
    crowd(false);
    const target = targetActivation(sup.snapshot(), START_MU);
    expect([target.deactivate, target.activate.map((a) => a.id)]).toEqual([[], []]);
    sup.tick();

    await playOut(phone, seat);

    // A latched stand-down leaves inside the handler that sees the whistle, so
    // this reddens first and names the bug; the rematch below is the half that
    // costs a person a game.
    await sleep(500);
    expect(phone.last('opponent_left')).toBeUndefined();

    phone.send({ type: 'rematch_request' });
    await phone.awaitCount('game_start', 2, 20_000);

    phone.close();
    await sup.stop();
  }, 90_000);

  it('leaves a bot the controller DID name standing down', async () => {
    // The other half of the same rule, and the guard it pins is one nothing
    // else in the suite could see: the clearing pass runs BELOW the
    // deactivation loop, so without `askedToStandDown` it would take back
    // every stand-down in the tick that requested it and deactivation would
    // silently stop working -- the population unable to shrink, and a bot
    // holding its seat for the life of the process.
    //
    // Nothing caught that. `tests/playbotLifecycle.test.ts` drives
    // `standDown()` on the driver by hand, which is the right layer for what
    // it owns and cannot observe a supervisor that undoes its own request:
    // measured, dropping the guard left all 23 tests across both suites green.
    const { sup, phone, botId, crowd, seat } = await seatedAgainstOneBot('playbot-standdown');

    crowd(true);
    expect(targetActivation(sup.snapshot(), START_MU).deactivate).toEqual([botId]);
    sup.tick();

    // Still mid-match, so the request is granted at the whistle and not before
    // -- an abandon is a real ranked loss for a bot that did nothing.
    expect(phone.last('opponent_left')).toBeUndefined();

    await playOut(phone, seat);
    await phone.await('opponent_left', 20_000);

    phone.close();
    await sup.stop();
  }, 90_000);
});

describe('a finished court holds a rematch window', () => {
  it('does not take the bot away while the human is deciding', async () => {
    // The whistle puts the driver in `over`, which `engaged()` treats as
    // inactive -- so the very next tick either redispatches that bot or reaps
    // it, while the human is still looking at the result overlay with Play
    // Again under their thumb. At the default 15s tick and a phase that is
    // random against the whistle, a large share of rematches simply vanish:
    // the bot's socket closes, the relay vacates its seat, and the vote the
    // human then casts is one nobody is left to answer.
    //
    // That is §2.11's own promise -- an explicit human Rematch is legitimate
    // play nothing may block -- lost to the population rather than to a
    // refusal, which is why wiring `acceptsRematch` did not reach it.
    //
    // The round-eleven reap is still right and still bounded: what it fixed
    // was a driver held on a finished court FOREVER, and a window that
    // expires does not bring that back.
    const { sup, phone, crowd, seat } = await seatedAgainstOneBot('playbot-rematch-window');
    void crowd;

    // Past DISPATCH_GRACE_MS before the whistle, and this is the assertion's
    // whole validity: without it the fixture finishes about two seconds after
    // the dispatch, `engaged()` returns true on `Date.now() - dispatchedAt <
    // 5_000` whatever the phase is, and the test passes against the unfixed
    // code -- the catalogue's own "a guard defended by a second guard
    // upstream". Measured: it did. A real match is minutes long, so the
    // dispatch grace never covers a real whistle.
    await sleep(5_500);

    await playOut(phone, seat);
    sup.tick();
    await sleep(500);

    expect(phone.last('opponent_left')).toBeUndefined();

    phone.send({ type: 'rematch_request' });
    await phone.awaitCount('game_start', 2, 20_000);

    phone.close();
    await sup.stop();
  }, 90_000);

  it('lets the window EXPIRE, so a finished court is still released', async () => {
    // The bound, which is the half that keeps the round-eleven reap true: what
    // it fixed was a driver held on a finished court forever, and a grace with
    // no end would be exactly that wearing a reason. Driven at a short window
    // rather than the real twenty seconds -- the same seam `idleLobbyMs` is,
    // and for the same reason.
    const { sup, phone, seat } = await seatedAgainstOneBot('playbot-window-ends', 500);

    await sleep(5_500);
    await playOut(phone, seat);

    // Inside the window: still there, so this is not passing because the bot
    // had already left for some other reason.
    sup.tick();
    await sleep(200);
    expect(phone.last('opponent_left')).toBeUndefined();

    // Past it. Released is not the same as CLOSED: with demand for it the very
    // same tick sends it somewhere else, so what the human sees is the seat
    // emptying rather than the roster shrinking -- `connectedBotIds` stays at
    // one, which is why the assertion is at the court and not at the pool.
    await sleep(700);
    sup.tick();
    await phone.await('opponent_left', 20_000);

    phone.close();
    await sup.stop();
  }, 90_000);

  it('is not taken away by a stand-down inside the window either', async () => {
    // The window closed one door and opened another, which is the shape this
    // feature keeps producing: holding a finished court in `engaged` is what
    // puts that bot INTO `activeBotIds`, and the controller names its
    // deactivations from exactly that set -- so as the target fades the bot is
    // ranked outside `kept`, arrives in `target.deactivate`, and `standDown`
    // on a phase of `over` leaves the table on the spot. Same loss to the same
    // human, through the door the fix had just created.
    const { sup, phone, botId, crowd, seat } = await seatedAgainstOneBot('playbot-window-standdown');

    await sleep(5_500);
    await playOut(phone, seat);

    // Twenty humans online with nobody queued: the target rounds to zero and
    // urgency stays zero, which is the state that names a still-engaged bot
    // for deactivation without any human being unserved.
    crowd(true);
    expect(targetActivation(sup.snapshot(), START_MU).deactivate).toEqual([botId]);
    sup.tick();
    await sleep(500);

    expect(phone.last('opponent_left')).toBeUndefined();

    phone.send({ type: 'rematch_request' });
    await phone.awaitCount('game_start', 2, 20_000);

    phone.close();
    await sup.stop();
  }, 90_000);

  it('gives the court up anyway when a human has no game at all', async () => {
    // §4.13's priority rule, which this feature has now made nominal three
    // separate times: a bot holding something that is not a match must not
    // outrank a human with nothing. The window yields to unserved demand
    // exactly as the idle-lobby window does -- somebody deciding whether to
    // play a SECOND game is a weaker claim than somebody waiting for a first.
    const { sup, phone, queue, seat } = await seatedAgainstOneBot('playbot-window-yields');

    await sleep(5_500);
    await playOut(phone, seat);

    // One human in the queue is an odd queue, so `unmetHumanDemand` is 1 and
    // the whole window is skipped -- well inside the twenty seconds it would
    // otherwise be held for.
    queue(1);
    sup.tick();
    await phone.await('opponent_left', 20_000);

    phone.close();
    await sup.stop();
  }, 90_000);
});

describe('a dispatch that throws', () => {
  it('costs one bot its turn, never the process', async () => {
    // `tick()` is synchronous and fires its dispatches with `void`, so a
    // rejection inside one has no handler anywhere: it reaches
    // `process.on('unhandledRejection')`, which `server.ts` answers with
    // `onFatal` — a controlled shutdown. One bot's opponent ranking would then
    // end every live duel on the server, and the throw is not exotic:
    // `openTable` reads `pairingView`, which is a SQLite read, so a full disk
    // or a volume remounted read-only is enough.
    //
    // The listener is the assertion. Vitest reports an unhandled rejection on
    // its own, but as a run-level error rather than as this test failing, so
    // the mutation would redden something that does not name the rule.
    relay = await startRelay('playbot-dispatch-throws');
    const rows = new Map<string, ReturnType<PlaybotAccountStore['load']>[number]>();

    // A human sitting alone at a public table, which is what makes the
    // dispatch a JOIN and therefore what makes it reach `pairingView` at all.
    const host = await relay.newDevice('ThrowHost');
    const hostPhone = await relay.openPhone(host);
    hostPhone.send({
      type: 'create_room',
      playerId: host.id,
      venueRoomId: 'casual',
      visibility: 'public',
    });
    await hostPhone.await('room_created');

    const sup = new PlaybotSupervisor({
      base: relay.base,
      wsUrl: relay.wsUrl,
      rosterSize: 1,
      tickMs: 3_600_000,
      traitsFor: (u) => ({
        ...seedTraits(u),
        skill: MIN_AI_COMPETENCE,
        rankedBias: 0,
        hostAppetite: 0,
        joinAppetite: 1,
        queueAppetite: 0,
      }),
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
        pairingView: () => {
          throw new Error('database is locked');
        },
      },
      live: () => ({
        humansOnline: 1,
        queuedHumans: 0,
        longestWaitMs: 0,
        openTableVenues: ['casual'],
      }),
    });
    await sup.start();

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      sup.tick();
      await sleep(2_000);
      expect(unhandled).toEqual([]);
      // And the supervisor is still usable afterwards rather than merely
      // silent: the next tick is what retries this bot.
      expect(() => sup.tick()).not.toThrow();
    } finally {
      process.off('unhandledRejection', onUnhandled);
      hostPhone.close();
      await sup.stop();
    }
  }, 60_000);
});

describe('whose band the roster is ranked against', () => {
  const rating: Record<string, number> = { legend: 36, novice: 14, mid: 25, bot: 30 };
  const ratingOf = (id: string): number | null => rating[id] ?? null;
  const isBot = (id: string): boolean => id === 'bot';

  it('reads a human waiting ALONE at a table, not only the queue', async () => {
    // The round-thirteen repair reached half the demand. It read the queue, so
    // a human sitting alone at a public table produced no centre at all, the
    // fallback was START_MU, and `targetActivation` activated the bot nearest
    // mu 25 for a player who might be a Legend or a beginner. `openTable`
    // cannot rescue that: it ranks TABLES for a bot already chosen and cannot
    // swap in a better-rated dormant one, so the mismatch stands while
    // suitable roster capacity sits idle.
    expect(
      bandCentreFor({
        queue: [],
        tables: [{ playerId: 'legend', waitingSince: 10 }],
        isBot,
        ratingOf,
      })
    ).toBe(36);
  });

  it('prefers the queue where both are waiting', async () => {
    // A queued player's own band is widening on a timer, so theirs is the wait
    // with a cost attached; a table host can still be joined by anybody.
    expect(
      bandCentreFor({
        queue: [{ playerId: 'novice', joinedAt: 50 }],
        tables: [{ playerId: 'legend', waitingSince: 10 }],
        isBot,
        ratingOf,
      })
    ).toBe(14);
  });

  it('takes the longest wait within each', async () => {
    expect(
      bandCentreFor({
        queue: [
          { playerId: 'mid', joinedAt: 90 },
          { playerId: 'legend', joinedAt: 20 },
        ],
        tables: [],
        isBot,
        ratingOf,
      })
    ).toBe(36);
    expect(
      bandCentreFor({
        queue: [],
        tables: [
          { playerId: 'mid', waitingSince: 90 },
          { playerId: 'novice', waitingSince: 20 },
        ],
        isBot,
        ratingOf,
      })
    ).toBe(14);
  });

  it('never ranks the population against one of its own', async () => {
    // The bots sit in that queue and at those tables themselves, so counting
    // one is a population steering by its own appetite -- the rule
    // `liveStateFrom` already follows for the demand count, applied to the
    // player that demand is ranked against.
    expect(
      bandCentreFor({
        queue: [{ playerId: 'bot', joinedAt: 1 }],
        tables: [{ playerId: 'bot', waitingSince: 1 }],
        isBot,
        ratingOf,
      })
    ).toBeUndefined();
    // And an unrated human is not a centre of zero: `ratingOf` answering null
    // means there is nothing to rank against, which is what START_MU is for.
    expect(
      bandCentreFor({
        queue: [],
        tables: [{ playerId: 'stranger', waitingSince: 1 }],
        isBot,
        ratingOf,
      })
    ).toBeUndefined();
  });
});
