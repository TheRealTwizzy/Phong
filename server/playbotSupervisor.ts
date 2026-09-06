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
import { newRating } from '../src/rating';
import type { Tier } from '../src/rating';
import {
  impatientDemand,
  targetActivation,
  unmetHumanDemand,
  type PopulationAction,
  type PopulationBot,
  type PopulationSnapshot,
  OPEN_VENUES,
  servableVenues,
  venuesOpenTo,
} from './playbotPopulation';

/** Live server state the supervisor cannot see for itself. */
export interface LiveState {
  /** Connected humans. Bots are the supervisor's own and are excluded here. */
  humansOnline: number;
  /** Humans waiting in the ranked queue — never the bots sitting in it too. */
  queuedHumans: number;
  /**
   * Bots waiting in that same queue, which is supply ALREADY SPENT on the
   * humans in it.
   *
   * Counted because queue demand is `queuedHumans % 2` and stays 1 for as long
   * as that person is unpaired — so a bot dispatched to serve them is engaged,
   * lands in `kept`, and the very next tick adds the same demand slot again on
   * top of it. Every tick then activated one more bot for one already-covered
   * waiter, and since `findPair` may hold that bot as their fallback while
   * their own band is still tight, the human stays unpaired and the connected
   * population grows toward the roster limit — the fading bound defeated by a
   * queue that is already being served.
   */
  queuedBots: number;
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
  /** Overrides REMATCH_GRACE_MS, so a suite can drive both sides of it. */
  rematchGraceMs?: number;
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

/**
 * How long a bot holds a FINISHED court while the human decides.
 *
 * The whistle puts the driver in `over`, which is not an ENGAGED phase -- so
 * without this the next tick either redispatches that bot or reaps it, while
 * the human is still on the result overlay with Play Again under their thumb.
 * At the default 15s tick, on a phase that is random against the whistle, a
 * large share of rematches simply vanished: the socket closed, the relay
 * vacated the seat, and the vote the human then cast was one nobody was left
 * to answer. §2.11 says an explicit human Rematch is legitimate play that
 * nothing may block, and this is the way it was being blocked that wiring
 * `acceptsRematch` could never reach -- the population took the opponent
 * away rather than the bot declining.
 *
 * It does NOT bring back what the round-eleven reap fixed, which was a driver
 * held on a finished court forever: this window expires, and a bot whose
 * opponent has already gone (`opponent_left`, so `hasOpponent()` is false) is
 * never held at all. Unserved human demand still outranks it, exactly as it
 * outranks the idle-lobby window: somebody with no game at all is a stronger
 * claim than somebody deciding whether to play a second one.
 *
 * Un-jittered, deliberately, where IDLE_LOBBY_MS is not: that stagger exists
 * because bots coming free together all host together and deadlock, and a
 * finished court is released to a bot that is about to be sent somewhere by
 * the controller rather than to one choosing for itself.
 */
const REMATCH_GRACE_MS = 20_000;

/**
 * The same list, started at a per-bot offset.
 *
 * Concurrent dispatches to one venue were choosing the SAME table: the
 * preference below is keyed on pair history, and with none — which is the
 * ordinary case for a fresh population — every bot falls through to the same
 * tiebreak and picks the same entry. One join lands, the rest are refused as
 * full, and those hosts wait another tick; with several tables in a venue that
 * degrades to serving roughly one of them per tick while bots sit spare.
 *
 * A SPREAD and not an assignment, which is the honest description: two bots
 * can still rotate onto the same table, and the complete answer is for the
 * controller to name the table rather than the venue — which needs table
 * identity in `PopulationSnapshot`, and is recorded in CLAUDE.md §5 as
 * deferred rather than done. This costs nothing and removes the case where
 * they collide EVERY time.
 *
 * Deterministic per bot, like every other stagger here, so it survives a
 * restart and a test can state it.
 */
export function rotate<T>(xs: T[], fraction: number): T[] {
  if (xs.length < 2) return xs;
  const at = Math.min(xs.length - 1, Math.floor(fraction * xs.length));
  return [...xs.slice(at), ...xs.slice(0, at)];
}

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
  queuedBots: 0,
  longestWaitMs: 0,
  openTableVenues: [],
};

