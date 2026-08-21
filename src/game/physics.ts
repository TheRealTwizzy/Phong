import { AIDifficulty, BallState } from '../types';

export const PADDLE_Y = 0.92;
export const PADDLE_HEIGHT = 0.024;
// Fixed for every player and mode — fairness rule: paddle width and ball
// speed are never exposed as user settings.
export const PADDLE_WIDTH_RATIO = 0.22;
export const BALL_BASE_RADIUS = 0.022;
export const BASE_BALL_SPEED = 0.85; // units per second
export const MAX_BALL_SPEED = 2.4;

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

/**
 * AI Bot logic on the hidden opponent half-court
 */
export class OpponentAI {
  public paddleX: number = 0.5;
  public paddleVx: number = 0;
  public difficulty: AIDifficulty;
  private reactionDelayTimer: number = 0;
  private targetX: number = 0.5;

  constructor(difficulty: AIDifficulty = 'pro') {
    this.difficulty = difficulty;
  }

  public setDifficulty(diff: AIDifficulty) {
    this.difficulty = diff;
  }

  public reset() {
    this.paddleX = 0.5;
    this.targetX = 0.5;
    this.paddleVx = 0;
    this.reactionDelayTimer = 0;
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
      const centerTarget = 0.5;
      const speed = 0.8 * dt;
      this.paddleX += (centerTarget - this.paddleX) * speed;
      return;
    }

    this.reactionDelayTimer += dt;

    // AI parameters per difficulty
    let reactionTime = 0.08;
    let maxSpeed = 1.6;
    let errorMargin = 0.04;
    let predictionDepth = true;

    switch (this.difficulty) {
      case 'rookie':
        reactionTime = 0.22;
        maxSpeed = 0.9;
        errorMargin = 0.14;
        predictionDepth = false;
        break;
      case 'pro':
        reactionTime = 0.1;
        maxSpeed = 1.4;
        errorMargin = 0.05;
        predictionDepth = true;
        break;
      case 'cyber':
        reactionTime = 0.03;
        maxSpeed = 2.1;
        errorMargin = 0.01;
        predictionDepth = true;
        break;
      case 'chaos':
        reactionTime = 0.06;
        maxSpeed = 1.8;
        errorMargin = (Math.random() - 0.5) * 0.15;
        predictionDepth = true;
        break;
    }

    if (this.reactionDelayTimer >= reactionTime) {
      this.reactionDelayTimer = 0;

      if (predictionDepth) {
        // Calculate predicted arrival X where ball will reach paddle Y
        const timeToPaddle = (PADDLE_Y - oppBall.y) / oppBall.vy;
        if (timeToPaddle > 0) {
          let predictedX = oppBall.x + oppBall.vx * timeToPaddle;
          // Account for wall bounces
          while (predictedX < 0 || predictedX > 1) {
            if (predictedX < 0) predictedX = -predictedX;
            if (predictedX > 1) predictedX = 2 - predictedX;
          }
          // Intentionally aim corner shots if pro/cyber
          const strategyOffset = (this.difficulty === 'cyber' || this.difficulty === 'chaos')
            ? (Math.sin(Date.now() / 300) * (paddleWidth * 0.35))
            : 0;

          this.targetX = predictedX + strategyOffset + (Math.random() - 0.5) * errorMargin;
        } else {
          this.targetX = oppBall.x;
        }
      } else {
        this.targetX = oppBall.x + (Math.random() - 0.5) * errorMargin;
      }
    }

    // Clamp target within table boundaries
    const halfP = paddleWidth / 2;
    const clampedTarget = Math.max(halfP, Math.min(1 - halfP, this.targetX));

    // Smooth movement towards target
    const prevX = this.paddleX;
    const dx = clampedTarget - this.paddleX;
    const maxMove = maxSpeed * dt;
    const move = Math.sign(dx) * Math.min(Math.abs(dx), maxMove);
    this.paddleX += move;
    this.paddleVx = (this.paddleX - prevX) / (dt || 0.016);
  }
}
