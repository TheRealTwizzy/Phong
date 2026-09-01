import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateUsername, usernameLockExpiry, isLinkableId } from '../src/profileRules';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-username-test-'));
process.env.DATA_DIR = TMP;

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const init = (id: string, username: string, nowIso?: string) => {
  db.getProfile(id);
  return db.initializeProfile(id, username, nowIso);
};

describe('username rules (shared client/server validator)', () => {
  it('accepts well-formed names', () => {
    for (const name of ['Neo', 'Neo_Smash-3', 'ABC', 'a1b2c3', 'X'.repeat(16)]) {
      expect(validateUsername(name).ok).toBe(true);
    }
  });

  it('rejects bad lengths, charsets, and the reserved placeholder prefix', () => {
    expect(validateUsername('ab').reason).toBe('too_short');
    expect(validateUsername('X'.repeat(17)).reason).toBe('too_long');
    expect(validateUsername('has space').reason).toBe('invalid_chars');
    expect(validateUsername('-leading').reason).toBe('invalid_chars');
    expect(validateUsername('émoji☺').reason).toBe('invalid_chars');
    expect(validateUsername('Paddle-1234').reason).toBe('reserved');
    expect(validateUsername('paddle-x').reason).toBe('reserved');
  });

  it('links only real profile ids', () => {
    expect(isLinkableId('dev_abc123')).toBe(true);
    expect(isLinkableId('bot-pro-01')).toBe(true);
    expect(isLinkableId('p_1755771234')).toBe(false);
    expect(isLinkableId('AI-cyber')).toBe(false);
    expect(isLinkableId(null)).toBe(false);
  });
});

describe('username uniqueness', () => {
  it('is case-insensitive and enforced at initialization', () => {
    expect(init('dev_aaaaaaaaaaaaaaaa10', 'NeonViper').ok).toBe(true);
    const clash = init('dev_aaaaaaaaaaaaaaaa11', 'neonviper');
    expect(clash.ok).toBe(false);
    expect(clash.code).toBe('USERNAME_TAKEN');
    expect(db.isUsernameAvailable('NEONVIPER')).toBe(false);
    // …but a player's own current name stays available to them
    expect(db.isUsernameAvailable('NeonViper', 'dev_aaaaaaaaaaaaaaaa10')).toBe(true);
  });

  it('rejects invalid names at initialization', () => {
    const bad = init('dev_aaaaaaaaaaaaaaaa12', 'no spaces!');
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('USERNAME_INVALID');
  });

  it('placeholder names never reserve anything — twin placeholders coexist', () => {
    // Same id tail → identical Paddle-XXXX placeholder on both rows
    const a = db.getProfile('dev_aaaaaaaaaaaaaa1234');
    const b = db.getProfile('dev_bbbbbbbbbbbbbb1234');
    expect(a.username).toBe(b.username);
    expect(a.initialized).toBe(false);
    expect(b.initialized).toBe(false);
  });
});

describe('365-day username lock', () => {
  const T0 = '2025-01-01T00:00:00.000Z';
  const DAY = 24 * 60 * 60 * 1000;

  it('locks from initialization and reports the exact unlock date', () => {
    expect(init('dev_aaaaaaaaaaaaaaaa20', 'LockedIn', T0).ok).toBe(true);

    const at364 = new Date(Date.parse(T0) + 364 * DAY).toISOString();
    const denied = db.changeUsername('dev_aaaaaaaaaaaaaaaa20', 'NewNameA', at364);
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe('USERNAME_LOCKED');
    expect(denied.unlockAt).toBe(usernameLockExpiry(T0).toISOString());
  });

  it('allows the change after the lock expires and re-locks from the change', () => {
    const at366 = new Date(Date.parse(T0) + 366 * DAY).toISOString();
    const renamed = db.changeUsername('dev_aaaaaaaaaaaaaaaa20', 'NewNameA', at366);
    expect(renamed.ok).toBe(true);
    expect(renamed.profile!.username).toBe('NewNameA');
    expect(renamed.profile!.usernameChangedAt).toBe(at366);

    // Immediately locked again for another 365 days
    const tooSoon = db.changeUsername(
      'dev_aaaaaaaaaaaaaaaa20',
      'NewNameB',
      new Date(Date.parse(at366) + DAY).toISOString()
    );
    expect(tooSoon.ok).toBe(false);
    expect(tooSoon.code).toBe('USERNAME_LOCKED');
  });

  it('releases the old name for other players after a change', () => {
    // 'LockedIn' was abandoned in the rename above
    const taken = init('dev_aaaaaaaaaaaaaaaa21', 'LockedIn');
    expect(taken.ok).toBe(true);
  });

  it('treats re-submitting the current name as a no-op', () => {
    const p = db.getProfile('dev_aaaaaaaaaaaaaaaa21');
    const noop = db.changeUsername('dev_aaaaaaaaaaaaaaaa21', p.username);
    expect(noop.ok).toBe(true);
    expect(noop.profile!.usernameChangedAt).toBe(p.usernameChangedAt);
  });

  it('refuses renames on uninitialized profiles', () => {
    db.getProfile('dev_aaaaaaaaaaaaaaaa22');
    const result = db.changeUsername('dev_aaaaaaaaaaaaaaaa22', 'SneakyName');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PROFILE_NOT_INITIALIZED');
  });
});

describe('a failed write is not automatically a taken name', () => {
  // Both username paths caught EVERY error from `upsertProfile` and answered
  // USERNAME_TAKEN. So a full disk or a read-only volume told the player their
  // name had gone and sent them to pick another one — which then failed the
  // same way, forever, with the real fault never surfacing anywhere.
  it('reports a genuine collision as taken', () => {
    db.getProfile('u_taken_a');
    db.getProfile('u_taken_b');
    expect(db.initializeProfile('u_taken_a', 'CollideMe').ok).toBe(true);
    expect(db.initializeProfile('u_taken_b', 'collideme').code).toBe('USERNAME_TAKEN');
  });

  it('lets any other write failure through instead of mislabelling it', () => {
    db.getProfile('u_disk');
    const boom = vi
      .spyOn(db as unknown as { upsertProfile: (p: unknown) => void }, 'upsertProfile')
      .mockImplementationOnce(() => {
        throw new Error('disk I/O error');
      });
    expect(() => db.initializeProfile('u_disk', 'DiskFull')).toThrow(/disk I\/O error/);
    boom.mockRestore();
  });
});
