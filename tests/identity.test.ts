import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { MatchEndPayload } from '../src/types';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-identity-test-'));
process.env.DATA_DIR = TMP;

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let auth: typeof import('../server/auth');

beforeAll(async () => {
  ({ db } = await import('../server/db'));
  auth = await import('../server/auth');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const win = (playerId: string): MatchEndPayload => ({
  playerId,
  username: 'Mover',
  playerScore: 5,
  opponentScore: 2,
  bestStreak: 6, endStreak: 0, earnedStreak: 6,
  mode: 'multiplayer',
  isWinner: true,
});

// Onboard a device with a chosen username (matches require initialization).
const init = (id: string, username: string) => {
  db.getProfile(id);
  const result = db.initializeProfile(id, username);
  if (!result.ok) throw new Error(`init failed: ${result.code}`);
  return result.profile!;
};

describe('device tokens', () => {
  it('mint/verify round-trips', () => {
    const id = auth.mintDeviceId();
    expect(id).toMatch(/^dev_[0-9a-f]{18}$/);
    const token = auth.mintToken(id);
    expect(auth.verifyToken(token)).toBe(id);
  });

  it('rejects tampered ids and signatures', () => {
    const token = auth.mintToken(auth.mintDeviceId());
    const [v, id, mac] = token.split('.');
    const otherId = auth.mintDeviceId();
    expect(auth.verifyToken(`${v}.${otherId}.${mac}`)).toBeNull();
    expect(auth.verifyToken(`${v}.${id}.${mac}x`)).toBeNull();
    expect(auth.verifyToken('v1.not-a-device.abc')).toBeNull();
    expect(auth.verifyToken(undefined)).toBeNull();
    expect(auth.verifyToken('garbage')).toBeNull();
  });

  it('extracts the device id from a cookie header', () => {
    const id = auth.mintDeviceId();
    const header = `foo=bar; ${auth.DEVICE_COOKIE}=${auth.mintToken(id)}; baz=1`;
    expect(auth.deviceIdFromCookieHeader(header)).toBe(id);
    expect(auth.deviceIdFromCookieHeader('foo=bar')).toBeNull();
    expect(auth.deviceIdFromCookieHeader(undefined)).toBeNull();
  });
});

describe('sign-in codes and the browsers an account belongs to', () => {
  it('every new profile gets a well-formed unique code', () => {
    const a = db.getProfile('dev_aaaaaaaaaaaaaaaaaa');
    const b = db.getProfile('dev_bbbbbbbbbbbbbbbbbb');
    expect(a.recoveryCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(b.recoveryCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(a.recoveryCode).not.toBe(b.recoveryCode);
  });

  it('signing in moves the profile and its history, and the code still works', () => {
    // A cookie jar does not cross browsers, so signing in somewhere else is
    // the ordinary case — an invitation tapped in a chat app opens a webview
    // that is not the browser the account was made in. It used to be a one-way
    // transfer that also spent the only credential that could undo it.
    const oldDevice = 'dev_111111111111111111';
    const newDevice = 'dev_222222222222222222';
    init(oldDevice, 'Mover');
    db.recordMatch(win(oldDevice));
    const code = db.getProfile(oldDevice).recoveryCode!;

    const signedIn = db.signInWithCode(code, newDevice);
    expect(signedIn).not.toBeNull();
    expect(signedIn!.id).toBe(newDevice);
    expect(signedIn!.username).toBe('Mover');
    expect(signedIn!.matchesWon).toBe(1);
    // The code is a credential the player keeps, not a one-shot token.
    expect(signedIn!.recoveryCode).toBe(code);
    // Match history followed the move
    const hist = db.getMatchHistory(newDevice);
    expect(hist.length).toBe(1);
    expect(hist[0].winnerId).toBe(newDevice);

    // Both browsers now belong to the account, and the one that handed it
    // over is NOT tombstoned — `released` is the state whose only exit used to
    // be destroying the account.
    expect(db.releasedDevice(oldDevice)).toBeNull();
    expect(db.linkedAccount(oldDevice)).toEqual({ playerId: newDevice, holdsIt: false });
    expect(db.linkedAccount(newDevice)).toEqual({ playerId: newDevice, holdsIt: true });
  });

  it('a browser that has signed in can take the account back with no code', () => {
    const first = 'dev_777777777777777771';
    const second = 'dev_777777777777777772';
    init(first, 'RoamsBack');
    const code = db.getProfile(first).recoveryCode!;
    db.signInWithCode(code, second);
    expect(db.linkedAccount(first)!.holdsIt).toBe(false);

    // Presenting the device cookie of a member IS the credential; the code is
    // what gets a browser into the set, not what it shows every time after.
    const back = db.reclaimLinkedAccount(first, 'ses_000000000000000000000001');
    expect(back).not.toBeNull();
    expect(back!.id).toBe(first);
    expect(back!.username).toBe('RoamsBack');
    expect(db.linkedAccount(second)).toEqual({ playerId: first, holdsIt: false });
    // ...and it can go back and forth, which is the point.
    expect(db.reclaimLinkedAccount(second, null)!.id).toBe(second);
  });

  it('refuses to reclaim for a browser that never signed in', () => {
    expect(db.reclaimLinkedAccount('dev_999999999999999999', null)).toBeNull();
  });

  it('rotating the code retires the old one', () => {
    const dev = 'dev_888888888888888881';
    init(dev, 'Rotator');
    const first = db.getProfile(dev).recoveryCode!;
    const next = db.rotateRecoveryCode(dev);
    expect(next).not.toBe(first);
    expect(db.getProfile(dev).recoveryCode).toBe(next);
    // The retired code no longer opens anything.
    expect(db.profileByRecoveryCode(first)).toBeNull();
    expect(db.profileByRecoveryCode(next!)!.id).toBe(dev);
  });

  it('sign-in accepts unformatted input and rejects unknown codes', () => {
    const dev = 'dev_333333333333333333';
    const target = 'dev_444444444444444444';
    const code = init(dev, 'CaseTest').recoveryCode!;
    const sloppy = code.toLowerCase().replace('-', ' ');
    const claimed = db.signInWithCode(sloppy, target);
    expect(claimed?.username).toBe('CaseTest');
    expect(db.signInWithCode('ZZZZ-ZZZZ', target)).toBeNull();
  });

  it('signing in replaces the throwaway profile already on the device', () => {
    const source = 'dev_555555555555555555';
    const device = 'dev_666666666666666666';
    db.getProfile(device); // uninitialized throwaway
    const code = init(source, 'Keeper').recoveryCode!;
    // Played once, so the claimed profile qualifies for the board — which is
    // what makes the no-duplicate-rows assertion below mean something.
    db.recordMatch({
      playerId: source, username: 'Keeper', playerScore: 5, opponentScore: 1,
      bestStreak: 4, endStreak: 0, earnedStreak: 4, mode: 'multiplayer', isWinner: true,
    } as never);
    const claimed = db.signInWithCode(code, device);
    expect(claimed!.username).toBe('Keeper');
    // The throwaway row is gone (no duplicate ids, leaderboard stays clean)
    const board = db.getLeaderboard('elo', 100);
    expect(board.filter((e) => e.id === device).length).toBe(1);
  });

  it('the avatar follows the profile on sign-in', () => {
    const source = 'dev_aaaaaaaaaaaaaaaa01';
    const device = 'dev_aaaaaaaaaaaaaaaa02';
    init(source, 'AvatarOwner');
    db.setAvatar(source, new Uint8Array([1, 2, 3, 4]));
    const code = db.getProfile(source).recoveryCode!;

    const claimed = db.signInWithCode(code, device);
    expect(claimed!.hasAvatar).toBe(true);
    expect(db.getAvatar(device)).not.toBeNull();
    expect(db.getAvatar(source)).toBeNull();
  });

  it('never leaks recovery codes through the leaderboard', () => {
    const rows = db.getLeaderboard('elo', 100) as unknown as Array<Record<string, unknown>>;
    expect(rows.every((r) => !('recoveryCode' in r))).toBe(true);
  });
});

describe('a rotated signing secret retires every device cookie', () => {
  it('refuses a cookie signed with a different secret', () => {
    // This is the failure behind "my match was not saved". The device cookie
    // is an HMAC over a secret held in the database's meta table, so a reset —
    // or a deploy that loses the data volume — rotates it. The browser keeps
    // sending the old cookie and it stops verifying.
    const deviceId = 'dev_aaaaaaaaaaaaaaaaaa';
    expect(auth.verifyToken(auth.mintToken(deviceId))).toBe(deviceId);

    // Same device id, signed with what a previous secret would have produced.
    const stale = crypto.createHmac('sha256', 'a-previous-secret').update(deviceId).digest('base64url');
    expect(auth.verifyToken(`v1.${deviceId}.${stale}`)).toBeNull();
  });

  it('mints a fresh, UNINITIALIZED identity for an unverifiable cookie', () => {
    // The important half: the replacement identity has no username, so
    // /api/match/record answers 403 PROFILE_NOT_INITIALIZED rather than
    // silently recording against a stranger's profile. The client has to
    // notice that and re-onboard — otherwise every match is lost while the
    // UI still shows the old cached profile.
    expect(auth.deviceIdFromCookieHeader('phong_device=v1.dev_aaaaaaaaaaaaaaaaaa.bogus')).toBeNull();

    const minted = auth.mintDeviceId();
    expect(db.getProfile(minted).initialized).toBe(false);
    expect(() =>
      db.recordMatch({
        playerId: minted,
        username: 'Ghost',
        playerScore: 5,
        opponentScore: 1,
        bestStreak: 8, endStreak: 0, earnedStreak: 8,
        mode: 'solo',
        difficulty: 'pro',
        isWinner: true,
      })
    ).toThrow('PROFILE_NOT_INITIALIZED');
  });
});
