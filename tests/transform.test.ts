import { describe, expect, it } from 'vitest';
import { transformBallForOpponent } from '../server/transform';

describe('cross-net transform', () => {
  it('mirrors x, negates vx, sends vy downward, flips spin, keeps speed', () => {
    const out = transformBallForOpponent({ x: 0.3, vx: 0.4, vy: -0.5, spin: 0.2, speedMultiplier: 1.5 });
    expect(out.x).toBeCloseTo(0.7, 10);
    expect(out.vx).toBe(-0.4);
    expect(out.vy).toBe(0.5);
    expect(out.spin).toBe(-0.2);
    expect(out.speedMultiplier).toBe(1.5);
  });

  it('always produces a downward vy, whatever the sender reported', () => {
    expect(transformBallForOpponent({ x: 0.5, vx: 0, vy: 0.9 }).vy).toBe(0.9);
    expect(transformBallForOpponent({ x: 0.5, vx: 0, vy: -0.9 }).vy).toBe(0.9);
  });

  it('clamps x into the visible court even for out-of-range input', () => {
    expect(transformBallForOpponent({ x: -0.5, vx: 0, vy: 1 }).x).toBe(0.98);
    expect(transformBallForOpponent({ x: 1.5, vx: 0, vy: 1 }).x).toBe(0.02);
    expect(transformBallForOpponent({ x: 0, vx: 0, vy: 1 }).x).toBe(0.98);
    expect(transformBallForOpponent({ x: 1, vx: 0, vy: 1 }).x).toBe(0.02);
  });

  it('is an involution on interior points: crossing twice returns the original', () => {
    for (const x of [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98]) {
      const once = transformBallForOpponent({ x, vx: 0.3, vy: -0.6, spin: 0.15, speedMultiplier: 1.2 });
      const twice = transformBallForOpponent({ ...once, vy: -once.vy });
      expect(twice.x).toBeCloseTo(x, 10);
      expect(twice.vx).toBeCloseTo(0.3, 10);
      expect(twice.spin).toBeCloseTo(0.15, 10);
      expect(twice.speedMultiplier).toBe(1.2);
    }
  });

  it('defaults spin and speedMultiplier when the client omits them', () => {
    const out = transformBallForOpponent({ x: 0.5, vx: 0.1, vy: 0.2 });
    expect(out.spin).toBe(-0);
    expect(out.speedMultiplier).toBe(1.0);
  });

  // The transform is the last thing between a hostile payload and the
  // opponent's physics loop, and it used to coerce only x. Everything below is
  // about a ball this client did not ask for and cannot refuse.
  describe('a payload the sender made up', () => {
    it('never emits a non-finite component, whatever the field held', () => {
      const junk = ['x', null, undefined, {}, [], NaN, Infinity, '1e999'];
      for (const bad of junk) {
        const out = transformBallForOpponent({
          x: bad as never,
          vx: bad as never,
          vy: bad as never,
          spin: bad as never,
          speedMultiplier: bad as never,
        });
        for (const [field, value] of Object.entries(out)) {
          expect(Number.isFinite(value), `${field} from ${String(bad)}`).toBe(true);
        }
      }
    });

    it('keeps a NaN vy from freezing the receiver forever', () => {
      // `Math.abs('x')` is NaN, and on the receiving court `b.y += NaN * dt`
      // makes every later comparison false — so the ball never bounces, never
      // crosses and never scores, and the point cannot end. The only way out
      // was quitting, which is recorded as an abandon: a real ranked loss for
      // the player who did nothing.
      const out = transformBallForOpponent({ x: 0.5, vx: 0, vy: 'x' as never });
      expect(Number.isFinite(out.vy)).toBe(true);
      expect(out.vy).toBeGreaterThan(0);
    });

    it('gives a stationary ball enough vy to arrive', () => {
      // Zero is the same freeze by another route: a ball that never reaches
      // the far paddle ends the point just as permanently as a NaN one.
      expect(transformBallForOpponent({ x: 0.5, vx: 0, vy: 0 }).vy).toBeGreaterThan(0);
    });

    it('bounds every component, so no single field can be enormous', () => {
      const out = transformBallForOpponent({
        x: 0.5,
        vx: 1e9,
        vy: -1e9,
        spin: 1e9,
        speedMultiplier: 1e9,
      });
      expect(Math.abs(out.vx)).toBeLessThanOrEqual(8);
      expect(out.vy).toBeLessThanOrEqual(8);
      expect(Math.abs(out.spin)).toBeLessThanOrEqual(8);
      expect(out.speedMultiplier).toBeLessThanOrEqual(10);

      const negative = transformBallForOpponent({ x: 0.5, vx: -1e9, vy: 1, spin: -1e9 });
      expect(negative.vx).toBeGreaterThanOrEqual(-8);
      expect(negative.spin).toBeGreaterThanOrEqual(-8);
    });

    it('falls back to mid-court for an unusable x rather than a wall', () => {
      expect(transformBallForOpponent({ x: 'nope' as never, vx: 0, vy: 1 }).x).toBeCloseTo(0.5, 10);
    });

    it('floors a zero or unusable speedMultiplier at something that moves', () => {
      expect(transformBallForOpponent({ x: 0.5, vx: 0, vy: 1, speedMultiplier: 0 }).speedMultiplier)
        .toBe(1);
      expect(
        transformBallForOpponent({ x: 0.5, vx: 0, vy: 1, speedMultiplier: -5 }).speedMultiplier
      ).toBeGreaterThanOrEqual(0.1);
    });
  });
});
