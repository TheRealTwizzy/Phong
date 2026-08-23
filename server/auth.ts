import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { db } from './db';
import { buildId } from './build';

// Device identity: the server issues each browser a signed, HttpOnly cookie
// on first contact. Clients can no longer choose or forge their player id —
// the id is whatever the verified cookie says. One cookie jar = one profile,
// which is as close to "one profile per device" as the web platform allows.
//
// Token format: v1.<deviceId>.<base64url HMAC-SHA256(deviceId)>
// The HMAC secret is generated once and persisted in the database's meta
// table, so it survives restarts and redeploys with no extra configuration.

export const DEVICE_COOKIE = 'phong_device';
const COOKIE_MAX_AGE_S = 2 * 365 * 24 * 60 * 60; // 2 years

let cachedSecret: Buffer | null = null;

function secret(): Buffer {
  if (!cachedSecret) {
    let hex = db.getMeta('auth_secret');
    if (!hex) {
      hex = crypto.randomBytes(32).toString('hex');
      db.setMeta('auth_secret', hex);
    }
    cachedSecret = Buffer.from(hex, 'hex');
  }
  return cachedSecret;
}

function sign(deviceId: string): string {
  return crypto.createHmac('sha256', secret()).update(deviceId).digest('base64url');
}

export function mintDeviceId(): string {
  return `dev_${crypto.randomBytes(9).toString('hex')}`;
}

export function mintToken(deviceId: string): string {
  return `v1.${deviceId}.${sign(deviceId)}`;
}

export function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, deviceId, mac] = parts;
  if (!/^dev_[0-9a-f]{18}$/.test(deviceId)) return null;
  const expected = sign(deviceId);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return deviceId;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Device id from a request's cookies, or null if absent/forged. */
export function deviceIdFromCookieHeader(cookieHeader: string | undefined): string | null {
  return verifyToken(parseCookies(cookieHeader)[DEVICE_COOKIE]);
}

declare module 'http' {
  interface IncomingMessage {
    deviceId?: string;
  }
}

/**
 * Express middleware: attaches req.deviceId, minting and setting the cookie
 * when the browser doesn't present a valid one yet.
 */
export function deviceIdentity(req: Request, res: Response, next: NextFunction): void {
  let deviceId = deviceIdFromCookieHeader(req.headers.cookie);
  if (!deviceId) {
    deviceId = mintDeviceId();
    const secure = req.secure ? '; Secure' : '';
    // append, not setHeader: a response can carry the session cookie too, and
    // setHeader would drop whichever of the two was written first.
    res.append(
      'Set-Cookie',
      `${DEVICE_COOKIE}=${mintToken(deviceId)}; Max-Age=${COOKIE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax${secure}`
    );
  }
  req.deviceId = deviceId;
  next();
}

// ---------------------------------------------------------------------------
// Sessions: which ONE of an account's devices is live right now.
//
// The device cookie above answers "who is this browser?". It cannot answer
// "is this browser still the one holding the account?", and that gap was
// exploitable: transferring a profile to a second device renames the player
// row's id, so the first device's cookie simply stopped matching a row — and
// `getProfile` mints a fresh, uninitialized profile for any id it has never
// seen. A device that had just been transferred away was therefore
// indistinguishable from a brand-new browser. It kept playing a whole match
// under an identity that no longer existed and only discovered it at the
// final whistle, when the match it had just played was refused and onboarding
// re-opened as if it were a guest.
//
// So a session is minted per page load, signed, and kept in its own cookie:
//   - the profile records the ONE session id that currently owns it, so a
//     second device playing the same account is `superseded` from the moment
//     the first one loads,
//   - a device whose profile was transferred away is `released` and resolves
//     to nothing at all rather than to a freshly minted stranger,
//   - the session carries the build it was minted under, so a deploy retires
//     every session in the field and each client re-syncs against the new one.
//
// Losing a session never costs the account: the device cookie is untouched by
// all three, so re-minting a session lands on exactly the same profile.

export const SESSION_COOKIE = 'phong_session';
// Sessions are cheap to re-mint and are re-minted on every load, so they only
// have to outlive a single sitting.
const SESSION_MAX_AGE_S = 12 * 60 * 60; // 12 hours

export interface SessionToken {
  sessionId: string;
  deviceId: string;
  /** The build id this session was minted under. */
  build: string;
}

/**
 * What the presented session cookie is worth on this request:
 *  - `active`      this session owns its account; everything is permitted
 *  - `none`        no session presented (or one that does not verify)
 *  - `released`    this DEVICE was transferred away; it owns no account
 *  - `superseded`  the account is held by a newer session on another load
 *  - `stale_build` minted by an older deployment; the client must refresh
 */