/** Node's own ceiling: past it `setInterval` fires every 1ms instead. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The two settings that arrive as an environment STRING, bounded here.
 *
 * `Number(process.env.X) || fallback` reads as a guard and is not one: it
 * catches junk and zero and passes everything else through. A fractional
 * roster size is the sharp one — `slice(0, 6.5)` loads six accounts while the
 * provisioning loop's `managed.length < 6.5` creates a seventh, so every
 * restart excludes that seventh, skips its held name, and mints another:
 * one username burned out of the pool permanently per deploy. `Infinity` is
 * the same bug with no bound at all. And a negative or sub-millisecond tick
 * reaches `setInterval`, which coerces it to 1ms — the supervisor loading the
 * roster and the live state a thousand times a second on the relay's event
 * loop, from one typo.
 *
 * Normalized HERE rather than at the call site, because the invariant belongs
 * to the two consumers: the `slice` and the provisioning bound are both in
 * this file, and a second caller constructing a supervisor by hand gets the
 * same answer for free.
 */
export function normalizeRosterSize(v: number | undefined): number {
  if (!Number.isFinite(v ?? NaN)) return 0;
  return Math.max(0, Math.floor(v!));
}

export function normalizeTickMs(v: number | undefined): number | undefined {
  if (!Number.isFinite(v ?? NaN)) return undefined;
  const ms = Math.floor(v!);
  return ms >= 1 && ms <= MAX_TIMER_MS ? ms : undefined;
}

