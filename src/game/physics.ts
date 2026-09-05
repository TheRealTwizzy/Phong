import { AIDifficulty, BallState, MatchRules } from '../types';
import { normalizeRules } from '../matchRules';
import { AI_RATINGS, START_MU, effectiveAiMu } from '../rating';

export const PADDLE_Y = 0.92;
export const PADDLE_HEIGHT = 0.024;
// The STOCK game. A match may scale this and the ball speeds through
// `src/matchRules.ts`, which is why every helper below takes rules; what is
// never true is that a phone can set them for itself, because both halves of
// one rally have to obey one set of numbers. Tuning inside the ranked band
// still rates; past it the match pays XP and moves no rating.
export const PADDLE_WIDTH_RATIO = 0.22;

/**
 * Where a serve is held, and launched from: resting on the paddle's face,
 * dead centre.
 *
 * The ball sits here and tracks the paddle until the serve fires, so the ball
 * the player is aiming IS the ball that leaves. Nothing was drawn here at all
 * before — the court had no ball on it while the player lined a serve up, and
 * one simply appeared, a visible distance above the paddle, once they let go.
 */
export const SERVE_BALL_Y = PADDLE_Y - PADDLE_HEIGHT / 2 - 0.012;
/**
 * Where a ball that has crossed the net appears on the receiving half.
 *
 * Just inside the line rather than on it, so the receiving court owns a ball
 * that is unambiguously in play: entered at exactly 0 it sits on the boundary
 * the crossing test itself uses (`y <= 0`), and it is the receiver's clock
 * that starts, not the sender's.
 *
 * A crossing carries `x`, `vx`, `vy`, `spin` and `speedMultiplier` and NO `y`,
 * so the receiver decides this for itself — which means every half that
 * receives a ball has to decide it the same way or they are playing two
 * different games. Shared for exactly that reason: `src/App.tsx` uses it at
 * all three of its entry points (a relayed `ball_incoming`, and both halves of
 * the solo cross-net) and `server/playbotDriver.ts` at its one, and a
 * play-bot spelling it `0` gave every ball a human put over 0.02 of extra
 * court to travel — more time to read the shot, and a different x on arrival,
 * since the extra run is taken at the shot's own angle.
 */
export const BALL_ENTRY_Y = 0.02;
export const BALL_BASE_RADIUS = 0.022;
export const BASE_BALL_SPEED = 0.85; // units per second
export const MAX_BALL_SPEED = 2.4;
/**
 * Upper bound on how finely one frame's flight is integrated. The step size is
 * chosen from the paddle's own catch window, so this only ever binds for a ball
 * that is both very fast and a long frame — where the remaining step is still
 * well inside the window and the alternative is an unbounded loop on a stall.
 */
export const MAX_PHYSICS_SUBSTEPS = 16;

/**
 * How many pieces one frame's flight must be integrated in for the paddle test
 * to be reliable.
 *
 * `checkPaddleCollision` is a POINT sample: it asks where the ball is now, not
 * where it has been. It catches a ball only inside a window
 * `PADDLE_HEIGHT + 2r` tall — 0.068 at stock — so a ball that moves further
 * than that in one integration passes straight through. At the 2.4 speed cap
 * and the 0.05s frame clamp a single jump is 0.12, and with a legal
 * `ballSpeedMax: 2` a wall rebound reaches 4.8 and tunnels even at a perfect
 * 60fps.
 *
 * Half the window per step, so a contact is sampled at least twice inside it
 * rather than exactly once at the boundary.
 */
export function physicsSubsteps(speed: number, dt: number, radius: number): number {
  const window = PADDLE_HEIGHT + 2 * Math.max(radius, 0);
  const travel = Math.abs(speed) * Math.max(dt, 0);
  if (!Number.isFinite(travel) || !Number.isFinite(window) || window <= 0) return 1;
  return Math.max(1, Math.min(MAX_PHYSICS_SUBSTEPS, Math.ceil(travel / (window / 2))));
}

// Serve aiming. The player sets direction and power on every serve; these
// bound what the aim can ask for, and the pre-match rules scale them.
export const SERVE_MAX_ANGLE_DEG = 55;
export const SERVE_MIN_POWER = 0.72;
export const SERVE_MAX_POWER = 1.35;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ---------------------------------------------------------------------------
// Match rules applied to the engine constants
// ---------------------------------------------------------------------------
// The constants above are the stock game. A match may scale them (see
// src/matchRules.ts); doing so costs the match its rating, never its XP.

export const paddleWidthFor = (rules?: Partial<MatchRules>): number =>
  PADDLE_WIDTH_RATIO * normalizeRules(rules).paddleScale;

export const ballRadiusFor = (rules?: Partial<MatchRules>): number =>
  BALL_BASE_RADIUS * normalizeRules(rules).ballScale;

export const minBallSpeedFor = (rules?: Partial<MatchRules>): number =>
  BASE_BALL_SPEED * 0.55 * normalizeRules(rules).ballSpeedMin;

export const maxBallSpeedFor = (rules?: Partial<MatchRules>): number =>
  MAX_BALL_SPEED * normalizeRules(rules).ballSpeedMax;

/** Hold a speed inside the band this match is played under. */
export function clampBallSpeed(speed: number, rules?: Partial<MatchRules>): number {
  return clamp(speed, minBallSpeedFor(rules), maxBallSpeedFor(rules));
}

export interface ServeAim {
  /** -1 hard left .. 0 straight .. +1 hard right, before the rule scale. */
  angle: number;
  /** 0 softest .. 1 hardest, before the rule scale. */
  power: number;
}

/**
 * The serving joystick's geometry, as a fraction of the canvas WIDTH.
 *
 * Width on BOTH axes, deliberately. These were a fraction of the width
 * horizontally and of the height vertically, which makes a circle in these
 * units an ellipse on a tall phone: the direction the thumb pushed and the
 * direction the ball left were then simply different angles, and the drawn
 * stick lied about where the serve was going. One unit on both axes is what
 * lets the overlay promise "the ball travels along this line" and mean it.
 *
 * These live here rather than in the canvas component so the mapping is a rule
 * the fast test layer can state, instead of something only a browser can
 * observe. The component draws the ring; this decides what the ring means.
 */
export const AIM_FULL_PUSH = 0.35;
export const AIM_DEADZONE = 0.03;

