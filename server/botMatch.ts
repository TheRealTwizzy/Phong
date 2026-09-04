// A play-bot's half of a court, and a whole match between two of them.
//
// This is the simulation ONLY. It owns no socket, no room, no database and no
// timer — it is stepped by a caller and reports what happened through the
// events it returns. That split is the same one `server/room.ts` and
// `server/matchmaking.ts` already make, and for the same reason: the rules can
// be argued about in a test without booting a process.
//
// It is also the one part of the play-bot feature whose COST decides whether
// the feature is possible at all, so it exists before the driver does: the
// server can run N of these with no sockets attached (see BOT_SIM_MATCHES in
// server.ts) and the contention against real relay traffic can be measured
// before anything is built on top.
//
// The frame convention is the one the client's own AI half already uses, and
// it is symmetric, which is what lets ONE implementation serve both sides:
// every half sees its own paddle at PADDLE_Y and the net at y = 0, so `vy > 0`
// is always "coming at me" and `y <= 0` is always "gone over the net". The
// asymmetry lives entirely in `transformBallForOpponent`, which is the same
// function the relay applies to a human crossing — so a bot rally and a human
// rally cannot disagree about what crossing the net does.

import {
  BALL_BASE_RADIUS,
  OpponentAI,
  PADDLE_HEIGHT,
  PADDLE_Y,
  aiServeAim,
  aiServeDelay,
  ballRadiusFor,
  bounceOffWall,
  checkPaddleCollision,
  clampBallSpeed,
  paddleWidthFor,
  physicsSubsteps,
  playerPressure,
  serveVelocity,
} from '../src/game/physics';
import { transformBallForOpponent } from './transform';
import type { AIDifficulty, BallState, MatchRules } from '../src/types';

/** Where a ball sits on the serving paddle, in that half's own frame. */
const SERVE_Y = PADDLE_Y - PADDLE_HEIGHT / 2 - 0.012;

/** Past this the ball is behind the baseline and the point is over. */
const MISS_Y = 1.05;

/**
 * A rally that will not end.
 *
 * Two evenly matched bots can in principle trade forever, and a match that
 * never ends is a bot that never frees its seat — which is rule 3 (a bot is
 * account-bound and exclusive) failing quietly rather than loudly. A rally
 * this long is not a rally, so the point is awarded to the receiver and play
 * moves on.
 */
const MAX_RALLY_SECONDS = 90;

/** What a single tick of a match produced, for the driver to act on. */
export interface BotMatchEvents {
  /** The ball crossed the net; the seat named is the one it arrived at. */
  crossedTo: 0 | 1 | null;
  /** A point was scored BY this seat. */
  scoredBy: 0 | 1 | null;
  /** The seat that just returned the ball, for streak counting. */
  returnedBy: 0 | 1 | null;
  /** The match reached the winning score. */
  finished: boolean;
}

const NO_EVENTS: BotMatchEvents = {
  crossedTo: null,
  scoredBy: null,
  returnedBy: null,
  finished: false,
};

/** What one half's own step produced, at its edges. */
export interface BotHalfStep {
  /** The serve clock ran out this tick; the caller launches the ball. */
  served: boolean;
  /** This half returned the ball. */
  returned: boolean;
  /** The ball left over the net, in THIS half's frame, untransformed. */
  crossed: { x: number; vx: number; vy: number; spin: number; speedMultiplier: number } | null;
  /** The ball went past this half's baseline: the other side scores. */
  missed: boolean;
}

/**
 * One bot's half-court.
 *
 * Holds the AI, its paddle, and the ball while the ball is on this side. The
 * ball being `null` is the whole of "not my problem right now" — it is either
 * on the other half or waiting to be served.
 */
export class BotHalf {
  public readonly ai: OpponentAI;
  public ball: BallState | null = null;
  /** Seconds left before this half serves, or null when it is not serving. */
  public serveIn: number | null = null;

  constructor(
    difficulty: AIDifficulty,
    /**
     * The bot's TRUE skill, fixed for its lifetime. Fed to the AI as the
     * "player" rating it adapts toward, which is what makes a bot's strength a
     * property of the bot rather than of whoever it happens to be playing.
     */
    trueSkillMu: number,
    private readonly rules: Partial<MatchRules> | undefined
  ) {
    this.ai = new OpponentAI(difficulty, trueSkillMu);
  }

  get paddleX(): number {
    return this.ai.paddleX;
  }

  reset(): void {
    this.ai.reset();
    this.ball = null;
    this.serveIn = null;
  }

  /** Put the ball on this half's paddle and start the serve clock. */
  beginServe(pressure: number): void {
    this.ball = null;
    this.serveIn = aiServeDelay(this.ai.competence(), pressure);
  }

  /** Take a ball that has just come over the net, already in this half's frame. */
  receive(ball: BallState): void {
    this.ball = ball;
    this.serveIn = null;
  }

