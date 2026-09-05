// The glue that makes a play-bot population a thing the SERVER runs, rather
// than a thing a test file can construct.
//
// It owns nothing anybody argues about. `server/playbotPopulation.ts` decides
// which bots should be on, `server/playbotPolicy.ts` decides what an
// autonomous one prefers, `server/playbotDriver.ts` plays the match, and
// `server/db.ts` records it through exactly the paths a human's match takes.
// What was missing was the layer that reads live server state, asks the
// controller, and starts or stands down drivers — so the drivers only ever
// existed inside `tests/playbotLifecycle.test.ts` and the shipped server had
// no population at all, against §7 step 22's own headline.
//
// §4.13'S RULE IS THE ONE TO KEEP IN MIND HERE, because this is the layer that
// holds a handle to both halves: the controller SELECTS which existing bots
// play and where, and never assigns a rank, clamps one toward a target,
// retunes competence, or touches a result. There is therefore no write to a
// trait, a rating or a match anywhere in this file, and `tests/
// playbotSupervisor.test.ts` asserts that absence by reading the source —
// because a rule about what cannot exist has to be checked where the thing
// would be written (the lesson step 17 recorded when a `setBotSkill` in
// `db.ts` was invisible to a test that only read the trait module).
//
// OFF BY DEFAULT, and that is §5: the population size is a tunable with a
// measured ceiling, not a constant, and nothing may ship a default before step
// 27 has run the load test. `rosterSize` 0 starts nothing, provisions nothing
// and burns no usernames.

import { PlaybotDriver } from './playbotDriver';
import { seedTraits, type PlaybotTraits } from './playbotTraits';
import { chooseVenue } from './playbotPolicy';
import {
  targetActivation,
  type PopulationAction,
  type PopulationBot,
  type PopulationSnapshot,
} from './playbotPopulation';
import { START_MU } from '../src/rating';

/** Live server state the supervisor cannot see for itself. */
export interface LiveState {
  /** Connected humans. Bots are the supervisor's own and are excluded here. */
  humansOnline: number;
  /** Humans waiting in the ranked queue — never the bots sitting in it too. */
  queuedHumans: number;
  /** How long the longest-waiting HUMAN has waited, ms. */
  longestWaitMs: number;
  /** Public tables sitting with a free playing seat. */
  openTables: number;
  /**
   * Where the ladder is thin, for `rankForActivation`'s preference. A
   * preference and never an assignment: no bot's rating moves because it was
   * chosen, and a roster with nobody near the band supplies its nearest.
   */
  bandCentre?: number;
}

export interface PlaybotAccountStore {
  /** Play-bot accounts this process can drive, oldest first. */
  load(): Array<{
    botId: string;
    username: string;
    deviceCookie: string;
    traits: PlaybotTraits;
    mu: number;
    recentMatches: number;
  }>;
  /** Marker row, credential and traits, written once at creation. */
  save(botId: string, deviceCookie: string, traits: PlaybotTraits): void;
}

export interface PlaybotSupervisorOptions {
  base: string;
  wsUrl: string;
  /** How many play-bot accounts to keep. 0 disables the population entirely. */
  rosterSize: number;
  tickMs?: number;
  /**
   * Where accounts are remembered. REQUIRED, and deliberately not defaulted to
   * a lazily-required `db`: the store has to be the SERVER's own handle, or
   * the marker row lands in the file while the process's `isBotAccount` cache
   * never hears about it — and that cache is the sole classifier, so the bot
   * would rate, badge and be counted as a human with nothing to see.
   */
  store: PlaybotAccountStore;
  /** Injected in tests; defaults to an empty server. */
  live?: () => LiveState;
  /** Names new accounts. Injected only so a test can make them predictable. */
  nameFor?: (n: number) => string;
}

export const DEFAULT_TICK_MS = 15_000;

/** A bot the supervisor holds an account for, connected or not. */
interface Managed {
  botId: string;
  username: string;
  deviceCookie: string;
  traits: PlaybotTraits;
  driver: PlaybotDriver | null;
}

const IDLE_LIVE: LiveState = {
  humansOnline: 0,
  queuedHumans: 0,
  longestWaitMs: 0,
  openTables: 0,
};