/**
 * A drag from the joystick's anchor as an aim, or null inside the deadzone —
 * which is what makes a plain tap still a plain serve.
 *
 * `dx`/`dy` are current-minus-anchor in canvas-width units, so `dy` is NEGATIVE
 * when the thumb has moved UP the screen.
 *
 * It is a true joystick: the DIRECTION of the drag is the direction the ball
 * leaves in, and its LENGTH is the power. A drag below the anchor is read as a
 * slingshot — pulled back through the anchor and inverted — because the paddle
 * sits at 90% of the court height, so a player who wants to aim by pulling has
 * the whole screen above them to pull away from rather than the ~10% below.
 * Pushing and pulling therefore reach full power equally, and neither is the
 * privileged gesture.
 *
 * `angleLimitDeg` is how far this match's rules let a serve swing
 * (`SERVE_MAX_ANGLE_DEG * serveAngleMax`). It is a parameter rather than the
 * bare constant so the fraction returned here, multiplied back out by
 * `serveVelocity`, reproduces the aimed angle degree-for-degree under ANY rule
 * setting — clamping against the stock 55° would silently compress or stretch
 * the aim whenever the rule was not 1, and the line the player is following
 * would stop being the line the ball takes.
 */
export function aimFromPush(
  dx: number,
  dy: number,
  angleLimitDeg: number = SERVE_MAX_ANGLE_DEG
): ServeAim | null {
  const len = Math.hypot(dx, dy);
  if (len < AIM_DEADZONE) return null;
  // Below the anchor is a pull: invert it, so what the player aimed away from
  // is what the ball is aimed at. `dy === 0` counts as a push, so a flat drag
  // right serves right.
  const pull = dy > 0;
  const ux = pull ? -dx : dx;
  const uy = pull ? -dy : dy; // never positive from here on
  // Measured from straight up, positive to the right.
  const deg = (Math.atan2(ux, -uy) * 180) / Math.PI;
  return {
    // A match may forbid any deflection at all (`serveAngleMax` floors at 0),
    // and that is a serve straight up rather than a division by zero.
    angle: angleLimitDeg > 0 ? clamp(deg / angleLimitDeg, -1, 1) : 0,
    power: clamp(len / AIM_FULL_PUSH, 0, 1),
  };
}