  /**
   * Advance this half by `dt`, and say what happened at its edges.
   *
   * The caller decides what a crossing MEANS. Two of them do: `BotMatch` hands
   * the ball straight to the other half through the same transform the relay
   * uses, and the live driver puts it on the wire as `ball_cross_net` and lets
   * the relay do it. Both must agree about the physics, so the physics lives
   * here once rather than being written out twice — that split is exactly the
   * drift CLAUDE.md records between the relay and the P2P replica.
   *
   * `crossed` is the ball in THIS half's own frame, untransformed, because
   * that is what `ball_cross_net` carries and what the relay expects.
   */
  step(dt: number, paddleWidth: number): BotHalfStep {
    const out: BotHalfStep = { served: false, returned: false, crossed: null, missed: false };

    if (this.serveIn !== null) {
      this.serveIn -= dt;
      if (this.serveIn <= 0) {
        this.serveIn = null;
        out.served = true;
      }
    }

    const b = this.ball;
    // The AI tracks whatever is on its half. `update` handles a null or a ball
    // travelling away from it by drifting back toward centre, which is the
    // behaviour a bot waiting for a serve should have.
    this.ai.update(b && b.active && b.vy > 0 ? b : null, dt, paddleWidth, this.rules);
    if (!b || !b.active) return out;

    // Substepped for the same reason the client substeps: a fast ball can
    // otherwise tunnel through the paddle between two frames.
    const steps = physicsSubsteps(Math.hypot(b.vx, b.vy), dt, b.radius);
    const sdt = dt / steps;

    for (let i = 0; i < steps; i++) {
      b.x += b.vx * sdt;
      b.y += b.vy * sdt;

      // Side walls, under the match's own speed band and spin rules.
      if (b.x - b.radius <= 0 || b.x + b.radius >= 1) {
        const atLeft = b.x - b.radius <= 0;
        b.x = atLeft ? b.radius : 1 - b.radius;
        const bounced = bounceOffWall(b.vx, b.vy, b.spin ?? 0, atLeft, this.rules);
        b.vx = bounced.vx;
        b.vy = bounced.vy;
        b.spin = bounced.spin;
      }

      const hit = checkPaddleCollision(
        b,
        this.paddleX,
        paddleWidth,
        this.ai.paddleVx,
        this.ai.aimBias(),
        this.rules
      );
      if (hit.hit && hit.angle !== undefined && hit.speed !== undefined) {
        const speed = clampBallSpeed(hit.speed, this.rules);
        b.vy = -Math.abs(speed * Math.cos(hit.angle));
        b.vx = speed * Math.sin(hit.angle);
        b.spin = hit.spin ?? 0;
        b.y = PADDLE_Y - PADDLE_HEIGHT / 2 - b.radius;
        out.returned = true;
      }

      if (b.y <= 0) {
        b.active = false;
        out.crossed = { x: b.x, vx: b.vx, vy: b.vy, spin: b.spin ?? 0, speedMultiplier: 1 };
        this.ball = null;
        break;
      }

      if (b.y >= MISS_Y) {
        b.active = false;
        this.ball = null;
        out.missed = true;
        break;
      }
    }

    return out;
  }

  /** Launch the ball this half is holding, aimed away from `opponentPaddleX`. */
  serve(opponentPaddleX: number, radius: number): void {
    // `aiServeAim` wants the opponent's paddle in the OPPONENT's coordinates
    // and mirrors it itself, which is exactly what the other half holds.
    const aim = aiServeAim(this.ai.competence(), opponentPaddleX);
    const v = serveVelocity(aim, this.rules);
    this.ball = {
      // Out of the middle of its own paddle, the same rule a human serve
      // obeys — not out of a hardcoded centre.
      x: Math.max(0.02, Math.min(0.98, this.paddleX)),
      y: SERVE_Y,
      // serveVelocity returns vy NEGATIVE (up-screen, toward the net), which
      // is the direction a serve leaves in for the half that hit it.
      vx: v.vx,
      vy: v.vy,
      spin: 0,
      radius,
      active: true,
    };
  }
}

export interface BotMatchOptions {
  difficulties: [AIDifficulty, AIDifficulty];
  trueSkillMu: [number, number];
  winningScore: number;
  rules?: Partial<MatchRules>;
  /** Which seat serves first. */
  servingPlayer?: 0 | 1;
}

/**
 * A whole match between two play-bots.
 *
 * Stepped by the caller. Everything it reports is a fact the driver has to
 * relay onward (a crossing, a point) or record (the finish) — it never sends
 * anything itself, which is what keeps it testable and what lets the same
 * object be run with no sockets at all while the cost is being measured.
 */
export class BotMatch {
  public readonly halves: [BotHalf, BotHalf];
  public scores: [number, number] = [0, 0];
  public servingPlayer: 0 | 1;
  public matchOver = false;
  /**
   * The three rally numbers, per seat, kept apart on purpose (CLAUDE.md §7).
   *
   * `streaks` is the run STILL GOING — it drops to zero the moment that seat
   * fails to return, and it is what the next match would carry in.
   * `bestStreaks` is the PEAK that run reached, which is what a result
   * records and what a career best is read from. Collapsing them into one
   * number is the documented way to either pay for work nobody did or
   * confiscate a run a player still had; a bot's runs feed the same columns a
   * human's do, so they get the same care.
   */
  public streaks: [number, number] = [0, 0];
  public bestStreaks: [number, number] = [0, 0];
  /** Longest rally of the match, either side — the match's own headline. */
  public bestRally = 0;

