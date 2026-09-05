import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AIDifficulty, BallState } from '../src/types';
import { effectiveAiMu } from '../src/rating';
import {
  BOT_MAX_COMPETENCE,
  lapseForCompetence,
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
  competenceForMu,
  aimFromPush,
  serveVelocity,
  SERVE_BALL_Y,
  SERVE_MIN_POWER,
  minBallSpeedFor,
  maxBallSpeedFor,
  SERVE_MAX_POWER,
  PADDLE_HEIGHT,
  AIM_FULL_PUSH,
  AIM_DEADZONE,
  SERVE_MAX_ANGLE_DEG,
  SPIN_MAX,
  MAX_REBOUND_ANGLE_DEG,
  AI_AGGRESSION_ANGLE_DEG,
  BALL_BASE_RADIUS,
  MAX_PHYSICS_SUBSTEPS,
  physicsSubsteps,
  bounceOffWall,
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

  it('measures the spin pace against the angle the BIAS produced, not the one before it', () => {
    // The AI's aggression used to be applied to the returned angle, in
    // App.tsx, after this function had already decided the pace. That pace is
    // signed: spinPace adds or scrubs up to SPIN_PADDLE_SPEED_GAIN according
    // to the sign of the direction the ball leaves in. So a bias that pushed a
    // shallow return ACROSS the zero-angle axis — which is precisely what
    // aggression is for — left the speed measured against a direction the ball
    // was no longer travelling, and a spun ball got a boost where it should
    // have been scrubbed.
    //
    // A ball hit just right of centre leaves at a small positive angle; a
    // negative bias takes it to a real negative one. With spin on the ball the
    // pace must follow the SECOND sign.
    // The bias is the largest the AI can actually apply, not a magic number,
    // so this stays a statement about the real lever.
    const bias = (AI_AGGRESSION_ANGLE_DEG * Math.PI) / 180;
    const spun = () => ballAt(0.5 + PADDLE_W * 0.05, { spin: SPIN_MAX * 0.2 });
    const plain = checkPaddleCollision(spun(), 0.5, PADDLE_W);
    const pushed = checkPaddleCollision(spun(), 0.5, PADDLE_W, 0, -bias);

    // The bias really did cross the axis, or this test proves nothing.
    expect(plain.angle!).toBeGreaterThan(0);
    expect(pushed.angle!).toBeLessThan(0);

    // Positive spin leaving rightward skids on; the same spin leaving leftward
    // is scrubbed. Both are the same contact, so the difference is the sign.
    expect(pushed.speed!).toBeLessThan(plain.speed!);
  });

  it('bounds a biased angle by the same rebound limit as an unbiased one', () => {
    const hard = checkPaddleCollision(ballAt(0.5 + PADDLE_W / 2), 0.5, PADDLE_W, 0, 1.5);
    expect(Math.abs(hard.angle!)).toBeLessThanOrEqual((Math.PI / 180) * MAX_REBOUND_ANGLE_DEG + 1e-9);
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

const LADDER: AIDifficulty[] = ['rookie', 'pro', 'elite', 'cyber', 'chaos'];

/**
 * The sample every bound below is set from.
 *
 * The AI rolls its reads PER RALLY, so a return rate is a sample and every
 * assertion on one is really an assertion about a distribution. At the
 * default sample (720 balls) the top rungs range 0.861-0.925 across repeats,
 * which is wide enough to straddle any bound worth stating — that is how the
 * ceiling rule below arrived as a CI failure reading `expected 0.9 to be less
 * than 0.9`. At 2160 balls the same population measures 0.877-0.909.
 *
 * So the rates are measured ONCE, at the bigger sample, and shared by every
 * rule that reads them. That is cheaper than re-sampling per assertion AND
 * more coherent: the rules are then all talking about the same measurement
 * rather than about independent draws that can disagree with each other.
 */
const BIG = 720;
const RATE: Record<AIDifficulty, number> = Object.fromEntries(
  LADDER.map((d) => [d, returnRate(d, 25, BIG)])
) as Record<AIDifficulty, number>;

/**
 * The hard ceiling rule, in one place.
 *
 * The clamp moved UP with the five-rung ladder (0.66 -> 0.78), a deliberate
 * reversal of the cut that answered "an adapted Cyber returning 93% makes the
 * top rung a lottery on its own error". The reversal is kept honest here: the
 * top of the ladder measures ~0.90 at this sample and may never reach 0.93.
 * Margin to the observed maximum is ~0.02, roughly three times the spread.
 */
const CEILING = 0.93;

describe('OpponentAI is beatable at every difficulty', () => {
  it('never returns every ball, not even at the top of the ladder', () => {
    for (const difficulty of LADDER) {
      expect({ difficulty, wall: RATE[difficulty] >= CEILING }).toEqual({ difficulty, wall: false });
    }
  });

  it('lets an average player score against the hardest AI', () => {
    // Nothing subtler than this is worth asserting: the shipped bug was that
    // this number was exactly zero.
    expect(RATE.chaos).toBeLessThan(CEILING);
    expect(RATE.chaos).toBeGreaterThan(0.3);
  });

  it('orders the ladder: harder difficulties return more balls', () => {
    const rates = LADDER.map((d) => RATE[d]);
    // Rookie through Cyber are ordered by raw strength. CHAOS is the one rung
    // NOT asserted into that chain at the same tolerance: at the competence
    // clamp its volatility can only swing downward, so it measures within
    // noise of Cyber in balls returned (0.877-0.909 against 0.880-0.906 over
    // 25 repeats) — its extra difficulty is aggression, serve pace and the
    // anchor the ladder rates it at, none of which this metric sees.
    for (let i = 1; i < rates.length - 1; i++) {
      expect(rates[i]).toBeGreaterThan(rates[i - 1] - 0.03);
    }
    expect(rates[rates.length - 1]).toBeGreaterThan(rates[rates.length - 2] - 0.05);
    // And the ladder must actually span a range, not five flavours of the
    // same. Measured spread rookie->chaos is ~0.19; the bound sits well below
    // that rather than beside it, because what is asserted is that the rungs
    // are genuinely far apart and a collapsed ladder would score near zero.
    expect(rates[rates.length - 1] - rates[0]).toBeGreaterThan(0.11);
  });

  it('keeps Rookie a warm-up: an average player scores freely', () => {
    // Rookie measures 0.711-0.744 over 2160 balls across 25 repeats. Both
    // bounds sit well outside that range rather than beside the mean — see
    // the note on measuring a distribution before picking one in TESTING.md.
    expect(RATE.rookie).toBeLessThan(0.78);
  });

  it('will not let Rookie sink back into an empty half-court', () => {
    // The other half of the same rule, and the one that was missing. Rookie
    // used to return under 60% of balls: an average player took roughly seven
    // matches in eight off it, which is not a warm-up, it is an opponent who
    // is not there. Nothing here may drift back below that.
    expect(RATE.rookie).toBeGreaterThan(0.66);
  });

  it('makes Pro a real step up from Rookie', () => {
    // Pro measures 0.783-0.811 over 2160 balls across 25 repeats.
    expect(RATE.pro).toBeGreaterThan(0.755);
  });

  it('gets harder as the player gets better, without ever becoming a wall', () => {
    for (const difficulty of LADDER) {
      // The DIFFERENCE here is large by construction — the adaptation band is
      // 20 mu wide downward — so the default sample carries it. The ceiling
      // check beside it is the tight one, so it gets the big sample.
      const vsWeak = returnRate(difficulty, 15);
      const vsStrong = returnRate(difficulty, 40, BIG);
      expect(vsStrong).toBeGreaterThan(vsWeak);
      // The ceiling holds no matter how good the player gets: an adapted top
      // rung plays the competence clamp and never past it. Measured
      // 0.879-0.909 for an adapted Chaos against a mu-40 player.
      expect({ difficulty, wall: vsStrong >= CEILING }).toEqual({ difficulty, wall: false });
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

  it('picks a side at random when the player is covering the middle', () => {
    // A player on dead centre has left neither side open, and a bare `> 0.5`
    // resolved that tie the same way every time — so the first AI serve of
    // every match, taken against a paddle still on its starting 0.5, went
    // predictably to one side.
    let left = 0;
    let right = 0;
    for (let i = 0; i < 400; i++) {
      // Full competence so commitment dominates the noise and the side the
      // AI CHOSE is the sign of the angle.
      const angle = aiServeAim(MAX_AI_COMPETENCE, 0.5).angle;
      if (angle < 0) left++;
      else if (angle > 0) right++;
    }
    expect(left).toBeGreaterThan(120);
    expect(right).toBeGreaterThan(120);
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

// The serving joystick's contract. This mapping used to live inside the canvas
// component, where the only thing that could observe it was a browser driving
// a real drag; it is a rule, so it is stated here instead.
//
// It is a POLAR joystick: the direction of the drag is the direction the ball
// leaves in and its length is the power. What it replaced decomposed the drag
// into independent axes — sideways for angle, upward for power — and threw
// downward travel away, so a pull did nothing at all.
const degOf = (aim: { angle: number }, limitDeg = SERVE_MAX_ANGLE_DEG) => aim.angle * limitDeg;

describe('the ball waiting to be served', () => {
  it('rests clear of the paddle face and inside the court', () => {
    // Held ON the paddle, not inside it: the drawn ball and the launched one
    // are the same ball, so a hold point under the face would serve from
    // inside the paddle it just left.
    expect(SERVE_BALL_Y).toBeLessThan(PADDLE_Y - PADDLE_HEIGHT / 2);
    // And close enough to read as held rather than as a ball already in play.
    expect(PADDLE_Y - PADDLE_HEIGHT / 2 - SERVE_BALL_Y).toBeLessThan(0.05);
    expect(SERVE_BALL_Y).toBeGreaterThan(0);
  });
});

describe('aimFromPush', () => {
  it('returns nothing inside the deadzone, which is what keeps tap-to-serve', () => {
    expect(aimFromPush(0, 0)).toBeNull();
    expect(aimFromPush(AIM_DEADZONE * 0.5, 0)).toBeNull();
    expect(aimFromPush(0, -AIM_DEADZONE * 0.9)).toBeNull();
    // A pull is inside the same circle: the deadzone is a radius, not a half.
    expect(aimFromPush(0, AIM_DEADZONE * 0.9)).toBeNull();
    // And is an aim the moment the drag clears it, either way.
    expect(aimFromPush(0, -AIM_DEADZONE * 1.5)).not.toBeNull();
    expect(aimFromPush(0, AIM_DEADZONE * 1.5)).not.toBeNull();
  });

  it('reads power off the DISTANCE dragged, whichever way it went', () => {
    expect(aimFromPush(0, -AIM_FULL_PUSH)!.power).toBeCloseTo(1, 10);
    expect(aimFromPush(0, -AIM_FULL_PUSH / 2)!.power).toBeCloseTo(0.5, 10);
    // A pull reaches full power exactly as a push does. It used to be pinned
    // at zero, which is what made pulling a no-op.
    expect(aimFromPush(0, AIM_FULL_PUSH)!.power).toBeCloseTo(1, 10);
    expect(aimFromPush(0, AIM_FULL_PUSH / 2)!.power).toBeCloseTo(0.5, 10);
    // Diagonally too: it is the hypotenuse, not either axis on its own.
    const diag = AIM_FULL_PUSH / Math.SQRT2;
    expect(aimFromPush(diag, -diag)!.power).toBeCloseTo(1, 10);
  });

  it('serves along the direction dragged, in degrees off straight up', () => {
    expect(degOf(aimFromPush(0, -AIM_FULL_PUSH)!)).toBeCloseTo(0, 10);
    const diag = AIM_FULL_PUSH / Math.SQRT2;
    expect(degOf(aimFromPush(diag, -diag)!)).toBeCloseTo(45, 10);
    expect(degOf(aimFromPush(-diag, -diag)!)).toBeCloseTo(-45, 10);
    // A 30° push is a 30° serve, not a fraction of the sideways reach.
    const rad = (30 * Math.PI) / 180;
    const push = aimFromPush(Math.sin(rad) * 0.2, -Math.cos(rad) * 0.2)!;
    expect(degOf(push)).toBeCloseTo(30, 10);
  });

  it('reads a drag BELOW the anchor as a slingshot, inverted through it', () => {
    // Pull down-right, serve up-left: the ball goes where the player aimed it,
    // not where their thumb ended up.
    for (const [dx, dy] of [
      [0.1, -0.15],
      [-0.05, -0.3],
      [0.22, -0.02],
    ]) {
      const push = aimFromPush(dx, dy)!;
      const pull = aimFromPush(-dx, -dy)!;
      expect(pull.angle).toBeCloseTo(push.angle, 10);
      expect(pull.power).toBeCloseTo(push.power, 10);
    }
    // Concretely, with the anchor down-right of the thumb's destination.
    expect(degOf(aimFromPush(0, AIM_FULL_PUSH)!)).toBeCloseTo(0, 10);
    const diag = AIM_FULL_PUSH / Math.SQRT2;
    expect(degOf(aimFromPush(diag, diag)!)).toBeCloseTo(-45, 10);
  });

  it('treats a flat sideways drag as a push, and clamps it to the limit', () => {
    expect(aimFromPush(AIM_FULL_PUSH, 0)!.angle).toBe(1);
    expect(aimFromPush(-AIM_FULL_PUSH, 0)!.angle).toBe(-1);
  });

  it('clamps power past full reach, so the ring being the edge is the truth', () => {
    const far = aimFromPush(AIM_FULL_PUSH * 4, -AIM_FULL_PUSH * 4)!;
    expect(far.power).toBe(1);
    // Dragging FURTHER does not swing the aim: 45° is 45°, at any distance.
    expect(degOf(far)).toBeCloseTo(45, 10);
    expect(degOf(aimFromPush(AIM_FULL_PUSH / 8, -AIM_FULL_PUSH / 8)!)).toBeCloseTo(45, 10);
  });

  it('clamps the angle only past the limit, not past full reach', () => {
    // Just inside the limit is reported exactly; beyond it pins to the edge.
    const nearRad = ((SERVE_MAX_ANGLE_DEG - 5) * Math.PI) / 180;
    const near = aimFromPush(Math.sin(nearRad) * 0.3, -Math.cos(nearRad) * 0.3)!;
    expect(degOf(near)).toBeCloseTo(SERVE_MAX_ANGLE_DEG - 5, 10);
    const pastRad = ((SERVE_MAX_ANGLE_DEG + 20) * Math.PI) / 180;
    expect(aimFromPush(Math.sin(pastRad) * 0.3, -Math.cos(pastRad) * 0.3)!.angle).toBe(1);
    expect(aimFromPush(-AIM_FULL_PUSH * 4, 0)!.angle).toBe(-1);
  });

  // The angle is measured against what THIS match allows, not the stock 55°,
  // so the line the player follows is the line the ball takes at every rule
  // setting. Clamping against the constant would compress or stretch the aim
  // the moment `serveAngleMax` was not 1.
  it('round-trips through serveVelocity at any serve-angle rule', () => {
    const rad = (25 * Math.PI) / 180;
    const drag: [number, number] = [Math.sin(rad) * 0.2, -Math.cos(rad) * 0.2];
    for (const serveAngleMax of [0.8, 1, 1.2]) {
      const limit = SERVE_MAX_ANGLE_DEG * serveAngleMax;
      const aim = aimFromPush(drag[0], drag[1], limit)!;
      const v = serveVelocity(aim, { serveAngleMax });
      expect((Math.atan2(v.vx, -v.vy) * 180) / Math.PI).toBeCloseTo(25, 6);
    }
  });

  it('serves straight up when the rules forbid any deflection at all', () => {
    // `serveAngleMax` floors at 0, and that is a serve up the middle rather
    // than a division by zero.
    const aim = aimFromPush(AIM_FULL_PUSH, -AIM_FULL_PUSH, 0)!;
    expect(aim.angle).toBe(0);
    expect(aim.power).toBe(1);
  });

  it('never serves anywhere but into the opponent\'s half', () => {
    for (let i = 0; i < 200; i++) {
      const dx = (Math.random() - 0.5) * 2;
      const dy = (Math.random() - 0.5) * 2;
      const aim = aimFromPush(dx, dy);
      if (!aim) continue;
      expect(serveVelocity(aim).vy).toBeLessThan(0);
    }
  });
});

describe('difficulty normalization', () => {
  // 'chaos' is a REVIVED name: it used to be retired and mapped to 'cyber'
  // here. Legacy rows were relabelled once by chaos_relabel_v1 (see
  // tests/chaosRelabel.test.ts); a 'chaos' arriving now means the top rung.
  it('passes real difficulties through and defaults anything else', () => {
    for (const d of AI_DIFFICULTIES) expect(normalizeDifficulty(d)).toBe(d);
    expect(normalizeDifficulty('CHAOS')).toBe('chaos');
    expect(normalizeDifficulty(undefined)).toBe('pro');
    expect(normalizeDifficulty('nonsense')).toBe('pro');
    expect(normalizeDifficulty(42)).toBe('pro');
  });

  it('carries all five rungs on the ladder', () => {
    expect(AI_DIFFICULTIES).toEqual(['rookie', 'pro', 'elite', 'cyber', 'chaos']);
  });
});


describe('physicsSubsteps keeps the ball inside the paddle it is passing', () => {
  // The rule the whole substep exists for: whatever the frame and whatever the
  // rules, one integration step must never carry the ball further than the
  // window the paddle can catch it in. A point-sampled test that jumps further
  // than its own window does not miss OCCASIONALLY, it misses a fixed fraction
  // of sub-frame phases — measured at 43% for a stock ball at the speed cap
  // and the frame clamp.
  const catchWindow = (radius: number) => PADDLE_HEIGHT + 2 * radius;

  it('never steps further than the catch window, across the whole legal envelope', () => {
    // ballScale bottoms out at 0.6 (the smallest window) and ballSpeedMax tops
    // out at 2 — and a wall rebound is not held to that cap, so the envelope is
    // taken to double it again rather than to the nominal maximum.
    const radii = [BALL_BASE_RADIUS * 0.6, BALL_BASE_RADIUS, BALL_BASE_RADIUS * 1.8];
    const speeds = [0.5, 1, BASE_BALL_SPEED, MAX_BALL_SPEED, MAX_BALL_SPEED * 2, MAX_BALL_SPEED * 4];
    // 1/120 is a fast phone, 1/60 an ordinary one, 0.05 the frame clamp.
    const dts = [1 / 240, 1 / 120, 1 / 60, 1 / 30, 0.05];

    for (const radius of radii) {
      for (const speed of speeds) {
        for (const dt of dts) {
          const steps = physicsSubsteps(speed, dt, radius);
          expect(steps).toBeGreaterThanOrEqual(1);
          expect(steps).toBeLessThanOrEqual(MAX_PHYSICS_SUBSTEPS);
          expect((speed * dt) / steps).toBeLessThanOrEqual(catchWindow(radius));
        }
      }
    }
  });

  it('does not substep a ball that is not going anywhere', () => {
    expect(physicsSubsteps(0, 1 / 60, BALL_BASE_RADIUS)).toBe(1);
    expect(physicsSubsteps(BASE_BALL_SPEED, 0, BALL_BASE_RADIUS)).toBe(1);
  });

  it('returns a usable count for junk rather than looping forever', () => {
    expect(physicsSubsteps(Number.NaN, 1 / 60, BALL_BASE_RADIUS)).toBe(1);
    expect(physicsSubsteps(Number.POSITIVE_INFINITY, 1 / 60, BALL_BASE_RADIUS)).toBe(1);
    expect(physicsSubsteps(-5, 1 / 60, BALL_BASE_RADIUS)).toBeGreaterThanOrEqual(1);
    expect(physicsSubsteps(BASE_BALL_SPEED, -1, BALL_BASE_RADIUS)).toBe(1);
  });

  it('a swept flight catches a contact a single jump passes through', () => {
    // The concrete failure: one integration at the speed cap over a clamped
    // frame steps from clear above the paddle to past the baseline, and the
    // point sample in between never happens.
    const radius = BALL_BASE_RADIUS;
    const dt = 0.05;
    const speed = MAX_BALL_SPEED;
    const paddleX = 0.5;

    const sample = (y: number) =>
      checkPaddleCollision(
        { x: paddleX, y, vx: 0, vy: speed, radius, spin: 0, active: true } as BallState,
        paddleX,
        PADDLE_WIDTH_RATIO,
        0
      ).hit;

    const startY = PADDLE_Y - PADDLE_HEIGHT / 2 - radius - 0.004;
    expect(sample(startY)).toBe(false);
    // One jump: straight past the whole window.
    expect(sample(startY + speed * dt)).toBe(false);

    // Swept: at least one step lands inside it.
    const steps = physicsSubsteps(speed, dt, radius);
    const hits = Array.from({ length: steps }, (_, i) => sample(startY + speed * (dt / steps) * (i + 1)));
    expect(hits.some(Boolean)).toBe(true);
  });
});

describe('the paddle obeys the match speed band', () => {
  // CLAUDE.md §3 promises "every rebound is held inside the match's own speed
  // band". `bounceOffWall` has taken the rules since spin shipped and
  // `checkPaddleCollision` did not, so the wall let a rally climb to
  // `MAX_BALL_SPEED * ballSpeedMax` while every paddle contact snapped it back
  // to the stock 2.4 — a rule that only ever made the game slower, and only in
  // one half of the rally.
  const arriving = (speed: number) =>
    ({
      x: 0.5,
      y: PADDLE_Y - PADDLE_HEIGHT / 2,
      vx: 0,
      vy: speed,
      radius: BALL_BASE_RADIUS,
      spin: 0,
      active: true,
    }) as BallState;

  it('still caps at the stock ceiling when the rules are stock', () => {
    const stock = checkPaddleCollision(arriving(MAX_BALL_SPEED), 0.5, PADDLE_WIDTH_RATIO, 0, 0, {});
    expect(stock.speed).toBeCloseTo(MAX_BALL_SPEED, 10);
  });

  it('behaves exactly as before when given no rules at all', () => {
    const bare = checkPaddleCollision(arriving(MAX_BALL_SPEED), 0.5, PADDLE_WIDTH_RATIO);
    expect(bare.speed).toBe(MAX_BALL_SPEED);
  });

  it('lets a raised ceiling actually raise it', () => {
    const fast = checkPaddleCollision(arriving(MAX_BALL_SPEED), 0.5, PADDLE_WIDTH_RATIO, 0, 0, {
      ballSpeedMax: 2,
    });
    expect(fast.speed).toBeGreaterThan(MAX_BALL_SPEED);
    expect(fast.speed).toBeLessThanOrEqual(MAX_BALL_SPEED * 2 + 1e-9);
  });

  it('agrees with the wall about where the ceiling is', () => {
    // The two surfaces disagreeing is the whole bug: a ball could be sped up
    // by a wall past a ceiling the paddle would then pull it back under.
    for (const ballSpeedMax of [1, 1.2, 1.5, 2]) {
      const rules = { ballSpeedMax };
      const paddle = checkPaddleCollision(arriving(MAX_BALL_SPEED * 4), 0.5, PADDLE_WIDTH_RATIO, 0, 0, rules);
      expect(paddle.speed).toBeLessThanOrEqual(MAX_BALL_SPEED * ballSpeedMax + 1e-9);
      const wall = bounceOffWall(-MAX_BALL_SPEED * 4, 0.1, 0, true, rules);
      expect(Math.hypot(wall.vx, wall.vy)).toBeLessThanOrEqual(MAX_BALL_SPEED * ballSpeedMax + 1e-9);
    }
  });
});

describe('every paddle contact in the app is told the match rules', () => {
  // `checkPaddleCollision`'s cap is the LAST word on a contact: called without
  // rules it pins the ball to the stock `MAX_BALL_SPEED`, and the
  // `clampBallSpeed` that follows each call site clamps into [min, max], so it
  // can raise a slow ball to the floor but can never restore a ceiling the
  // contact already took away. A call site that forgets the argument therefore
  // fails exactly the way the asymmetry this parameter exists to remove failed:
  // silently, in one half of the rally, only on a non-stock band.
  //
  // Nothing else can see this. `tsc` accepts the short call because the
  // parameter is optional, and the tests above call the function directly, so
  // they stay green while the game does not. Reading the source is what the
  // stylesheet, schema and `t()` checks elsewhere in this suite do for the same
  // reason: the fact under test lives at a call site, not behind an export.
  const CALLERS = ['src/App.tsx', 'src/components/SplitScreenMatch.tsx'];

  /** The argument list of every `checkPaddleCollision(` call in `src`, by balanced parens. */
  function callArgs(src: string): string[] {
    const calls: string[] = [];
    const needle = 'checkPaddleCollision(';
    for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
      let depth = 0;
      let i = at + needle.length - 1;
      for (; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')' && --depth === 0) break;
      }
      calls.push(src.slice(at + needle.length, i));
    }
    return calls;
  }

  it('finds the calls at all, so a rename cannot make this vacuous', () => {
    const found = CALLERS.flatMap((f) => callArgs(readFileSync(resolve(__dirname, '..', f), 'utf8')));
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  it.each(CALLERS)('%s passes the rules to every contact', (file) => {
    for (const args of callArgs(readFileSync(resolve(__dirname, '..', file), 'utf8'))) {
      expect(args).toMatch(/rulesRef\.current|activeRules/);
    }
  });
});

describe('the split-screen mirror is in Y alone', () => {
  // Split screen is ONE screen, not two phones head to head, so the transform
  // that lets player 2's paddle reuse the half-court routine flips y and vy and
  // leaves world x alone. Everything along x therefore passes through
  // untouched — the paddle's own velocity going in, the `sin(angle)` coming
  // back — while spin FLIPS, because a reflection reverses the sense of a
  // rotation. Negating the paddle velocity instead made player 2's drive push
  // the ball the opposite way from their swipe.
  const arriving = (vy: number, spin = 0) =>
    ({
      x: 0.5,
      y: PADDLE_Y - PADDLE_HEIGHT / 2,
      vx: 0,
      vy,
      radius: BALL_BASE_RADIUS,
      spin,
      active: true,
    }) as BallState;

  /**
   * What the split-screen loop does for player 2, as one function. The ball
   * starts where a ball reaching the TOP paddle actually is — mirroring one
   * already sitting on the bottom paddle line lands it at the far end of the
   * court, where nothing is hit and every sign test passes on a zero.
   */
  const p2Return = (paddleVx: number) => {
    const b = { ...arriving(-0.9), y: 1 - (PADDLE_Y - PADDLE_HEIGHT / 2) } as BallState;
    const mirrored = { ...b, y: 1 - b.y, vy: -b.vy, spin: -(b.spin ?? 0) } as BallState;
    const hit = checkPaddleCollision(mirrored, 0.5, PADDLE_WIDTH_RATIO, paddleVx, 0, {});
    return { vx: (hit.speed ?? 0) * Math.sin(hit.angle ?? 0), spin: -(hit.spin ?? 0) };
  };

  it('sends the ball the way the paddle was actually moving, for both players', () => {
    // Player 1 is the unmirrored case and is the reference for "correct".
    const p1 = checkPaddleCollision(arriving(0.9), 0.5, PADDLE_WIDTH_RATIO, 0.9, 0, {});
    const p1Vx = (p1.speed ?? 0) * Math.sin(p1.angle ?? 0);
    expect(p1Vx).toBeGreaterThan(0);
    // A rightward swipe is a rightward swipe on either side of one screen.
    expect(p2Return(0.9).vx).toBeGreaterThan(0);
    expect(p2Return(-0.9).vx).toBeLessThan(0);
  });

  it('gives the two halves mirror-image drive, not identical drive', () => {
    expect(p2Return(0.9).vx).toBeCloseTo(-p2Return(-0.9).vx, 12);
  });

  it('puts OPPOSITE world spin on the same swipe, because the paddles touch opposite faces', () => {
    // Not a sign slip: player 1's paddle is under the ball and player 2's is
    // over it, so one drags the bottom of the ball rightward and the other
    // drags the top of it rightward. Identical swipes, mirror-image rotation —
    // which is the reflection reversing the sense of a rotation, seen from the
    // other end. What has to hold is that world spin is then read back
    // consistently: `bounceOffWall` takes it as-is and player 2's next contact
    // mirrors it in again.
    const p1 = checkPaddleCollision(arriving(0.9), 0.5, PADDLE_WIDTH_RATIO, 0.9, 0, {});
    expect(p1.spin ?? 0).not.toBe(0);
    expect(Math.sign(p2Return(0.9).spin)).toBe(-Math.sign(p1.spin ?? 0));
  });

  it('bounces a wall in the frame the speed band was written in', () => {
    // Split screen runs every speed at SPEED_SCALE, because a full court is
    // ~2.2x the travel of a half-court leg, while `bounceOffWall` holds its
    // result inside `[minBallSpeedFor, maxBallSpeedFor]` — the band UNSCALED.
    // This mode's ENTIRE legal range sits below that floor, so handed raw
    // values the clamp is not a ceiling, it is a launch: every wall bounce
    // speeds the ball up to the half-court minimum and pins it there. The loop
    // converts into that frame and back, which is what this states.
    const SPEED_SCALE = 0.55;
    const rules = {};
    const floor = minBallSpeedFor(rules) * SPEED_SCALE;
    const cap = maxBallSpeedFor(rules) * SPEED_SCALE;
    const vx = -0.5 * SPEED_SCALE;
    const vy = 0.4 * SPEED_SCALE;
    const started = Math.hypot(vx, vy);
    expect(started).toBeGreaterThan(floor);
    expect(started).toBeLessThan(cap);

    // Converted: an unspun bounce is a pure reflection, and a spun one stays
    // inside the band this mode actually plays at.
    for (const spin of [-SPIN_MAX, 0, SPIN_MAX]) {
      const off = bounceOffWall(vx / SPEED_SCALE, vy / SPEED_SCALE, spin, true, rules);
      const speed = Math.hypot(off.vx * SPEED_SCALE, off.vy * SPEED_SCALE);
      expect(speed).toBeGreaterThanOrEqual(floor - 1e-9);
      expect(speed).toBeLessThanOrEqual(cap + 1e-9);
    }
    expect(
      Math.hypot(
        bounceOffWall(vx / SPEED_SCALE, vy / SPEED_SCALE, 0, true, rules).vx * SPEED_SCALE,
        bounceOffWall(vx / SPEED_SCALE, vy / SPEED_SCALE, 0, true, rules).vy * SPEED_SCALE
      )
    ).toBeCloseTo(started, 12);

    // Raw, which is what this mode did: the ball is dragged up to the
    // half-court floor whatever it arrived at, so two different legal speeds
    // leave the same wall at one identical speed.
    const raw = bounceOffWall(vx, vy, 0, true, rules);
    const slower = bounceOffWall(vx * 0.5, vy * 0.5, 0, true, rules);
    expect(Math.hypot(raw.vx, raw.vy)).toBeCloseTo(minBallSpeedFor(rules), 12);
    expect(Math.hypot(slower.vx, slower.vy)).toBeCloseTo(minBallSpeedFor(rules), 12);
    expect(Math.hypot(raw.vx, raw.vy)).toBeGreaterThan(started);
  });
});

describe('the split-screen serve obeys the match rules', () => {
  // Two of the six physics rules this mode's own pre-match sheet offers reached
  // nothing: the launch used a hardcoded random `vx` and a fixed base speed, so
  // `serveAngleMax: 0` still served at an angle and `servePowerMax` did nothing
  // whatever. This states the mapping the component uses.
  const SPREAD = 0.5;
  const POWER_FRAC = (1 - SERVE_MIN_POWER) / (SERVE_MAX_POWER - SERVE_MIN_POWER);

  it('leaves the stock serve exactly where it was', () => {
    const { vx, vy } = serveVelocity({ angle: 0, power: POWER_FRAC }, {});
    expect(Math.hypot(vx, vy)).toBeCloseTo(BASE_BALL_SPEED, 10);
  });

  it('serves straight when the match forbids an angle', () => {
    for (const angle of [-SPREAD, 0, SPREAD]) {
      const { vx } = serveVelocity({ angle, power: POWER_FRAC }, { serveAngleMax: 0 });
      expect(Math.abs(vx)).toBeCloseTo(0, 12);
    }
  });

  it('widens and narrows with serveAngleMax', () => {
    const wide = serveVelocity({ angle: SPREAD, power: POWER_FRAC }, { serveAngleMax: 1.4 });
    const stock = serveVelocity({ angle: SPREAD, power: POWER_FRAC }, {});
    expect(Math.abs(wide.vx)).toBeGreaterThan(Math.abs(stock.vx));
  });

  it('scales with servePowerMax', () => {
    const hard = serveVelocity({ angle: 0, power: POWER_FRAC }, { servePowerMax: 1.5 });
    const stock = serveVelocity({ angle: 0, power: POWER_FRAC }, {});
    expect(Math.hypot(hard.vx, hard.vy)).toBeGreaterThan(Math.hypot(stock.vx, stock.vy));
  });

  it('keeps the spread inside the match limit, so a random aim is always legal', () => {
    const { vx, vy } = serveVelocity({ angle: SPREAD, power: POWER_FRAC }, {});
    const deg = (Math.abs(Math.atan2(vx, -vy)) * 180) / Math.PI;
    expect(deg).toBeLessThanOrEqual(SERVE_MAX_ANGLE_DEG + 1e-9);
    expect(deg).toBeCloseTo(SERVE_MAX_ANGLE_DEG * SPREAD, 9);
  });
});

describe('keyboard paddles move per SECOND, in every component that has one', () => {
  // A flat delta added on every animation frame moves the paddle exactly twice
  // as fast on a 120Hz display as on a 60Hz one. `CourtCanvas` was fixed and
  // `SplitScreenMatch` was missed by the same commit — and there it is not
  // only a speed, because those positions are differentiated into the paddle
  // velocity that feeds `driveCoupling`, so the refresh rate decided the
  // angle, the pace and the spin of an otherwise identical return.
  //
  // Read from the source for the same reason the paddle call sites are: this
  // lives inside a `useEffect` in a `.tsx`, and a frame-rate dependence
  // compiles, runs, and looks correct on whatever display you happen to own.
  const DRIVERS = ['src/components/CourtCanvas.tsx', 'src/components/SplitScreenMatch.tsx'];

  it.each(DRIVERS)('%s scales its keyboard delta by dt', (file) => {
    const src = readFileSync(resolve(__dirname, '..', file), 'utf8');
    const uses = src
      .split('\n')
      .filter((l) => l.includes('KEY_PADDLE_SPEED') && !l.includes('const KEY_PADDLE_SPEED'));
    // It has to be there at all, or the assertion below is vacuous.
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/KEY_PADDLE_SPEED \* dt/);
    // And the per-second constant is declared, rather than a bare literal.
    expect(src).toMatch(/const KEY_PADDLE_SPEED = [\d.]+ \* 60;/);
  });
});


describe('a play-bot brings its own competence, and solo does not notice', () => {
  // Step 17 deferred this: a bot's competence is an intrinsic TRAIT, so
  // OpponentAI has to be able to take one instead of deriving it from the
  // difficulty ladder. The whole risk in that change is the solo path, which
  // must be byte-identical — so that is asserted first and over the whole grid.

  const RUNGS: AIDifficulty[] = ['rookie', 'pro', 'elite', 'cyber', 'chaos'];
  const PLAYER_MU = [8, 15, 20, 25, 30, 36, 42];

  it('derives competence exactly as it always did when nothing is overridden', () => {
    for (const rung of RUNGS) {
      for (const mu of PLAYER_MU) {
        const ai = new OpponentAI(rung, mu);
        expect({ rung, mu, c: ai.competence() }).toEqual({
          rung,
          mu,
          c: competenceForMu(effectiveAiMu(rung, mu)),
        });
      }
    }
  });

  it('takes the override instead, and stops adapting to the opponent', () => {
    // The separation at the physics boundary. A solo rung slides toward the
    // player; a bot must not, or its strength would chase its own results.
    for (const mu of PLAYER_MU) {
      const bot = new OpponentAI('pro', mu, { competence: 0.42, style: { volatility: 0, aggression: 0.3 } });
      expect(bot.competence()).toBe(0.42);
    }
    // ...and the same rung WITHOUT the override does adapt, so the fixture is
    // measuring the override rather than a rung that happens to be flat.
    const solo = PLAYER_MU.map((mu) => new OpponentAI('pro', mu).competence());
    expect(new Set(solo).size).toBeGreaterThan(1);
  });

  it('plays a bot at its own strength, whatever the opponent is rated', () => {
    // setPlayerSkill is what a duel would call as the opponent's rating moves.
    // For a bot it must change nothing.
    const bot = new OpponentAI('pro', 25, { competence: 0.6, style: { volatility: 0, aggression: 0.5 } });
    const before = bot.competence();
    bot.setPlayerSkill(45);
    expect(bot.competence()).toBe(before);
    bot.setPlayerSkill(5);
    expect(bot.competence()).toBe(before);
  });
});


describe('a play-bot plays under its own ceiling, and solo keeps the old one', () => {
  // §4.8. MAX_AI_COMPETENCE is a statement about the five DIFFICULTIES: their
  // top knot, their clamp, and the denominator their lapse and serve skill are
  // normalised by. It came DOWN to 0.81 because an adapted Cyber returning 93%
  // made the top rung a lottery on the AI's own error — reasoning that is not
  // about a bot, which is not a rung of anybody's ladder and has to hold its
  // own against a Cyber Overlord for the population to reach the top of the
  // board at all.
  //
  // The whole risk is the SOLO path, so that is asserted first and over a
  // grid, exactly as the competence override was.

  const RUNGS: AIDifficulty[] = ['rookie', 'pro', 'elite', 'cyber', 'chaos'];
  const PLAYER_MU = [8, 15, 20, 25, 30, 36, 42];

  it('leaves every difficulty on the solo ceiling', () => {
    for (const rung of RUNGS) {
      for (const mu of PLAYER_MU) {
        expect({ rung, mu, c: new OpponentAI(rung, mu).ceiling() }).toEqual({
          rung, mu, c: MAX_AI_COMPETENCE,
        });
      }
    }
  });

  it('gives a bot the higher one', () => {
    const bot = new OpponentAI('pro', 25, {
      competence: 0.9,
      style: { volatility: 0, aggression: 0.5 },
    });
    expect(bot.ceiling()).toBe(BOT_MAX_COMPETENCE);
    expect(BOT_MAX_COMPETENCE).toBeGreaterThan(MAX_AI_COMPETENCE);
    // ...and it actually plays there, rather than being clamped back to a
    // rung's limit the moment a rally begins.
    expect(bot.competence()).toBe(0.9);
  });

  it('does not clamp a strong bot back to a rung’s limit when a rally begins', () => {
    // `beginRally` clamps the rolled competence, and under the solo constant a
    // bot at 0.95 plays every rally at 0.81 — the ceiling would be a field
    // nothing read. Everything the clamp feeds is private and its only other
    // consequence is a return rate no fixture can attribute to one ceiling, so
    // the rolled value is exposed.
    const ball: BallState = {
      x: 0.5, y: 0.05, vx: 0, vy: 1, radius: 0.022, active: true, spin: 0, speedMultiplier: 1,
    };
    const bot = new OpponentAI('pro', 25, {
      competence: 0.95,
      style: { volatility: 0, aggression: 0.5 },
    });
    bot.update(ball, 0.016, 0.22);
    expect(bot.lastRallyCompetence()).toBeCloseTo(0.95, 6);
    expect(bot.lastRallyCompetence()).toBeGreaterThan(MAX_AI_COMPETENCE);

    // A difficulty is unchanged: it can never roll above the solo ceiling.
    const rung = new OpponentAI('chaos', 42);
    rung.update(ball, 0.016, 0.22);
    expect(rung.lastRallyCompetence()).toBeLessThanOrEqual(MAX_AI_COMPETENCE);
  });

  it('does not saturate a strong bot’s serve skill', () => {
    // The collapse this prevents is one the ladder already had: normalised by
    // 0.81, every competence above it lands on skill 1.000, so all three top
    // rungs served IDENTICALLY. A population of strong bots would do the same.
    const aim = (c: number, ceiling: number) => {
      let total = 0;
      for (let i = 0; i < 600; i += 1) total += Math.abs(aiServeAim(c, 0.05, ceiling).angle);
      return total / 600;
    };
    // Under the solo ceiling two strong bots are indistinguishable...
    expect(aim(0.85, MAX_AI_COMPETENCE)).toBeCloseTo(aim(0.95, MAX_AI_COMPETENCE), 1);
    // ...and the SAME competence read against the two ceilings is not, which
    // is the assertion that isolates the ceiling rather than the competence:
    // a monotonicity check passes whichever denominator is used. 0.88 sits
    // strictly BETWEEN the two ceilings on purpose — at 0.95 both normalise to
    // skill 1.000 and the comparison is vacuous, which is how it was written
    // first.
    expect(aim(0.88, BOT_MAX_COMPETENCE)).toBeLessThan(aim(0.88, MAX_AI_COMPETENCE));
  });

  it('reads the lapse chance against the same ceiling', () => {
    // The fifth site, and the one with nothing to observe it: `lapseChance` is
    // private and its only consequence is a rally the AI stands out of.
    // Normalised by the solo constant a strong bot lapses as if it were at
    // skill 1.000 — measured, reverting it reddened nothing until this
    // existed, so the pure function is exported and read directly.
    expect(lapseForCompetence(0.88, BOT_MAX_COMPETENCE)).toBeGreaterThan(
      lapseForCompetence(0.88, MAX_AI_COMPETENCE)
    );
    // A difficulty is unmoved: at or below the solo ceiling the two agree.
    expect(lapseForCompetence(0.5, MAX_AI_COMPETENCE)).toBe(lapseForCompetence(0.5));
  });

  it('keeps the same-delay collapse away from the serve TIMER too', () => {
    const delay = (c: number, ceiling: number) => {
      let total = 0;
      for (let i = 0; i < 600; i += 1) total += aiServeDelay(c, 0.5, ceiling);
      return total / 600;
    };
    expect(delay(0.85, MAX_AI_COMPETENCE)).toBeCloseTo(delay(0.95, MAX_AI_COMPETENCE), 2);
    // Same competence, two ceilings — the one comparison the denominator can
    // change. A strong bot read against its own ceiling is slower to serve
    // than one pinned to skill 1.000 by the solo constant.
    // By a MARGIN, not merely greater: `aiServeDelay` carries ±0.06 of
    // jitter, so over 600 samples the two means differ by ~0.0014 of noise
    // alone and a bare `>` passes about half the time whatever the code does.
    // The real gap here is ~0.04.
    expect(delay(0.88, BOT_MAX_COMPETENCE) - delay(0.88, MAX_AI_COMPETENCE)).toBeGreaterThan(0.01);
  });
});