export type SessionStatus = 'active' | 'none' | 'released' | 'superseded' | 'stale_build';

export function mintSessionId(): string {
  return `ses_${crypto.randomBytes(12).toString('hex')}`;
}

function signSession(sessionId: string, deviceId: string, build: string): string {
  return crypto
    .createHmac('sha256', secret())
    .update(`${sessionId}|${deviceId}|${build}`)
    .digest('base64url');
}

export function mintSessionToken(sessionId: string, deviceId: string, build: string): string {
  return `s1.${sessionId}.${deviceId}.${build}.${signSession(sessionId, deviceId, build)}`;
}

export function verifySessionToken(token: string | undefined): SessionToken | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 's1') return null;
  const [, sessionId, deviceId, build, mac] = parts;
  if (!/^ses_[0-9a-f]{24}$/.test(sessionId)) return null;
  if (!/^dev_[0-9a-f]{18}$/.test(deviceId)) return null;
  if (!/^[0-9a-f]{12}$/.test(build)) return null;
  const a = Buffer.from(mac);
  const b = Buffer.from(signSession(sessionId, deviceId, build));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { sessionId, deviceId, build };
}

export interface RequestSession {
  status: SessionStatus;
  /** The session id presented, when one verified. */
  sessionId: string | null;
  /** Where the account went, for a `released` device. */
  movedToPlayerId?: string;
}

declare module 'http' {
  interface IncomingMessage {
    session?: RequestSession;
  }
}

/**
 * What the caller's session cookie is worth right now. Order matters: a
 * released device owns nothing whatever its session cookie says, and a
 * session from a previous deployment is spent before its ownership is even
 * worth looking up.
 */
export function resolveSession(deviceId: string, cookieHeader: string | undefined): RequestSession {
  // A browser SIGNED IN to an account is a member of it, whether or not it is
  // the one holding it right now. Checked before the tombstone, because the
  // two states are answers to different questions and only one of them is a
  // dead end: `released` means "this browser gave an account away and has no
  // claim on it", while a linked browser simply is not the one currently
  // holding an account that is still its own. Reporting the second as the
  // first is what put players in front of a wall whose only button destroyed
  // the account — and cookie jars do not cross browsers, so a player opening
  // an invitation in Messenger's webview lands here as a matter of course.
  const link = db.linkedAccount(deviceId);
  if (link && !link.holdsIt) {
    // `superseded`, deliberately: it is the state that already means "your
    // account is live somewhere else" and already has a non-destructive way
    // back. POST /api/session brings the account here for a linked browser.
    return { status: 'superseded', sessionId: null, movedToPlayerId: link.playerId };
  }

  const release = db.releasedDevice(deviceId);
  if (release) {
    return { status: 'released', sessionId: null, movedToPlayerId: release.movedToPlayerId };
  }

  const token = verifySessionToken(parseCookies(cookieHeader)[SESSION_COOKIE]);
  // A session signed for a different device is somebody else's cookie in this
  // jar; it is worth exactly as much as no cookie at all.
  if (!token || token.deviceId !== deviceId) return { status: 'none', sessionId: null };
  if (token.build !== buildId()) return { status: 'stale_build', sessionId: token.sessionId };

  const owner = db.activeSessionId(deviceId);
  // Nobody holds the account — including the very first contact, before a
  // profile row exists. The client mints one and takes it.
  if (!owner) return { status: 'none', sessionId: token.sessionId };
  if (owner !== token.sessionId) return { status: 'superseded', sessionId: token.sessionId };
  return { status: 'active', sessionId: token.sessionId };
}

function cookieAttributes(req: Request, maxAgeSeconds: number): string {
  const secure = req.secure ? '; Secure' : '';
  return `Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

/**
 * Start a session on this device and hand the account to it. Returns the new
 * session id. The device cookie is not touched — the account binding survives
 * every session change, which is the whole point of keeping the two separate.
 */
export function issueSession(req: Request, res: Response, deviceId: string): string {
  const sessionId = mintSessionId();
  db.getProfile(deviceId); // the row has to exist before it can name an owner
  db.adoptSession(deviceId, sessionId);
  setSessionCookie(req, res, sessionId, deviceId);
  return sessionId;
}

/**
 * Hand this browser a session cookie for an id the caller already owns.
 *
 * For the one path that mints the id before the account is in place: a linked
 * browser taking its account back needs the session recorded on the row as it
 * moves, so `issueSession` (which resolves the profile first) cannot be used.
 */
export function setSessionCookie(
  req: Request,
  res: Response,
  sessionId: string,
  deviceId: string
): void {
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${mintSessionToken(sessionId, deviceId, buildId())}; ${cookieAttributes(req, SESSION_MAX_AGE_S)}`
  );
}

