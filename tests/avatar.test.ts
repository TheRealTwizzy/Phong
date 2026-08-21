import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateAvatarPng } from '../server/image';
import { AVATAR_SIZE, AVATAR_MAX_BYTES } from '../src/profileRules';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-avatar-test-'));
process.env.DATA_DIR = TMP;

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// Hand-build a minimal PNG header: signature + IHDR with the given
// dimensions (that is all the validator reads), padded to a plausible size.
function makePng(width: number, height: number, totalBytes = 200): Buffer {
  const buf = Buffer.alloc(Math.max(totalBytes, 33));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR data length
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('validateAvatarPng', () => {
  it('accepts an exactly 256×256 PNG', () => {
    const result = validateAvatarPng(makePng(AVATAR_SIZE, AVATAR_SIZE));
    expect(result.ok).toBe(true);
    expect(result.width).toBe(256);
    expect(result.height).toBe(256);
  });

  it('rejects wrong dimensions', () => {
    expect(validateAvatarPng(makePng(300, 300)).code).toBe('AVATAR_INVALID');
    expect(validateAvatarPng(makePng(256, 300)).code).toBe('AVATAR_INVALID');
    expect(validateAvatarPng(makePng(128, 128)).code).toBe('AVATAR_INVALID');
  });

  it('rejects non-PNG bytes (e.g. JPEG magic)', () => {
    const jpeg = Buffer.alloc(200);
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(jpeg, 0);
    expect(validateAvatarPng(jpeg).code).toBe('AVATAR_INVALID');
  });

  it('rejects truncated files and oversized files', () => {
    expect(validateAvatarPng(Buffer.alloc(10)).code).toBe('AVATAR_INVALID');
    const huge = makePng(AVATAR_SIZE, AVATAR_SIZE, AVATAR_MAX_BYTES + 1);
    expect(validateAvatarPng(huge).code).toBe('AVATAR_TOO_LARGE');
  });
});

describe('avatar storage', () => {
  const id = 'dev_aaaaaaaaaaaaaaaa30';

  it('stores, versions, and deletes avatars per player', () => {
    db.getProfile(id);
    db.initializeProfile(id, 'PicPerson');

    expect(db.getProfile(id).hasAvatar).toBe(false);
    const version = db.setAvatar(id, makePng(AVATAR_SIZE, AVATAR_SIZE));
    expect(version).toBeGreaterThan(0);

    const p = db.getProfile(id);
    expect(p.hasAvatar).toBe(true);
    expect(p.avatarVersion).toBe(version);
    expect(db.getAvatar(id)!.data.length).toBeGreaterThan(0);

    db.deleteAvatar(id);
    expect(db.getProfile(id).hasAvatar).toBe(false);
    expect(db.getAvatar(id)).toBeNull();
  });

  it('surfaces avatarVersion on the leaderboard', () => {
    const v = db.setAvatar(id, makePng(AVATAR_SIZE, AVATAR_SIZE));
    const board = db.getLeaderboard('elo', 50);
    const row = board.find((e) => e.id === id)!;
    expect(row.avatarVersion).toBe(v);
  });
});

describe('public profiles', () => {
  it('sanitizes the world-readable view', () => {
    const id = 'dev_aaaaaaaaaaaaaaaa31';
    db.getProfile(id);
    db.initializeProfile(id, 'PublicFigure');

    const pub = db.getPublicProfile(id) as unknown as Record<string, unknown>;
    expect(pub.username).toBe('PublicFigure');
    expect('recoveryCode' in pub).toBe(false);
    expect('lastDailyDate' in pub).toBe(false);
    expect('lastActive' in pub).toBe(false);
  });

  it('hides uninitialized profiles and unknown ids', () => {
    db.getProfile('dev_aaaaaaaaaaaaaaaa32'); // never onboards
    expect(db.getPublicProfile('dev_aaaaaaaaaaaaaaaa32')).toBeNull();
    expect(db.getPublicProfile('dev_does_not_exist_00')).toBeNull();
  });

  it('marks bots', () => {
    db.insertBot({ id: 'bot-test-01', username: 'TestBot', eloRating: 1400 });
    const pub = db.getPublicProfile('bot-test-01')!;
    expect(pub.isBot).toBe(true);
    expect(pub.username).toBe('TestBot');
  });
});
