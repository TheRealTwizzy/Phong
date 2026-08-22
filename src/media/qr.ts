// A QR encoder, in the repo, with no dependencies.
//
// The desktop gate has to hand the player a link they can get onto their
// phone, and the only sane way to do that is a QR code. The previous gate
// fetched one from api.qrserver.com, which means every desktop visitor's URL
// — room codes and all — was handed to a third party, the gate broke on any
// network that could not reach them, and what came back was a 200×200 bitmap
// that looks like porridge on a retina display. This produces a matrix; the
// caller renders it as SVG at whatever size it likes, perfectly crisp.
//
// Byte mode only (URLs), versions 1–10, all four ECC levels. That covers any
// URL this game will ever show: version 10 at level M holds 213 bytes.
// Structure follows ISO/IEC 18004 — the tables below are from the standard
// and are verified against an independent encoder in tests/qr.test.ts.

export type EccLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  /** Modules per side. */
  size: number;
  version: number;
  /** Which of the eight mask patterns the penalty rules chose. */
  mask: number;
  /** [row][col], true = dark. */
  modules: boolean[][];
}

const MAX_VERSION = 10;

// [ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords]
type EccSpec = [number, number, number, number, number];

const ECC_TABLE: Record<EccLevel, EccSpec[]> = {
  // Indexed by version - 1.
  L: [
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
  ],
  Q: [
    [13, 1, 13, 0, 0],
    [22, 1, 22, 0, 0],
    [18, 2, 17, 0, 0],
    [26, 2, 24, 0, 0],
    [18, 2, 15, 2, 16],
    [24, 4, 19, 0, 0],
    [18, 2, 14, 4, 15],
    [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17],
    [24, 6, 19, 2, 20],
  ],
  H: [
    [17, 1, 9, 0, 0],
    [28, 1, 16, 0, 0],
    [22, 2, 13, 0, 0],
    [16, 4, 9, 0, 0],
    [22, 2, 11, 2, 12],
    [28, 4, 15, 0, 0],
    [26, 4, 13, 1, 14],
    [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13],
    [28, 6, 15, 2, 16],
  ],
};

/** Alignment pattern centre coordinates, indexed by version - 1. */
const ALIGNMENT_CENTRES: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** Bits of padding after the interleaved codewords, indexed by version - 1. */
const REMAINDER_BITS = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

// ---------------------------------------------------------------------------
// GF(256), primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D).

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function eccCodewords(data: Uint8Array, count: number): Uint8Array {
  const gen = generatorPoly(count);
  const remainder = new Uint8Array(count);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[count - 1] = 0;
    for (let i = 0; i < count; i++) remainder[i] ^= gfMul(gen[i + 1], factor);
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// Bit stream

class BitBuffer {
  readonly bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
}

function dataCapacity(version: number, level: EccLevel): number {
  const [, g1, d1, g2, d2] = ECC_TABLE[level][version - 1];
  return g1 * d1 + g2 * d2;
}

/** Byte mode: 8-bit character count below version 10, 16-bit from 10 up. */
const countBits = (version: number): number => (version < 10 ? 8 : 16);

function chooseVersion(byteLength: number, level: EccLevel): number {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const needed = 4 + countBits(version) + byteLength * 8;
    if (needed <= dataCapacity(version, level) * 8) return version;
  }
  throw new Error(`QR payload too long: ${byteLength} bytes exceeds version ${MAX_VERSION}${level}`);
}

function buildCodewords(bytes: Uint8Array, version: number, level: EccLevel): Uint8Array {
  const capacity = dataCapacity(version, level);
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4); // byte mode
  buffer.push(bytes.length, countBits(version));
  for (const b of bytes) buffer.push(b, 8);

  // Terminator: up to four zero bits, then pad to a byte boundary.
  const terminator = Math.min(4, capacity * 8 - buffer.length);
  buffer.push(0, terminator);
  if (buffer.length % 8) buffer.push(0, 8 - (buffer.length % 8));

  const data = new Uint8Array(capacity);
  for (let i = 0; i < buffer.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | buffer.bits[i + b];
    data[i / 8] = byte;
  }
  // Alternating pad codewords fill whatever is left.
  for (let i = buffer.length / 8; i < capacity; i++) {
    data[i] = i % 2 === (buffer.length / 8) % 2 ? 0xec : 0x11;
  }

  // Split into blocks, error-correct each, then interleave both halves.
  const [ecPerBlock, g1, d1, g2, d2] = ECC_TABLE[level][version - 1];
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < g1 + g2; i++) {
    const size = i < g1 ? d1 : d2;
    const block = data.subarray(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    eccBlocks.push(eccCodewords(block, ecPerBlock));
  }

  const out: number[] = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of eccBlocks) out.push(block[i]);
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Matrix

