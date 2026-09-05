// A play-bot, as a CLIENT.
//
// It speaks the relay protocol a phone speaks, over a real socket, holding a
// real device cookie and a real session — obtained by making the same HTTP
// calls a browser makes, against 127.0.0.1, where loopback is rate-limit
// exempt by design (CLAUDE.md §5). There is deliberately NO privileged
// in-process path: a shortcut past `requireActiveSession` or the WS upgrade
// would be a second door into everything those two guard, which is exactly
// what the session rules forbid.
//
// It simulates its OWN half and reports `ball_cross_net` / `point_scored`,
// which is the client-authoritative trade CLAUDE.md §5 already documents. No
// new relay message, no new P2P behaviour, and `src/net/p2p.ts` is untouched:
// a bot declines `rtc_signal` and plays relayed, so the two-implementations
// rule is not engaged.
//
// THE FRAME CONVENTION, because it is the likeliest bug here: this half is the
// ORDINARY court. The paddle is at PADDLE_Y, a ball arriving from the net has
// vy > 0, and a ball leaving has vy < 0 and exits at y <= 0. `ball_incoming`
// already arrives transformed into this frame by the relay, and
// `opponent_paddle` already arrives mirrored into it — so neither is
// re-mirrored here, and the one place that has to un-mirror is marked.

import WebSocket from 'ws';
import type { BallState, MatchRules, RoomMatchConfig, WSServerMessage } from '../src/types';
import type { ServeAim } from '../src/game/physics';
import {
  BALL_BASE_RADIUS,
  BOT_MAX_COMPETENCE,
  BASE_BALL_SPEED,
  clampBallSpeed,
  OpponentAI,
  PADDLE_WIDTH_RATIO,
  PADDLE_Y,
  aiServeAim,
  aiServeDelay,
  bounceOffWall,
  checkPaddleCollision,
  physicsSubsteps,
  playerPressure,
  serveVelocity,
} from '../src/game/physics';
import { normalizeRules } from '../src/matchRules';
import { styleFor, type PlaybotTraits } from './playbotTraits';

/** How often the simulated half advances. A phone's animation frame. */
export const TICK_MS = 16;

/** Paddle positions go out on movement, at about the rate a browser coalesces. */
const PADDLE_SEND_EPSILON = 0.004;

/**
 * Where this bot serves, given where the opponent is standing IN THIS HALF'S
 * FRAME.
 *
 * Its own exported function because the frame is the likeliest bug in the
 * driver and the least visible: `aiServeAim` mirrors what it is handed into
 * the AI's own coordinates (it was written for solo, where the caller passes
 * the local player's paddle in the PLAYER's frame), while `opponent_paddle`
 * has ALREADY been mirrored into this frame by the relay. So the value is
 * un-mirrored going in, and getting that backwards serves the ball straight at
 * the opponent instead of away from them — which changes who wins and nothing
 * a match-level test can see.
 */
export function serveAimFor(
  competence: number,
  oppPaddleInThisFrame: number,
  ceiling: number = BOT_MAX_COMPETENCE
): ServeAim {
  return aiServeAim(competence, 1 - oppPaddleInThisFrame, ceiling);
}

export interface PlaybotDriverOptions {
  /** http://127.0.0.1:PORT */
  base: string;
  /** ws://127.0.0.1:PORT/ws */
  wsUrl: string;
  /** The name this bot onboards under. Its ACCOUNT id is issued, not chosen. */
  username: string;
  traits: PlaybotTraits;
  /** Injected so a test can drive the loop by hand. */
  now?: () => number;
}

/**
 * `queued` is between asking for a match and being seated in one. It exists so
 * the supervisor can tell a bot that is WAITING for a game from one that is
 * doing nothing — without it a queued bot reads as idle, gets re-dispatched on
 * every tick, and is counted as spare capacity the controller can activate
 * somebody else instead of.
 */
type Phase = 'idle' | 'queued' | 'lobby' | 'serving' | 'rally' | 'waiting' | 'over';

export class PlaybotDriver {
  /** Issued by the server on the document navigation, like any browser's. */
  public botId = '';
  public roomId: string | null = null;
  public seat: 0 | 1 | null = null;
  public phase: Phase = 'idle';
  public scores: [number, number] = [0, 0];

