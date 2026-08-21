import { AVATAR_SIZE, AVATAR_MAX_BYTES } from '../src/profileRules';

// Dependency-free avatar validation. The client normalizes every upload to
// an exactly AVATAR_SIZE × AVATAR_SIZE PNG (center-crop + canvas re-encode),
// so the server only ever needs to understand one format: check the PNG
// signature, find the IHDR chunk that the spec requires first, and read the
// big-endian dimensions out of it.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface AvatarCheck {
  ok: boolean;
  width?: number;
  height?: number;
  code?: 'AVATAR_TOO_LARGE' | 'AVATAR_INVALID';
  message?: string;
}

export function validateAvatarPng(buf: Buffer): AvatarCheck {
  if (buf.length > AVATAR_MAX_BYTES) {
    return {
      ok: false,
      code: 'AVATAR_TOO_LARGE',
      message: `Avatar must be ${Math.round(AVATAR_MAX_BYTES / 1024)}KB or smaller`,
    };
  }
  // 8 signature + 8 IHDR length/type + 13 IHDR data + 4 CRC
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ok: false, code: 'AVATAR_INVALID', message: 'Avatar must be a PNG image' };
  }
  if (buf.toString('latin1', 12, 16) !== 'IHDR') {
    return { ok: false, code: 'AVATAR_INVALID', message: 'Malformed PNG (missing IHDR)' };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== AVATAR_SIZE || height !== AVATAR_SIZE) {
    return {
      ok: false,
      code: 'AVATAR_INVALID',
      message: `Avatar must be exactly ${AVATAR_SIZE}×${AVATAR_SIZE} (got ${width}×${height})`,
    };
  }
  return { ok: true, width, height };
}
