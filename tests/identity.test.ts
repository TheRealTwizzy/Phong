import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
  maxRally: 6,
  mode: 'multiplayer',
  isWinner: true,
});

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

describe('recovery codes and profile transfer', () => {
  it('every new profile gets a well-formed unique code', () => {
    const a = db.getProfile('dev_aaaaaaaaaaaaaaaaaa');
    const b = db.getProfile('dev_bbbbbbbbbbbbbbbbbb');
    expect(a.recoveryCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(b.recoveryCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(a.recoveryCode).not.toBe(b.recoveryCode);
  });

  it('claiming moves the profile, its history, and rotates the code', () => {
    const oldDevice = 'dev_111111111111111111';
    const newDevice = 'dev_222222222222222222';
    const original = db.getProfile(oldDevice, 'Mover');
    db.recordMatch(win(oldDevice));
    const code = db.getProfile(oldDevice).recoveryCode!;

    const claimed = db.claimProfileByCode(code, newDevice);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(newDevice);
    expect(claimed!.username).toBe('Mover');
    expect(claimed!.matchesWon).toBe(1);
    // Code rotated on use
    expect(claimed!.recoveryCode).toBeDefined();
    expect(claimed!.recoveryCode).not.toBe(code);
    // Old device no longer resolves to the moved profile: a fresh one appears
    const fresh = db.getProfile(oldDevice);
    expect(fresh.matchesPlayed).toBe(0);
    expect(fresh.createdAt).not.toBe(original.createdAt);
    // Match history followed the move
    const hist = db.getMatchHistory(newDevice);
    expect(hist.length).toBe(1);
    expect(hist[0].winnerId).toBe(newDevice);
  });

  it('claim accepts unformatted input and rejects unknown codes', () => {
    const dev = 'dev_333333333333333333';
    const target = 'dev_444444444444444444';
    const code = db.getProfile(dev, 'CaseTest').recoveryCode!;
    const sloppy = code.toLowerCase().replace('-', ' ');
    const claimed = db.claimProfileByCode(sloppy, target);
    expect(claimed?.username).toBe('CaseTest');
    expect(db.claimProfileByCode('ZZZZ-ZZZZ', target)).toBeNull();
  });

  it('claiming replaces the throwaway profile already on the device', () => {
    const source = 'dev_555555555555555555';
    const device = 'dev_666666666666666666';
    db.getProfile(device, 'Throwaway');
    const code = db.getProfile(source, 'Keeper').recoveryCode!;
    const claimed = db.claimProfileByCode(code, device);
    expect(claimed!.username).toBe('Keeper');
    // The throwaway row is gone (no duplicate ids, leaderboard stays clean)
    const board = db.getLeaderboard('elo', 100);
    expect(board.filter((e) => e.id === device).length).toBe(1);
  });

  it('never leaks recovery codes through the leaderboard', () => {
    const rows = db.getLeaderboard('elo', 100) as unknown as Array<Record<string, unknown>>;
    expect(rows.every((r) => !('recoveryCode' in r))).toBe(true);
  });
});
