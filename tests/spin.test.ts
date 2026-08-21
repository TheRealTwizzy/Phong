import { describe, expect, it } from 'vitest';
import { BallState } from '../src/types';
import {
  DRIVE_SPEED_GAIN,
  HEAD_ON_COUPLING,
  PADDLE_REFERENCE_SPEED,
  PADDLE_WIDTH_RATIO,
  PADDLE_Y,
  SPIN_MAX,
  SPIN_WALL_RETENTION,
  OpponentAI,
  bounceOffWall,
  checkPaddleCollision,
  driveCoupling,
  predictLanding,
} from '../src/game/physics';
import { transformBallForOpponent } from '../server/transform';

const HALF = PADDLE_WIDTH_RATIO / 2;

// A ball arriving at the paddle, `offset` of the way toward its right tip.
const arriving = (offset: number): BallState => ({
  x: 0.5 + offset * HALF,
  y: PADDLE_Y,
  vx: 0,
  vy: 0.9,
  radius: 0.022,
  active: true,
});

const hitWith = (offset: number, paddleVx: number) =>
  checkPaddleCollision(arriving(offset), 0.5, PADDLE_WIDTH_RATIO, paddleVx);

describe('paddle velocity finally does something', () => {
  it('is inert when the paddle is still — the old game, exactly', () => {
    const still = hitWith(0.5, 0);
    expect(still.hit).toBe(true);
    expect(still.spin).toBe(0);
    // Angle comes from the contact point alone, as it always did.
    expect(still.angle).toBeCloseTo(0.5 * ((Math.PI / 180) * 62), 6);
  });

  it('couples more at the edge than head-on', () => {
    // The rule the mechanic is built on: a dead-centre hit is a clean rebound
    // and barely carries the paddle's motion; an edge brushes, and carries it.
    const headOn = Math.abs(driveCoupling(PADDLE_REFERENCE_SPEED, 0));
    const edge = Math.abs(driveCoupling(PADDLE_REFERENCE_SPEED, 1));
    expect(edge).toBeGreaterThan(headOn);
    expect(headOn).toBeCloseTo(HEAD_ON_COUPLING, 6);
    expect(edge).toBeCloseTo(1, 6);
  });

  it('couples more the faster the paddle is moving', () => {
    const slow = Math.abs(driveCoupling(PADDLE_REFERENCE_SPEED * 0.25, 0.8));
    const fast = Math.abs(driveCoupling(PADDLE_REFERENCE_SPEED, 0.8));
    expect(fast).toBeGreaterThan(slow);
  });

  it('imparts spin in the direction of the swing', () => {
    expect(hitWith(0.8, PADDLE_REFERENCE_SPEED).spin).toBeGreaterThan(0);
    expect(hitWith(0.8, -PADDLE_REFERENCE_SPEED).spin).toBeLessThan(0);
  });

  it('imparts more spin at the edge than head-on, at the same paddle speed', () => {
    const headOn = Math.abs(hitWith(0, PADDLE_REFERENCE_SPEED).spin!);
    const edge = Math.abs(hitWith(1, PADDLE_REFERENCE_SPEED).spin!);
    expect(edge).toBeGreaterThan(headOn);
  });

  it('adds pace when driving through, and never breaks the speed cap', () => {
    const still = hitWith(0.6, 0).speed!;
    const driven = hitWith(0.6, PADDLE_REFERENCE_SPEED).speed!;
    expect(driven).toBeGreaterThan(still);
    expect(driven / still).toBeLessThanOrEqual(1 + DRIVE_SPEED_GAIN + 1e-6);
  });

  it('never exceeds the spin cap however hard the paddle is swung', () => {
    for (const vx of [-99, -10, 10, 99]) {
      for (const offset of [-1.1, -0.5, 0, 0.5, 1.1]) {
        const spin = hitWith(offset, vx).spin!;
        expect(Math.abs(spin)).toBeLessThanOrEqual(SPIN_MAX + 1e-9);
      }
    }
  });

  it('keeps the rebound inside the legal angle range', () => {
    const maxAngle = (Math.PI / 180) * 62;
    for (const vx of [-99, 0, 99]) {
      for (const offset of [-1.1, 0, 1.1]) {
        expect(Math.abs(hitWith(offset, vx).angle!)).toBeLessThanOrEqual(maxAngle + 1e-9);
      }
    }
  });
});