export class PlaybotSupervisor {
  private readonly opts: PlaybotSupervisorOptions;
  private readonly store: PlaybotAccountStore;
  private readonly live: () => LiveState;
  private managed: Managed[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(opts: PlaybotSupervisorOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.live = opts.live ?? (() => IDLE_LIVE);
  }

  /** The bots currently holding a connection — the controller's active set. */
  public activeBotIds(): string[] {
    return this.managed.filter((m) => m.driver !== null).map((m) => m.botId);
  }

  public snapshot(): PopulationSnapshot {
    const live = this.live();
    return {
      humansOnline: live.humansOnline,
      queuedHumans: live.queuedHumans,
      longestWaitMs: live.longestWaitMs,
      openTables: live.openTables,
      activeBotIds: this.activeBotIds(),
      roster: this.roster(),
    };
  }

  /**
   * Load the accounts this database already holds, provision any shortfall,
   * and begin ticking.
   *
   * Provisioning is the ONLY thing here that creates anything, it happens once
   * per account for the life of the database, and a boot that finds its roster
   * already there creates nothing at all — which is what stops a restart
   * burning another username out of the pool.
   */
  public async start(): Promise<void> {
    // A guard no test can hold, recorded here rather than dropped — the fourth
    // of these in this feature. The provisioning loop's own bound (`n <
    // rosterSize`) already creates nothing at 0, and `tick()` returns at 0 too,
    // so removing this line changes no observable behaviour and reddens
    // nothing. What it prevents is a `setInterval` armed on every deployment
    // that has the population OFF — which is all of them until step 27 — ticking
    // forever over an empty roster. A cost guard, like step 10's human-only
    // exposure queries, and kept for the same reason.
    if (this.opts.rosterSize <= 0) return;
    for (const row of this.store.load()) {
      this.managed.push({
        botId: row.botId,
        username: row.username,
        deviceCookie: row.deviceCookie,
        traits: row.traits,
        driver: null,
      });
    }
    for (let n = this.managed.length; n < this.opts.rosterSize; n++) {
      await this.provision(n);
    }
    const every = this.opts.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => void this.tickSafely(), every);
    // A bot population must never be the reason a process refuses to exit.
    this.timer.unref?.();
  }