  private ws: WebSocket | null = null;
  private cookies = '';
  private readonly opts: PlaybotDriverOptions;
  private readonly ai: OpponentAI;
  private timer: NodeJS.Timeout | null = null;
  private lastTick = 0;

  private ball: BallState | null = null;
  private rules: MatchRules = normalizeRules({});
  private config: RoomMatchConfig | null = null;
  private serveTimer = 0;
  private oppPaddleX = 0.5;
  private sentPaddleX = 0.5;
  private opponentPresent = false;
  /** A `create_room` whose venue may still be refused. Cleared once answered. */
  private pendingHost: { config: Partial<RoomMatchConfig> } | null = null;
  private standingDown = false;

  constructor(opts: PlaybotDriverOptions) {
    this.opts = opts;
    // Its own competence and style, never the difficulty ladder's — a bot's
    // strength is a trait and must not slide toward whoever it is playing.
    this.ai = new OpponentAI('pro', 25, {
      competence: opts.traits.skill,
      style: styleFor(opts.traits),
      // A separate trait from the style pair, and it has to travel separately:
      // `styleFor` returns an AIStyle, which is volatility and aggression and
      // nothing else, so a spinRead folded into it would be dropped.
      spinRead: opts.traits.spinRead,
    });
  }

  private clock(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';')[0];
      const name = pair.slice(0, pair.indexOf('='));
      const kept = this.cookies
        .split('; ')
        .filter(Boolean)
        .filter((c) => !c.startsWith(`${name}=`));
      this.cookies = [...kept, pair].join('; ');
    }
  }

  /**
   * Become an account, by the doors a browser goes through and no others.
   *
   * A bot's account id is ISSUED, never chosen: the device cookie is minted by
   * the server on the document navigation (CLAUDE.md §5 — never on an /api
   * call, or a boot burst mints three identities), and `players.id` IS that
   * device id. That is also why a play-bot's id looks like a human's:
   * `verifyToken` accepts the `dev_` shape alone, so an id it never issues can
   * never hold a cookie — and it does not need to, because `bot_accounts` is
   * what makes an account a bot and the prefix decides nothing (D26).
   *
   * The marker row is the ONE thing that does not come over HTTP, because
   * there is no route that grants it and there must not be: a client that
   * could declare itself a bot could take the reduced stakes with it.
   */
  public async provision(mark: (botId: string) => void): Promise<void> {
    // 1. The document, which is where the device cookie comes from.
    this.absorb(await fetch(`${this.opts.base}/`, { headers: { cookie: this.cookies } }));
    // 2. The session every write path is gated behind.
    this.absorb(
      await fetch(`${this.opts.base}/api/session`, {
        method: 'POST',
        headers: { cookie: this.cookies, 'content-type': 'application/json' },
        body: '{}',
      })
    );
    // 3. A username, without which the relay refuses a seat (NEEDS_USERNAME).
    const claimed = await fetch(`${this.opts.base}/api/profile/initialize`, {
      method: 'POST',
      headers: { cookie: this.cookies, 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.opts.username }),
    });
    if (!claimed.ok) {
      throw new Error(`playbot onboarding failed: ${claimed.status} ${await claimed.text()}`);
    }
    const me = (await (
      await fetch(`${this.opts.base}/api/profile/me`, { headers: { cookie: this.cookies } })
    ).json()) as { id: string };
    this.botId = me.id;
    mark(this.botId);
  }

  /**
   * The device cookie this bot holds — persisted by the supervisor so a later
   * boot can come back to the SAME account.
   *
   * A play-bot's id is ISSUED, so it cannot be re-derived: without this a
   * second boot mints a second account, burns a second username out of the
   * pool for good, and strands the first one's rating and history under an id
   * nothing holds a credential for.
   */
  public deviceCookie(): string {
    return this.cookies;
  }

  /**
   * Come back to an account this bot already holds, over the same doors a
   * returning browser uses: present the device cookie, mint a fresh session,
   * read back who that makes you.
   *
   * Deliberately NOT a privileged in-process mint. The cookie is signed over a
   * secret in `meta`, so it survives a restart and a deploy — sessions are
   * disposable, the device→account binding is not (CLAUDE.md §5) — and every
   * gate downstream is the one a human passes.
   */
  public async resume(deviceCookie: string): Promise<void> {
    this.cookies = deviceCookie;
    this.absorb(
      await fetch(`${this.opts.base}/api/session`, {
        method: 'POST',
        headers: { cookie: this.cookies, 'content-type': 'application/json' },
        body: '{}',
      })
    );
    const me = (await (
      await fetch(`${this.opts.base}/api/profile/me`, { headers: { cookie: this.cookies } })
    ).json()) as { id?: string; initializedAt?: string | null };
    if (!me?.id || !me.initializedAt) {
      throw new Error('playbot could not resume: the stored cookie holds no initialized account');
    }
    this.botId = me.id;
  }

  public async connect(): Promise<void> {
    if (!this.botId) throw new Error('playbot must be provisioned before it connects');
    const ws = new WebSocket(this.opts.wsUrl, { headers: { cookie: this.cookies } });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    // A socket can die without anybody asking it to -- a relay restart, a
    // reaped room, a transient network fault. With no handler the timer kept
    // running and the phase stayed `queued`/`lobby`/`rally`, so `engaged()`
    // went on counting a driver whose every `send` was going nowhere and the
    // supervisor never rebuilt it: repeated disconnects drained the effective
    // population until the process restarted.
    //
    // It goes back to `idle` and drops its seat state, which is what makes the
    // next tick see a bot that is not engaged and dispatch it again.
    ws.on('close', () => {
      if (this.ws !== ws) return;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.ws = null;
      this.phase = 'idle';
      this.roomId = null;
      this.seat = null;
      this.opponentPresent = false;
      this.ball = null;
    });
    // `ws` raises socket faults as an 'error' emit, and an EventEmitter
    // 'error' with no listener THROWS -- from an I/O callback outside any
    // try/catch, which is the same fault §5 records taking the whole relay
    // down. The `once` above is spent by the connect promise.
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      let msg: WSServerMessage;
      try {
        msg = JSON.parse(raw.toString()) as WSServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    });
    this.lastTick = this.clock();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Never hold the process open on a bot's account.
    this.timer.unref?.();
  }

  public send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  public host(config: Partial<RoomMatchConfig> = {}, venueRoomId?: string): void {
    // Remembered only so a bracket refusal can be answered once — see the
    // VENUE_LOCKED arm below.
    this.pendingHost = venueRoomId ? { config } : null;
    this.send({
      type: 'create_room',
      playerId: this.botId,
      config: { winningScore: 3, rules: {}, ...config },
      ...(venueRoomId ? { venueRoomId, visibility: 'public' } : { visibility: 'public' }),
    });
  }

  public join(roomId: string): void {
    this.send({ type: 'join_room', roomId, playerId: this.botId });
  }

  /**
   * Drop the socket the way a relay restart would, for a test.
   *
   * `close()` tears the driver down deliberately; this severs the transport
   * and leaves the driver to notice, which is the case the close handler
   * exists for and the only way to reach it without a second process.
   */
  public dropSocketForTest(): void {
    this.ws?.terminate();
  }

  /** Whether this driver still holds a live socket. */
  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === this.ws.OPEN;
  }

  /** Whether somebody is sitting opposite. A lobby with nobody in it is a wait. */
  public hasOpponent(): boolean {
    return this.opponentPresent;
  }

  public queue(): void {
    this.send({ type: 'queue_join' });
    this.phase = 'queued';
  }

  /**
   * Stand down when this match ends — never in the middle of one.
   *
   * The population controller names bots to deactivate as demand falls, and a
   * bot cut off mid-rally leaves its opponent on a dead court and is judged an
   * ABANDON by the relay: a real ranked loss for a bot that did nothing, and a
   * win handed to whoever it was playing. So a deactivation is a request, and
   * the whistle is what grants it.
   */
  public standDown(): void {
    this.standingDown = true;
    // A bot WAITING is not a bot playing, so there is no whistle to wait for
    // -- and `queued` is an ENGAGED phase, so a driver left in it is counted
    // active forever and the supervisor's reap can never close it. It stayed
    // in matchmaking indefinitely and could be seated into a match after it
    // had been chosen for deactivation.
    if (this.phase === 'queued') {
      this.send({ type: 'queue_cancel' });
      this.phase = 'idle';
      return;
    }
    if (this.phase === 'idle' || this.phase === 'over' || this.phase === 'lobby') this.leave();
  }

  public leave(): void {
    this.send({ type: 'leave_room' });
    this.roomId = null;
    this.seat = null;
    this.phase = 'idle';
    // Who is sitting opposite is about the ROOM, so it goes with the room --
    // the same rule `resetTableForNextPair` states one level up. Only
    // `opponent_left` used to clear it, so after an ordinary final whistle it
    // stayed TRUE for the life of the process: the supervisor's next `host`
    // dispatch then opened an empty table that reported `hasOpponent()` true,
    // `engaged()` never applied the idle-lobby window to it, and the bot was
    // parked there permanently instead of coming free for the next demand.
    this.opponentPresent = false;
  }

  public close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
  }

  // ---- protocol -----------------------------------------------------------

  private handle(msg: WSServerMessage): void {
    switch (msg.type) {
      case 'error':
        // The bracket gate is the relay's and it can refuse a room this bot
        // aimed at: `beginner` carries a tierMax, so a bot that has CLIMBED
        // past Contender is turned away from the very room its own rankedBias
        // asked for. Nothing here can fix that verdict, and a bot that keeps
        // asking is a bot that never plays — so the preference has been tried
        // and answered, and it falls back to the ungated room once.
        //
        // Deliberately `casual` rather than no venue at all: a table with no
        // venue lands in the hidden `_default` room, which is UNLISTED, so
        // nobody could ever find it. An unranked table somebody can walk up to
        // beats a ranked one nobody can see.
        if (msg.code === 'VENUE_LOCKED' && this.pendingHost) {
          const { config } = this.pendingHost;
          this.pendingHost = null;
          this.host(config, 'casual');
        }
        break;
      case 'room_created':
        this.pendingHost = null;
        this.roomId = msg.roomId;
        this.seat = msg.playerIndex;
        this.phase = 'lobby';
        // A table this bot has just opened has nobody at it. Cleared here as
        // well as in `leave()` deliberately: the supervisor leaves only from
        // 'over' or 'lobby', so a host dispatch from any other phase reaches
        // `create_room` without one -- and a stale `true` parks the bot for
        // good, which is worse than the redundancy.
        this.opponentPresent = false;
        break;
      case 'room_joined':
        this.roomId = msg.roomId;
        this.seat = msg.playerIndex;
        this.phase = 'lobby';
        this.opponentPresent = true;
        // A guest's half of the lobby handshake. The host cannot start
        // without it, so a bot that never readied would seat itself and wait
        // forever — which is a bot that has taken a human's table and is not
        // playing on it.
        this.send({ type: 'player_ready', ready: true });
        break;
      case 'opponent_joined':
        this.opponentPresent = true;
        break;
      case 'room_config':
        this.config = msg.config;
        this.rules = normalizeRules(msg.config.rules);
        break;
      case 'ready_state':
        // Host only: start once the guest has said yes.
        if (this.seat === 0 && msg.ready[1] && this.phase === 'lobby') {
          this.send({ type: 'start_match' });
        }
        break;
      case 'rematch_state': {
        // A human who finishes a duel with a bot and presses Play Again sends
        // `rematch_request`, and the relay broadcasts the votes. Nothing here
        // handled that message, so the bot never cast its own and the human
        // sat on the winner overlay until the supervisor happened to move the
        // bot somewhere else -- while §2.11 says an explicit human Rematch is
        // legitimate play that nothing may block or decline.
        //
        // Accepted UNCONDITIONALLY, which is D25's rule for a human and the
        // safe default for the other case: telling a human from a bot here
        // would mean plumbing an identity resolver into a component written as
        // a client, and it would only feed `acceptsRematch`'s taper, which
        // also wants a `recentPairCount` the driver does not have. Repeating a
        // pair is not prevented by refusing it in any case -- the saturation
        // ladders make it worth progressively less and then nothing, which is
        // the safeguard that actually holds (§2.3).
        //
        // So `server/playbotPolicy.ts`'s `acceptsRematch` stays unwired, and
        // that is recorded rather than left to look like an oversight.
        if (this.seat === null || this.phase !== 'over') break;
        const mine = msg.votes[this.seat];
        const theirs = msg.votes[this.seat === 0 ? 1 : 0];
        if (theirs && !mine) this.send({ type: 'rematch_request' });
        break;
      }
      case 'game_start':
        this.config = msg.config;
        this.rules = normalizeRules(msg.config.rules);
        this.scores = [0, 0];
        this.ai.reset();
        this.ball = null;
        // Publish where the paddle IS, before it has moved anywhere. The
        // opponent's net indicators and the aim of their own serve both read
        // this, so a bot that waited for its first movement would leave them
        // serving blind for the whole first point — and the epsilon below
        // means a bot that never moves never publishes at all.
        this.sentPaddleX = this.ai.paddleX;
        this.send({ type: 'paddle_move', x: this.ai.paddleX });
        this.beginPoint(msg.servingPlayer === this.seat);
        break;
      case 'ball_incoming':
        // Already in this half's frame — the relay transformed it.
        // `radius` is the receiving client's to decide — it comes from THIS
        // match's ball scale, not from the sender's frame.
        this.ball = {
          ...msg.ball,
          // It enters AT the net. The wire carries a crossing, not a
          // position: `y` and `radius` belong to the receiving half, which is
          // why neither travels.
          y: 0,
          radius: BALL_BASE_RADIUS * this.rules.ballScale,
          active: true,
        };
        this.phase = 'rally';
        break;
      case 'opponent_paddle':
        // Already mirrored into this frame by the relay.
        this.oppPaddleX = msg.x;
        break;
      case 'score_update': {
        this.scores = [msg.p1Score, msg.p2Score];
        const cap = this.config?.winningScore ?? 3;
        if (msg.p1Score >= cap || msg.p2Score >= cap) {
          this.phase = 'over';
          this.ball = null;
          if (this.standingDown) this.leave();
        } else {
          this.beginPoint(msg.nextServer === this.seat);
        }
        break;
      }
      case 'opponent_left':
        this.phase = 'over';
        this.ball = null;
        this.opponentPresent = false;
        break;
      case 'rtc_signal':
        // Declined: a bot plays relayed, so src/net/p2p.ts stays untouched and
        // the P2P replica never has to know a bot exists.
        break;
      default:
        break;
    }
  }

  private beginPoint(mine: boolean): void {
    this.ball = null;
    if (mine) {
      this.phase = 'serving';
      this.serveTimer = aiServeDelay(
        this.ai.competence(),
        playerPressure({
          playerScore: this.scores[this.seat ?? 0],
          opponentScore: this.scores[this.seat === 0 ? 1 : 0],
          maxRally: 0,
        }),
        // Its OWN ceiling: normalised by the solo ladder's, a bot above 0.81
        // would saturate at skill 1 and every strong bot would serve
        // identically — the same collapse the top three rungs had.
        this.ai.ceiling()
      );
    } else {
      this.phase = 'waiting';
    }
  }

  // ---- the half ------------------------------------------------------------

  private tick(): void {
    const now = this.clock();
    const dt = Math.min(0.05, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (dt <= 0) return;

    const paddleWidth = PADDLE_WIDTH_RATIO * this.rules.paddleScale;
    this.ai.update(this.ball, dt, paddleWidth, this.rules);
    if (Math.abs(this.ai.paddleX - this.sentPaddleX) > PADDLE_SEND_EPSILON) {
      this.sentPaddleX = this.ai.paddleX;
      this.send({ type: 'paddle_move', x: this.ai.paddleX });
    }

    if (this.phase === 'serving') {
      this.serveTimer -= dt;
      if (this.serveTimer <= 0) this.serve();
      return;
    }
    if (this.phase !== 'rally' || !this.ball?.active) return;
    this.stepBall(dt, paddleWidth);
  }

  private serve(): void {
    const aim = serveAimFor(this.ai.competence(), this.oppPaddleX, this.ai.ceiling());
    const v = serveVelocity(aim, this.rules);
    this.ball = {
      x: this.ai.paddleX,
      y: PADDLE_Y - 0.04,
      vx: v.vx,
      vy: v.vy,
      radius: BALL_BASE_RADIUS * this.rules.ballScale,
      spin: 0,
      speedMultiplier: 1,
      active: true,
    };
    this.phase = 'rally';
  }

  /**
   * One frame of this bot's own half, integrated the way the BROWSER does it.
   *
   * `speedMultiplier` is DERIVED display metadata and never a factor on the
   * velocity: `src/App.tsx` computes it as `hypot(vx, vy) / BASE_BALL_SPEED`
   * and integrates `vx`/`vy` straight, because the pace a paddle adds is
   * already inside the velocity `checkPaddleCollision` returns. This applied
   * it as a factor AND grew it 4% per contact on top of the 4% `hit.speed`
   * already carried, so the same ball ran at roughly `speed x 1.04^n` on the
   * bot's court and at `speed` on the human's -- distorted misses, distorted
   * rallies, and a distorted number on the wire, since the crossing carries
   * this field to the other half.
   */
  private stepBall(dt: number, paddleWidth: number): void {
    const ball = this.ball!;
    const radius = BALL_BASE_RADIUS * this.rules.ballScale;
    const steps = physicsSubsteps(Math.hypot(ball.vx, ball.vy), dt, radius);
    const sub = dt / steps;

    for (let i = 0; i < steps; i += 1) {
      ball.x += ball.vx * sub;
      ball.y += ball.vy * sub;

      if (ball.x <= radius || ball.x >= 1 - radius) {
        const atLeft = ball.x <= radius;
        const b = bounceOffWall(ball.vx, ball.vy, ball.spin, atLeft, this.rules);
        ball.vx = b.vx;
        ball.vy = b.vy;
        ball.spin = b.spin;
        ball.x = atLeft ? radius : 1 - radius;
      }

      // The net. Leaving this half is a crossing, and the relay transforms it.
      if (ball.y <= 0) {
        this.send({
          type: 'ball_cross_net',
          ball: {
            x: ball.x,
            vx: ball.vx,
            vy: ball.vy,
            spin: ball.spin ?? 0,
            // Derived from the velocity at the moment it leaves, the same
            // line App.tsx uses -- never a carried factor.
            speedMultiplier: Math.hypot(ball.vx, ball.vy) / BASE_BALL_SPEED,
          },
        });
        ball.active = false;
        this.ball = null;
        this.phase = 'waiting';
        return;
      }

      if (ball.vy > 0 && ball.y >= PADDLE_Y - radius) {
        const hit = checkPaddleCollision(
          ball,
          this.ai.paddleX,
          paddleWidth,
          this.ai.paddleVx,
          this.ai.aimBias(),
          this.rules
        );
        if (hit.hit && hit.angle !== undefined && hit.speed !== undefined) {
          // The match's own band, the same call App.tsx makes at the
          // equivalent contact. `checkPaddleCollision` can return a pace BELOW
          // a raised `ballSpeedMin` once spin has scrubbed it, so without this
          // the two halves of one rally obey different speed rules -- and the
          // rules are a term of the match, not of the court.
          const paced = clampBallSpeed(hit.speed, this.rules);
          ball.vx = Math.sin(hit.angle) * paced;
          ball.vy = -Math.abs(Math.cos(hit.angle) * paced);
          ball.spin = hit.spin ?? 0;
          ball.y = PADDLE_Y - radius - 0.001;
          // No 4% here: `hit.speed` already carries it, and this field is
          // derived rather than accumulated.
          ball.speedMultiplier = Math.hypot(ball.vx, ball.vy) / BASE_BALL_SPEED;
          continue;
        }
      }

      // Past the baseline: the point belongs to the opponent.
      if (ball.y > 1 + radius) {
        const scorer = this.seat === 0 ? 'p2' : 'p1';
        this.send({ type: 'point_scored', scorer });
        ball.active = false;
        this.ball = null;
        this.phase = 'waiting';
        return;
      }
    }
  }
}