describe('spin acts on impacts, never on the flight', () => {
  it('leaves a ball with no spin travelling exactly straight', () => {
    // The model in one assertion: between impacts, spin does nothing at all.
    // Position is integrated from velocity alone, so a spinning ball and an
    // unspun one on the same velocity land in the same place until something
    // is struck.
    const straight = predictLanding({ x: 0.5, y: 0.02, vx: 0, vy: 1, radius: 0.022, spin: 0 });
    const spun = predictLanding({ x: 0.5, y: 0.02, vx: 0, vy: 1, radius: 0.022, spin: SPIN_MAX });
    expect(spun).toBeCloseTo(straight, 6);
    expect(spun).toBeCloseTo(0.5, 6);
  });

  it('tilts the angle a ball leaves the wall at', () => {
    const plain = bounceOffWall(-0.5, 0.8, 0, true);
    const spun = bounceOffWall(-0.5, 0.8, SPIN_MAX, true);
    const angleOf = (r: { vx: number; vy: number }) => Math.atan2(r.vx, r.vy);
    expect(angleOf(spun)).not.toBeCloseTo(angleOf(plain), 3);
    // Opposite spin tilts the other way.
    const other = bounceOffWall(-0.5, 0.8, -SPIN_MAX, true);
    expect(Math.sign(angleOf(spun) - angleOf(plain))).toBe(
      -Math.sign(angleOf(other) - angleOf(plain))
    );
  });

  it('preserves speed across a wall rebound', () => {
    for (const spin of [-SPIN_MAX, -0.5, 0, 0.5, SPIN_MAX]) {
      const before = Math.hypot(-0.6, 0.9);
      const after = bounceOffWall(-0.6, 0.9, spin, true);
      expect(Math.hypot(after.vx, after.vy)).toBeCloseTo(before, 6);
    }
  });

  it('always turns the ball away from the wall it hit', () => {
    for (const spin of [-SPIN_MAX, 0, SPIN_MAX]) {
      expect(bounceOffWall(-0.6, 0.9, spin, true).vx).toBeGreaterThan(0);
      expect(bounceOffWall(0.6, 0.9, spin, false).vx).toBeLessThan(0);
    }
  });

  it('reverses and damps spin across a wall rebound, never amplifying', () => {
    expect(bounceOffWall(-0.5, 0.8, 1, true).spin).toBeCloseTo(SPIN_WALL_RETENTION, 6);
    expect(Math.abs(bounceOffWall(-0.5, 0.8, 1, true).spin)).toBeLessThan(1);
    expect(bounceOffWall(-0.5, 0.8, 0, true).spin).toBeCloseTo(0, 10);
    expect(Math.abs(bounceOffWall(-0.5, 0.8, SPIN_MAX * 10, true).spin)).toBeLessThanOrEqual(
      SPIN_MAX
    );
  });

  it('tilts the angle a ball leaves the PADDLE at, by the spin it arrived with', () => {
    const still = { x: 0.5, y: PADDLE_Y, vx: 0, vy: 0.9, radius: 0.022, active: true };
    const plain = checkPaddleCollision({ ...still, spin: 0 }, 0.5, PADDLE_WIDTH_RATIO, 0);
    const right = checkPaddleCollision({ ...still, spin: SPIN_MAX }, 0.5, PADDLE_WIDTH_RATIO, 0);
    const left = checkPaddleCollision({ ...still, spin: -SPIN_MAX }, 0.5, PADDLE_WIDTH_RATIO, 0);
    expect(right.angle!).toBeGreaterThan(plain.angle!);
    expect(left.angle!).toBeLessThan(plain.angle!);
  });

  it('carries part of the incoming spin through the contact, reversed', () => {
    const arrivingSpun = { x: 0.5, y: PADDLE_Y, vx: 0, vy: 0.9, radius: 0.022, active: true, spin: 1 };
    const out = checkPaddleCollision(arrivingSpun, 0.5, PADDLE_WIDTH_RATIO, 0);
    expect(out.spin!).toBeLessThan(0);
    expect(Math.abs(out.spin!)).toBeLessThan(1);
  });
});

describe('predictLanding is the shared source of truth', () => {
  it('folds a wall rebound instead of running off the court', () => {
    const landing = predictLanding({ x: 0.5, y: 0.02, vx: -1.4, vy: 1, radius: 0.022, spin: 0 });
    expect(landing).toBeGreaterThanOrEqual(0);
    expect(landing).toBeLessThanOrEqual(1);
  });

  it('differs by the spin factor only when a wall is actually struck', () => {
    // No wall on the way: the read cannot matter.
    const noWall = { x: 0.5, y: 0.02, vx: 0.05, vy: 1.2, radius: 0.022, spin: SPIN_MAX };
    expect(predictLanding(noWall, 0)).toBeCloseTo(predictLanding(noWall, 1), 6);

    // A wall on the way: reading the spin changes where you expect the ball.
    const wall = { x: 0.5, y: 0.02, vx: -1.5, vy: 0.9, radius: 0.022, spin: SPIN_MAX };
    expect(Math.abs(predictLanding(wall, 0) - predictLanding(wall, 1))).toBeGreaterThan(0.01);
  });

  it('returns the ball position for a ball that is not coming', () => {
    expect(predictLanding({ x: 0.3, y: 0.5, vx: 0.2, vy: 0, radius: 0.022 })).toBe(0.3);
    expect(predictLanding({ x: 0.3, y: 0.5, vx: 0.2, vy: -1, radius: 0.022 })).toBe(0.3);
  });
});

