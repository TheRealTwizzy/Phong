import { AIDifficulty, BallState, MatchRules } from '../types';
import { normalizeRules } from '../matchRules';
import { AI_RATINGS, START_MU, effectiveAiMu } from '../rating';

export const PADDLE_Y = 0.92;
export const PADDLE_HEIGHT = 0.024;
// Fixed for every player and mode — fairness rule: paddle width and ball
// speed are never exposed as user settings.
export const PADDLE_WIDTH_RATIO = 0.22;
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

      // Calculate rebound angle (max ~60 degrees)
      const maxAngle = (Math.PI / 180) * 62;
      const angle = hitOffset * maxAngle;

      const currentSpeed = Math.hypot(ball.vx, ball.vy);
      // Speed up slightly on each hit up to cap
      const newSpeed = Math.min(currentSpeed * 1.04, MAX_BALL_SPEED);

      return {
        hit: true,
        angle,
        speed: newSpeed,
        offset: hitOffset,
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

/** Competence 0 (flailing) .. 1 (near-perfect) for an AI playing at `mu`. */
export function competenceForMu(mu: number): number {
  return clamp((mu - 12) / 29, 0.05, 0.9);
}

interface AIStyle {
  /** How far competence swings between rallies — Chaos is erratic by design. */
  volatility: number;
  /** How hard it plays for the corners rather than safely centring the return. */
  aggression: number;
}

const AI_STYLES: Record<AIDifficulty, AIStyle> = {
  rookie: { volatility: 0.06, aggression: 0.15 },
  pro: { volatility: 0.08, aggression: 0.45 },
  chaos: { volatility: 0.22, aggression: 0.85 },
  cyber: { volatility: 0.03, aggression: 1.0 },
};

interface AIParams {
  reactionTime: number;
  maxSpeed: number;
  contactError: number;
  readError: number;
  bounceSkill: number;
  lapseChance: number;
  jitter: number;
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
    lapseChance: lerp(0.14, 0, c),
    jitter: lerp(0.05, 0.008, c),
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
  private targetX: number = 0.5;

  // Per-rally state: the AI decides how it is going to read *this* ball once,
  // when the ball enters its half, and lives with that read. Re-rolling the
  // error every tick would average out to a perfect aim over a long flight,
  // which is exactly how the previous AI became unbeatable.
  private rallyActive: boolean = false;
  private entryY: number = 0;
  private contactBias: number = 0;
  private readBias: number = 0;
  private aimShift: number = 0;
  private lapsed: boolean = false;
  private readsBounce: boolean = true;
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
    const c = clamp(base + (Math.random() - 0.5) * 2 * style.volatility, 0.05, 0.97);
    const p = paramsForCompetence(c);
    this.params = p;

    this.rallyActive = true;
    this.entryY = oppBall.y;
    this.contactBias = gaussian() * p.contactError;
    this.readBias = gaussian() * p.readError;
    this.readsBounce = Math.random() < p.bounceSkill;
    this.lapsed = Math.random() < p.lapseChance;
    // Deliberate off-centre contact to return at a sharper angle. Bounded to
    // the paddle's own half-width so ambition never becomes a guaranteed whiff.
    this.aimShift = (Math.random() - 0.5) * 2 * style.aggression * 0.6;
    this.reactionDelayTimer = p.reactionTime; // plan immediately on arrival
  }

  /**
   * Update AI paddle position based on ball in opponent's half
   * @param oppBall Ball state from opponent's perspective (0 is top/net, 1 is baseline)
   * @param dt Delta time in seconds
   * @param paddleWidth Opponent paddle width
   */
  public update(oppBall: BallState | null, dt: number, paddleWidth: number) {
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
        const raw = oppBall.x + oppBall.vx * timeToPaddle;
        let predicted: number;
        if (this.readsBounce) {
          predicted = raw;
          while (predicted < 0 || predicted > 1) {
            if (predicted < 0) predicted = -predicted;
            if (predicted > 1) predicted = 2 - predicted;
          }
        } else {
          // Missed the wall read: keeps chasing the line straight into the wall.
          predicted = clamp(raw, 0.02, 0.98);
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
          gaussian() * p.jitter +
          this.aimShift * (paddleWidth / 2);
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
