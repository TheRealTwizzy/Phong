import { describe, expect, it } from 'vitest';
import {
  BAND_OPEN_MS,
  BAND_TIGHT_MS,
  BAND_WIDE_MS,
  Candidate,
  OPEN_BAND,
  TIGHT_BAND,
  WIDE_BAND,
  bandFor,
  findPair,
} from '../server/matchmaking';
import { START_MU, START_SIGMA, winProbability } from '../src/rating';

// Who the queue pairs, and how hard it insists.
//
// The brief asked for two things a low-population server cannot both have —
// "never match unless the win chance is 40-60% for both" and "always find
// another player" — so the band is a target held for the first ninety seconds
// rather than an absolute. These tests pin BOTH halves of that trade: the
// promise while it holds, and the fact that it eventually gives.

const at = (mu: number, joinedAt = 0, rttMs: number | null = null): Candidate => ({
  deviceId: `d${mu}-${joinedAt}-${rttMs}`,
  mu,
  sigma: START_SIGMA,
  joinedAt,
  rttMs,
});

describe('bandFor', () => {
  it('insists on a coin flip for the first half-minute', () => {
    expect(bandFor(0)).toEqual(TIGHT_BAND);
    expect(bandFor(BAND_TIGHT_MS - 1)).toEqual(TIGHT_BAND);
    // A negative wait is not a thing, and must not read as "waited forever".
    expect(bandFor(-5000)).toEqual(TIGHT_BAND);
  });

  it("holds the brief's own 40-60 for the minute after that", () => {
    expect(bandFor(BAND_TIGHT_MS)).toEqual(WIDE_BAND);
    expect(bandFor(BAND_WIDE_MS - 1)).toEqual(WIDE_BAND);
  });

  it('slides open past 90 seconds rather than stepping', () => {
    // Stepping would pair somebody against a wall of a player the instant a
    // threshold passed. Halfway through the slide is halfway between.
    const half = bandFor((BAND_WIDE_MS + BAND_OPEN_MS) / 2);
    expect(half.lo).toBeCloseTo((WIDE_BAND.lo + OPEN_BAND.lo) / 2, 6);
    expect(half.hi).toBeCloseTo((WIDE_BAND.hi + OPEN_BAND.hi) / 2, 6);
    expect(half.lo).toBeGreaterThan(OPEN_BAND.lo);
    expect(half.lo).toBeLessThan(WIDE_BAND.lo);
  });

  it('stops widening, and never inverts', () => {
    expect(bandFor(BAND_OPEN_MS)).toEqual(OPEN_BAND);
    expect(bandFor(BAND_OPEN_MS * 100)).toEqual(OPEN_BAND);
    for (const ms of [0, 1000, 29_999, 30_000, 89_999, 120_000, 180_000, 10 ** 7]) {
      const band = bandFor(ms);
      expect({ ms, ok: band.lo < 0.5 && band.hi > 0.5 && band.lo < band.hi }).toEqual({
        ms,
        ok: true,
      });
    }
  });

  it('only ever widens as the wait grows', () => {
    let prev = bandFor(0);
    for (let ms = 0; ms <= BAND_OPEN_MS * 2; ms += 500) {
      const band = bandFor(ms);
      expect(band.lo).toBeLessThanOrEqual(prev.lo + 1e-9);
      expect(band.hi).toBeGreaterThanOrEqual(prev.hi - 1e-9);
      prev = band;
    }
  });
});

describe('findPair', () => {
  it('pairs nobody out of an empty or lone queue', () => {
    expect(findPair([], 0)).toBe(null);
    expect(findPair([at(START_MU)], 60_000)).toBe(null);
  });

  it('pairs two even players immediately', () => {
    const pair = findPair([at(START_MU, 0), at(START_MU, 0)], 1000);
    expect(pair).not.toBe(null);
    expect(winProbability(pair![0], pair![1])).toBeCloseTo(0.5, 6);
  });

  it('refuses a mismatch while the tight band holds, and takes it later', () => {
    // The whole trade in one test. A wide gap is outside the coin-flip band,
    // so a fresh queue declines it — and a queue that has waited long enough
    // takes it rather than leaving both players with no game at all.
    const queue = [at(START_MU - 4, 0), at(START_MU + 4, 0)];
    expect(winProbability(queue[0], queue[1])).toBeLessThan(TIGHT_BAND.lo);
    expect(findPair(queue, 1000)).toBe(null);
    expect(findPair(queue, BAND_TIGHT_MS + 1000)).toBe(null); // still outside 40-60
    expect(findPair(queue, BAND_OPEN_MS + 1000)).not.toBe(null);
  });

  it('judges the band on the player who has waited longer', () => {
    // The point of widening is to get a game to somebody who has been waiting
    // for one. Judging on the NEWCOMER's own tight band would let a fresh
    // arrival veto the very pairing the wait was widening toward.
    const now = BAND_OPEN_MS + 5000;
    const veteran = at(START_MU - 4, 0);
    const newcomer = at(START_MU + 4, now);
    expect(findPair([veteran, newcomer], now)).not.toBe(null);
  });

  it('prefers the closest to a coin flip among everyone inside the band', () => {
    const now = 1000;
    const me = at(START_MU, 0);
    const near = at(START_MU + 0.2, 0);
    const far = at(START_MU + 2.5, 0);
    const pair = findPair([me, far, near], now);
    expect(pair).not.toBe(null);
    expect(new Set([pair![0].deviceId, pair![1].deviceId])).toEqual(
      new Set([me.deviceId, near.deviceId])
    );
  });

  it('breaks a tie on the better connection, and an unknown RTT does not win by default', () => {
    const now = 1000;
    const me = at(START_MU, 0);
    // Identical ratings, so identical fairness: only the connection separates
    // them.
    const laggy = { ...at(START_MU, 0, 300), deviceId: 'laggy' };
    const quick = { ...at(START_MU, 0, 30), deviceId: 'quick' };
    const unknown = { ...at(START_MU, 0, null), deviceId: 'unknown' };
    const pair = findPair([me, laggy, unknown, quick], now);
    expect(pair![1].deviceId).toBe('quick');
  });

  it('drains the queue in the order it filled', () => {
    // Otherwise somebody can be permanently unlucky: a queue that always
    // starts from the newest arrival never reaches the person at the back.
    const now = 10_000;
    const oldest = { ...at(START_MU, 0), deviceId: 'oldest' };
    const middle = { ...at(START_MU, 2000), deviceId: 'middle' };
    const newest = { ...at(START_MU, 4000), deviceId: 'newest' };
    const pair = findPair([newest, middle, oldest], now);
    expect(pair![0].deviceId).toBe('oldest');
  });

  it('always pairs two candidates who are inside the band', () => {
    // The property that matters more than any individual preference: if a
    // legal pairing exists, the queue must not sit on it.
    for (let gap = 0; gap <= 4; gap += 0.25) {
      const queue = [at(START_MU - gap / 2, 0), at(START_MU + gap / 2, 0)];
      const p = winProbability(queue[0], queue[1]);
      const legal = p >= TIGHT_BAND.lo && p <= TIGHT_BAND.hi;
      expect({ gap, paired: findPair(queue, 1000) !== null }).toEqual({ gap, paired: legal });
    }
  });
});