export class PlaybotSupervisor {
  private readonly opts: PlaybotSupervisorOptions;
  private readonly store: PlaybotAccountStore;
  private readonly live: () => LiveState;
  private managed: Managed[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(opts: PlaybotSupervisorOptions) {
    this.opts = {
      ...opts,
      rosterSize: normalizeRosterSize(opts.rosterSize),
      tickMs: normalizeTickMs(opts.tickMs),
    };
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

  /**
   * A court that has finished with somebody still sitting at it, inside the
   * window their Play Again is answered in. See REMATCH_GRACE_MS.
   *
   * Asked in two places and they must not drift: `engaged` KEEPS such a bot,
   * and the deactivation loop must not send it a `standDown` — which, on a
   * phase of `over`, leaves the table on the spot. Holding it in `engaged`
   * alone would therefore have handed the same loss back through the other
   * door: the controller ranks the bot outside `kept` as the target fades, it
   * is named for deactivation precisely BECAUSE it is now counted as active,
   * and the human loses the opponent inside the grace that exists for them.
   */
  private inRematchGrace(m: Managed): boolean {
    if (!m.driver || m.driver.phase !== 'over' || !m.driver.hasOpponent()) return false;
    return Date.now() - m.driver.finishedAt < (this.opts.rematchGraceMs ?? REMATCH_GRACE_MS);
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
    // A finished court is not a match, and it is not nothing either — see
    // REMATCH_GRACE_MS. Somebody is still sitting at it, and their Play Again
    // is theirs to press.
    if (this.inRematchGrace(m)) {
      if (urgent > 0) return false;
      return true;
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
      queuedBots: live.queuedBots,
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

    // No `?? START_MU`. An absent centre means nobody is waiting anywhere the
    // controller can see, which is an answer — see `rankForActivation`. The
    // substitution made the idle server a homeostat around mu 25 and was the
    // dominant reason the population never grew a top.
    const target = targetActivation(this.snapshotFrom(live), live.bandCentre);

    for (const { id, action, venue } of target.activate) {
      const m = this.managed.find((x) => x.botId === id);
      if (!m) continue;
      void this.dispatch(m, action, venue);
    }
    for (const id of target.deactivate) {
      const m = this.managed.find((x) => x.botId === id);
      if (!m?.driver) continue;
      m.retiring = true;
      // `standDown` LEAVES on a phase of `over`, so a bot inside its rematch
      // window is asked later rather than now: the request stands (`retiring`
      // is set, and the derived pass below leaves it alone), and the window
      // ends on its own — after which this driver is no longer engaged and the
      // reap closes it. Unserved demand still takes it away at once, because
      // `engaged` returns false under urgency, so such a bot is not in the
      // active set the controller names from at all.
      if (this.inRematchGrace(m)) continue;
      m.driver.standDown();
    }

    // A stand-down is DERIVED from the controller's answer, never latched.
    //
    // The flag and the driver's own latch used to be cleared in the activate
    // loop, which reads as covering every way a stand-down is reversed and
    // covers one of them: `targetActivation` returns `activate` and
    // `deactivate` and nothing else, and `activate` is built from the bots
    // that are NOT active. So a bot asked to stand down during an occupied
    // lobby or a rally, and wanted again before the whistle, is named by
    // NEITHER array -- it is simply KEPT, and nothing ever told it the
    // decision had been reversed. It went on giving up a table the controller
    // had just decided to keep, and refusing the human's rematch, which §2.11
    // says nothing may do.
    //
    // Below both loops, so what stands afterwards is exactly what the
    // controller just said. A bot dispatched this tick is covered too: a
    // driver it REUSES (`dispatchInner` keeps a connected one) is the same
    // object that may be carrying the latch, and a rebuilt one starts clear.
    const askedToStandDown = new Set(target.deactivate);
    for (const m of this.managed) {
      if (askedToStandDown.has(m.botId)) continue;
      m.retiring = false;
      m.driver?.backInService();
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
        // `newRating().mu` rather than START_MU, and the distinction is the
        // point: this is what a bot with no stored row HAS, not a number the
        // controller is aiming at. Naming the constant here is what let the
        // idle fallback above look like an ordinary default.
        mu: row?.mu ?? newRating().mu,
        recentMatches: row?.recentMatches ?? 0,
        // When this bot was last SENT, not when it last finished. With nobody
        // waiting the controller has no rating to rank on, so this is what
        // stops a bot whose connect keeps failing holding the front of the
        // queue forever: it never records a match, so `recentMatches` never
        // moves, and the dispatch is the only thing that does.
        lastDispatchedAt: m.dispatchedAt,
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
  private async dispatch(m: Managed, action: PopulationAction, assigned?: string): Promise<void> {
    // One at a time per bot, for the whole of it — see `Managed.dispatching`.
    // `tickSafely`'s guard cannot do this: `tick()` is synchronous and fires
    // its dispatches with `void`, so `ticking` is false again while every one
    // of them is still in flight, and its own comment described a guarantee it
    // was not providing.
    if (m.dispatching) return;
    if (this.engaged(m, urgencyOf(this.live()))) return;
    m.dispatching = true;
    try {
      await this.dispatchInner(m, action, assigned);
    } catch (e) {
      // A dispatch that throws must not end every live duel on the server.
      //
      // `tick()` is synchronous and fires these with `void`, so a rejection
      // here has no handler at all and reaches `process.on('unhandledRejection')`,
      // which `server.ts` answers with `onFatal` — a controlled shutdown of the
      // whole process. `tickSafely` cannot cover it (its guard is the tick's own
      // body, and its comment says so), and the reachable throw is not exotic:
      // `openTable` reads `pairingView`, which is a SQLite read, so a full disk
      // or a volume remounted read-only turns one bot's opponent ranking into an
      // outage.
      //
      // Caught at the same granularity `provision` already uses — one bot short
      // is a smaller population, not a failed boot — and deliberately not around
      // `tick()`, because §5's lesson is that a handler which swallows faults with
      // no owner is worse than the crash. This one has an owner and a right
      // answer: skip this dispatch, and let the next tick try again.
      console.warn(`[playbot] could not dispatch ${m.username}:`, (e as Error)?.message ?? e);
    } finally {
      m.dispatching = false;
    }
  }

  private async dispatchInner(
    m: Managed,
    action: PopulationAction,
    /**
     * The venue this JOIN was matched to, when the controller matched it to a
     * specific waiting table. A preference the search may widen past, never a
     * refusal — see `openTable`.
     */
    assigned?: string
  ): Promise<void> {
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
    // TWO independent draws, and neither is the bias itself — see `rollFor`.
    // `roll` decides ranked-or-Casual and `pick` decides which room; sharing
    // one number puts the tail of the ranked pool out of reach, which is the
    // bias-as-its-own-roll defect wearing a different coat.
    const draw = this.opts.rollFor ?? Math.random;
    const venue = chooseVenue({
      traits: m.traits,
      roll: draw(),
      pick: draw(),
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
    const table = wantsTable ? await this.openTable(m, venue, allowed, assigned) : null;
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
    return venuesOpenTo({ level: m.level, tier: m.tier });
  }

  /**
   * The rooms this ROSTER can reach right now — what `server.ts` narrows the
   * demand count to.
   *
   * Reads only the in-memory `level`/`tier` that `roster()` refreshes on every
   * tick, so it costs no store read and is exactly as fresh as the roster the
   * controller ranks. No recursion either: `roster()` never asks for the live
   * state.
   *
   * Public because the alternative is `server.ts` holding its own copy of the
   * rule, and a rule spelled twice is the thing this feature keeps being bitten
   * by. Demand and the search have to be one predicate.
   */
  public servableVenues(): string[] {
    return servableVenues(this.managed.map((m) => ({ level: m.level, tier: m.tier })));
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
  private async openTable(
    m: Managed,
    venue: string | null,
    allowed: string[],
    /**
     * The venue the CONTROLLER matched this join to, when it matched it to a
     * specific waiting table.
     *
     * Searched alone first, and this is the only place a venue narrows the
     * gather rather than merely ordering it. Round five's finding was the
     * opposite mistake — returning inside the first venue that held any free
     * table, so a bot table in Casual was taken while a human waited in
     * Beginner — so the ordinary bias-chosen `venue` still gathers everything
     * and chooses globally. An assignment is different in kind: it names the
     * human this activation exists for, and dropping it is what let two bots
     * matched to two different venues both walk up to the same table, one join
     * refused as full and the other host unserved.
     *
     * It widens rather than refuses, because the table may have filled between
     * the tick and the dispatch, and a bot that finds nothing does nothing.
     */
    assigned?: string
  ): Promise<string | null> {
    if (assigned) {
      const first = this.pickTable(await this.freeTables([assigned], m), m);
      if (first) return first;
    }
    return this.pickTable(
      await this.freeTables([...new Set(venue ? [venue, ...allowed] : allowed)], m),
      m
    );
  }

  /** Every joinable table in these rooms, as the listing reports them. */
  private async freeTables(rooms: string[], m: Managed): Promise<FreeTable[]> {
    const selfId = m.botId;
    /** The table this bot is already sitting at, if any — never a candidate. */
    const ownRoomId = m.driver?.roomId ?? null;
    const free: FreeTable[] = [];
    // Deduped by the caller: `venue` is drawn FROM `allowed`, so a plain
    // concatenation asked the same room for its tables twice and pushed every
    // table in it into `free` twice — a wasted round trip per dispatch, and a
    // list that does not describe what is out there.
    for (const room of rooms) {
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
    return free;
  }

  /** Which of them to walk up to. */
  private pickTable(free: FreeTable[], m: Managed): string | null {
    const selfId = m.botId;
    // A human's table comes first wherever it was found — §4.13's priority
    // rule, and it decides BEFORE the preference below rather than competing
    // with it, since a bot that would rather play another bot must not act on
    // that while somebody is waiting.
    // Rotated BEFORE the partition, never after it: `humanTablesFirst` is a
    // stable partition, so rotating its input rotates within each half and the
    // §4.13 priority survives — rotating its output would move a bot's table
    // in front of a waiting human's, which is the rule it exists to hold.
    const pool = humanTablesFirst(
      rotate(free, jitterFraction(selfId)),
      new Set(this.managed.map((x) => x.botId))
    );
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

/**
 * Whose band the controller should be ranking bots against, right now.
 *
 * `targetActivation` orders the roster by distance from this, so it decides
 * WHICH bot is spent on the human being served. It was never supplied at all
 * once (round thirteen), and the repair reached only half the demand: it read
 * the queue, so a human sitting ALONE at a public table produced no centre,
 * the fallback was START_MU, and the bot nearest mu 25 was activated for a
 * player who might be a Legend or a beginner. `openTable` cannot rescue that —
 * it ranks TABLES for a bot already chosen, and cannot swap in a better-rated
 * dormant one — so the mismatch stands with suitable roster capacity idle.
 *
 * The QUEUE wins where both exist: a queued player's own band is widening on a
 * timer (`server/matchmaking.ts`), so they are the one whose wait has a cost
 * attached, and a table host can still be joined by anybody. Within each, the
 * longest wait wins, which is the same rule `findPair` judges a pairing on.
 *
 * Bots are excluded from both, for the reason `liveStateFrom` counts humans:
 * the population sits in that queue and at those tables itself, so ranking the
 * roster against one of its own members is a population steering by its own
 * appetite. Pure over an injected `ratingOf` so the rule is a fast test rather
 * than something only a live server can show — and read through
 * `db.matchmakingRating` at the call site for the reason §7 gives: the HIDDEN
 * estimator, because that is the pair `queueCandidate` itself pairs on, and
 * two floats rather than a whole profile and a ladder scan.
 */
export function bandCentreFor(a: {
  queue: Array<{ playerId: string; joinedAt: number }>;
  /** One entry per public table with a lone occupant, and when it began waiting. */
  tables: Array<{ playerId: string; waitingSince: number }>;
  isBot: (id: string) => boolean;
  ratingOf: (id: string) => number | null;
}): number | undefined {
  const queued = a.queue
    .filter((e) => !a.isBot(e.playerId))
    .sort((x, y) => x.joinedAt - y.joinedAt)[0];
  const waiting =
    queued ??
    a.tables
      .filter((t) => !a.isBot(t.playerId))
      .sort((x, y) => x.waitingSince - y.waitingSince)[0];
  if (!waiting) return undefined;
  return a.ratingOf(waiting.playerId) ?? undefined;
}

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
    queuedBots: a.queue.length - humanQueue.length,
    longestWaitMs,
    openTableVenues: a.openTableVenues,
    bandCentre: a.bandCentre,
  };
}
