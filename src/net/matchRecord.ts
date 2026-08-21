import { MatchEndPayload, MatchEndResult } from '../types';

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

/** One attempt. Returns the result, or null if the server refused it. */
async function attempt(payload: MatchEndPayload): Promise<MatchEndResult | null> {
  const res = await fetch('/api/match/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    // 4xx is a verdict, not a hiccup: replaying it will fail identically.
    const permanent = res.status >= 400 && res.status < 500;
    throw Object.assign(new Error(`record failed: ${res.status}`), { permanent });
  }
  return (await res.json()) as MatchEndResult;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Record a finished match. Retries once on a transient failure, and queues the
 * payload for replay if it still doesn't land. Returns null when the result
 * could not be recorded now — the caller should tell the player.
 */
export async function postMatchRecord(payload: MatchEndPayload): Promise<MatchEndResult | null> {
  for (let tryIndex = 0; tryIndex < 2; tryIndex++) {
    try {
      return await attempt(payload);
    } catch (e: any) {
      if (e?.permanent) {
        console.error('Match rejected by the server:', e.message);
        return null; // queueing a rejected payload would just fail forever
      }
      if (tryIndex === 0) await sleep(RETRY_DELAY_MS);
    }
  }
  writeQueue([...readQueue(), { payload, queuedAt: Date.now() }]);
  return null;
}

/**
 * Replay anything parked by an earlier session. Runs on load, drops payloads
 * the server rejects outright, and keeps the rest for the next attempt.
 */
export async function flushPendingMatches(): Promise<number> {
  const queue = readQueue();
  if (!queue.length) return 0;

  const stillPending: Queued[] = [];
  let recovered = 0;
  for (const item of queue) {
    try {
      await attempt(item.payload);
      recovered++;
    } catch (e: any) {
      if (!e?.permanent) stillPending.push(item);
    }
  }
  writeQueue(stillPending);
  return recovered;
}

export const pendingMatchCount = (): number => readQueue().length;