describe('spin survives the net', () => {
  it('mirrors with the court, so a curve keeps its direction on screen', () => {
    // x is mirrored across the net, so the spin has to flip with it or a ball
    // curving right for one player would curve left for the other.
    const crossed = transformBallForOpponent({ x: 0.3, vx: 0.4, vy: -0.8, spin: 0.7 });
    expect(crossed.spin).toBeCloseTo(-0.7, 10);
    expect(transformBallForOpponent({ x: 0.3, vx: 0, vy: -1, spin: 0 }).spin).toBeCloseTo(0, 10);
  });

  it('round-trips back to the original after two crossings', () => {
    const once = transformBallForOpponent({ x: 0.3, vx: 0.4, vy: -0.8, spin: 0.7 });
    const twice = transformBallForOpponent({ ...once, vy: -Math.abs(once.vy) });
    expect(twice.spin).toBeCloseTo(0.7, 10);
  });

  it('treats a ball with no spin field as unspun', () => {
    expect(transformBallForOpponent({ x: 0.5, vx: 0, vy: -1 }).spin).toBeCloseTo(0, 10);
  });
});

describe('spin reading as a difficulty lever', () => {
  // Under the impact-only model spin acts ONLY where a surface is struck, so
  // its effect on an AI shows up as prediction error on balls that rebound off
  // a side wall. That is measured directly here: predictLanding(ball, factor)
  // with factor 1 is the true landing point, and a lower factor is what an AI
  // that reads less of the spin expects instead.
  const wallBound = (dir: number, spin: number) => ({
    x: 0.5,
    y: 0.02,
    vx: dir * 1.3,
    vy: 0.95,
    radius: 0.022,
    spin,
  });

  const readError = (factor: number, spin: number) => {
    let total = 0;
    let n = 0;
    for (const dir of [-1, 1]) {
      const ball = wallBound(dir, spin);
      total += Math.abs(predictLanding(ball, factor) - predictLanding(ball, 1));
      n++;
    }
    return total / n;
  };

  it('leaves an AI that reads less of the spin further from the truth', () => {
    const barelyReads = readError(0.18, SPIN_MAX * 0.75); // about Rookie
    const mostlyReads = readError(0.7, SPIN_MAX * 0.75); // about Cyber
    expect(barelyReads).toBeGreaterThan(mostlyReads);
    expect(mostlyReads).toBeGreaterThan(0); // capped read: nobody is exempt
  });

  it('costs nothing at all when there is no spin to read', () => {
    expect(readError(0, 0)).toBeCloseTo(0, 10);
    expect(readError(1, SPIN_MAX)).toBeCloseTo(0, 10);
  });

  it('grows with the spin on the ball', () => {
    expect(readError(0.18, SPIN_MAX)).toBeGreaterThan(readError(0.18, SPIN_MAX * 0.3));
  });

  it('never turns any difficulty into a wall or a pushover', () => {
    // End to end through the real AI and the real collision code, averaged
    // over both wall sides and a spread of entry angles so no single geometry
    // biases the result.
    const dt = 1 / 60;
    const rate = (playAt: number, spin: number) => {
      let returned = 0;
      let n = 0;
      for (let i = 0; i < 600; i++) {
        const ai = new OpponentAI('pro', 25);
        Object.defineProperty(ai, 'effectiveMu', { value: () => playAt, configurable: true });
        ai.reset();
        const ball: BallState = {
          x: 0.2 + ((i * 0.137) % 1) * 0.6,
          y: 0.02,
          vx: (i % 2 ? 1 : -1) * (0.2 + ((i * 0.211) % 1) * 1.2),
          vy: 0.95,
          radius: 0.022,
          active: true,
          spin,
        };
        let hit = false;
        for (let step = 0; step < 1500 && !hit; step++) {
          ball.x += ball.vx * dt;
          ball.y += ball.vy * dt;
          if (ball.x - ball.radius <= 0 || ball.x + ball.radius >= 1) {
            const atLeft = ball.x - ball.radius <= 0;
            ball.x = atLeft ? ball.radius : 1 - ball.radius;
            const bounced = bounceOffWall(ball.vx, ball.vy, ball.spin, atLeft);
            ball.vx = bounced.vx;
            ball.vy = bounced.vy;
            ball.spin = bounced.spin;
          }
          ai.update(ball, dt, PADDLE_WIDTH_RATIO);
          if (checkPaddleCollision(ball, ai.paddleX, PADDLE_WIDTH_RATIO, ai.paddleVx).hit) hit = true;
          else if (ball.y >= 1.05) break;
        }
        n++;
        if (hit) returned++;
      }
      return returned / n;
    };

    for (const playAt of [18, 25, 29]) {
      for (const spin of [-SPIN_MAX, 0, SPIN_MAX]) {
        const r = rate(playAt, spin);
        expect(r).toBeGreaterThan(0.3);
        expect(r).toBeLessThan(0.9);
      }
    }
  });
});