/** Turn an aim into a launch velocity, bounded by the match rules. */
export function serveVelocity(
  aim: ServeAim | null | undefined,
  rules?: Partial<MatchRules>
): { vx: number; vy: number } {
  const r = normalizeRules(rules);
  const angleFrac = clamp(aim?.angle ?? 0, -1, 1);
  const powerFrac = clamp(aim?.power ?? 0.5, 0, 1);
  const radians = (angleFrac * SERVE_MAX_ANGLE_DEG * r.serveAngleMax * Math.PI) / 180;
  const power = lerp(SERVE_MIN_POWER, SERVE_MAX_POWER * r.servePowerMax, powerFrac);
  const speed = clampBallSpeed(BASE_BALL_SPEED * power, rules);
  return { vx: Math.sin(radians) * speed, vy: -Math.abs(Math.cos(radians) * speed) };
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Standard normal sample (Box-Muller). */
function gaussian(): number {
  const u = Math.max(1e-6, Math.random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

export interface HitResult {
  hit: boolean;
  angle?: number;
  speed?: number;
  offset?: number;
  /** Spin imparted by this contact. Positive curves the ball to the right. */
  spin?: number;
}

// ---------------------------------------------------------------------------
// Spin and paddle drive
// ---------------------------------------------------------------------------
//
// The paddle used to be a wall with a bounce angle: `checkPaddleCollision` took
// a paddleVx argument and never read it, and BallState.spin was carried across
// the net, mirrored by server/transform.ts, and hardcoded to 0 by the client.
// So the only input a player had was WHERE the ball hit. Now the paddle's own
// motion is an input too, and it produces spin that curves the flight.
//
// Two rules give the mechanic its shape:
//   - Contact point decides how much of the paddle's motion couples into the
//     ball. Head-on contact is a clean rebound and barely carries; an edge
//     brushes, and carries most.
//   - Paddle speed decides the magnitude. A stationary paddle plays exactly
//     like the old one, so nothing about the game is taken away.

/** Paddle speed, in court widths per second, that counts as a full swing. */
export const PADDLE_REFERENCE_SPEED = 2.2;
/** How much of the paddle's motion couples in on a dead-centre hit. */
export const HEAD_ON_COUPLING = 0.22;
export const SPIN_FROM_DRIVE = 1.35;
export const SPIN_MAX = 1.6;
/** Extra deflection a full swing adds to the rebound angle, in degrees. */
export const DRIVE_ANGLE_DEG = 14;
/** Extra pace a full swing adds. */
export const DRIVE_SPEED_GAIN = 0.16;
/** How far full spin tilts the angle a ball leaves the PADDLE at, in degrees. */
export const SPIN_REBOUND_DEG = 18;
/** How far full spin tilts the angle a ball leaves a SIDE WALL at, in degrees. */
export const SPIN_WALL_TILT_DEG = 16;
/**
 * How much pace full spin adds to — or scrubs off — a rebound. Signed by
 * whether the spin runs WITH the direction the ball leaves in: a ball spinning
 * the way it is going skids on, one spinning against itself is checked. Spin
 * therefore costs or buys pace at every surface instead of being free angle.
 */
export const SPIN_WALL_SPEED_GAIN = 0.12;
/** The same trade at a paddle contact, where the swing already adds its own. */
export const SPIN_PADDLE_SPEED_GAIN = 0.1;
/** Spin kept, and reversed, across a side-wall rebound. */
export const SPIN_WALL_RETENTION = -0.55;
/** Incoming spin retained through a paddle contact, reversed with the ball. */
export const SPIN_PADDLE_CARRY = -0.35;
/** No AI ever fully reads spin — it has to stay worth using at the top. */
export const MAX_SPIN_READ = 0.85;

/** The steepest a ball may leave any paddle, the AI's aggression included. */
export const MAX_REBOUND_ANGLE_DEG = 62;

/**
 * How far aggression may bend the AI's OWN return, in degrees.
 *
 * Sized against the 62 degrees a paddle can produce at all: a fully aggressive
 * rung adds up to 14, roughly a fifth of the range, which is a visibly
 * cornered ball without turning every return into the extreme.
 */
export const AI_AGGRESSION_ANGLE_DEG = 14;

/**
 * How strongly this contact couples the paddle's motion into the ball:
 * 0 at rest, toward 1 for a fast swing caught on the edge.
 */
export function driveCoupling(paddleVx: number, hitOffset: number): number {
  const swing = clamp(paddleVx / PADDLE_REFERENCE_SPEED, -1, 1);
  const edge = Math.min(1, Math.abs(hitOffset));
  return swing * (HEAD_ON_COUPLING + (1 - HEAD_ON_COUPLING) * edge);
}

/** Rotate a velocity by `radians`, preserving speed. */
function rotate(vx: number, vy: number, radians: number): { vx: number; vy: number } {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { vx: vx * cos - vy * sin, vy: vx * sin + vy * cos };
}

/**
 * How spin trades against pace at a contact: +1 when the ball spins the way it
 * is leaving (it skids on), -1 when it spins against itself (it is checked).
 *
 * Mirroring the court flips BOTH the spin and the horizontal velocity
 * (server/transform.ts), so this product is the same on either half — the two
 * phones cannot disagree about whether a ball sped up.
 */
function spinPace(spinNorm: number, outgoingVx: number): number {
  return spinNorm * (Math.sign(outgoingVx) || 1);
}

/**
 * Rebound off a side wall. Spin does NOT bend the ball in flight — it is
 * stored on the ball and spends itself on impacts, changing the angle AND the
 * speed the ball leaves a surface with. Here that means a spinning ball kicks
 * off the wall shallower or steeper than the mirror angle and skids on or is
 * scrubbed by it, while the spin itself reverses and damps.
 */
export function bounceOffWall(
  vx: number,
  vy: number,
  spin: number | undefined,
  atLeftWall: boolean,
  rules?: Partial<MatchRules>
): { vx: number; vy: number; spin: number } {
  const flipped = atLeftWall ? Math.abs(vx) : -Math.abs(vx);
  const spinNorm = clamp(spin || 0, -SPIN_MAX, SPIN_MAX) / SPIN_MAX;
  const tilt = spinNorm * ((SPIN_WALL_TILT_DEG * Math.PI) / 180);
  // The tilt is applied about the wall normal, so it opens or closes the
  // rebound rather than turning the ball back into the wall.
  const turned = rotate(flipped, vy, atLeftWall ? tilt : -tilt);

  // Then pace. Held inside the match's own speed band so a ball cannot be
  // spun faster and faster off alternating walls.
  const speed = Math.hypot(turned.vx, turned.vy);
  const paced = clampBallSpeed(
    speed * (1 + spinPace(spinNorm, turned.vx) * SPIN_WALL_SPEED_GAIN),
    rules
  );
  const scale = speed > 1e-9 ? paced / speed : 1;

  return {
    vx: turned.vx * scale,
    vy: turned.vy * scale,
    spin: clamp((spin || 0) * SPIN_WALL_RETENTION, -SPIN_MAX, SPIN_MAX),
  };
}

/**
 * The Practice Wall's RETURN LINE: the same surface rule, rotated a quarter
 * turn.
 *
 * The net is a wall in that mode — the ball bounces straight back and never
 * leaves the player's screen — and it was the one surface in the game that did
 * not spend spin: `b.vy = Math.abs(b.vy)` and nothing else, so a spun ball came
 * off it exactly as it went in. Every other surface reverses the spin, damps
 * it, tilts the rebound and trades angle against pace.
 *
 * Rather than a second copy of that arithmetic, the ball is rotated into
 * `bounceOffWall`'s frame and back: swapping the axes maps a horizontal normal
 * onto a vertical one, and a ball arriving at the return line is moving
 * upward, which in that frame is the left wall.
 */
export function bounceOffReturnLine(
  vx: number,
  vy: number,
  spin: number | undefined,
  rules?: Partial<MatchRules>
): { vx: number; vy: number; spin: number } {
  const turned = bounceOffWall(vy, vx, spin, true, rules);
  return { vx: turned.vy, vy: turned.vx, spin: turned.spin };
}

/**
 * Where a ball will cross the paddle line, folding side-wall rebounds. Shared
 * with the AI so its prediction uses the same rules the ball does.
 *
 * `spinFactor` scales how much of spin's effect on those rebounds is accounted
 * for: 1 is the true landing point, 0 ignores spin entirely and lands where an
 * unspun ball would have. That is exactly the AI's read of the ball.
 */
export function predictLanding(
  ball: Pick<BallState, 'x' | 'vx' | 'vy' | 'radius'> & { y: number; spin?: number },
  spinFactor: number = 1,
  rules?: Partial<MatchRules>
): number {
  if (ball.vy <= 0) return ball.x;
  const dt = 1 / 120;
  const factor = clamp(spinFactor, 0, 1);
  let x = ball.x;
  let y = ball.y;
  let vx = ball.vx;
  let vy = ball.vy;
  let spin = (ball.spin || 0) * factor;
  const radius = ball.radius || BALL_BASE_RADIUS;

  for (let step = 0; step < 4000 && y < PADDLE_Y; step++) {
    x += vx * dt;
    y += vy * dt;
    if (x - radius <= 0 || x + radius >= 1) {
      const atLeft = x - radius <= 0;
      x = atLeft ? radius : 1 - radius;
      const bounced = bounceOffWall(vx, vy, spin, atLeft, rules);
      vx = bounced.vx;
      vy = Math.abs(bounced.vy) || vy;
      spin = bounced.spin;
    }
  }
  return clamp(x, 0, 1);
}

/**
 * Check collision between ball and paddle at bottom
 */
export function checkPaddleCollision(
  ball: BallState,
  paddleX: number,
  paddleWidth: number,
  paddleVx: number = 0,
  /**
   * An extra push on the outgoing angle, in radians. The AI's aggression, and
   * nothing else — the player passes none.
   *
   * It belongs INSIDE the contact rather than applied to the returned angle
   * afterwards, and the reason is two lines down from here: `outgoingVx` is
   * derived from this angle and fed to spinPace, which adds or scrubs up to
   * SPIN_PADDLE_SPEED_GAIN of pace ACCORDING TO ITS SIGN. Bending the angle
   * after the fact leaves the speed measured against a direction the ball is
   * no longer going, so a push across the zero-angle axis — a shallow return
   * nudged to the other side, which is exactly what aggression is for — gave a
   * spun ball a boost where it should have been scrubbed. Folded in here, the
   * angle, the pace and the returned spin cannot disagree by construction.
   */
  angleBias: number = 0,
  // The band this match is played under. `bounceOffWall` above has taken this
  // since spin shipped, and the paddle not taking it is the asymmetry that
  // made CLAUDE.md §3's "every rebound is held inside the match's own speed
  // band" false: the wall let a rally climb to `MAX_BALL_SPEED * ballSpeedMax`
  // while every paddle contact snapped it back to the stock 2.4. Measured with
  // `ballSpeedMax: 2` — 3.37 after three bounces, 4.80 after nine, and 2.4 off
  // the paddle in between. Optional, so the stock game and every existing
  // caller behave exactly as before.
  rules?: Partial<MatchRules>
): HitResult {
  const paddleTop = PADDLE_Y - PADDLE_HEIGHT / 2;
  const paddleBottom = PADDLE_Y + PADDLE_HEIGHT / 2;
  const paddleLeft = paddleX - paddleWidth / 2;
  const paddleRight = paddleX + paddleWidth / 2;

  // Ball must be moving downward towards paddle
  if (ball.vy <= 0) return { hit: false };

  // Check vertical overlap with ball radius
  if (ball.y + ball.radius >= paddleTop && ball.y - ball.radius <= paddleBottom) {
    // Check horizontal overlap with forgiving edge buffer
    const edgeBuffer = ball.radius * 0.7;
    if (ball.x + ball.radius >= paddleLeft - edgeBuffer && ball.x - ball.radius <= paddleRight + edgeBuffer) {
      // Clamped hit offset from -1 (left tip) to +1 (right tip)
      const rawOffset = (ball.x - paddleX) / (paddleWidth / 2);
      const hitOffset = Math.max(-1.1, Math.min(1.1, rawOffset));

      // How much of the paddle's own motion this contact carries.
      const drive = driveCoupling(paddleVx, hitOffset);
      // Spin the ball ARRIVED with tilts the angle it leaves at. This is the
      // whole of what spin does: it never bends the flight, it spends itself
      // on impacts.
      const incoming = clamp(ball.spin || 0, -SPIN_MAX, SPIN_MAX) / SPIN_MAX;

      // Calculate rebound angle (max ~60 degrees), plus what the swing and the
      // incoming spin add.
      const maxAngle = (Math.PI / 180) * MAX_REBOUND_ANGLE_DEG;
      const angle = clamp(
        hitOffset * maxAngle +
          (drive * DRIVE_ANGLE_DEG * Math.PI) / 180 +
          (incoming * SPIN_REBOUND_DEG * Math.PI) / 180 +
          angleBias,
        -maxAngle,
        maxAngle
      );

      const currentSpeed = Math.hypot(ball.vx, ball.vy);
      // Speed up slightly on each hit up to cap; driving through adds pace,
      // and the spin the ball arrived with adds or scrubs its own — measured
      // against the direction the ball is about to leave in, which the rebound
      // angle has just decided.
      const outgoingVx = Math.sin(angle);
      const newSpeed = Math.min(
        currentSpeed *
          (1.04 +
            Math.abs(drive) * DRIVE_SPEED_GAIN +
            spinPace(incoming, outgoingVx) * SPIN_PADDLE_SPEED_GAIN),
        rules ? maxBallSpeedFor(rules) : MAX_BALL_SPEED
      );

      return {
        hit: true,
        angle,
        speed: newSpeed,
        offset: hitOffset,
        // What the ball leaves with: the swing's own spin, plus whatever of
        // the incoming spin survived the contact (reversed, as the ball is).
        spin: clamp(
          drive * SPIN_FROM_DRIVE + (ball.spin || 0) * SPIN_PADDLE_CARRY,
          -SPIN_MAX,
          SPIN_MAX
        ),
      };
    }
  }

  return { hit: false };
}

// ---------------------------------------------------------------------------
// Opponent AI
// ---------------------------------------------------------------------------
//
// Difficulty is a *rating*, not a switch. Each difficulty is an anchor mu in
// rating.ts that slides part-way toward the player's own hidden rating, and
// that mu collapses into a single `competence` scalar in [0,1] which drives
// every AI parameter below. One knob keeps the difficulties monotonic by
// construction — there is no per-difficulty table to fall out of sync.
//
// The old AI branched on a boolean `predictionDepth`: Rookie chased the ball's
// current x, everyone above solved the exact landing point including wall
// reflections. Measured against the real collision code, that made Pro, Chaos
// and Cyber return 100% of balls in every bucket — solo above Rookie was
// unwinnable, not merely hard. The fix is that a competent AI still misreads
// the ball; it just misreads it by less.

/**
 * Competence 0 (flailing) .. 1 (near-perfect) for an AI playing at `mu`.
 *
 * The ceiling moved UP with the five-rung ladder — a deliberate reversal of
 * the 0.9 → 0.66 cut, taken knowingly: players reported the whole ladder too
 * easy, and two new top rungs need headroom above the old Cyber to be
 * distinct. It rose again, 0.78 → 0.81, when the knots were extended past the
 * top anchor so the top three rungs stop being the same opponent.
 *
 * It cannot rise much further, and the reason is worth knowing before anyone
 * tries. This constant does FIVE jobs — the top knot, the clamp in
 * competenceForMu, the lapse normaliser, the serve-skill normaliser, and the
 * per-rally volatility clamp — so raising it changes every rung, not just the
 * top. And the hard rule in tests/physics.test.ts, that no difficulty may ever
 * return ≥93% of balls, binds: measured at the suite's own sample against a
 * mu-40 player, the top rungs sit at 91.0-91.2%, and pushing the clamp to 0.86
 * put them at 92.8% (93.0 on a smaller sample), which is a flaky CI job and a
 * broken promise at the same time.
 *
 * One thing this bought back on the way up: at the old clamp all three top
 * rungs had serve skill exactly 1.000 — identical serves by construction —
 * because that is `competence / MAX_AI_COMPETENCE`. They now differ.
 */
export const MAX_AI_COMPETENCE = 0.81;

/**
 * The ceiling a PLAY-BOT may play at, above the solo ladder's.
 *
 * `MAX_AI_COMPETENCE` is a statement about the five DIFFICULTIES: it is their
 * top knot, their clamp, and the denominator their lapse and serve skill are
 * normalised by, and it came DOWN to 0.81 because an adapted Cyber returning
 * 93% made the top rung a lottery on the AI's own error. None of that
 * reasoning is about a bot, which is not a rung of anybody's ladder and has to
 * be able to hold its own against a Cyber Overlord for the population to reach
 * the top of the board at all.
 *
 * So the ceiling is a PARAMETER wherever those five sites read it, defaulting
 * to the solo value — which is what keeps solo byte-identical, and what
 * `tests/physics.test.ts` asserts over the whole rung-by-rating grid.
 *
 * `tests/physics.test.ts`'s standing rule — no DIFFICULTY may ever return ≥93%
 * of balls — stays scoped to the five difficulties. It is not widened to bots,
 * which get their own bound: the rule exists because a rung a player cannot
 * beat is a broken rung, and a bot is an opponent rather than a setting.
 */
export const BOT_MAX_COMPETENCE = 0.95;

/**
 * The other end of the same range, and it exists for the same reason the top
 * one does: the curve has to keep the rungs apart everywhere they can land.
 *
 * effectiveAiMu tracks the player DOWN by AI_ADAPT_DOWN_BAND (20), so the
 * reachable effective mu runs from Rookie's 20 - 20 = 0 to Chaos's 36 +
 * AI_ADAPT_BAND = 43. The curve used to start at mu 12 and clamp at 0.05
 * underneath, which put Rookie AND Pro on that floor for every player under
 * mu ~10.9 — a state reached by ordinary losing, since rating has no floor of
 * its own (twenty Pro losses from a standing start land at mu 8.76). Measured
 * at 2700 balls a cell there, Rookie returned 44.6% of them and Pro 45.4%:
 * the same opponent, while prediction and XP priced Pro as substantially
 * stronger. At mu 0 the collapse reached Elite as well and the measured order
 * inverted — Elite 41.6% against Rookie's 44.4%.
 *
 * 0.02 rather than 0 because every parameter in paramsForCompetence is a lerp
 * in c, so a rung at 0 is the fixed bottom of all nine at once and nothing
 * below it can ever be told apart. Note that a floor in the CURVE is not by
 * itself enough — see MAX_CONTACT_ERROR, which was pinning the dominant
 * parameter well above it.
 */
export const MIN_AI_COMPETENCE = 0.02;

// The ladder as it is actually PLAYED, in competence.
//
// Knots at the five anchors in rating.ts (rookie 20, pro 24, elite 30, cyber
// 33, chaos 36), each calibrated against the rally simulation in
// tests/physics.test.ts rather than chosen: measured at player mu 25, roughly
// 72% of balls returned at Rookie, 79% at Pro, 86% at Elite, 89% at Cyber and
// 89% at Chaos.
//
// Two knots then continue PAST the top anchor to 43, which is 36 +
// AI_ADAPT_BAND and therefore the furthest an adapted Chaos can reach. Without
// them the curve went flat at 36 — and because effectiveAiMu measures its
// deviation from START_MU, every rung receives the identical offset and they
// all arrived at that flat section together: from player mu 30 upward Elite,
// Cyber and Chaos were byte-identical opponents.
//
// The separation up there is deliberately small (0.784 / 0.795 / 0.810 against
// a mu-40 player) and cannot be widened: return rate SATURATES near the top,
// so a bigger competence spread buys almost no measurable difficulty, while
// the hard 93% ceiling in tests/physics.test.ts caps how far the hardest rung
// may go. What actually separates the top three is carried elsewhere — the
// anchor each is rated at, how hard each plays for the corners (aimBias),
// how much spin each reads, and serve pace.
//
// And one knot continues DOWN, to the other end of the same reachable range.
// The curve used to start at mu 12 with a flat clamp underneath, which is the
// identical collapse seen from below: a player under mu ~10.9 met a Rookie and
// a Pro pinned to the same 0.05, and at mu 0 the pin reached Elite too and
// INVERTED the ladder — measured over 4000 rally starts, Elite committed a
// mean aim error of 0.5610 against Rookie's 0.5522, because with competence
// flat the only surviving difference between the rungs was their volatility,
// and Elite's swing is the smaller one. That is reachable by ordinary losing:
// rating carries no floor of its own and twenty Pro losses land at mu 8.76.
// See MIN_AI_COMPETENCE, and MAX_CONTACT_ERROR for the second floor that had
// to move with it.
const COMPETENCE_KNOTS: readonly (readonly [number, number])[] = [
  [0, MIN_AI_COMPETENCE],
  [12, 0.05],
  [20, 0.36],
  [24, 0.49],
  [30, 0.66],
  [33, 0.72],
  [36, 0.78],
  // Above the top ANCHOR, not above the ladder. The curve used to stop at
  // Chaos's own anchor of 36 and go flat, and effectiveAiMu measures its
  // deviation from START_MU — so every rung receives the IDENTICAL offset and
  // they all reached that flat section together. Measured: from player mu 30
  // upward Elite, Cyber and Chaos were byte-identical at 0.780, and every
  // player who can select Chaos (cyber_10 gates it on Grandmaster) was inside
  // that region. The ladder advertised five rungs and delivered three.
  //
  // These two carry the adaptation band (7) past the top anchor so an adapted
  // Cyber and an adapted Chaos still separate. Nothing above 43 is reachable:
  // 36 + AI_ADAPT_BAND is exactly 43.
  [40, 0.795],
  [43, MAX_AI_COMPETENCE],
];

export function competenceForMu(mu: number): number {
  if (!Number.isFinite(mu)) return MIN_AI_COMPETENCE;
  for (let i = 1; i < COMPETENCE_KNOTS.length; i++) {
    const [mLo, cLo] = COMPETENCE_KNOTS[i - 1];
    const [mHi, cHi] = COMPETENCE_KNOTS[i];
    if (mu <= mHi) {
      const t = clamp((mu - mLo) / (mHi - mLo), 0, 1);
      return clamp(cLo + (cHi - cLo) * t, MIN_AI_COMPETENCE, MAX_AI_COMPETENCE);
    }
  }
  return MAX_AI_COMPETENCE;
}

export interface AIStyle {
  /** How far competence swings between rallies — Chaos is erratic by design. */
  volatility: number;
  /** How hard it plays for the corners rather than safely centring the return. */
  aggression: number;
}

const AI_STYLES: Record<AIDifficulty, AIStyle> = {
  rookie: { volatility: 0.06, aggression: 0.15 },
  pro: { volatility: 0.08, aggression: 0.58 },
  elite: { volatility: 0.05, aggression: 0.75 },
  cyber: { volatility: 0.04, aggression: 0.9 },
  // Chaos's identity is the anchor it is rated at and how hard it plays for the
  // corners, NOT volatility. It carried 0.11 while sitting on the competence
  // clamp, where a swing can only reach downward — so the rung the ladder
  // rates hardest measured as the WEAKEST of the top three (mean per-rally
  // competence 0.7525 against Cyber's 0.7700). A style that can only subtract
  // is a penalty wearing a style's name.
  chaos: { volatility: 0, aggression: 0.95 },
};

interface AIParams {
  reactionTime: number;
  maxSpeed: number;
  contactError: number;
  readError: number;
  bounceSkill: number;
  lapseChance: number;
  jitter: number;
  spinRead: number;
}

// A lapse is the AI not moving for a WHOLE rally, and on the original line
// (`lerp(0.14, 0, c)`) that was one rally in nine at Rookie — the single most
// visible thing about the bottom rung, and the part that read as broken
// rather than easy. Cut at the bottom (0.075, as before) and running down to
// what the original expression gives at the ceiling (0.14 × (1 − 0.78) ≈
// 0.03): even Chaos stands a rally out roughly one time in thirty-three,
// which is part of why the ceiling is not a wall.
export function lapseForCompetence(c: number, ceiling: number = MAX_AI_COMPETENCE): number {
  // The floor rose with the aggression rework. Aggression used to be paid for
  // in accuracy — it was added to targetX, so a rung played for the corners by
  // standing off-centre and missing more. Moving it to the ball leaving made
  // the AI strictly better, and the ladder's hardest rungs went straight at
  // the 93% ceiling (measured 92.8, and 93.0 on a smaller sample). The
  // difference is given back here rather than by capping competence, because
  // competence is what ORDERS the rungs and lapses are what make any of them
  // beatable.
  return lerp(0.078, 0.048, clamp(c / ceiling, 0, 1));
}

// Calibrated by simulating rallies through the real checkPaddleCollision above.
// The paddle catches a ball within ~0.147 of its centre (half-width plus ball
// radius plus the edge buffer), so `contactError` — the aim error still present
// at the moment of contact — is what actually decides whether the AI returns.
//
// This comment used to quote "Rookie 57%, Pro 77%, Chaos 87%, Cyber 89%" — the
// PRE-FIX numbers, with the top two printed in the wrong order, and a Rookie
// figure that tests/physics.test.ts asserts must be above 66% precisely
// because 57% was the bug that was fixed. Current measured rates live in the
// header note above competenceForMu, in one place, where the curve they
// describe is.
/**
 * The most aim error the AI may carry into a contact, as a standard deviation
 * against a catch window of ~0.147.
 *
 * Derived from MIN_AI_COMPETENCE rather than picked, because a flat number here
 * is a SECOND floor under the curve and it sat well above the first one. It was
 * 0.6, which `0.085 * c^-0.7` reaches at c = 0.061 — above the competence an
 * adapted Rookie AND an adapted Pro play at for any player under mu ~10.9, so
 * the ladder's dominant parameter was one value for both of them exactly where
 * the rungs are meant to be furthest apart. Extending COMPETENCE_KNOTS down to
 * mu 0 did not fix that on its own: the curve separated (0.035 against 0.045 at
 * mu 8.76) and the measured return rates did not move at all, 43.7% against
 * 44.1% over 2700 balls a cell.
 *
 * Anchoring it to the bottom of the competence range makes it a rail against a
 * nonsense input instead of a pin inside the reachable one — it can no longer
 * bind for any competence the curve can produce. Nothing at ordinary skill
 * changes: an average player's Rookie sits at c 0.36, where the expression
 * gives 0.174.
 */
const MAX_CONTACT_ERROR = 0.085 * Math.pow(MIN_AI_COMPETENCE, -0.7);

function paramsForCompetence(c: number, ceiling: number = MAX_AI_COMPETENCE): AIParams {
  return {
    reactionTime: lerp(0.34, 0.05, c),
    maxSpeed: lerp(0.6, 1.7, c),
    contactError: clamp(0.085 * Math.pow(c, -0.7), 0.078, MAX_CONTACT_ERROR),
    // An early misread that decays as the ball closes: the AI commits to the
    // wrong spot, then scrambles. Costs it the rally when it cannot cover the
    // correction in time, which is where maxSpeed bites.
    readError: lerp(0.3, 0.05, c),
    // Chance it resolves a wall bounce instead of chasing the unreflected line.
    bounceSkill: clamp((c - 0.1) / 0.6, 0, 1),
    lapseChance: lapseForCompetence(c, ceiling),
    jitter: lerp(0.05, 0.008, c),
    // How much of the ball's curve it accounts for. A weak AI reads a spinning
    // ball as if it were travelling straight and arrives where the ball would
    // have been — the most natural way for an AI to be beaten, and a better
    // difficulty lever than raw aim error. Deliberately capped below 1: an AI
    // that read curve perfectly would make spin worthless against the top
    // rung, which is exactly where a player most needs another option.
    // The divisor is set so the cap is reached only at the top of the
    // competence range, not partway up it. At /0.72 it saturated at c = 0.692
    // — which an adapted Cyber passes at player mu 22.7 and an adapted Elite
    // at 27.7 — so every rung a strong player ever meets read spin
    // identically, and a lever the design leans on for the top of the ladder
    // was doing nothing there. /0.86 puts the cap at c = 0.821, just past
    // Chaos at its clamp.
    spinRead: clamp((c - 0.08) / 0.86, 0, MAX_SPIN_READ),
  };
}

// ---------------------------------------------------------------------------
// AI serving
// ---------------------------------------------------------------------------
// The AI has no finger to tap with, so it serves itself. It used to do so on a
// flat 900ms timer with a random angle and fixed power — a metronome that
// served nowhere in particular. Both are now expressions of how good it is.

export const AI_SERVE_DELAY_MIN = 0.6;
export const AI_SERVE_DELAY_MAX = 1.15;

/** How the match is going for the player, 0 (being crushed) .. 1 (cruising). */
export interface MatchPressure {
  playerScore: number;
  opponentScore: number;
  /** Best rally this match — a proxy for how well the player is hanging on. */
  maxRally: number;
}

export function playerPressure(state: MatchPressure): number {
  const total = state.playerScore + state.opponentScore;
  const lead = total > 0 ? (state.playerScore - state.opponentScore) / total : 0;
  // A long rally means the player is competing even when the score says not.
  const rally = clamp((state.maxRally || 0) / 14, 0, 1);
  return clamp(0.5 + lead * 0.4 + (rally - 0.5) * 0.2, 0, 1);
}

/**
 * Seconds the AI waits before serving. A weak AI dawdles; a strong one is
 * brisk, and gets brisker still while the player is winning — the pressure
 * term is what makes a comeback feel like the opponent is bearing down.
 */
export function aiServeDelay(
  competence: number,
  pressure = 0.5,
  ceiling: number = MAX_AI_COMPETENCE
): number {
  const skill = clamp(competence / ceiling, 0, 1);
  const base = lerp(AI_SERVE_DELAY_MAX, AI_SERVE_DELAY_MIN, skill);
  const urgency = (clamp(pressure, 0, 1) - 0.5) * 0.18;
  const jitter = (Math.random() - 0.5) * 0.12;
  return clamp(base - urgency + jitter, AI_SERVE_DELAY_MIN, AI_SERVE_DELAY_MAX);
}

/**
 * How the AI aims its serve. It plays away from where the player is standing,
 * and commits harder the better it is: a Rookie serve is barely more than
 * noise, a Cyber serve is a deliberate corner at pace.
 *
 * `playerPaddleX` is in the PLAYER's coordinates; the cross-net transform
 * mirrors x, so the AI targets the mirror of where the player is not.
 *
 * A player standing dead centre has left neither side open, and a bare
 * `> 0.5` resolved that tie the same way every time — so the first AI serve of
 * every match, taken against a paddle still sitting at its starting 0.5, was
 * predictably to one side. A centred player draws a coin flip instead.
 */
export function aiServeAim(
  competence: number,
  playerPaddleX: number,
  ceiling: number = MAX_AI_COMPETENCE
): ServeAim {
  const skill = clamp(competence / ceiling, 0, 1);
  // Where the player stands, seen from the AI's own half.
  const playerInAiCoords = 1 - clamp(playerPaddleX, 0, 1);
  // Serve to the side the player has left open — or either, if they are
  // covering the middle and there is no open side to pick.
  const offCentre = playerInAiCoords - 0.5;
  const direction =
    Math.abs(offCentre) < 1e-6 ? (Math.random() < 0.5 ? -1 : 1) : offCentre > 0 ? -1 : 1;
  const commitment = skill * 0.85;
  const noise = (Math.random() - 0.5) * 2 * (1 - skill) * 0.8;
  return {
    angle: clamp(direction * commitment + noise, -1, 1),
    power: clamp(0.35 + skill * 0.5 + (Math.random() - 0.5) * 0.2, 0, 1),
  };
}

/**
 * AI Bot logic on the hidden opponent half-court
 */
export class OpponentAI {
  public paddleX: number = 0.5;
  public paddleVx: number = 0;
  public difficulty: AIDifficulty;
  private playerMu: number = START_MU;
  private reactionDelayTimer: number = 0;
  private rules: Partial<MatchRules> | undefined;
  private targetX: number = 0.5;

  // Per-rally state: the AI decides how it is going to read *this* ball once,
  // when the ball enters its half, and lives with that read. Re-rolling the
  // error every tick would average out to a perfect aim over a long flight,
  // which is exactly how the previous AI became unbeatable.
  private rallyActive: boolean = false;
  private entryY: number = 0;
  private contactBias: number = 0;
  private readBias: number = 0;
  private aggressionBias: number = 0;
  private lapsed: boolean = false;
  private readsBounce: boolean = true;
  private spinRead: number = 1;
  private params: AIParams = paramsForCompetence(competenceForMu(AI_RATINGS.pro.mu));

  /**
   * A PLAY-BOT's own competence and style, in place of the difficulty ladder's.
   *
   * Solo derives competence from the PLAYER's mu so the rung adapts to them
   * (`effectiveAiMu`). A play-bot must not: its competence is an intrinsic
   * trait, so its strength cannot chase its own results and its rating stays a
   * measurement of something. Absent — which is every solo match — nothing
   * below changes at all.
   */
  private override: { competence: number; style: AIStyle; spinRead?: number } | null = null;
  private rallyCompetence: number = 0;

  constructor(
    difficulty: AIDifficulty = 'pro',
    playerMu: number = START_MU,
    override: { competence: number; style: AIStyle; spinRead?: number } | null = null
  ) {
    this.difficulty = difficulty;
    this.playerMu = playerMu;
    this.override = override;
  }

  public setDifficulty(diff: AIDifficulty) {
    this.difficulty = diff;
  }

  /**
   * Feed the AI the player's hidden rating so the difficulty can slide toward
   * them. Safe to call every time the profile refreshes; it only takes effect
   * on the next rally.
   */
  public setPlayerSkill(mu: number) {
    if (Number.isFinite(mu)) this.playerMu = mu;
  }

  /** The mu this AI is actually playing at — what a match against it is worth. */
  public effectiveMu(): number {
    return effectiveAiMu(this.difficulty, this.playerMu);
  }

  /** Its competence right now, for serve timing and aim. */
  public competence(): number {
    return this.override ? this.override.competence : competenceForMu(this.effectiveMu());
  }

  /**
   * The top this AI may play at.
   *
   * A play-bot's is BOT_MAX_COMPETENCE and a difficulty's is the solo ladder's,
   * which is what keeps every solo number identical: the five sites that read
   * a ceiling all take it from here, and for a rung it is the constant they
   * always had.
   */
  /** The competence rolled for the rally in progress, after the clamp. */
  public lastRallyCompetence(): number {
    return this.rallyCompetence;
  }

  public ceiling(): number {
    return this.override ? BOT_MAX_COMPETENCE : MAX_AI_COMPETENCE;
  }

  public reset() {
    this.paddleX = 0.5;
    this.targetX = 0.5;
    this.paddleVx = 0;
    this.reactionDelayTimer = 0;
    this.rallyActive = false;
  }

  /** Decide how this particular ball gets read, once, as it crosses the net. */
  private beginRally(oppBall: BallState) {
    const style = this.override ? this.override.style : AI_STYLES[this.difficulty];
    const base = this.competence();
    // The ceiling a PLAY-BOT plays under is its own; the five difficulties
    // keep theirs. Both the volatility clamp and the lapse normaliser read it,
    // so a bot above 0.81 is not silently pulled back to a rung's limit.
    const c = clamp(
      base + (Math.random() - 0.5) * 2 * style.volatility,
      MIN_AI_COMPETENCE,
      this.ceiling()
    );
    const p = paramsForCompetence(c, this.ceiling());
    this.params = p;
    // Kept so the CLAMP is observable. Everything it feeds is private and its
    // only other consequence is a return rate, which no fixture can attribute
    // to one ceiling — measured, reverting the clamp to the solo constant
    // reddened nothing at all.
    this.rallyCompetence = c;

    this.rallyActive = true;
    this.entryY = oppBall.y;
    this.contactBias = gaussian() * p.contactError;
    this.readBias = gaussian() * p.readError;
    this.readsBounce = Math.random() < p.bounceSkill;
    // Rolled per rally like everything else: an AI commits to one reading of
    // this ball. Re-deciding every tick would average out to a perfect read.
    // A play-bot's spin reading is a PERSISTENT TRAIT, not a function of its
    // competence: two bots that have converged on the same tier still read
    // spin differently, which is the whole point of style being separate from
    // skill (§4.13). Absent -- every solo match -- this is `p.spinRead` and
    // the line is byte-identical to what it was.
    const spinBase = this.override?.spinRead ?? p.spinRead;
    this.spinRead = clamp(spinBase * (0.75 + Math.random() * 0.5), 0, 1);
    this.lapsed = Math.random() < p.lapseChance;
    // Which corner this rally is played for, committed once like every other
    // read. Applied to the ball LEAVING (see aimBias), never to where the
    // paddle stands.
    this.aggressionBias = (Math.random() - 0.5) * 2 * style.aggression;
    this.reactionDelayTimer = p.reactionTime; // plan immediately on arrival
  }

  /**
   * Aggression, applied to the ball LEAVING rather than to where the paddle
   * stands.
   *
   * It used to be added to `targetX`, so a rung played for the corners by
   * deliberately standing off-centre from where the ball was going: it bought
   * a sharper rebound with a higher chance of missing outright. That reads as
   * a risk/reward style and measured as a self-handicap — the harder rungs
   * carry MORE aggression, so the lever fought the competence curve that is
   * supposed to order them, and Cyber returned fewer balls than Elite despite
   * strictly better parameters.
   *
   * Here it costs the AI nothing and costs the PLAYER the width of the court:
   * the return leaves at a steeper angle, so it has further to travel to reach
   * it. That gives the top rungs the second separating axis they need, because
   * return rate saturates near the top and cannot carry them on its own.
   *
   * Bounded by the same limit checkPaddleCollision applies, so the AI can
   * never produce a ball the physics would not.
   */
  public aimBias(): number {
    return (this.aggressionBias * AI_AGGRESSION_ANGLE_DEG * Math.PI) / 180;
  }

  /**
   * Update AI paddle position based on ball in opponent's half
   * @param oppBall Ball state from opponent's perspective (0 is top/net, 1 is baseline)
   * @param dt Delta time in seconds
   * @param paddleWidth Opponent paddle width
   */
  public update(
    oppBall: BallState | null,
    dt: number,
    paddleWidth: number,
    rules?: Partial<MatchRules>
  ) {
    // The AI predicts under the same speed band the ball is actually held to.
    this.rules = rules;
    if (!oppBall || !oppBall.active || oppBall.vy <= 0) {
      // Return gently toward center when ball is not on AI's side
      this.rallyActive = false;
      const centerTarget = 0.5;
      const speed = 0.8 * dt;
      this.paddleX += (centerTarget - this.paddleX) * speed;
      return;
    }

    if (!this.rallyActive) this.beginRally(oppBall);
    const p = this.params;
    this.reactionDelayTimer += dt;

    if (this.reactionDelayTimer >= p.reactionTime) {
      this.reactionDelayTimer = 0;

      const timeToPaddle = (PADDLE_Y - oppBall.y) / oppBall.vy;
      if (timeToPaddle > 0) {
        let predicted: number;
        if (this.readsBounce) {
          // Same rules the ball obeys, with this AI's reading of the spin. An
          // AI that reads none of it expects the plain mirror angle off the
          // wall; one that reads it expects the kick.
          predicted = predictLanding(oppBall, this.spinRead, this.rules);
        } else {
          // Missed the wall read: keeps chasing the line straight into the wall.
          predicted = clamp(oppBall.x + oppBall.vx * timeToPaddle, 0.02, 0.98);
        }

        // How far down its half the ball has come: the early misread fades,
        // the contact bias does not.
        const travelled = clamp(
          (oppBall.y - this.entryY) / Math.max(1e-3, PADDLE_Y - this.entryY),
          0,
          1
        );
        this.targetX =
          predicted +
          this.contactBias +
          this.readBias * (1 - travelled) +
          gaussian() * p.jitter;
      } else {
        this.targetX = oppBall.x;
      }
    }

    if (this.lapsed) {
      this.paddleVx = 0;
      return; // read this one completely wrong and never committed
    }

    // Clamp target within table boundaries
    const halfP = paddleWidth / 2;
    const clampedTarget = Math.max(halfP, Math.min(1 - halfP, this.targetX));

    // Smooth movement towards target
    const prevX = this.paddleX;
    const dx = clampedTarget - this.paddleX;
    const maxMove = p.maxSpeed * dt;
    const move = Math.sign(dx) * Math.min(Math.abs(dx), maxMove);
    this.paddleX += move;
    this.paddleVx = (this.paddleX - prevX) / (dt || 0.016);
  }
}
