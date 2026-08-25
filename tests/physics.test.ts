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
  competenceForMu,
  aimFromPush,
  serveVelocity,
  SERVE_BALL_Y,
  PADDLE_HEIGHT,
  AIM_FULL_PUSH,
  AIM_DEADZONE,
  SERVE_MAX_ANGLE_DEG,
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
    // A bigger sample than the other cases use, because this is the one
    // assertion made on a DIFFERENCE. The AI rolls its reads per rally, so a
    // measured return rate is a sample, and subtracting two of them adds both
    // their noise. Measured over 400 repeats: at the default sample size the
    // spread runs min 0.1875 / mean 0.2545, and lands at or below 0.2 about
    // three times in four hundred — which is exactly how this arrived, as a
    // CI failure reading `expected 0.19999999999999996 to be greater than
    // 0.2` on a docs-only change. Tripling the sample leaves the mean where it
    // was (0.2537 — same population, less noise) and moves the minimum to
    // 0.2167.
    const rates = LADDER.map((d) => returnRate(d, 25, 720));
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeGreaterThan(rates[i - 1] - 0.03);
    }
    // And the ladder must actually span a range, not three flavours of the
    // same. The threshold sits well below that minimum rather than beside the
    // mean: what is being asserted is that the rungs are genuinely far apart,
    // and a ladder that had actually collapsed would score near zero here, so
    // the margin costs the test nothing it was buying.
    //
    // Lowered from 0.15 when the floor came up. Raising Rookie and Pro while
    // the ceiling stays where it is NARROWS this by construction — that is
    // what "raise the floor, not the ceiling" means arithmetically — and the
    // spread now measures around 0.156, straddling the old bound. Return rate
    // also saturates near the top, so the compression is worse in this
    // measure than in the one players feel: Pro and Cyber are four points
    // apart in balls returned and thirteen apart in matches won.
    expect(rates[rates.length - 1] - rates[0]).toBeGreaterThan(0.11);
  });

  it('keeps Rookie a warm-up: an average player scores freely', () => {
    // Raised from 0.7 alongside the floor lift. Rookie now measures ~0.674
    // over 720 balls (SE ~0.017), so 0.7 sat about 1.5 sigma away and would
    // have gone red on its own regularly — see the note on measuring a
    // distribution before picking a bound in TESTING.md §5.
    expect(returnRate('rookie')).toBeLessThan(0.74);
  });

  it('will not let Rookie sink back into an empty half-court', () => {
    // The other half of the same rule, and the one that was missing. Rookie
    // used to return under 60% of balls: an average player took roughly seven
    // matches in eight off it, which is not a warm-up, it is an opponent who
    // is not there. Nothing here may drift back below that.
    expect(returnRate('rookie')).toBeGreaterThan(0.6);
  });

  it('makes Pro a real step up from Rookie', () => {
    // Pro measures ~0.789 over 720 balls (SE ~0.015). Before the lift it was
    // ~0.754 and an average player won a little over half their matches
    // against it, which made the middle rung read as a coin toss rather than
    // as the rung you climb to.
    expect(returnRate('pro')).toBeGreaterThan(0.73);
  });

  it('leaves the top of the ladder EXACTLY where it was', () => {
    // The floor was raised on the explicit condition that the ceiling did not
    // move, and a sampled return rate is far too noisy to hold that: at the
    // sample sizes above, a genuine two-point drift in Cyber is inside the
    // noise. So it is pinned where it can be pinned exactly. competenceForMu
    // is a straight line at and above Cyber's own anchor, every AI parameter
    // is a pure function of the competence it returns, and Cyber's style is
    // untouched — so Cyber, and the adapted Cyber that reaches
    // MAX_AI_COMPETENCE, are bit-for-bit what they were.
    const originalLine = (mu: number) => Math.min(Math.max((mu - 12) / 29, 0.05), MAX_AI_COMPETENCE);
    for (const mu of [29, 30, 31, 31.14, 32, 36, 40, 100]) {
      expect(competenceForMu(mu)).toBeCloseTo(originalLine(mu), 12);
    }
    // And the curve below it only ever lifts — it never makes a rung easier.
    for (let mu = 12; mu < 29; mu += 0.5) {
      expect(competenceForMu(mu)).toBeGreaterThanOrEqual(originalLine(mu) - 1e-12);
    }
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
