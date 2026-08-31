import { AIDifficulty, BallState, MatchRules } from '../types';
import { normalizeRules } from '../matchRules';
import { AI_RATINGS, START_MU, effectiveAiMu } from '../rating';

export const PADDLE_Y = 0.92;
export const PADDLE_HEIGHT = 0.024;
// Fixed for every player and mode — fairness rule: paddle width and ball
// speed are never exposed as user settings.
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
export const BALL_BASE_RADIUS = 0.022;
export const BASE_BALL_SPEED = 0.85; // units per second
export const MAX_BALL_SPEED = 2.4;

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
  paddleVx: number = 0
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
          (incoming * SPIN_REBOUND_DEG * Math.PI) / 180,
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
        MAX_BALL_SPEED
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
 * distinct. 0.78 puts the hardest thing in the game (Chaos, and an adapted
 * Chaos at the clamp) near ~90% of balls returned — a genuine wall that still
 * drops roughly one ball in ten. The old lottery critique is honoured by the
 * hard rule in tests/physics.test.ts: no difficulty may ever return ≥93%.
 */
export const MAX_AI_COMPETENCE = 0.81;

// The ladder as it is actually PLAYED, in competence.
//
// Knots at the five anchors in rating.ts (rookie 20, pro 24, elite 30, cyber
// 33, chaos 36), each calibrated against the rally simulation in
// tests/physics.test.ts rather than chosen: the targets are roughly 72% of
// balls returned at Rookie, 79% at Pro, 85% at Elite, 88% at Cyber and 90% at
// Chaos. Return rate saturates near the top, so the top rungs sit closer
// together in balls returned than in matches won — the measure players feel.
// Above the top anchor the curve is flat at the clamp: an adapted Chaos plays
// the ceiling, never past it.
const COMPETENCE_KNOTS: readonly (readonly [number, number])[] = [
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
  if (!Number.isFinite(mu)) return 0.05;
  for (let i = 1; i < COMPETENCE_KNOTS.length; i++) {
    const [mLo, cLo] = COMPETENCE_KNOTS[i - 1];
    const [mHi, cHi] = COMPETENCE_KNOTS[i];
    if (mu <= mHi) {
      const t = clamp((mu - mLo) / (mHi - mLo), 0, 1);
      return clamp(cLo + (cHi - cLo) * t, 0.05, MAX_AI_COMPETENCE);
    }
  }
  return MAX_AI_COMPETENCE;
}

interface AIStyle {
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
function lapseForCompetence(c: number): number {
  // The floor rose with the aggression rework. Aggression used to be paid for
  // in accuracy — it was added to targetX, so a rung played for the corners by
  // standing off-centre and missing more. Moving it to the ball leaving made
  // the AI strictly better, and the ladder's hardest rungs went straight at
  // the 93% ceiling (measured 92.8, and 93.0 on a smaller sample). The
  // difference is given back here rather than by capping competence, because
  // competence is what ORDERS the rungs and lapses are what make any of them
  // beatable.
  return lerp(0.078, 0.048, clamp(c / MAX_AI_COMPETENCE, 0, 1));
}

// Calibrated by simulating rallies through the real checkPaddleCollision above.
// The paddle catches a ball within ~0.147 of its centre (half-width plus ball
// radius plus the edge buffer), so `contactError` — the aim error still present
// at the moment of contact — is what actually decides whether the AI returns.
// Its curve is what sets the ladder: measured AI return rates come out at
// roughly Rookie 57%, Pro 77%, Chaos 87%, Cyber 89% for an average player.
function paramsForCompetence(c: number): AIParams {
  return {
    reactionTime: lerp(0.34, 0.05, c),
    maxSpeed: lerp(0.6, 1.7, c),
    contactError: clamp(0.085 * Math.pow(c, -0.7), 0.078, 0.6),
    // An early misread that decays as the ball closes: the AI commits to the
    // wrong spot, then scrambles. Costs it the rally when it cannot cover the
    // correction in time, which is where maxSpeed bites.
    readError: lerp(0.3, 0.05, c),
    // Chance it resolves a wall bounce instead of chasing the unreflected line.
    bounceSkill: clamp((c - 0.1) / 0.6, 0, 1),
    lapseChance: lapseForCompetence(c),
    jitter: lerp(0.05, 0.008, c),
    // How much of the ball's curve it accounts for. A weak AI reads a spinning
    // ball as if it were travelling straight and arrives where the ball would
    // have been — the most natural way for an AI to be beaten, and a better
    // difficulty lever than raw aim error. Deliberately capped below 1: an AI
    // that read curve perfectly would make spin worthless against the top
    // rung, which is exactly where a player most needs another option.
    spinRead: clamp((c - 0.08) / 0.72, 0, MAX_SPIN_READ),
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
export function aiServeDelay(competence: number, pressure = 0.5): number {
  const skill = clamp(competence / MAX_AI_COMPETENCE, 0, 1);
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
export function aiServeAim(competence: number, playerPaddleX: number): ServeAim {
  const skill = clamp(competence / MAX_AI_COMPETENCE, 0, 1);
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

  constructor(difficulty: AIDifficulty = 'pro', playerMu: number = START_MU) {
    this.difficulty = difficulty;
    this.playerMu = playerMu;
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
    return competenceForMu(this.effectiveMu());
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
    const style = AI_STYLES[this.difficulty];
    const base = competenceForMu(this.effectiveMu());
    const c = clamp(base + (Math.random() - 0.5) * 2 * style.volatility, 0.05, MAX_AI_COMPETENCE);
    const p = paramsForCompetence(c);
    this.params = p;

    this.rallyActive = true;
    this.entryY = oppBall.y;
    this.contactBias = gaussian() * p.contactError;
    this.readBias = gaussian() * p.readError;
    this.readsBounce = Math.random() < p.bounceSkill;
    // Rolled per rally like everything else: an AI commits to one reading of
    // this ball. Re-deciding every tick would average out to a perfect read.
    this.spinRead = clamp(p.spinRead * (0.75 + Math.random() * 0.5), 0, 1);
    this.lapsed = Math.random() < p.lapseChance;
    // Which corner this rally is played for, committed once like every other
    // read. Applied to the ball LEAVING (see aimReturn), never to where the
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
  public aimReturn(angle: number): number {
    const limit = (Math.PI / 180) * MAX_REBOUND_ANGLE_DEG;
    const push = (this.aggressionBias * AI_AGGRESSION_ANGLE_DEG * Math.PI) / 180;
    return clamp(angle + push, -limit, limit);
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
