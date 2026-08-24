// A per-browser identity for ordering the writes that ASSIGN a rally run.
//
// Two mechanisms compare a write against another, and this is the newer of
// them. An elapsed AGE (`endedAt` at the event, `clientNow` as the request
// goes out) orders writes from genuinely different moments — including a
// result replayed off the on-device queue, from a browser that may not even
// be the one that reloads. It cannot order two writes from the SAME browser
// correctly when their own network transit times differ: age never counts a
// request's own time on the wire, so a write whose response takes 8 seconds
// and one that takes 80ms can compare in either order depending on when each
// happens to reach the server — regardless of which one was decided first.
//
// A serializing queue (`queueRunWrite` in App.tsx) only fixes this for writes
// that are actually queued behind one another; it cannot fix it for a queued
// match replayed after a reload racing a live write on the new page, because
// nothing connects the two once the page that queued the first one is gone.
//
// This is the fix for both: a monotonic counter, assigned at the moment the
// underlying event happens (the same moment `endedAt` is captured) rather
// than when the request is sent, and PERSISTED — so it survives a reload and
// a replayed write keeps the exact position it was assigned, comparable to
// whatever this same browser assigns after the reload. Two writes from one
// browser instance can then be compared by this number alone, with no regard
// to when either one's request actually completes.
//
// Deliberately not tied to the account or the server session, both of which
// can change more often than the browser does (a device can hold different
// accounts over time; a session is re-minted every load) — only to this
// origin's storage, which is what a single physical install of the app is.

const KEY = 'phong_run_chain';

interface ChainState {
  chainId: string;
  seq: number;
}

function randomChainId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // No uniqueness requirement beyond "does not collide with another browser's
  // chain in practice" — this is an ordering aid, not a credential.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function readChain(): ChainState {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed.chainId === 'string' && Number.isFinite(parsed.seq)) {
      return parsed;
    }
  } catch {
    /* corrupt or unavailable — start a fresh chain rather than throw */
  }
  return { chainId: randomChainId(), seq: 0 };
}

/**
 * The next position in this browser's run-write chain.
 *
 * Call once per logical event that assigns a run — the same moment `endedAt`
 * is captured for it, before anything is sent — so a payload parked and
 * replayed later keeps the number it was actually decided at, rather than
 * one assigned by whenever the replay happens to run.
 *
 * If storage cannot be written, the chain simply does not persist: the next
 * call starts a fresh chain rather than continuing this one. Two writes never
 * compare as `sameChain` in that case, so ordering falls back to the age —
 * the same behavior as before this existed, not a broken one.
 */
export function nextRunSeq(): { chainId: string; runSeq: number } {
  const state = readChain();
  state.seq += 1;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage full or unavailable */
  }
  return { chainId: state.chainId, runSeq: state.seq };
}
