import { MatchEndPayload, MatchEndResult } from '../types';
import { openSession, refreshForBuild } from './session';

// Recording a finished match used to be fire-and-forget: the response status
// was never checked, so a 403, a 500, or a dropped connection left the player
// on a normal victory screen with the match silently gone. A result you earned
// and cannot see is worse than an error, so failures are now retried, then
// parked on the device and replayed on the next load.

const QUEUE_KEY = 'phong_pending_matches';
const MAX_QUEUED = 20;
const RETRY_DELAY_MS = 900;

type Queued = { payload: MatchEndPayload; queuedAt: number };

function readQueue(): Queued[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(items: Queued[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-MAX_QUEUED)));
  } catch {
    /* storage full or unavailable — nothing useful to do */
  }
}

// Bumped only by clearPendingMatches, when this browser's identity changes
// out from under whatever is currently queued (startFreshIdentity in App.tsx,
// which swaps the device cookie via /api/session/reset). postMatchRecord and
// runFlush each capture the generation in force when THEY started, and check
// it again at two distinct points, because a stale generation invalidates two
// different things:
//
//   - Before every WRITE that re-queues a payload after a failure. A write
//     already in flight when the identity changes (a slow fetch, a retry's
//     own delay) can still resolve afterward and call writeQueue with the OLD
//     identity's payload, resurrecting it into a queue that now belongs to the
//     fresh one — clearPendingMatches only ever touched the CURRENT value, not
//     writes still on their way.
//
//   - Before every network ATTEMPT. This is the sharper one, and refusing only
//     the write is not enough: both loops sleep (postMatchRecord's 900ms retry
//     delay, an openSession round trip) or iterate over further items, and the
//     attempt that follows carries whatever device cookie the browser holds by
//     then. /api/match/record discards the payload's own playerId and stamps
//     `req.deviceId` — so an attempt issued after the reset reports the OLD
//     account's match under the NEW identity, which is the whole failure this
//     file's `evicted` rule exists to prevent, reached from the other side.
//
// It stays narrower than cancelling an in-flight request: one already on the
// wire is left to succeed or fail on its own, since it went out under the old
// cookie and correctly records onto the old account if it still can. What is
// refused is starting a NEW attempt, or re-queueing, once the identity is gone.
let generation = 0;

function currentGeneration(): number {
  return generation;
}

/** Has this browser's identity moved on since `gen` was captured? */
function identityMovedOn(gen: number): boolean {
  return gen !== generation;
}

/** As writeQueue, but a no-op if the identity has moved on since `gen` was captured. */
function writeQueueFor(gen: number, items: Queued[]): void {
  if (identityMovedOn(gen)) return;
  writeQueue(items);
}

/** One attempt. Throws with a classification the caller can act on. */
async function attempt(payload: MatchEndPayload): Promise<MatchEndResult | null> {
  const res = await fetch('/api/match/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `clientNow` is read HERE rather than in the payload, so it is this
    // attempt's clock and not the whistle's. The server never uses either
    // absolute value: it takes the DIFFERENCE, which says how long ago the
    // match ended and cancels whatever offset this device's clock carries.
    // Every path lands here — first try, retry, and a replay off the queue
    // days later — so each says how stale it really is.
    body: JSON.stringify({ ...payload, clientNow: Date.now() }),
  });
  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* no body to read */
    }
    const code = body?.error || '';
    // The server does not recognise this device. That is not the player's
    // fault and not a hiccup: the device cookie is signed with a secret held
    // in the database, so a reset or a deploy that loses the data volume
    // rotates it and every existing cookie stops verifying. The middleware
    // then quietly mints a NEW device id, whose profile has no username — so
    // every match 403s while the UI still shows the old cached profile. The
    // caller has to re-sync and re-onboard; the match is kept meanwhile.
    if (res.status === 403 && code === 'PROFILE_NOT_INITIALIZED') {
      throw Object.assign(new Error(code), { unidentified: true });
    }
    // This device no longer holds the account: it handed it to another device,
    // or a newer load elsewhere took it over. The match is NOT queued — the
    // profile it was played under is not ours any more, and replaying it later
    // would credit whatever fresh identity this browser ends up with for a
    // match somebody else's account played.
    if (code === 'DEVICE_RELEASED' || code === 'SESSION_SUPERSEDED') {
      throw Object.assign(new Error(code), { evicted: true });
    }
    // This bundle is older than the deployment being served. Minting a fresh
    // session here would let it keep running indefinitely on the old code —
    // the retry would succeed, the next heartbeat would say `active`, and the
    // one guarantee this whole mechanism exists to make ("an update always
    // force-refreshes the field") would quietly not hold. The reload is the
    // point, so it is what happens.
    if (code === 'SESSION_STALE_BUILD') {
      throw Object.assign(new Error(code), { staleBuild: true, build: body?.build });
    }
    // No live session at all — first contact, or one we ended ourselves.
    // That IS recoverable in place: mint a new one and try again.
    if (code === 'SESSION_REQUIRED') {
      throw Object.assign(new Error(code), { needsSession: true });
    }
    // Any other 4xx is a verdict, not a hiccup: replaying it fails identically.
    const permanent = res.status >= 400 && res.status < 500;
    throw Object.assign(new Error(`record failed: ${res.status}`), { permanent });
  }
  return (await res.json()) as MatchEndResult;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deliberately a flat interface rather than a discriminated union: this repo
 * compiles with strictNullChecks off, under which TypeScript cannot narrow a
 * union by its tag, so `outcome.reason` would not type-check after `if
 * (!outcome.ok)`.
 */