  /**
   * Close every driver.
   *
   * Deliberately a CLOSE and not a stand-down: this runs on the way out, where
   * `server.ts` has already set `shuttingDown`, so a socket dying mid-duel is
   * not charged an abandon (CLAUDE.md §10, and `tests/playbotLifecycle.test.ts`
   * holds it). A stand-down waits for the whistle, which a shutdown cannot.
   */
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const m of this.managed) {
      m.driver?.close();
      m.driver = null;
    }
  }

  /**
   * One pass: ask the controller, then act on what it said.
   *
   * Activation connects a driver and sends it where the controller said to go.
   * Deactivation is a REQUEST — `standDown` waits for the whistle, because a
   * bot cut off mid-rally leaves its opponent on a dead court and is judged an
   * abandon: a real ranked loss for a bot that did nothing, and a win handed to
   * whoever it was playing.
   */
  public tick(): void {
    if (this.stopped || this.opts.rosterSize <= 0) return;
    const live = this.live();
    const snapshot = this.snapshot();
    const target = targetActivation(snapshot, live.bandCentre ?? START_MU);

    for (const { id, action } of target.activate) {
      const m = this.managed.find((x) => x.botId === id);
      if (!m || m.driver) continue;
      void this.activate(m, action);
    }
    for (const id of target.deactivate) {
      const m = this.managed.find((x) => x.botId === id);
      m?.driver?.standDown();
    }
  }

  private async tickSafely(): Promise<void> {
    // Re-entrant guard: a tick that is still awaiting a connect must not have
    // a second one start alongside it and activate the same bot twice.
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.tick();
    } catch (e) {
      console.warn('[playbot] tick failed:', (e as Error)?.message ?? e);
    } finally {
      this.ticking = false;
    }
  }

  private roster(): PopulationBot[] {
    const byId = new Map(this.store.load().map((r) => [r.botId, r]));
    return this.managed.map((m) => {
      const row = byId.get(m.botId);
      return {
        id: m.botId,
        traits: m.traits,
        // EARNED, read and never written: a bot suits a thin band or it does
        // not, and if none does the answer is more bots at creation rather
        // than a different rating on this one (§4.13).
        mu: row?.mu ?? START_MU,
        recentMatches: row?.recentMatches ?? 0,
      };
    });
  }

  /** Onboard a brand-new play-bot through the doors a browser uses. */
  private async provision(n: number): Promise<void> {
    const username = (this.opts.nameFor ?? defaultName)(n);
    const traits = seedTraits(username);
    const driver = new PlaybotDriver({
      base: this.opts.base,
      wsUrl: this.opts.wsUrl,
      username,
      traits,
    });
    try {
      await driver.provision((botId) => {
        this.store.save(botId, driver.deviceCookie(), traits);
      });
    } catch (e) {
      // A name a human already holds, a server still coming up — per-bot
      // recoverable, exactly as `seedBotRoster` treats a roster collision.
      // One bot short is a smaller population, not a failed boot.
      console.warn(`[playbot] could not provision ${username}:`, (e as Error)?.message ?? e);
      return;
    }
    this.managed.push({
      botId: driver.botId,
      username,
      deviceCookie: driver.deviceCookie(),
      traits,
      driver: null,
    });
  }

  private async activate(m: Managed, action: PopulationAction): Promise<void> {
    const driver = new PlaybotDriver({
      base: this.opts.base,
      wsUrl: this.opts.wsUrl,
      username: m.username,
      traits: m.traits,
    });
    // Claim the slot BEFORE the await, or two ticks in flight activate the
    // same bot twice and it holds two sockets on one account — which the
    // relay resolves by evicting the first, mid-match.
    m.driver = driver;
    try {
      await driver.resume(m.deviceCookie);
      await driver.connect();
    } catch (e) {
      console.warn(`[playbot] ${m.username} could not connect:`, (e as Error)?.message ?? e);
      driver.close();
      m.driver = null;
      return;
    }
    if (this.stopped) {
      driver.close();
      m.driver = null;
      return;
    }
    if (action === 'queue') {
      driver.queue();
      return;
    }
    // Hosting and joining both put a table in a venue the bot's own appetite
    // picks. `join` has no table to aim at until the browser poll lands, so it
    // opens one and waits — a table somebody can walk into is the same offer
    // from the other side, and it never leaves the bot doing nothing.
    const venue = chooseVenue({ traits: m.traits, roll: m.traits.rankedBias, allowed: OPEN_VENUES });
    driver.host({}, venue ?? undefined);
  }
}

/**
 * The venues a bot will open a table in.
 *
 * Deliberately the two ungated ones. A bracketed room refuses a host who may
 * not play there (`roomEntryVerdict`, enforced at `create_room`), so a bot
 * aiming at one would be turned away for a reason nothing here can fix, and
 * the brackets exist to sort HUMANS by tier rather than to be filled by the
 * population.
 */
const OPEN_VENUES = ['casual', 'beginner'];

const defaultName = (n: number): string => `Rally${String(n + 1).padStart(2, '0')}Bot`;

/**
 * The live picture the controller needs, built from what `server.ts` holds.
 *
 * Pure over its inputs so the one rule that matters here can be argued about
 * in a test: **the queue is counted by HUMANS**. The supervisor's own bots sit
 * in that same queue, so counting entries would make every bot it activates
 * look like another waiting human asking for one more — a population that
 * grows on its own appetite, which is the opposite of `unmetHumanDemand`'s
 * arithmetic and of §4.13's displacement rule.
 *
 * `longestWaitMs` is a HUMAN's wait for the same reason: `impatientDemand`
 * reads it as somebody who has plainly not found anybody, and a bot that has
 * been queuing for a minute is not that person.
 */
export function liveStateFrom(a: {
  /** Every socket's account id, bots included. */
  connectedIds: string[];
  /** The ranked queue, in whatever order it is held. */
  queue: Array<{ playerId: string; joinedAt: number }>;
  /** Public tables with a free playing seat. */
  openTables: number;
  now: number;
  isBot: (id: string) => boolean;
  bandCentre?: number;
}): LiveState {
  const humanQueue = a.queue.filter((e) => !a.isBot(e.playerId));
  const longestWaitMs = humanQueue.reduce((worst, e) => Math.max(worst, a.now - e.joinedAt), 0);
  return {
    humansOnline: a.connectedIds.filter((id) => !a.isBot(id)).length,
    queuedHumans: humanQueue.length,
    longestWaitMs,
    openTables: Math.max(0, a.openTables),
    bandCentre: a.bandCentre,
  };
}
