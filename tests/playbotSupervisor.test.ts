import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { liveStateFrom } from '../server/playbotSupervisor';
import { PATIENCE_MS } from '../server/playbotPopulation';
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

/** Players sitting at a public table in the ungated room, over every table. */
const seatedInCasual = async (base: string): Promise<number> => {
  const body = await (await fetch(`${base}/api/rooms/casual/tables`)).json();
  return ((body?.tables ?? []) as Array<{ playerCount: number }>).reduce(
    (n, t) => n + t.playerCount,
    0
  );
};

/** Wait for the population to actually be PLAYING, not merely to exist. */
const waitForSeated = async (base: string, tries = 60): Promise<number> => {
  let seated = 0;
  for (let i = 0; i < tries; i++) {
    seated = await seatedInCasual(base);
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
      openTables: 0,
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
      openTables: 0,
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
      openTables: 0,
      now: 10 * PATIENCE_MS,
      isBot,
    });
    expect(state.queuedHumans).toBe(0);
    expect(state.longestWaitMs).toBe(0);
  });

  it('never reports a negative table count', () => {
    expect(liveStateFrom({ connectedIds: [], queue: [], openTables: -3, now: 0, isBot }).openTables)
      .toBe(0);
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
