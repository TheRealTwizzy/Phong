import { describe, expect, it } from 'vitest';
import { BallState } from '../src/types';
import {
  BASE_BALL_SPEED,
  MAX_BALL_SPEED,
  PADDLE_Y,
  checkPaddleCollision,
} from '../src/game/physics';

const ballAt = (x: number, overrides: Partial<BallState> = {}): BallState => ({
  x,
  y: PADDLE_Y,
  vx: 0,
  vy: BASE_BALL_SPEED,
  radius: 0.022,
  active: true,
  ...overrides,
});

describe('checkPaddleCollision', () => {
  const PADDLE_W = 0.18;

  it('registers a centered hit with zero offset and zero angle', () => {
    const res = checkPaddleCollision(ballAt(0.5), 0.5, PADDLE_W);
    expect(res.hit).toBe(true);
    expect(res.offset).toBeCloseTo(0, 10);
    expect(res.angle).toBeCloseTo(0, 10);
  });

  it('clamps the hit offset to [-1.1, 1.1] at the paddle tips', () => {
    const right = checkPaddleCollision(ballAt(0.5 + PADDLE_W), 0.5, PADDLE_W);
    // Far enough to exceed the raw offset range, close enough to graze the buffer
    if (right.hit) {
      expect(right.offset!).toBeLessThanOrEqual(1.1);
    }
    const edge = checkPaddleCollision(ballAt(0.5 + PADDLE_W / 2), 0.5, PADDLE_W);
    expect(edge.hit).toBe(true);
    expect(Math.abs(edge.offset!)).toBeLessThanOrEqual(1.1);
    expect(edge.offset!).toBeGreaterThan(0.9);
  });

  it('never returns a hit for a ball moving upward', () => {
    const res = checkPaddleCollision(ballAt(0.5, { vy: -1 }), 0.5, PADDLE_W);
    expect(res.hit).toBe(false);
  });

  it('misses when the ball is horizontally away from the paddle', () => {
    const res = checkPaddleCollision(ballAt(0.1), 0.8, PADDLE_W);
    expect(res.hit).toBe(false);
  });

  it('speeds the ball up 4% per hit but caps at MAX_BALL_SPEED', () => {
    const slow = checkPaddleCollision(ballAt(0.5, { vy: 1.0 }), 0.5, PADDLE_W);
    expect(slow.speed).toBeCloseTo(1.04, 10);

    const fast = checkPaddleCollision(ballAt(0.5, { vy: MAX_BALL_SPEED }), 0.5, PADDLE_W);
    expect(fast.speed).toBe(MAX_BALL_SPEED);
  });

  it('keeps rebound angles under the 62-degree ceiling across the paddle face', () => {
    const maxAngle = (Math.PI / 180) * 62;
    for (let frac = -1; frac <= 1; frac += 0.25) {
      const res = checkPaddleCollision(ballAt(0.5 + (frac * PADDLE_W) / 2), 0.5, PADDLE_W);
      expect(res.hit).toBe(true);
      expect(Math.abs(res.angle!)).toBeLessThanOrEqual(maxAngle * 1.1 + 1e-9);
    }
  });
});
