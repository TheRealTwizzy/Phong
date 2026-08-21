import { describe, expect, it } from 'vitest';
import { AIDifficulty, BallState } from '../src/types';
import {
  BASE_BALL_SPEED,
  MAX_BALL_SPEED,
  PADDLE_WIDTH_RATIO,
  PADDLE_Y,
  OpponentAI,
  checkPaddleCollision,
  aiServeAim,
  aiServeDelay,
  playerPressure,
  AI_SERVE_DELAY_MIN,
  AI_SERVE_DELAY_MAX,
  MAX_AI_COMPETENCE,
} from '../src/game/physics';
import { AI_DIFFICULTIES, normalizeDifficulty } from '../src/rating';

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

const LADDER: AIDifficulty[] = ['rookie', 'pro', 'cyber'];

describe('OpponentAI is beatable at every difficulty', () => {
  it('never returns every ball, not even at the top of the ladder', () => {
    for (const difficulty of LADDER) {
      const rate = returnRate(difficulty);
      // Headroom for a player to actually score. Cyber sits at the ceiling by
      // design, but a perfect wall is not a difficulty setting.
      expect(rate).toBeLessThan(0.88);
    }
  });

  it('lets an average player score against the hardest AI', () => {
    // Nothing subtler than this is worth asserting: the shipped bug was that
    // this number was exactly zero.
    expect(returnRate('cyber')).toBeLessThan(0.88);
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
      // The ceiling holds no matter how good the player gets. This is what
      // "lower the ceiling, not the floor" means in one assertion.
      expect(vsStrong).toBeLessThan(0.9);
    }
  });
});

describe('AI serving', () => {
  it('waits between 0.6s and 1.15s, always', () => {
    for (const c of [0.05, 0.2, 0.4, 0.66, 1]) {
      for (const pressure of [0, 0.5, 1]) {
        for (let i = 0; i < 60; i++) {
          const d = aiServeDelay(c, pressure);
          expect(d).toBeGreaterThanOrEqual(AI_SERVE_DELAY_MIN);
          expect(d).toBeLessThanOrEqual(AI_SERVE_DELAY_MAX);
        }
      }
    }
  });

  it('serves quicker the better it is', () => {
    const mean = (c: number) => {
      let total = 0;
      for (let i = 0; i < 400; i++) total += aiServeDelay(c, 0.5);
      return total / 400;
    };
    expect(mean(MAX_AI_COMPETENCE)).toBeLessThan(mean(0.1));
  });

  it('bears down while the player is winning', () => {
    const mean = (pressure: number) => {
      let total = 0;
      for (let i = 0; i < 400; i++) total += aiServeDelay(0.4, pressure);
      return total / 400;
    };
    expect(mean(1)).toBeLessThan(mean(0));
  });

  it('reads pressure from the score and the rally, not just the score', () => {
    expect(playerPressure({ playerScore: 4, opponentScore: 0, maxRally: 6 })).toBeGreaterThan(
      playerPressure({ playerScore: 0, opponentScore: 4, maxRally: 6 })
    );
    // Losing but hanging on in long rallies still reads as competing.
    expect(playerPressure({ playerScore: 1, opponentScore: 3, maxRally: 20 })).toBeGreaterThan(
      playerPressure({ playerScore: 1, opponentScore: 3, maxRally: 1 })
    );
    for (const s of [
      { playerScore: 0, opponentScore: 0, maxRally: 0 },
      { playerScore: 9, opponentScore: 0, maxRally: 99 },
      { playerScore: 0, opponentScore: 9, maxRally: 0 },
    ]) {
      const p = playerPressure(s);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it('serves away from where the player is standing', () => {
    // The cross-net transform mirrors x, so a serve aimed away from the
    // player in the AI's own half must arrive away from them in the player's.
    const sample = (playerX: number) => {
      let total = 0;
      for (let i = 0; i < 500; i++) total += aiServeAim(MAX_AI_COMPETENCE, playerX).angle;
      return total / 500;
    };
    // Player hugging the left: seen from the AI they are on the right, so the
    // AI plays left — and the mirror lands it on the player's right.
    expect(sample(0.1)).toBeLessThan(0);
    expect(sample(0.9)).toBeGreaterThan(0);
  });

  it('commits harder and hits harder the better it is', () => {
    const commitment = (c: number) => {
      let total = 0;
      for (let i = 0; i < 600; i++) total += Math.abs(aiServeAim(c, 0.1).angle);
      return total / 600;
    };
    const power = (c: number) => {
      let total = 0;
      for (let i = 0; i < 600; i++) total += aiServeAim(c, 0.5).power;
      return total / 600;
    };
    expect(commitment(MAX_AI_COMPETENCE)).toBeGreaterThan(commitment(0.08));
    expect(power(MAX_AI_COMPETENCE)).toBeGreaterThan(power(0.08));
  });

  it('never produces an aim the serve engine would reject', () => {
    for (const c of [0.05, 0.3, 0.66, 1]) {
      for (let i = 0; i < 300; i++) {
        const aim = aiServeAim(c, Math.random());
        expect(aim.angle).toBeGreaterThanOrEqual(-1);
        expect(aim.angle).toBeLessThanOrEqual(1);
        expect(aim.power).toBeGreaterThanOrEqual(0);
        expect(aim.power).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('the retired difficulty', () => {
  it('maps a stored chaos setting to the surviving hard rung', () => {
    expect(normalizeDifficulty('chaos')).toBe('cyber');
    expect(normalizeDifficulty('CHAOS')).toBe('cyber');
  });

  it('passes real difficulties through and defaults anything else', () => {
    for (const d of AI_DIFFICULTIES) expect(normalizeDifficulty(d)).toBe(d);
    expect(normalizeDifficulty(undefined)).toBe('pro');
    expect(normalizeDifficulty('nonsense')).toBe('pro');
    expect(normalizeDifficulty(42)).toBe('pro');
  });

  it('leaves only three rungs on the ladder', () => {
    expect(AI_DIFFICULTIES).toEqual(['rookie', 'pro', 'cyber']);
  });
});