/** Drop the session cookie, leaving the device cookie (and the account) alone. */
export function clearSessionCookie(req: Request, res: Response): void {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttributes(req, 0)}`);
}

/**
 * Issue this browser a brand-new device identity. The only way off a released
 * device: the account it used to hold is alive elsewhere, so this browser
 * starts over as a new player rather than being handed the old one back.
 */
export function resetDeviceIdentity(req: Request, res: Response): string {
  const deviceId = mintDeviceId();
  res.append('Set-Cookie', `${DEVICE_COOKIE}=${mintToken(deviceId)}; ${cookieAttributes(req, COOKIE_MAX_AGE_S)}`);
  clearSessionCookie(req, res);
  req.deviceId = deviceId;
  req.session = { status: 'none', sessionId: null };
  return deviceId;
}

/** Express middleware: attaches req.session. Runs after deviceIdentity. */
export function sessionIdentity(req: Request, res: Response, next: NextFunction): void {
  req.session = resolveSession(req.deviceId!, req.headers.cookie);
  next();
}

/**
 * Gate for everything that spends, earns, or changes something. A request
 * that is not the account's live session is refused with the reason, which is
 * what the client acts on — it is not an error so much as an instruction to
 * re-sync, and in the released case to stop playing immediately.
 */
export function requireActiveSession(req: Request, res: Response, next: NextFunction): void {
  const status = req.session?.status ?? 'none';
  if (status === 'active') return next();
  res.status(status === 'released' || status === 'superseded' ? 409 : 401).json({
    error: {
      released: 'DEVICE_RELEASED',
      superseded: 'SESSION_SUPERSEDED',
      stale_build: 'SESSION_STALE_BUILD',
      none: 'SESSION_REQUIRED',
      active: 'SESSION_REQUIRED',
    }[status],
    sessionStatus: status,
    build: buildId(),
  });
}

/**
 * Lighter gate for reads: a released device must not reach `getProfile`,
 * which would mint it the fresh, empty profile this whole mechanism exists to
 * prevent. A superseded or stale session may still READ its own account —
 * it is the player's account, they are simply not acting from it.
 */
export function blockReleasedDevice(req: Request, res: Response, next: NextFunction): void {
  // A linked browser that is not holding its account must not reach getProfile
  // either: the lazy mint would hand it a fresh empty profile, which is the
  // failure this whole area exists to stop. It is told where the account is
  // instead, and POST /api/session brings it back.
  if (req.session?.status === 'superseded' && req.session.movedToPlayerId) {
    res.status(409).json({
      error: 'ACCOUNT_ELSEWHERE',
      sessionStatus: 'superseded',
      build: buildId(),
    });
    return;
  }
  if (req.session?.status === 'released') {
    res.status(409).json({ error: 'DEVICE_RELEASED', sessionStatus: 'released', build: buildId() });
    return;
  }
  next();
}

/**
 * Gate for restoring an account onto this device with its recovery code.
 *
 * `requireActiveSession` refused a RELEASED device, which made the one state
 * that most needs this door the one state that could not reach it. A released
 * device is a browser whose account was transferred away; the session wall it
 * gets offered exactly one button, "start as a new player", and that button is
 * irreversible — it mints a new device identity, so the account left behind is
 * reachable by nobody, ever. A player who followed an invitation link into a
 * second browser and then wanted their own account back had no move that did
 * not destroy it.
 *
 * Letting a released device claim grants nothing new. The credential is the
 * account's own recovery code, and the same device could already reach the
 * same call by pressing "start fresh" first and restoring from the fresh
 * identity — it just lost its device id and its release record on the way.
 * The only thing this changes is that the non-destructive order is available.
 */
export function requireRestorableSession(req: Request, res: Response, next: NextFunction): void {
  const status = req.session?.status ?? 'none';
  if (status === 'active' || status === 'released') return next();
  res.status(status === 'superseded' ? 409 : 401).json({
    error: status === 'superseded' ? 'SESSION_SUPERSEDED' : status === 'stale_build' ? 'SESSION_STALE_BUILD' : 'SESSION_REQUIRED',
    sessionStatus: status,
    build: buildId(),
  });
}