export interface RecordOutcome {
  ok: boolean;
  /** Present when ok. */
  result?: MatchEndResult;
  /**
   * Why it did not land:
   *  - 'queued'       parked on the device; it will be replayed
   *  - 'unidentified' the server doesn't know this device; re-onboard needed
   *  - 'evicted'      the account moved on; this match belongs to nobody here
   *  - 'stale_build'  a newer deployment is live; queued, and the page reloads
   *  - 'rejected'     refused outright; replaying would fail identically
   */
  reason?: 'queued' | 'unidentified' | 'evicted' | 'stale_build' | 'rejected';
}

/**
 * Record a finished match. Retries once on a transient failure, and queues the
 * payload for replay if it still doesn't land.
 */
export async function postMatchRecord(payload: MatchEndPayload): Promise<RecordOutcome> {
  // Captured once, at the moment this match's recording began — the identity
  // it was actually played and reported under. Every write below checks it
  // again at write time; see writeQueueFor.
  const gen = currentGeneration();
  for (let tryIndex = 0; tryIndex < 2; tryIndex++) {
    // Re-checked per attempt, not just captured once: the second pass is
    // reached after a 900ms sleep or an openSession round trip, and the
    // identity can change inside either. The attempt would carry the NEW
    // device cookie, and the server stamps the payload with whatever that
    // cookie resolves to — so this match would be filed against an account
    // that never played it. Reported as `evicted`, which is exactly what it
    // is and which the caller already handles without promising a retry.
    if (identityMovedOn(gen)) {
      console.warn('Match discarded — this browser changed identity mid-record.');
      return { ok: false, reason: 'evicted' };
    }
    try {
      const result = await attempt(payload);
      if (result) return { ok: true, result };
    } catch (e: any) {
      if (e?.unidentified) {
        // Keep the match: once the player re-onboards it can still be paid.
        writeQueueFor(gen, [...readQueue(), { payload, queuedAt: Date.now() }]);
        return { ok: false, reason: 'unidentified' };
      }
      if (e?.evicted) {
        // Deliberately dropped rather than queued: see attempt().
        console.warn('Match discarded — this device no longer holds the account:', e.message);
        return { ok: false, reason: 'evicted' };
      }
      if (e?.staleBuild) {
        // Park it first: the reload replays the queue under the new build, so
        // the match is paid rather than lost to the refresh.
        writeQueueFor(gen, [...readQueue(), { payload, queuedAt: Date.now() }]);
        refreshForBuild(e.build);
        return { ok: false, reason: 'stale_build' };
      }
      if (e?.permanent) {
        console.error('Match rejected by the server:', e.message);
        return { ok: false, reason: 'rejected' };
      }
      if (e?.needsSession && tryIndex === 0) {
        // Re-mint in place; the second pass then carries a live session.
        await openSession();
        continue;
      }
      if (tryIndex === 0) await sleep(RETRY_DELAY_MS);
    }
  }
  writeQueueFor(gen, [...readQueue(), { payload, queuedAt: Date.now() }]);
  return { ok: false, reason: 'queued' };
}

