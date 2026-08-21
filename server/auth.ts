import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { db } from './db';

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
    res.setHeader(
      'Set-Cookie',
      `${DEVICE_COOKIE}=${mintToken(deviceId)}; Max-Age=${COOKIE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax${secure}`
    );
  }
  req.deviceId = deviceId;
  next();
}
