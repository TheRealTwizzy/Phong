import { describe, expect, it } from 'vitest';
import { LADDER_HIGH_AT, LADDER_MID_AT, ladderStop } from '../src/components/ui/ladderTone';

/**
 * The rank meter is the one bar in the app whose colour is chosen by its VALUE
 * rather than by what it means, so this is the only tone with a rule to state.
 * It lives in its own module for the reason meterMemory.ts does — vitest runs
 * in `node`, and importing ProgressBar to test three comparisons would drag
 * `motion/react` in behind it.
 */

describe('ladderStop', () => {
  it('gives each stop the band it is named for', () => {
    expect(ladderStop(0)).toBe(0);
    expect(ladderStop(0.15)).toBe(0);
    expect(ladderStop(0.5)).toBe(1);
    expect(ladderStop(0.95)).toBe(2);
    expect(ladderStop(1)).toBe(2);
  });

  it('puts each boundary in the band above it', () => {
    // Stated rather than left to the reader: a threshold that belonged to the
    // band BELOW would make a bar at exactly 0.7 the mid colour, and 0.7 is
    // where a tier's meter sits often enough to notice the difference.
    expect(ladderStop(LADDER_MID_AT - 0.0001)).toBe(0);
    expect(ladderStop(LADDER_MID_AT)).toBe(1);
    expect(ladderStop(LADDER_HIGH_AT - 0.0001)).toBe(1);
    expect(ladderStop(LADDER_HIGH_AT)).toBe(2);
  });

  it('reads a value outside the meter as its nearest end', () => {
    expect(ladderStop(-1)).toBe(0);
    expect(ladderStop(4)).toBe(2);
  });

  it('reads a non-finite value as empty rather than as no stop at all', () => {
    // The consequence of getting this wrong is not a wrong colour, it is
    // LADDER[undefined] — a fill painted with no background class, which is an
    // invisible bar rather than a visibly wrong one.
    expect(ladderStop(NaN)).toBe(0);
    expect(ladderStop(Infinity)).toBe(0);
    expect(ladderStop(-Infinity)).toBe(0);
  });

  it('never answers outside the three stops it has', () => {
    for (let v = -0.5; v <= 1.5; v += 0.01) {
      expect([0, 1, 2]).toContain(ladderStop(v));
    }
  });
});
