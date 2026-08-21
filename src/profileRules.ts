// Username & avatar rules shared by client and server (same convention as
// types.ts: server imports from src/ so the two sides can never disagree).

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 16;
// Starts alphanumeric, then letters/digits/underscore/hyphen.
export const USERNAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{2,15}$/;
// Uninitialized profiles carry auto-generated "Paddle-XXXX" placeholders;
// the prefix is reserved so a chosen name can never collide with one.
export const RESERVED_USERNAME_PREFIX = 'paddle-';
// A username locks for this long after profile initialization and after
// every subsequent change.
export const USERNAME_LOCK_DAYS = 365;

// Avatars are exactly this square size, PNG, and capped in bytes. The client
// crops/resizes every upload to match; the server rejects anything else.
export const AVATAR_SIZE = 256;
export const AVATAR_MAX_BYTES = 512 * 1024;

export type UsernameProblem = 'too_short' | 'too_long' | 'invalid_chars' | 'reserved';

// Plain optional-field result (not a discriminated union): this repo's
// tsconfig has strictNullChecks off, where union narrowing doesn't apply.
export function validateUsername(name: string): { ok: boolean; reason?: UsernameProblem } {
  if (typeof name !== 'string' || name.length < USERNAME_MIN) {
    return { ok: false, reason: 'too_short' };
  }
  if (name.length > USERNAME_MAX) {
    return { ok: false, reason: 'too_long' };
  }
  if (!USERNAME_REGEX.test(name)) {
    return { ok: false, reason: 'invalid_chars' };
  }
  if (name.toLowerCase().startsWith(RESERVED_USERNAME_PREFIX)) {
    return { ok: false, reason: 'reserved' };
  }
  return { ok: true };
}

export function usernameLockExpiry(usernameChangedAt: string): Date {
  return new Date(Date.parse(usernameChangedAt) + USERNAME_LOCK_DAYS * 24 * 60 * 60 * 1000);
}

// Ids that resolve to a real profile for public viewing: device identities
// (dev_) and bots (bot-). Synthetic cookie-less WS ids (p_...) and AI
// pseudo-opponents (AI-...) have no profile behind them.
export function isLinkableId(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^(dev_|bot-)/.test(id);
}
