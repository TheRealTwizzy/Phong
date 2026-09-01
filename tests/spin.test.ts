import { describe, expect, it } from 'vitest';
import { BallState } from '../src/types';
import {
  DRIVE_SPEED_GAIN,
  HEAD_ON_COUPLING,
  PADDLE_REFERENCE_SPEED,
  PADDLE_WIDTH_RATIO,
  MAX_BALL_SPEED,
  PADDLE_Y,
  SPIN_MAX,
  SPIN_WALL_RETENTION,
  OpponentAI,
  bounceOffWall,
  checkPaddleCollision,
  bounceOffReturnLine,
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

  it('preserves speed across a wall rebound when there is no spin to spend', () => {
    const before = Math.hypot(-0.6, 0.9);
    const after = bounceOffWall(-0.6, 0.9, 0, true);
    expect(Math.hypot(after.vx, after.vy)).toBeCloseTo(before, 6);
  });

  it('trades spin for pace off a wall, in both directions', () => {
    // Spin does not only shape the angle: a ball spinning the way it comes off
    // the wall skids on, one spinning against itself is scrubbed. Both are the
    // same impact — the flight either side of it is still perfectly straight.
    const before = Math.hypot(-0.6, 0.9);
    const speedOf = (spin: number) => {
      const r = bounceOffWall(-0.6, 0.9, spin, true);
      return Math.hypot(r.vx, r.vy);
    };
    // Off the LEFT wall the ball leaves rightward, so positive spin runs with it.
    expect(speedOf(SPIN_MAX)).toBeGreaterThan(before);
    expect(speedOf(-SPIN_MAX)).toBeLessThan(before);
    expect(speedOf(SPIN_MAX)).toBeGreaterThan(speedOf(0.5));
    expect(speedOf(-SPIN_MAX)).toBeLessThan(speedOf(-0.5));
  });

  it('changes pace by the same amount on either half of the court', () => {
    // server/transform.ts mirrors x and flips both vx and spin across the net.
    // The pace trade has to survive that, or the two phones would disagree
    // about how fast the ball is now travelling.
    const here = bounceOffWall(-0.6, 0.9, 0.8, true);
    const mirrored = bounceOffWall(0.6, 0.9, -0.8, false);
    expect(Math.hypot(mirrored.vx, mirrored.vy)).toBeCloseTo(
      Math.hypot(here.vx, here.vy),
      10
    );
  });

  it('cannot be spun faster and faster off alternating walls', () => {
    // Every rebound is held inside the match's own speed band, so a ball with
    // the maximum spin converges on the cap instead of running away.
    let vx = -0.6;
    let vy = 0.9;
    for (let i = 0; i < 40; i++) {
      const atLeft = vx < 0;
      // Re-spin to the maximum in the helpful direction every single time:
      // the worst case a player could ever produce, and still bounded.
      const spin = atLeft ? SPIN_MAX : -SPIN_MAX;
      const r = bounceOffWall(vx, vy, spin, atLeft);
      expect(Math.hypot(r.vx, r.vy)).toBeLessThanOrEqual(MAX_BALL_SPEED + 1e-9);
      // Send it straight back at the other wall for the next rebound.
      vx = -r.vx;
      vy = r.vy;
    }
  });

  it('trades spin for pace at the paddle too', () => {
    // Same rule at the other surface, measured against the direction the
    // rebound angle sends the ball. Caught off-centre so it leaves sideways.
    const arriving = (spin: number) => ({
      x: 0.5 + PADDLE_WIDTH_RATIO * 0.3,
      y: PADDLE_Y,
      vx: 0,
      vy: 0.9,
      radius: 0.022,
      active: true,
      spin,
    });
    const plain = checkPaddleCollision(arriving(0), 0.5, PADDLE_WIDTH_RATIO, 0);
    const with_ = checkPaddleCollision(arriving(SPIN_MAX), 0.5, PADDLE_WIDTH_RATIO, 0);
    const against = checkPaddleCollision(arriving(-SPIN_MAX), 0.5, PADDLE_WIDTH_RATIO, 0);
    expect(with_.speed!).toBeGreaterThan(plain.speed!);
    expect(against.speed!).toBeLessThan(plain.speed!);
    expect(with_.speed!).toBeLessThanOrEqual(MAX_BALL_SPEED);
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

    // The five anchors of the ladder as it now stands, not the three it had:
    // driving only up to mu 29 would leave the top two rungs unguarded by the
    // very rule this test states.
    //
    // NOTE the bounds are wider than the ladder simulation's in
    // physics.test.ts, and deliberately so: this geometry is easier. Every
    // ball here enters at vy 0.95 on a shallow angle, where that one samples
    // a fast bucket and a sharply angled one as well, so the same AI returns
    // more of them (mu 36 measures 0.873-0.968 here against 0.880-0.906
    // there, over 40 repeats). The binding ceiling rule lives beside the
    // harder sample; what THIS bound catches is a literal wall — a spin read
    // that made some difficulty return everything, or nothing.
    for (const playAt of [20, 24, 30, 33, 36]) {
      for (const spin of [-SPIN_MAX, 0, SPIN_MAX]) {
        const r = rate(playAt, spin);
        expect({ playAt, spin, pushover: r <= 0.3 }).toEqual({ playAt, spin, pushover: false });
        expect({ playAt, spin, wall: r >= 0.98 }).toEqual({ playAt, spin, wall: false });
      }
    }
  });
});

describe('the Practice Wall return line spends spin like any other surface', () => {
  // It was the one surface that did not: `b.vy = Math.abs(b.vy)` and nothing
  // else, so a spun ball came off the net in Practice exactly as it went in
  // while every wall and paddle in the game reversed, damped and traded it.
  const arriving = { vx: 0.4, vy: -1.4 };

  it('reverses and damps the spin', () => {
    const out = bounceOffReturnLine(arriving.vx, arriving.vy, SPIN_MAX);
    expect(Math.sign(out.spin)).toBe(-Math.sign(SPIN_MAX));
    expect(Math.abs(out.spin)).toBeLessThan(SPIN_MAX);
  });

  it('sends the ball back down the court', () => {
    const out = bounceOffReturnLine(arriving.vx, arriving.vy, 0);
    expect(Math.sign(out.vy)).toBe(1);
  });

  it('tilts the rebound sideways, which is what spin buys on a surface', () => {
    const plain = bounceOffReturnLine(0, -1.4, 0);
    const right = bounceOffReturnLine(0, -1.4, SPIN_MAX);
    const left = bounceOffReturnLine(0, -1.4, -SPIN_MAX);
    expect(right.vx).not.toBeCloseTo(plain.vx, 3);
    expect(Math.sign(right.vx)).toBe(-Math.sign(left.vx));
  });

  it('stays inside the match speed band', () => {
    for (const ballSpeedMax of [1, 1.5, 2]) {
      const out = bounceOffReturnLine(2, -4, SPIN_MAX, { ballSpeedMax });
      expect(Math.hypot(out.vx, out.vy)).toBeLessThanOrEqual(MAX_BALL_SPEED * ballSpeedMax + 1e-9);
    }
  });
});
