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
import { chooseOpponent, chooseVenue, type PolicyCandidate } from './playbotPolicy';
import { roomById, roomEntryVerdict } from '../src/venues';
import type { Tier } from '../src/rating';
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
  /**
   * Public tables sitting with a free playing seat, one entry per table,
   * naming the venue — see `PopulationSnapshot.openTableVenues`.
   */
  openTableVenues: string[];
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
    /** What the bracket gate judges — see `venuesFor`. */
    level: number;
    tier: Tier;
  }>;
  /** Marker row, credential and traits, written once at creation. */
  save(botId: string, deviceCookie: string, traits: PlaybotTraits): void;
  /**
   * What §2.11's diversity preference needs about people this bot could sit
   * down with: the three things a table listing cannot carry.
   *
   * `self` comes back from the SAME call, deliberately, so both sides are read
   * on one estimator. This feeds `winProbability`, and §7's rule is that each
   * estimator rates against its own counterpart — a self read on the visible
   * ladder against candidates read on the hidden one is a comparison across
   * two scales that diverge by design. One call makes that unrepresentable.
   */
  pairingView(selfId: string, ids: string[]): PairingView;
}

/** One question — who could this bot play — answered on one estimator. */
export interface PairingView {
  /** This bot, on the same estimator the candidates below are read on. */
  self: { mu: number; sigma: number };
  candidates: PolicyCandidate[];
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

/**
 * How many name collisions provisioning will walk past before giving up.
 *
 * Bounded rather than unlimited: a server where every candidate name is held
 * should log a few warnings and carry on with a smaller population, which is
 * what `provision` already treats a collision as.
 */
const NAME_ATTEMPT_SLACK = 8;

/** A bot the supervisor holds an account for, connected or not. */
interface Managed {
  botId: string;
  username: string;
  deviceCookie: string;
  traits: PlaybotTraits;
  driver: PlaybotDriver | null;
  /** Asked to stand down; closed once it is out of whatever it was in. */
  retiring: boolean;
  /**
   * A dispatch that has not finished, so a later tick cannot start a second.
   *
   * `dispatchedAt` plus DISPATCH_GRACE_MS was the only thing standing here and
   * it is a GUESS: a `resume`/`connect` slower than the grace lets the next
   * tick dispatch the same bot, and that second dispatch can close and replace
   * `m.driver` while the first is still awaiting — after which the first
   * continuation drives the REPLACEMENT, marking an unconnected driver queued
   * and leaving its own live socket managed by nobody. A boolean is exact
   * where a timeout is a bet on how slow loopback can be.
   */
  dispatching: boolean;
  /** The bot's own bracket standing, refreshed whenever the roster is loaded. */
  level: number;
  tier: Tier;
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
  openTableVenues: [],
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

