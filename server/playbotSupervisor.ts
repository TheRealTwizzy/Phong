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
  impatientDemand,
  targetActivation,
  unmetHumanDemand,
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
  /**
   * How long a bot may sit at a table nobody joined before it counts as spare,
   * and the spread that window is jittered over. Injected ONLY to keep a test
   * that has to wait one out from costing thirty seconds of CI — the same seam
   * `tickMs` is, and for the same reason. Production uses the constants.
   */
  idleLobbyMs?: number;
  idleLobbyJitterMs?: number;
  /**
   * The traits a NEW account is seeded with. Creation may seed and nothing
   * after it may steer (§4.13), so this is reachable exactly once per account
   * and there is no path that reaches an existing one — which is what makes it
   * safe to expose at all. Injected only by a test that needs a population
   * whose matches are short enough to measure; production seeds from the id.
   */
  traitsFor?: (username: string) => PlaybotTraits;
  /**
   * The coin flip a venue choice is judged against, in [0,1).
   *
   * A SEPARATE draw from the trait it is compared to, and the separation is
   * the whole of it: `chooseVenue` asks `roll < traits.rankedBias`, so handing
   * it the bias itself makes that `x < x` — false for every bot at every
   * appetite, so every table this population opened was Casual and no
   * table-based bot match could move the visible ladder. The pure function was
   * right and tested throughout; only the caller was wrong, which is why the
   * test for this reads the CALL SITE (§12's `unrankedReasons` idiom).
   *
   * Injected only so a test can make the choice deterministic.
   */
  rollFor?: () => number;
}

export const DEFAULT_TICK_MS = 15_000;

/** A bot the supervisor holds an account for, connected or not. */
interface Managed {
  botId: string;
  username: string;
  deviceCookie: string;
  traits: PlaybotTraits;
  driver: PlaybotDriver | null;
  /** Asked to stand down; closed once it is out of whatever it was in. */
  retiring: boolean;
  /** When it was last sent somewhere, so a reply in flight is not re-sent. */
  dispatchedAt: number;
}

/**
 * A bot is ENGAGED when it is in a match or waiting for one.
 *
 * `idle` and `over` are both "has nothing to do": a driver sitting on a
 * finished match holds a room and plays nobody, and this is what makes the
 * controller see it as spare capacity and send it somewhere again. Without it
 * a bot plays exactly ONE match for the life of the process — and a human who
 * queues while every bot is mid-match waits forever, because the controller
 * counts them all active and activates nobody.
 */
const ENGAGED = new Set(['queued', 'lobby', 'serving', 'rally', 'waiting']);

/**
 * How long a dispatch is given to become a phase.
 *
 * `create_room` and `join_room` are round trips, so a driver reads `idle` for
 * the beat between asking and being answered — and a tick landing inside that
 * beat would ask again, seating the bot at two tables.
 */
const DISPATCH_GRACE_MS = 5_000;

/**
 * How long a bot may sit at a table nobody has joined before it counts as
 * spare again.
 *
 * A hosted table with nobody at it is a bot doing NOTHING, and reading it as
 * engagement is what turns a population into a deadlock: every bot whose
 * appetite says host opens a table, none of them is available to join
 * anybody's, and the roster sits in parallel empty lobbies playing no matches
 * at all. Measured — two bots that both chose `host` played nothing in two
 * minutes. It is also what makes a waiting HUMAN reachable: a bot parked in an
 * empty lobby becomes spare, and the next tick sends it to the queue where
 * they are.
 *
 * Long enough that a real arrival is not raced, short enough that a human's
 * wait is bounded by it.
 */
const IDLE_LOBBY_MS = 20_000;

/**
 * Spread over which that window is JITTERED, per bot, deterministically.
 *
 * Without it every bot dispatched on the same tick comes free on the same
 * tick: they all give up their tables at the same instant, all look for one to
 * join at the same instant, all find nothing (each other's are being torn down
 * in the same breath) and all host again — a synchronised deadlock that looks
 * exactly like the un-jittered one and survives every fix to the join path.
 * Measured: two bots churned leave/host every tick for two minutes and played
 * nothing. Staggered, the first to come free finds the second still parked and
 * walks up to it.
 */
const IDLE_LOBBY_JITTER_MS = 12_000;

