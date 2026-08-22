import { PlayerProfile, SessionState, SessionStatus } from '../types';

// The client half of "one account, one live device".
//
// The device cookie says which browser this is; a session says whether that
// browser is still the one holding the account. Both live in HttpOnly cookies
// the server sets, so nothing here handles a token — this module's whole job
// is to ask, on a heartbeat, whether we are still allowed to be playing, and
// to say so loudly the moment we are not.
//
// The bug this exists for: transferring an account to a second device left
// the first one able to play an entire match under an identity the server had
// already retired. It only found out at the final whistle, when the match it
// had just finished was refused and onboarding re-opened as though it were a
// guest. Ten seconds of polling costs nothing next to a match played for
// nothing.

const HEARTBEAT_MS = 15_000;
/** Remembers which build we have already reloaded for, so we cannot loop. */
const RELOAD_GUARD_KEY = 'phong_build_reload';

export type ClientSessionStatus = SessionStatus | 'connecting' | 'offline';

export interface SessionSnapshot {
  status: ClientSessionStatus;
  build: string | null;
}

// Two mints in flight at once are worse than one: each takes the account from
// the other, and whichever RESPONSE lands last leaves its cookie behind while
// the database names the other session as the owner — so the tab that just
// loaded is told it is "playing elsewhere", against itself. Boot and the
// first heartbeat can both ask, so they share one attempt.
let opening: Promise<{ status: ClientSessionStatus; profile?: PlayerProfile }> | null = null;

/** Start (or take back) the session for this device. */
export function openSession(): Promise<{ status: ClientSessionStatus; profile?: PlayerProfile }> {
  if (opening) return opening;
  opening = mintSession().finally(() => {
    opening = null;
  });
  return opening;
}

async function mintSession(): Promise<{ status: ClientSessionStatus; profile?: PlayerProfile }> {
  try {
    const res = await fetch('/api/session', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data?.status === 'active') {
      return { status: 'active', profile: data.profile as PlayerProfile };
    }
    return { status: (data?.sessionStatus as SessionStatus) || 'none' };
  } catch {
    return { status: 'offline' };
  }
}

/**
 * Give up this device's identity and start over as a new player. The only way
 * off a released device: the account it used to hold is alive on the device it
 * was transferred to, and handing it back here would recreate the very
 * two-devices-one-account state this all exists to prevent.
 */
export async function resetDevice(): Promise<{ status: ClientSessionStatus; profile?: PlayerProfile }> {
  try {
    const res = await fetch('/api/session/reset', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data?.status === 'active') {
      return { status: 'active', profile: data.profile as PlayerProfile };
    }
    return { status: 'none' };
  } catch {
    return { status: 'offline' };
  }
}

/** Hand the account back on the way out. Best-effort; never awaited. */
export function endSession(): void {
  try {
    // keepalive so it still goes out while the page is being torn down.
    void fetch('/api/session/end', { method: 'POST', keepalive: true });
  } catch {
    /* nothing useful to do while unloading */
  }
}

async function readSession(): Promise<SessionSnapshot> {
  try {
    const res = await fetch('/api/session');
    const data = (await res.json()) as SessionState;
    return { status: data?.status || 'none', build: data?.build || null };
  } catch {
    // A dropped network is not an eviction. Saying otherwise would throw a
    // player out of a match every time a phone changed cells.
    return { status: 'offline', build: null };
  }
}

/**
 * Reload onto the deployment the server is actually serving. Guarded by build
 * id: if we have already reloaded once for this build and are somehow still
 * being told we are stale, stop reloading and let the session re-mint carry
 * it — a reload loop is worse than an out-of-date tab.
 */
export function refreshForBuild(build: string): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_GUARD_KEY) === build) return false;
    sessionStorage.setItem(RELOAD_GUARD_KEY, build);
  } catch {
    /* private mode: fall through and reload once */
  }
  window.location.reload();
  return true;
}

/**
 * Poll session ownership for as long as the page is open. Fires `onChange`
 * only when the answer actually changes, plus immediately whenever the tab
 * comes back to the foreground — the most likely moment for the account to
 * have moved while we were not looking.
 */
export function watchSession(onChange: (snapshot: SessionSnapshot) => void): () => void {
  let stopped = false;
  let last: ClientSessionStatus | null = null;

  const tick = async () => {
    if (stopped) return;
    const snapshot = await readSession();
    if (stopped) return;
    if (snapshot.status !== last) {
      last = snapshot.status;
      onChange(snapshot);
    }
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') void tick();
  };

  const timer = setInterval(() => void tick(), HEARTBEAT_MS);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
  };
}

/**
 * Re-check ownership right now. Used when a write comes back 409/401: the
 * server has just told us something changed, so there is no reason to wait
 * for the next heartbeat to find out what.
 */
export const probeSession = readSession;