  /**
   * The bots still HOLDING a driver, engaged or not.
   *
   * Deliberately a different question from `activeBotIds`, and the gap between
   * the two is the whole of the reap: a driver on a finished court or in a
   * stale empty lobby is not engaged, so it is absent from the active set
   * while its socket, its seat and its 16ms timer are all still there.
   */
  public connectedBotIds(): string[] {
    return this.managed.filter((m) => m.driver).map((m) => m.botId);
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
      openTableVenues: live.openTableVenues,
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
    // The configured size bounds what is LOADED, not just what is created.
    // `targetActiveCount` clamps against `snapshot.roster.length`, so without
    // this a deployment turned down from 60 to 1 goes on activating the old
    // 60 under demand and the operational bound stops being one. The extra
    // accounts are dormant rows -- two columns, no socket, no timer -- and
    // come back if the size is raised again.
    for (const row of this.store.load().slice(0, this.opts.rosterSize)) {
      this.managed.push({
        botId: row.botId,
        username: row.username,
        deviceCookie: row.deviceCookie,
        traits: row.traits,
        driver: null,
        retiring: false,
        dispatching: false,
        dispatchedAt: 0,
        level: row.level,
        tier: row.tier,
      });
    }
    // A name index that advances INDEPENDENTLY of how many accounts exist.
    // Starting it at `managed.length` leaves a permanent collision permanently
    // short: with a size of 2 and `Rally01Bot` already held by a human, index 0
    // fails and index 1 makes `Rally02Bot` -- and every later boot loads one
    // account, starts the loop at 1, and retries the name that account already
    // holds. It never reaches `Rally03Bot`, so the roster is one short for the
    // life of the deployment.
    //
    // Names already held are skipped rather than retried, and the attempt
    // budget is bounded so a server where every candidate is taken logs a
    // handful of warnings instead of spinning.
    const held = new Set(this.managed.map((m) => m.username));
    const naming = this.opts.nameFor ?? defaultName;
    let attempts = 0;
    for (
      let n = 0;
      this.managed.length < this.opts.rosterSize && attempts < this.opts.rosterSize + NAME_ATTEMPT_SLACK;
      n += 1
    ) {
      if (held.has(naming(n))) continue;
      attempts += 1;
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
    const urgent = urgencyOf(live);

    const target = targetActivation(this.snapshotFrom(live), live.bandCentre ?? START_MU);

    for (const { id, action } of target.activate) {
      const m = this.managed.find((x) => x.botId === id);
      if (!m) continue;
      m.retiring = false;
      // The DRIVER's own latch too, not just the controller's flag. A bot told
      // to stand down and then wanted again went on leaving at every whistle
      // and refusing every rematch, because nothing ever told it the decision
      // had been reversed.
      m.driver?.backInService();
      void this.dispatch(m, action);
    }
    for (const id of target.deactivate) {
      const m = this.managed.find((x) => x.botId === id);
      if (!m?.driver) continue;
      m.retiring = true;
      m.driver.standDown();
    }

    // Reap LAST, and on the DRIVER rather than on the request.
    //
    // It used to run first and open with `m.retiring &&`, which made it
    // unreachable for the two states a bot actually ends a job in. `deactivate`
    // is `activeBotIds.filter(not kept)` and `activeBotIds` IS the engaged set,
    // so a driver on a finished court or in a stale empty lobby is absent from
    // the set the controller can name — never named, never `retiring`, never
    // reaped, and holding its socket, its seat and its 16ms timer while the
    // controller ranked other dormant accounts above it.
    //
    // Running it AFTER the two loops is what makes that safe: a bot dispatched
    // on this very tick is protected twice over — `dispatch` sets `dispatching`
    // synchronously before its first await, and `dispatchInner` sets
    // `dispatchedAt` the same way, so the grace answers too. Reaping first
    // would instead close a socket that is about to be reused, and one still
    // holding a seat the driver gives up properly with `leave`.
    //
    // Still never mid-rally: `engaged` covers every playing phase, so a bot
    // asked to stand down is let go at the whistle exactly as before — which
    // is the abandon this loop has always been careful of.
    for (const m of this.managed) {
      if (m.driver && !m.dispatching && !this.engaged(m, urgent)) {
        m.driver.close();
        m.driver = null;
        m.retiring = false;
      }
    }
  }

  private async tickSafely(): Promise<void> {
    // Re-entrant guard for the TICK's own body. It does not extend to the
    // dispatches it fires — `tick()` is synchronous and launches them with
    // `void` — so a bot already being dispatched is held by `Managed.dispatching`
    // instead, which is per-bot and covers the whole await.
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
      // The bracket state is REFRESHED here, and the note that used to sit at
      // the provision site -- "the next roster load reads the real values" --
      // was simply wrong: there is a load, every tick, and it took `mu` and
      // `recentMatches` off the fresh row while discarding `level` and `tier`.
      // So `venuesFor` judged every bot by whatever it was at startup, and a
      // bot provisioned in this process stayed level 1 and unranked for good:
      // one that CLIMBED past Contender went on being sent at `beginner`, was
      // refused, and left its human unserved until a restart. That is the
      // fifth round's own finding surviving inside its own fix.
      if (row) {
        m.level = row.level;
        m.tier = row.tier;
      }
      return {
        id: m.botId,
        traits: m.traits,
        // EARNED, read and never written: a bot suits a thin band or it does
        // not, and if none does the answer is more bots at creation rather
        // than a different rating on this one (§4.13).
        mu: row?.mu ?? START_MU,
        recentMatches: row?.recentMatches ?? 0,
        // The same `allowed` list `chooseVenue` is handed, and for the same
        // reason: an activation aimed at a table the relay would refuse this
        // bot is an activation that serves nobody, and nothing about the bot
        // changes when it is turned away, so the next tick picks it again.
        venues: this.venuesFor(m),
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
      dispatching: false,
      dispatchedAt: 0,
      // A brand new account: level 1 and unplaced, which is what the bracket
      // gate judges it as, and correct until its own matches move it. The
      // per-tick roster read refreshes both from the store afterwards -- see
      // `roster`, where discarding them was a bug in its own right.
      level: 1,
      tier: 'unranked',
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
    // One at a time per bot, for the whole of it — see `Managed.dispatching`.
    // `tickSafely`'s guard cannot do this: `tick()` is synchronous and fires
    // its dispatches with `void`, so `ticking` is false again while every one
    // of them is still in flight, and its own comment described a guarantee it
    // was not providing.
    if (m.dispatching) return;
    if (this.engaged(m, urgencyOf(this.live()))) return;
    m.dispatching = true;
    try {
      await this.dispatchInner(m, action);
    } finally {
      m.dispatching = false;
    }
  }

  private async dispatchInner(m: Managed, action: PopulationAction): Promise<void> {
    // Claim the slot BEFORE the await, or two ticks in flight dispatch the
    // same bot twice.
    m.dispatchedAt = Date.now();
    // A driver whose socket has died is not a driver. Rebuilt rather than
    // reused, because `resume`/`connect` set up the message pump and the tick
    // together and every `send` on the dead one goes nowhere.
    if (m.driver && !m.driver.isConnected()) {
      m.driver.close();
      m.driver = null;
    }
    if (!m.driver) {
      const driver = new PlaybotDriver({
        base: this.opts.base,
        wsUrl: this.opts.wsUrl,
        username: m.username,
        traits: m.traits,
        // The driver is a client and has no reach of its own; the two facts
        // §2.11's rematch rule turns on live here. Read at the moment it is
        // asked rather than cached at the join, because `recentPairCount`
        // rises with the match that has just been played.
        opponentFacts: (oppId) => {
          const c = this.store.pairingView(m.botId, [oppId]).candidates[0];
          return c ? { isBot: c.isBot, recentPairCount: c.recentPairCount } : null;
        },
        rollFor: this.opts.rollFor,
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
    // Only venues this bot may actually ENTER. `chooseVenue`'s own doc says
    // `allowed` is the set the bracket gate permits, supplied by the caller,
    // and the caller handed it the raw list — so a bot that had climbed past
    // Contender was sent at `beginner`, which carries a tierMax, and refused.
    // A refused HOST fell back; a refused JOIN had nowhere to fall back to and
    // simply retried the same forbidden table on every tick, while the human
    // it was dispatched to serve went on waiting.
    const allowed = this.venuesFor(m);
    // An INDEPENDENT roll, never the bias itself — see `rollFor`.
    const venue = chooseVenue({
      traits: m.traits,
      roll: (this.opts.rollFor ?? Math.random)(),
      allowed,
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
    const table = wantsTable ? await this.openTable(m, venue, allowed) : null;
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

  /**
   * The venues this bot may enter, judged by the same predicate the relay asks.
   *
   * Never empty in practice — `casual` gates nobody — but the empty case is
   * handled rather than assumed, since `chooseVenue` answers null for it and
   * `host` then creates a table with no venue at all, which is the ungated
   * `_default` room.
   */
  private venuesFor(m: Managed): string[] {
    const who = { level: m.level, tier: m.tier };
    return OPEN_VENUES.filter((id) => roomEntryVerdict(roomById(id), who).ok);
  }

  /**
   * An open public table somebody else is sitting at, preferring a HUMAN's.
   *
   * Gathered across every venue BEFORE choosing, which is the half a first
   * version got wrong: returning inside the first venue that had any free
   * table meant a bot table in `casual` was taken while a human sat waiting in
   * `beginner` — the human preference applied within a venue and not across
   * them, so the activation that existed to serve that person served a bot.
   */
  private async openTable(m: Managed, venue: string | null, allowed: string[]): Promise<string | null> {
    const selfId = m.botId;
    /** The table this bot is already sitting at, if any — never a candidate. */
    const ownRoomId = m.driver?.roomId ?? null;
    const free: FreeTable[] = [];
    // Deduped: `venue` is drawn FROM `allowed`, so the plain concatenation
    // asked the same room for its tables twice and pushed every table in it
    // into `free` twice — a wasted round trip per dispatch, and a list that
    // does not describe what is out there.
    for (const room of new Set(venue ? [venue, ...allowed] : allowed)) {
      try {
        const res = await fetch(`${this.opts.base}/api/rooms/${encodeURIComponent(room)}/tables`);
        if (!res.ok) continue;
        const body = (await res.json()) as {
          tables?: Array<{ id: string; isFull: boolean; seatedIds?: string[] }>;
        };
        for (const t of body.tables ?? []) {
          const seatedIds = t.seatedIds ?? [];
          // By ROOM ID and by SEAT, never by host. A bot in seat 1 whose host
          // has left holds a table that is still listed with `hostId: null` --
          // which is not `selfId`, so a host comparison kept it and the bot
          // could pick its OWN room as the fallback. `join_room` answers
          // ALREADY_AT_TABLE for the room a socket already sits in, the driver
          // does not transition on it, and the same room is chosen again on
          // every tick: a bot that has stopped playing anybody and cannot
          // recover without a restart.
          if (t.isFull || t.id === ownRoomId || seatedIds.includes(selfId)) continue;
          free.push({ id: t.id, seatedIds });
        }
      } catch {
        // A listing that cannot be read is a listing with nothing in it.
      }
    }
    // A human's table comes first wherever it was found — §4.13's priority
    // rule, and it decides BEFORE the preference below rather than competing
    // with it, since a bot that would rather play another bot must not act on
    // that while somebody is waiting.
    const pool = humanTablesFirst(free, new Set(this.managed.map((x) => x.botId)));
    if (!pool.length) return null;

    // And among those, §2.11: where comparably suitable opponents are
    // available, prefer the less recently played one. `chooseOpponent` had no
    // caller in the shipped server at all, so the preference existed, was
    // tested, and did nothing — the same bots repeated the same pairings while
    // fresher comparable ones sat free, spending the same-pair rating
    // allowance on matches that then counted for nothing.
    //
    // Keyed by OCCUPANT, because the policy chooses an opponent and the table
    // is only where they are sitting. First occupant wins for a table with
    // more than one, which today is only a claimable CPU chair beside a
    // person.
    const tableOf = new Map<string, string>();
    for (const t of pool) {
      for (const id of t.seatedIds) if (!tableOf.has(id)) tableOf.set(id, t.id);
    }
    if (!tableOf.size) return pool[0].id;
    const view = this.store.pairingView(selfId, [...tableOf.keys()]);
    const pick = chooseOpponent({
      self: { id: selfId, mu: view.self.mu, sigma: view.self.sigma, traits: m.traits },
      candidates: view.candidates,
      now: Date.now(),
    });
    // Never a refusal: `chooseOpponent` answers null only for an empty list,
    // and a candidate the store could not describe still has a table.
    return (pick && tableOf.get(pick.id)) ?? pool[0].id;
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
export const OPEN_VENUES = ['casual', 'beginner'];

/** A table with a playing seat going spare, as the listing describes it. */
export interface FreeTable {
  id: string;
  /** Everybody holding a playing seat there, in seat order. */
  seatedIds: string[];
}

/**
 * The tables worth choosing between: a HUMAN's, wherever they were found, and
 * otherwise all of them.
 *
 * A PARTITION rather than a pick, because two different rules decide those two
 * questions and only one of them is negotiable. Serving a waiting person comes
 * first (§4.13) and is never traded away; which of several comparable tables
 * to walk up to is §2.11's preference, and it decides inside whichever
 * partition this returns.
 *
 * Takes the WHOLE gathered list rather than one venue's, which is the shape
 * the bug had: returning inside the first venue that held any free table meant
 * a bot table in `casual` was taken while a human sat waiting in `beginner` —
 * the preference applied within a venue and not across them, so the activation
 * that existed to serve that person served a bot instead.
 *
 * Judged over EVERY seat rather than over the host, which is the second shape
 * of the same failure: a table outlives its host, so seat 0 empties, seat 1
 * stays, and the listing then names a live table with a null host. Read as
 * "hosted by a human" that person was invisible, and a bot activated to serve
 * them walked past them to another bot's table.
 *
 * "One of MY OWN bots" rather than `isBotAccount`: the curated roster never
 * hosts a table and the population is single-process by design, so `managed`
 * is the complete set of bot-held tables and this needs no new dependency.
 */
export function humanTablesFirst(
  free: ReadonlyArray<FreeTable>,
  botIds: ReadonlySet<string>
): FreeTable[] {
  const human = free.filter((t) => t.seatedIds.some((id) => !botIds.has(id)));
  return human.length ? human : [...free];
}

/**
 * The nth name the population asks for.
 *
 * Exported so a test can take one out of the pool before the population boots
 * and watch it walk past — the collision that used to leave the roster short
 * for the life of the deployment.
 */
export const defaultPlaybotName = (n: number): string =>
  `Rally${String(n + 1).padStart(2, '0')}Bot`;
const defaultName = defaultPlaybotName;

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
  /** Public tables with a free playing seat, one entry per table, by venue. */
  openTableVenues: string[];
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
    openTableVenues: a.openTableVenues,
    bandCentre: a.bandCentre,
  };
}