/** A stable 0..1 from an id, so the stagger survives a restart. */
function jitterFraction(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
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

  /** The bots actually playing or waiting to — the controller's active set. */
  public activeBotIds(): string[] {
    return this.engagedIds(urgencyOf(this.live()));
  }

  private engagedIds(urgent: number): string[] {
    return this.managed.filter((m) => this.engaged(m, urgent)).map((m) => m.botId);
  }

  private engaged(m: Managed, urgent: number): boolean {
    if (!m.driver) return false;
    // A table nobody has joined is not a match — see IDLE_LOBBY_MS. And when a
    // HUMAN is unserved it is not engagement at ALL: §4.13's priority rule is
    // that more human demand than human supply activates bots, and a bot
    // parked at an empty table is precisely the supply. Without this clause
    // that rule is only nominally true — the human waits out the idle window
    // behind a bot that is doing nothing.
    if (m.driver.phase === 'lobby' && !m.driver.hasOpponent()) {
      if (urgent > 0) return false;
      const base = this.opts.idleLobbyMs ?? IDLE_LOBBY_MS;
      const spread = this.opts.idleLobbyJitterMs ?? IDLE_LOBBY_JITTER_MS;
      return Date.now() - m.dispatchedAt < base + jitterFraction(m.botId) * spread;
    }
    if (ENGAGED.has(m.driver.phase)) return true;
    // A dispatch still in flight counts, or the next tick sends it twice.
    return Date.now() - m.dispatchedAt < DISPATCH_GRACE_MS;
  }

  public snapshot(): PopulationSnapshot {
    return this.snapshotFrom(this.live());
  }

  private snapshotFrom(live: LiveState): PopulationSnapshot {
    return {
      humansOnline: live.humansOnline,
      queuedHumans: live.queuedHumans,
      longestWaitMs: live.longestWaitMs,
      openTables: live.openTables,
      activeBotIds: this.engagedIds(urgencyOf(live)),
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
        retiring: false,
        dispatchedAt: 0,
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
    // Reap first: a bot asked to stand down leaves at the whistle, and this is
    // where its socket is let go once it is out. Closing it at the request
    // instead would cut it off mid-rally, which the relay judges an abandon —
    // a real ranked loss for a bot that did nothing.
    const live = this.live();
    const urgent = urgencyOf(live);
    for (const m of this.managed) {
      if (m.retiring && m.driver && !this.engaged(m, urgent)) {
        m.driver.close();
        m.driver = null;
        m.retiring = false;
      }
    }

    const target = targetActivation(this.snapshotFrom(live), live.bandCentre ?? START_MU);

    for (const { id, action } of target.activate) {
      const m = this.managed.find((x) => x.botId === id);
      if (!m) continue;
      m.retiring = false;
      void this.dispatch(m, action);
    }
    for (const id of target.deactivate) {
      const m = this.managed.find((x) => x.botId === id);
      if (!m?.driver) continue;
      m.retiring = true;
      m.driver.standDown();
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
    const traits = (this.opts.traitsFor ?? seedTraits)(username);
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
      retiring: false,
      dispatchedAt: 0,
    });
  }

  /**
   * Send one bot where the controller said, connecting it first if it is not
   * already, and letting go of a finished match on the way.
   *
   * REUSES the driver when there is one. Building a second on the same account
   * would put two sockets on one device id, which the relay resolves by
   * evicting the first — mid-match, if that bot happened to be playing.
   */
  private async dispatch(m: Managed, action: PopulationAction): Promise<void> {
    if (this.engaged(m, urgencyOf(this.live()))) return;
    // Claim the slot BEFORE the await, or two ticks in flight dispatch the
    // same bot twice.
    m.dispatchedAt = Date.now();
    if (!m.driver) {
      const driver = new PlaybotDriver({
        base: this.opts.base,
        wsUrl: this.opts.wsUrl,
        username: m.username,
        traits: m.traits,
      });
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
    }
    // A room this bot is still sitting in has to be given up first — a
    // finished match, or a table nobody came to. The next pair cannot have
    // that seat until it stands up, and `queue_join` is refused outright for a
    // socket that already holds one.
    //
    // An EMPTY lobby is the one piece of evidence this bot has that its last
    // choice did not work out.
    const gaveUpEmptyTable = m.driver.phase === 'lobby' && !m.driver.hasOpponent();
    m.dispatchedAt = Date.now();
    // An INDEPENDENT roll, never the bias itself — see `rollFor`.
    const venue = chooseVenue({
      traits: m.traits,
      roll: (this.opts.rollFor ?? Math.random)(),
      allowed: OPEN_VENUES,
    });
    // JOIN means join. Mapping it to `host` looked harmless — a table somebody
    // can walk into is the same offer from the other side — and it is what
    // deadlocks the population: with nobody ever joining, every bot opens its
    // own table and the roster plays nothing.
    //
    // The same deadlock survives a `join` that works, because the appetites are
    // seeded and therefore FIXED: a roster whose bots all prefer hosting opens
    // parallel empty tables forever. Measured — two such bots played nothing in
    // two minutes. So a bot that has just given up a table nobody came to
    // looks for one to walk up to whatever its appetite said. That is not
    // overriding the preference (§2.11 makes diversity a preference and never a
    // prohibition); it is the preference having been tried and answered.
    const wantsTable = action !== 'queue' && (action === 'join' || gaveUpEmptyTable);
    const table = wantsTable ? await this.openTable(venue, m.botId) : null;
    if (table) {
      // Deliberately WITHOUT leaving first: `join_room` vacates whatever seat
      // this socket already holds, and only once the destination is certain —
      // so a table that has gone in the meantime costs nothing, where leaving
      // first would have cost the seat and left the bot with neither.
      m.driver.join(table);
      return;
    }
    // Hosting and queueing both need the old seat given up: `queue_join` is
    // refused outright for a socket holding one, and a bot that hosts while
    // seated leaves its previous table behind for the reaper.
    if (m.driver.phase === 'over' || m.driver.phase === 'lobby') m.driver.leave();
    if (action === 'queue') m.driver.queue();
    else m.driver.host({}, venue ?? undefined);
  }

  /** An open public table in this venue that somebody else is sitting at. */
  private async openTable(venue: string | null, selfId: string): Promise<string | null> {
    for (const room of venue ? [venue, ...OPEN_VENUES] : OPEN_VENUES) {
      try {
        const res = await fetch(`${this.opts.base}/api/rooms/${encodeURIComponent(room)}/tables`);
        if (!res.ok) continue;
        const body = (await res.json()) as {
          tables?: Array<{ id: string; isFull: boolean; hostId: string | null }>;
        };
        const free = (body.tables ?? []).find((t) => !t.isFull && t.hostId !== selfId);
        if (free) return free.id;
      } catch {
        // A listing that cannot be read is a listing with nothing in it.
      }
    }
    return null;
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

/** Humans the queue and the tables cannot serve by themselves, right now. */
const urgencyOf = (live: LiveState): number =>
  unmetHumanDemand(live) + impatientDemand(live);

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