  private rallySeconds = 0;
  private rallyReturns = 0;
  private readonly winningScore: number;
  private readonly rules: Partial<MatchRules> | undefined;
  private readonly radius: number;
  private readonly paddleWidth: number;

  constructor(opts: BotMatchOptions) {
    this.rules = opts.rules;
    this.winningScore = Math.max(1, Math.floor(opts.winningScore));
    this.radius = ballRadiusFor(opts.rules) || BALL_BASE_RADIUS;
    this.paddleWidth = paddleWidthFor(opts.rules);
    this.servingPlayer = opts.servingPlayer ?? 0;
    this.halves = [
      new BotHalf(opts.difficulties[0], opts.trueSkillMu[0], opts.rules),
      new BotHalf(opts.difficulties[1], opts.trueSkillMu[1], opts.rules),
    ];
    this.halves[this.servingPlayer].beginServe(0.5);
  }

  private other(seat: 0 | 1): 0 | 1 {
    return seat === 0 ? 1 : 0;
  }

  /**
   * How hard the serving bot is being pressed, for its serve timing.
   *
   * `playerPressure` is written from the point of view of the AI's OPPONENT —
   * `aiServeDelay` shortens the wind-up as it rises, i.e. the machine hurries
   * when the other side is doing well. So the serving seat is the "opponent"
   * here and its rival is the "player"; passing them the other way round makes
   * a bot dawdle exactly when it is losing.
   */
  private pressure(seat: 0 | 1): number {
    return playerPressure({
      playerScore: this.scores[this.other(seat)],
      opponentScore: this.scores[seat],
      maxRally: this.bestRally,
    });
  }

  /**
   * Award a point and set up the next serve.
   *
   * The scorer serves next, which is the convention the relay's own
   * `score_update` carries as `nextServer`.
   */
  private awardPoint(seat: 0 | 1, ev: BotMatchEvents): void {
    this.scores[seat] += 1;
    ev.scoredBy = seat;
    this.rallySeconds = 0;
    this.rallyReturns = 0;
    this.halves[0].ball = null;
    this.halves[1].ball = null;
    this.halves[0].serveIn = null;
    this.halves[1].serveIn = null;
    if (this.scores[seat] >= this.winningScore) {
      this.matchOver = true;
      ev.finished = true;
      return;
    }
    this.servingPlayer = seat;
    this.halves[seat].beginServe(this.pressure(seat));
  }

  /**
   * Advance the match by `dt` seconds.
   *
   * A local harness: it owns BOTH halves and hands the ball across itself,
   * through the same `transformBallForOpponent` the relay applies to a human
   * crossing. The live driver instead runs ONE half per bot and puts the
   * crossing on the wire — same `BotHalf.step`, different courier.
   */
  tick(dt: number): BotMatchEvents {
    if (this.matchOver) return NO_EVENTS;
    const ev: BotMatchEvents = { ...NO_EVENTS };

    for (const seat of [0, 1] as const) {
      const half = this.halves[seat];
      const other = this.other(seat);
      const step = half.step(dt, this.paddleWidth);

      if (step.served) half.serve(this.halves[other].paddleX, this.radius);

      if (step.returned) {
        ev.returnedBy = seat;
        this.rallyReturns += 1;
        this.streaks[seat] += 1;
        this.bestStreaks[seat] = Math.max(this.bestStreaks[seat], this.streaks[seat]);
        this.bestRally = Math.max(this.bestRally, this.rallyReturns);
      }

      if (half.ball || step.crossed || step.missed) this.rallySeconds += dt;

      if (step.crossed) {
        const t = transformBallForOpponent(step.crossed);
        this.halves[other].receive({
          x: t.x,
          y: 0.02,
          vx: t.vx,
          vy: t.vy,
          spin: t.spin,
          radius: this.radius,
          active: true,
        });
        ev.crossedTo = other;
        break;
      }

      if (step.missed) {
        // The seat that MISSED loses its run; the other seat's keeps going.
        // A streak breaks only when its own owner fails to return — the
        // opponent missing is a point you won, not a run you lost.
        this.streaks[seat] = 0;
        this.awardPoint(other, ev);
        break;
      }
    }

    // A rally that will not end frees the seat rather than holding it forever.
    if (!this.matchOver && ev.scoredBy === null && this.rallySeconds > MAX_RALLY_SECONDS) {
      const receiver = this.other(this.servingPlayer);
      this.halves[0].ball = null;
      this.halves[1].ball = null;
      this.awardPoint(receiver, ev);
    }

    return ev;
  }

  /** Which seat won, once `matchOver`. */
  winner(): 0 | 1 | null {
    if (!this.matchOver) return null;
    return this.scores[0] > this.scores[1] ? 0 : 1;
  }
}