type Grid = { modules: boolean[][]; reserved: boolean[][]; size: number };

function blankGrid(size: number): Grid {
  const make = () => Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  return { modules: make(), reserved: make(), size };
}

function setModule(grid: Grid, row: number, col: number, dark: boolean, reserve = true): void {
  grid.modules[row][col] = dark;
  if (reserve) grid.reserved[row][col] = true;
}

function drawFinder(grid: Grid, row: number, col: number): void {
  // The 7×7 finder plus its one-module separator, clipped to the grid.
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const y = row + r;
      const x = col + c;
      if (y < 0 || y >= grid.size || x < 0 || x >= grid.size) continue;
      const outerRing = (r === 0 || r === 6) && c >= 0 && c <= 6;
      const sideRing = (c === 0 || c === 6) && r >= 0 && r <= 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      setModule(grid, y, x, outerRing || sideRing || core);
    }
  }
}

function drawAlignment(grid: Grid, version: number): void {
  const centres = ALIGNMENT_CENTRES[version - 1];
  for (const row of centres) {
    for (const col of centres) {
      // The three finder corners already own their neighbourhoods.
      const atFinder =
        (row === 6 && col === 6) ||
        (row === 6 && col === grid.size - 7) ||
        (row === grid.size - 7 && col === 6);
      if (atFinder) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const ring = Math.max(Math.abs(r), Math.abs(c));
          setModule(grid, row + r, col + c, ring !== 1);
        }
      }
    }
  }
}

function drawTiming(grid: Grid): void {
  for (let i = 8; i < grid.size - 8; i++) {
    const dark = i % 2 === 0;
    setModule(grid, 6, i, dark);
    setModule(grid, i, 6, dark);
  }
}

/** BCH(15,5) for the format string, and BCH(18,6) for the version string. */
function bch(value: number, generator: number, dataBits: number, totalBits: number): number {
  let rest = value << (totalBits - dataBits);
  const genBits = 32 - Math.clz32(generator);
  for (let i = totalBits; i >= genBits; i--) {
    if (rest & (1 << (i - 1))) rest ^= generator << (i - genBits);
  }
  return ((value << (totalBits - dataBits)) | rest) >>> 0;
}

function formatBits(level: EccLevel, mask: number): number {
  const data = (ECC_FORMAT_BITS[level] << 3) | mask;
  return (bch(data, 0b10100110111, 5, 15) ^ 0b101010000010010) >>> 0;
}

function reserveFormatAreas(grid: Grid): void {
  const n = grid.size;
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      setModule(grid, 8, i, false);
      setModule(grid, i, 8, false);
    }
  }
  // (8,6) and (6,8) belong to the TIMING patterns, not to the format strings —
  // reserving them here would overwrite two timing modules with light.
  for (let i = 0; i < 8; i++) {
    setModule(grid, 8, n - 1 - i, false);
    setModule(grid, n - 1 - i, 8, false);
  }
  // The one module that is always dark, and never masked.
  setModule(grid, n - 8, 8, true);
}

function drawFormat(grid: Grid, level: EccLevel, mask: number): void {
  const bits = formatBits(level, mask);
  const n = grid.size;
  // Both copies carry all fifteen bits. The vertical strip runs down column 8
  // and continues up the bottom edge; the horizontal one runs in from the
  // right of row 8 and continues at its left end. Column 6 and row 6 are
  // timing and are stepped over, which is what the i<6 / i<8 splits below do.
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;
    if (i < 6) setModule(grid, i, 8, dark);
    else if (i < 8) setModule(grid, i + 1, 8, dark);
    else setModule(grid, n - 15 + i, 8, dark);
  }
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;
    if (i < 8) setModule(grid, 8, n - 1 - i, dark);
    else if (i < 9) setModule(grid, 8, 7, dark);
    else setModule(grid, 8, 14 - i, dark);
  }
  // Written last: the one module that is always dark sits inside the strip
  // the loop above just walked, and must win.
  setModule(grid, n - 8, 8, true);
}