// Two flushes running at once would each read the same queue and each POST
// every entry in it. Every match carries an idempotency key now, so the second
// copy is recognised server-side rather than paid — but the second flush would
// still rewrite the queue from a snapshot taken before the first one emptied
// it, resurrecting matches that had already landed.
let flushing: Promise<number> | null = null;

/**
 * Replay anything parked by an earlier session. Runs on load, drops payloads
 * the server rejects outright, and keeps the rest for the next attempt.
 */
export function flushPendingMatches(): Promise<number> {
  if (flushing) return flushing;
  flushing = runFlush().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function runFlush(): Promise<number> {
  const queue = readQueue();
  if (!queue.length) return 0;
  // Captured once, before this flush's own async work begins — see
  // postMatchRecord and writeQueueFor. Every item this loop keeps was read
  // BEFORE this call started, so if the identity moves on mid-flush, none of
  // them belong to it; the whole batch is dropped rather than written back.
  const gen = currentGeneration();

  const stillPending: Queued[] = [];
  let recovered = 0;
  for (const item of queue) {
    // Same rule, per item. A flush is a sequence of round trips (plus an
    // openSession of its own on a missing session), so the identity can
    // change several items in — and every item still to come was read from
    // the OLD identity's queue. None of them belong to whoever holds this
    // browser now, so the loop stops rather than reporting them under a
    // cookie that would have the server file them against the new account.
    // Nothing is written back either: writeQueueFor below refuses a stale
    // generation, so the batch is dropped exactly as clearPendingMatches
    // intended.
    if (identityMovedOn(gen)) break;
    try {
      // Sent as originally built, chainId and runSeq included: those are this
      // BROWSER's persisted ordering (src/net/runChain.ts), assigned when the
      // match ended and unaffected by how long it then sat in this queue or
      // how long this specific replay's own round trip takes. Stripping them
      // would leave the replay ordered by age alone, which cannot see a
      // request's own network time and can misorder it against a live write
      // that happens to have a faster round trip.
      await attempt(item.payload);
      recovered++;
    } catch (e: any) {
      if (e?.needsSession) {
        // No live session yet — this queue is flushed on load, which can beat
        // the session being minted. Keep everything and try the next time.
        await openSession();
        stillPending.push(item);
        continue;
      }
      if (e?.staleBuild) {
        // Keep it and go get the new bundle; the queue survives the reload.
        stillPending.push(item);
        refreshForBuild(e.build);
        continue;
      }
      // Keep anything that might still land; drop outright refusals, and
      // anything played under an account this device no longer holds.
      if (!e?.permanent && !e?.evicted) stillPending.push(item);
    }
  }
  writeQueueFor(gen, stillPending);
  return recovered;
}

export const pendingMatchCount = (): number => readQueue().length;

/**
 * Drop everything parked here, unsent. For the one moment a queued match
 * must NOT survive: this device is giving up the identity that earned it
 * (`startFreshIdentity` in App.tsx, the way off a released device). The
 * queue is a flat, unnamespaced localStorage key — it does not know which
 * account was active when an entry was queued — so left alone, a match
 * queued under the old identity is still sitting here the moment the new,
 * fresh one goes to onboard, and a later flush (once that fresh profile is
 * initialized) credits it there instead: XP, rating, achievements and
 * streaks earned by an account this browser no longer holds, paid to one
 * that never played it. The same reasoning `attempt()` already applies to
 * an `evicted` result — dropped rather than queued, because replaying it
 * later would credit whatever identity this browser ends up with — applied
 * one step earlier, to a result that was queued before the identity moved
 * on rather than discovered after.
 *
 * Clearing the CURRENT value is not the whole fix: a write already in
 * flight when this runs (a slow fetch, a retry's own delay) can still
 * resolve afterward and re-queue the very payload just cleared. Bumping
 * `generation` is what closes that — every in-flight write captured the
 * generation in force when IT started, and writeQueueFor refuses to apply a
 * write whose captured generation no longer matches.
 */
export const clearPendingMatches = (): void => {
  generation++;
  writeQueue([]);
};
