import { deflateSync } from 'node:zlib';
import { AVATAR_SIZE } from '../src/profileRules';

// The one avatar every play-bot wears.
//
// §4.11 makes the BOT badge a disclosure requirement — a bot's profile must
// never imply a human is behind it — and that used to be carried twice over,
// because `RallyNNBot` disclosed in the name itself on every surface a name
// reaches. Human-looking handles take that away, and most of those surfaces
// (the in-match opponent label, the lobby, the result strip, the denormalized
// names in match history) have no badge. So the avatar is the visual tell, and
// it ships in the same commit as the names or the product has quietly stopped
// disclosing.
//
// GENERATED, not a checked-in base64 literal. `node:zlib` is built in and a
// PNG is four chunks, so this costs a CRC table and a scanline loop — against
// an unreviewable blob in a repo whose `public/` holds two SVGs and nothing
// else, where nobody could later tell whether it had been swapped. It is the
// same instinct `server/image.ts` already follows on the reading side.
//
// It is written to the `avatars` table per bot rather than synthesized at the
// route, so `rowToProfile` derives `hasAvatar`/`avatarVersion` from the LEFT
// JOIN exactly as it does for a person and every surface lights up with no
// client change. A synthesized response would need the same question answered
// in `readProfile`, `getLeaderboard` and `GET /api/avatar/:id` separately,
// which is how this feature's own catalogue says failures happen. The cost is
// one copy of a few KB per bot against a 512KB per-avatar limit.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type+data. */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

type Rgb = readonly [number, number, number];

// The field `AvatarImage` already falls back to — its gradient runs accent to
// indigo — so the tile reads as a deliberate sibling of the placeholder rather
// than a foreign asset dropped in beside it.
const BG_TOP: Rgb = [0x3f, 0x3c, 0xbb];
const BG_BOTTOM: Rgb = [0x24, 0x60, 0xb8];
const SHELL: Rgb = [0xe6, 0xed, 0xf7];
const VISOR: Rgb = [0x11, 0x18, 0x2c];
const EYE: Rgb = [0x7d, 0xe8, 0xff];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/**
 * Inside a rounded rectangle, in pixel space.
 *
 * Corners are tested against the circle centred on each corner's inset point,
 * which is the whole of "rounded" — no anti-aliasing, deliberately: flat
 * colour is what makes the file deflate to a couple of KB, and the image is
 * only ever drawn at 32-40px on a phone.
 */
function inRoundRect(
  x: number,
  y: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  r: number
): boolean {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = x < left + r ? left + r : x > right - r ? right - r : x;
  const cy = y < top + r ? top + r : y > bottom - r ? bottom - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function draw(size: number): Buffer {
  // One filter byte (0, "none") per scanline plus RGBA. Filtering would shrink
  // it further and this is already a few KB of flat colour.
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(stride * size);
  const u = size / 256; // the geometry below is written at 256 and scaled

  const headL = 62 * u;
  const headR = 194 * u;
  const headT = 84 * u;
  const headB = 196 * u;

  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      let c = mix(BG_TOP, BG_BOTTOM, y / (size - 1));

      // Antenna: a stem and a bead above the head.
      const stem = Math.abs(x - size / 2) <= 4 * u && y >= 46 * u && y <= headT;
      const bead = (x - size / 2) ** 2 + (y - 44 * u) ** 2 <= (13 * u) ** 2;
      if (stem || bead) c = SHELL;

      if (inRoundRect(x, y, headL, headT, headR, headB, 30 * u)) c = SHELL;

      // Visor, inset, with two eyes in it.
      if (inRoundRect(x, y, 82 * u, 104 * u, 174 * u, 154 * u, 18 * u)) {
        c = VISOR;
        const eyeY = 129 * u;
        const dxL = x - 108 * u;
        const dxR = x - 148 * u;
        const dy = y - eyeY;
        if (dxL * dxL + dy * dy <= (11 * u) ** 2 || dxR * dxR + dy * dy <= (11 * u) ** 2) c = EYE;
      }

      // Mouth slot.
      if (inRoundRect(x, y, 100 * u, 168 * u, 156 * u, 178 * u, 5 * u)) c = VISOR;

      const p = row + 1 + x * 4;
      raw[p] = c[0];
      raw[p + 1] = c[1];
      raw[p + 2] = c[2];
      raw[p + 3] = 255;
    }
  }
  return raw;
}

function build(size: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(draw(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let cached: Buffer | null = null;

/**
 * The shared robot avatar, as PNG bytes.
 *
 * Memoised at module scope so every bot stores byte-identical data and the
 * image is built once per process. Returns a copy, because the caller hands it
 * to a BLOB bind and a shared mutable Buffer escaping into a database layer is
 * the kind of thing that is fine until it is not.
 */
export function botAvatarPng(): Buffer {
  cached ??= build(AVATAR_SIZE);
  return Buffer.from(cached);
}