function drawVersion(grid: Grid, version: number): void {
  if (version < 7) return;
  const bits = bch(version, 0b1111100100101, 6, 18);
  const n = grid.size;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + n - 11;
    setModule(grid, a, b, dark);
    setModule(grid, b, a, dark);
  }
}

function placeData(grid: Grid, codewords: Uint8Array, version: number): void {
  const n = grid.size;
  const bits: number[] = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  for (let i = 0; i < REMAINDER_BITS[version - 1]; i++) bits.push(0);

  let index = 0;
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    // The vertical timing pattern occupies column 6; the column pairs step
    // over it rather than through it.
    if (right === 6) right = 5;
    for (let step = 0; step < n; step++) {
      const row = upward ? n - 1 - step : step;
      for (let c = 0; c < 2; c++) {
        const col = right - c;
        if (grid.reserved[row][col]) continue;
        grid.modules[row][col] = index < bits.length && bits[index] === 1;
        index++;
      }
    }
    upward = !upward;
  }
}

const MASKS: Array<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(grid: Grid, mask: number): void {
  for (let r = 0; r < grid.size; r++) {
    for (let c = 0; c < grid.size; c++) {
      if (!grid.reserved[r][c] && MASKS[mask](r, c)) grid.modules[r][c] = !grid.modules[r][c];
    }
  }
}

/** The standard's four penalty rules; the lowest total wins the mask. */
function penalty(grid: Grid): number {
  const n = grid.size;
  const m = grid.modules;
  let score = 0;

  // Rule 1: runs of five or more.
  for (let i = 0; i < n; i++) {
    for (const readRow of [true, false]) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        const cur = readRow ? m[i][j] : m[j][i];
        const prev = readRow ? m[i][j - 1] : m[j - 1][i];
        if (cur === prev) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2: 2×2 blocks of one colour.
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 sequences with four light modules beside them.
  const A = [true, false, true, true, true, false, true, false, false, false, false];
  const B = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (get: (k: number) => boolean, start: number, pattern: boolean[]) => {
    for (let k = 0; k < pattern.length; k++) if (get(start + k) !== pattern[k]) return false;
    return true;
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j + 11 <= n; j++) {
      const row = (k: number) => m[i][k];
      const col = (k: number) => m[k][i];
      if (matches(row, j, A) || matches(row, j, B)) score += 40;
      if (matches(col, j, A) || matches(col, j, B)) score += 40;
    }
  }

  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) dark++;
  const percent = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/**
 * Encode `text` as a QR matrix. Picks the smallest version that fits at the
 * requested error-correction level, and the mask the standard's penalty rules
 * prefer.
 */
export function encodeQr(text: string, level: EccLevel = 'M'): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length, level);
  const codewords = buildCodewords(bytes, version, level);
  const size = 17 + version * 4;

  let best: Grid | null = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    const grid = blankGrid(size);
    drawFinder(grid, 0, 0);
    drawFinder(grid, 0, size - 7);
    drawFinder(grid, size - 7, 0);
    drawAlignment(grid, version);
    drawTiming(grid);
    reserveFormatAreas(grid);
    drawVersion(grid, version);
    placeData(grid, codewords, version);
    applyMask(grid, mask);
    drawFormat(grid, level, mask);
    const score = penalty(grid);
    if (score < bestScore) {
      bestScore = score;
      best = grid;
      bestMask = mask;
    }
  }
  return { size, version, mask: bestMask, modules: best!.modules };
}

/**
 * One SVG path covering every dark module, in a viewBox of `size + 2*quiet`
 * units. A single path keeps the DOM to one node no matter the version, and
 * the caller scales it to any resolution without a bitmap in sight.
 */
export function qrToSvgPath(matrix: QrMatrix, quietZone = 4): string {
  const parts: string[] = [];
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.modules[r][c]) parts.push(`M${c + quietZone} ${r + quietZone}h1v1h-1z`);
    }
  }
  return parts.join('');
}
