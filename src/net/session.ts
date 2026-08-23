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

/**
 * The session THIS page load was given.
 *
 * `phong_session` is an origin cookie, not a per-page one, so two tabs on the
 * same device share it and the newest value is sent by both — the server sees
 * one caller and cannot tell them apart. Holding the id we were handed, in
 * memory where a second tab cannot reach it, is what lets the older tab
 * notice that the account has moved on without it.
 *
 * This is a correctness aid for honest clients, not a boundary: the server's
 * guarantee is one live DEVICE, and a modified client could always decline to
 * check. Nothing is granted on the strength of it.
 */
let mySessionId: string | null = null;
/** Remembers which build we have already reloaded for, so we cannot loop. */
const RELOAD_GUARD_KEY = 'phong_build_reload';

export type ClientSessionStatus = SessionStatus | 'connecting' | 'offline';

/**
 * The states in which nothing the player does counts, and so the only ones
 * SessionGuard puts a wall in front of.
 *
 * Deliberately a WALL and not a toast: in these states no match records, no XP
 * lands and no rating moves. Letting play continue behind a dismissible banner
 * is exactly the reported bug — a full match on a phone whose account had
 * already moved to a desktop, discovered only when the finished match was
 * refused.
 *
 * `offline` is NOT on this list. A heartbeat that could not reach the server
 * is a dropped connection, not an eviction, and throwing a player off the
 * court every time a phone changes cells would be its own bug.
 *
 * `connecting` and `none` are off it for a different reason. They do not mean
 * "you may not play", they mean "we have not asked yet" — and blocking on them
 * put a network round trip in front of the first paint, so the menu and the
 * onboarding modal arrived a beat later for every player on every load.
 * Nothing is lost by rendering: writes are gated server-side regardless, and a
 * match recorded before the session lands is answered SESSION_REQUIRED, which
 * postMatchRecord resolves by minting one and retrying.
 *
 * Lives here rather than in the component so the rule can be asserted without
 * a DOM — it is a property of the session model, not of how it is drawn.
 */
export const BLOCKING_STATUSES: readonly ClientSessionStatus[] = [
  'released',
  'superseded',
  'stale_build',
];

/** Whether this status is one the player must be stopped on. */
export const isBlockingStatus = (status: ClientSessionStatus): boolean =>
  BLOCKING_STATUSES.includes(status);

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

/**
 * Start (or take back) the session for this device.
 *
 * `force` mints unconditionally, for the one caller that genuinely wants a NEW
 * session: the player pressing "play here instead" on the session wall, taking
 * the account back from another device on purpose.
 */
export function openSession(
  options: { force?: boolean } = {}
): Promise<{ status: ClientSessionStatus; profile?: PlayerProfile }> {
  if (opening) return opening;
  opening = (options.force ? mintSession() : ensureSession()).finally(() => {
    opening = null;
  });
  return opening;
}

/**
 * A page that already holds a live session must not mint a second one.
 *
 * The guard above only ever covered mints that OVERLAP. These arrive in
 * SEQUENCE: boot mints one, and then the match queue — which is flushed on
 * load and can beat the session being established — is answered
 * SESSION_REQUIRED and mints another. The second supersedes the first, and
 * superseding closes every socket opened under it. A player following an
 * invitation link had their relay socket shut mid-join and was shown the
 * "playing elsewhere" wall, against themselves: exactly the failure the
 * comment above describes, arrived at the other way round.
 *
 * Measured at roughly one join in twenty before this.
 */
async function ensureSession(): Promise<{
  status: ClientSessionStatus;
  profile?: PlayerProfile;
}> {
  if (mySessionId) {
    const snapshot = await readSession();
    // Still ours: nothing to do, and minting would only take it from itself.
    if (snapshot.status === 'active') return { status: 'active' };
    // Genuinely lost it (another tab, another device) — minting is how a
    // caller that needs a live session gets one back, as it always was.
  }
  return mintSession();
}

async function mintSession(): Promise<{ status: ClientSessionStatus; profile?: PlayerProfile }> {
  try {
    const res = await fetch('/api/session', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data?.status === 'active') {
      mySessionId = data.sessionId || null;
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
      mySessionId = data.sessionId || null;
      return { status: 'active', profile: data.profile as PlayerProfile };
    }
    return { status: 'none' };
  } catch {
    return { status: 'offline' };
  }
}

/**
 * Hand the account back on the way out. Best-effort; never awaited.
 *
 * The session id THIS page was given rides along, and the server ends nothing
 * unless it matches. Without it a closing tab handed back whatever the shared
 * origin cookie happened to hold — which, with two tabs open, is the session
 * the OTHER tab just minted. Closing the stale tab therefore signed the live
 * one out: its next request carried no session at all, the relay refused its
 * socket at the upgrade, and a join in flight died with it.
 */
export function endSession(): void {
  try {
    // keepalive so it still goes out while the page is being torn down.
    void fetch('/api/session/end', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: mySessionId }),
    });
  } catch {
    /* nothing useful to do while unloading */
  }
}


async function readSession(): Promise<SessionSnapshot> {
  try {
    const res = await fetch('/api/session');
    const data = (await res.json()) as SessionState;
    // The account is live, but held by a session this page was never given —
    // another tab on this same device loaded after us and took it. The server
    // cannot report that (it sees one shared cookie), so we conclude it here.
    if (data?.status === 'active' && mySessionId && data.sessionId && data.sessionId !== mySessionId) {
      return { status: 'superseded', build: data.build || null };
    }
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
export function refreshForBuild(build: string | null | undefined): boolean {
  // Normalised before it is compared: an absent build id used to be written
  // to storage as the string "undefined" and then compared against the
  // `undefined` value, which never matched — so the guard against looping was
  // exactly the case that looped.
  const key = build || 'unknown';
  try {
    if (sessionStorage.getItem(RELOAD_GUARD_KEY) === key) return false;
    sessionStorage.setItem(RELOAD_GUARD_KEY, key);
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
