import { MatchEndPayload, MatchEndResult } from '../types';
import { openSession } from './session';

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

/** One attempt. Throws with a classification the caller can act on. */
async function attempt(payload: MatchEndPayload): Promise<MatchEndResult | null> {
  const res = await fetch('/api/match/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let code = '';
    try {
      code = (await res.json())?.error || '';
    } catch {
      /* no body to read */
    }
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
    // We simply have no live session — first contact, or one retired by a
    // deployment. That is recoverable in place: mint a new one and try again.
    if (code === 'SESSION_REQUIRED' || code === 'SESSION_STALE_BUILD') {
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
   *  - 'rejected'     refused outright; replaying would fail identically
   */
  reason?: 'queued' | 'unidentified' | 'evicted' | 'rejected';
}

/**
 * Record a finished match. Retries once on a transient failure, and queues the
 * payload for replay if it still doesn't land.
 */
export async function postMatchRecord(payload: MatchEndPayload): Promise<RecordOutcome> {
  for (let tryIndex = 0; tryIndex < 2; tryIndex++) {
    try {
      const result = await attempt(payload);
      if (result) return { ok: true, result };
    } catch (e: any) {
      if (e?.unidentified) {
        // Keep the match: once the player re-onboards it can still be paid.
        writeQueue([...readQueue(), { payload, queuedAt: Date.now() }]);
        return { ok: false, reason: 'unidentified' };
      }
      if (e?.evicted) {
        // Deliberately dropped rather than queued: see attempt().
        console.warn('Match discarded — this device no longer holds the account:', e.message);
        return { ok: false, reason: 'evicted' };
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
  writeQueue([...readQueue(), { payload, queuedAt: Date.now() }]);
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

  const stillPending: Queued[] = [];
  let recovered = 0;
  for (const item of queue) {
    try {
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
      // Keep anything that might still land; drop outright refusals, and
      // anything played under an account this device no longer holds.
      if (!e?.permanent && !e?.evicted) stillPending.push(item);
    }
  }
  writeQueue(stillPending);
  return recovered;
}

export const pendingMatchCount = (): number => readQueue().length;
