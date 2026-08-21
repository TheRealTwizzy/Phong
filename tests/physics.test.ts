import { describe, expect, it } from 'vitest';
import { AIDifficulty, BallState } from '../src/types';
import {
  BASE_BALL_SPEED,
  MAX_BALL_SPEED,
  PADDLE_WIDTH_RATIO,
  PADDLE_Y,
  OpponentAI,
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

// ---------------------------------------------------------------------------
// The AI must be beatable. This is the regression guard for a shipped bug:
// every difficulty above Rookie used to solve the exact landing point of every
// ball, including wall reflections, and had the paddle speed to get there. Rally
// simulation through the real collision code above measured Pro, Chaos and Cyber
// returning 100% of balls — solo play above Rookie could not be won at all.
// ---------------------------------------------------------------------------

/** Play one ball into the AI's half and report whether it got returned. */
function rally(ai: OpponentAI, speedMultiplier: number, angleDeg: number, seedX: number): boolean {
  const dt = 1 / 60;
  const speed = BASE_BALL_SPEED * speedMultiplier;
  const a = (angleDeg * Math.PI) / 180;
  const ball: BallState = {
    x: seedX,
    y: 0.02,
    vx: Math.sin(a) * speed,
    vy: Math.abs(Math.cos(a) * speed),
    radius: 0.022,
    active: true,
  };
  for (let step = 0; step < 1200; step++) {
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    if (ball.x - ball.radius <= 0) {
      ball.x = ball.radius;
      ball.vx = Math.abs(ball.vx);
    } else if (ball.x + ball.radius >= 1) {
      ball.x = 1 - ball.radius;
      ball.vx = -Math.abs(ball.vx);
    }
    ai.update(ball, dt, PADDLE_WIDTH_RATIO);
    if (checkPaddleCollision(ball, ai.paddleX, PADDLE_WIDTH_RATIO, ai.paddleVx).hit) return true;
    if (ball.y >= 1.05) return false;
  }
  return false;
}

/** AI return rate over a spread of easy, fast and sharply-angled balls. */
function returnRate(difficulty: AIDifficulty, playerMu = 25, n = 240): number {
  const buckets: [number, number][] = [
    [1.0, 10], // slow and shallow
    [2.0, 20], // fast
    [1.4, 55], // sharp angle, forces a wall read
  ];
  let returned = 0;
  let total = 0;
  for (const [speedMultiplier, angle] of buckets) {
    for (let i = 0; i < n; i++) {
      const ai = new OpponentAI(difficulty, playerMu);
      ai.reset();
      if (rally(ai, speedMultiplier, (i % 2 ? 1 : -1) * angle, 0.05 + ((i * 0.137) % 1) * 0.9)) {
        returned++;
      }
      total++;
    }
  }
  return returned / total;
}

const LADDER: AIDifficulty[] = ['rookie', 'pro', 'chaos', 'cyber'];

describe('OpponentAI is beatable at every difficulty', () => {
  it('never returns every ball, not even at the top of the ladder', () => {
    for (const difficulty of LADDER) {
      const rate = returnRate(difficulty);
      // Headroom for a player to actually score. Cyber sits near the ceiling
      // by design, but a perfect wall is not a difficulty setting.
      expect(rate).toBeLessThan(0.95);
    }
  });

  it('lets an average player score against the hardest AI', () => {
    // Nothing subtler than this is worth asserting: the shipped bug was that
    // this number was exactly zero.
    expect(returnRate('cyber')).toBeLessThan(0.95);
    expect(returnRate('chaos')).toBeLessThan(0.95);
  });

  it('orders the ladder: harder difficulties return more balls', () => {
    const rates = LADDER.map((d) => returnRate(d));
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeGreaterThan(rates[i - 1] - 0.03);
    }
    // And the ladder must actually span a range, not four flavours of the same.
    expect(rates[rates.length - 1] - rates[0]).toBeGreaterThan(0.2);
  });

  it('keeps Rookie a warm-up: an average player scores freely', () => {
    expect(returnRate('rookie')).toBeLessThan(0.7);
  });

  it('gets harder as the player gets better, without ever becoming a wall', () => {
    for (const difficulty of LADDER) {
      const vsWeak = returnRate(difficulty, 15);
      const vsStrong = returnRate(difficulty, 40);
      expect(vsStrong).toBeGreaterThan(vsWeak);
      expect(vsStrong).toBeLessThan(0.97);
    }
  });
});
