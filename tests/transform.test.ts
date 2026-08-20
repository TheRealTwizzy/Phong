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
});
