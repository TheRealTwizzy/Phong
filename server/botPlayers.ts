// The play-bot population: who is seated, what they are doing, and the one
// timer that drives all of them.
//
// A bot here is a CLIENT. It speaks the ordinary protocol through a
// `BotSocket` into the relay's own `wss.on('connection')` handler, so it needs
// no server internals at all beyond the `wss` it is handed — no room map, no
// database, no seat bookkeeping. Everything it does, a phone could do.
//
// That is the whole design, and three properties fall out of it rather than
// being built:
//
//   - EXCLUSIVITY, for free. The relay already treats a seat and a queue place
//     as one commitment: `queue_join` is refused to a socket holding a seat,
//     and taking a seat vacates whatever seat the socket already held. One bot
//     is one socket, so a bot that is playing cannot also be queued or sitting
//     at another table, with no new bookkeeping to get wrong.
//   - THE SAME GATES. `roomEntryVerdict` judges a bot exactly as it judges a
//     person, because the relay cannot tell them apart. A bot at 0/5 Unranked
//     sits below every bracket floor and can only open a table in the ungated
//     rooms, which is what "bots follow the same gate rules" means in practice.
//   - A BUG IN BOT PLAY IS A BUG IN REAL PLAY. There is no bot-only path to be
//     wrong in isolation.
//
// Cost, measured rather than assumed (`scripts/bot-sim.mjs`, numbers in
// DEPLOYMENT.md): on a 4-core box, 200 concurrent bot matches cost 0.23% of a
// core in physics and 0.39% in the JSON their paddle streams cost the relay.
// Neither binds. `findPair` is the one that does — O(n^2), called once per
// pair the sweep makes, so a 1000-long queue blocks the event loop for 110ms.
// That is why bot-vs-bot pairing will use its own pool rather than joining the
// shared matchmaking queue, and why the cap below is about TASTE (the owner's
// "do not overload the play-space") rather than about CPU.

import type { WebSocketServer } from 'ws';
import { BotSocket, botUpgradeRequest } from './botSocket';
import { BotHalf } from './botMatch';
import { ballRadiusFor, paddleWidthFor, playerPressure } from '../src/game/physics';
import { DEFAULT_MATCH_RULES, DEFAULT_WINNING_SCORE } from '../src/matchRules';
import type { AIDifficulty, MatchRules, WSClientMessage, WSServerMessage } from '../src/types';

/**
 * How many bots hold a table in a room's browser at once.
 *
 * A cap on VISIBLE PRESENCE, not on cost. An idle bot sitting at a table runs
 * no physics and sends nothing, so this number is chosen for what a player
 * should see — a room that looks lived-in, not one papered with machines.
 */
export const MAX_HOSTED_TABLES = 4;

/** The rooms a bot may open a table in. Ungated, so an unplaced bot qualifies. */
export const BOT_TABLE_VENUES = ['casual'] as const;

/** How often the population is looked at. Nothing here is latency-sensitive. */
export const SCHEDULER_TICK_MS = 5_000;

/**
 * How many bot-vs-bot matches run at once.
 *
 * Taste, not CPU. `scripts/bot-sim.mjs` puts 200 concurrent matches at 0.23%
 * of a core in physics and 0.39% in JSON, so this could be two orders of
 * magnitude higher and cost nothing measurable. It is small because the game
 * should feel alive rather than crowded, and because every bot playing is a
 * bot NOT sitting at a table where a human could join it.
 */
export const MAX_PLAYING_BOT_MATCHES = 2;

/** The physics tick. Matches the client's own frame budget. */
export const MATCH_TICK_MS = 1000 / 60;

/**
 * How often a bot streams its paddle.
 *
 * A constant, not a frame rate. A phone sends `paddle_move` once per
 * `pointermove`, coalesced to about one per animation frame — up to 60Hz. A
 * bot sends at the `ball_pos` sonar rate instead, because nothing observes a
 * bot's paddle more finely than the sonar renders it, and the difference is
 * two thirds of the wire cost this population has.
 */
export const BOT_PADDLE_HZ = 20;

/**
 * The countdown a duel opens with.
 *
 * `game_start` arms a 3-second countdown on every phone and no serve fires
 * under it. The relay does not enforce that — the client does — so a bot that
 * served immediately would be serving into an opponent still watching a
 * counter. It waits the same three seconds.
 */
export const COUNTDOWN_MS = 3_000;

export interface BotHandle {
  readonly id: string;
  readonly socket: BotSocket;
  /** Fixed for this bot's lifetime; the ladder discovers it through play. */
  readonly trueSkillMu: number;
  readonly difficulty: AIDifficulty;
  /** The room this bot holds a seat in, once the relay confirms one. */
  roomId: string | null;
  /** Which seat, from `room_created` / `room_joined`. */
  seat: 0 | 1 | null;
  /** True once a human or another bot is opposite. */
  hasOpponent: boolean;
  /** This bot's own half of the court, while a match is running. */
  half: BotHalf | null;
  rules: Partial<MatchRules>;
  winningScore: number;
  scores: [number, number];
  /** Wall clock before which no serve fires — the duel countdown. */
  countdownUntil: number;
  lastPaddleAt: number;
  /** The opponent's paddle, already mirrored into THIS bot's frame. */
  opponentPaddleX: number;
  send(msg: WSClientMessage): void;
  close(): void;
}

export interface BotPlayersDeps {
  wss: Pick<WebSocketServer, 'emit'>;
  /** The bot accounts to run. Ids must already exist as `bot-` player rows. */
  botIds: string[];
  maxHostedTables?: number;
  maxPlayingMatches?: number;
  tickMs?: number;
  /** Injected in tests; defaults to the real timer. */
  now?: () => number;
}

export interface BotPlayers {
  /** Live handles, for tests and for a status readout. */
  readonly bots: BotHandle[];
  /** One pass of the population's bookkeeping. Exposed so a test can step it. */
  tick(): void;
  /** One physics frame for every bot in a match. Exposed for the same reason. */
  stepMatches(dtSeconds: number): void;
  stop(): void;
}

/**
 * A bot's fixed strength, derived from its id.
 *
 * Rule 9 wants a population spread across the ladder rather than a row of
 * clones, and rule 10 wants each bot's ceiling to be its own — so strength is
 * a property of the ACCOUNT, decided once, and its RATING is what the ladder
 * discovers about it through play. That is why the bot starts at 0/5 Unranked
 * like everybody else: nothing is asserted about where it belongs.
 *
 * Derived from the id rather than stored, so it survives a restart and cannot
 * drift from the account it describes. The top of the range sits under the
 * Overlord floor of 37 on purpose: no bot should reach the apex as a birthright
 * — it has to come from a genuine run against the field, which is what keeps
 * the top of the bot ladder churning instead of settling.
 */
export function trueSkillForBot(botId: string): number {
  let h = 2166136261;
  for (let i = 0; i < botId.length; i++) {
    h ^= botId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Two folds of a 32-bit hash, summed, approximate a bell far better than one
  // uniform draw — a flat spread would put as many bots at the rails as in the
  // middle, which is not what a player base looks like.
  const a = ((h >>> 0) % 10000) / 10000;
  const b = ((Math.imul(h, 2246822519) >>> 0) % 10000) / 10000;
  const centred = (a + b) / 2; // 0..1, peaked at 0.5
  return 18 + centred * 18; // 18..36, under the 37 apex floor
}

/** The rung whose style a bot plays with, picked from its own strength. */
export function difficultyForSkill(mu: number): AIDifficulty {
  if (mu < 21) return 'rookie';
  if (mu < 26) return 'pro';
  if (mu < 31) return 'elite';
  if (mu < 34.5) return 'cyber';
  return 'chaos';
}

/**
 * Open a bot's connection through the relay's real handler.
 *
 * `wss.emit('connection', ...)` runs every listener the server registered,
 * which is the entire point: the bot gets the same per-connection closure a
 * phone gets. It does NOT add the socket to `wss.clients` — `ws` populates
 * that only on a genuine upgrade — so the heartbeat never probes it and
 * `shutdown` never closes it, both of which are correct rather than merely
 * convenient (see botSocket.ts).
 */
export function connectBot(
  wss: Pick<WebSocketServer, 'emit'>,
  botId: string,
  onMessage: (msg: WSServerMessage) => void
): BotHandle {
  const socket = new BotSocket(botId, (m) => onMessage(m as WSServerMessage));
  const trueSkillMu = trueSkillForBot(botId);
  const handle: BotHandle = {
    id: botId,
    socket,
    trueSkillMu,
    difficulty: difficultyForSkill(trueSkillMu),
    roomId: null,
    seat: null,
    hasOpponent: false,
    half: null,
    rules: DEFAULT_MATCH_RULES,
    winningScore: DEFAULT_WINNING_SCORE,
    scores: [0, 0],
    countdownUntil: 0,
    lastPaddleAt: 0,
    opponentPaddleX: 0.5,
    send: (msg) => socket.receive(msg),
    close: () => socket.close(1000, 'bot leaving'),
  };
  wss.emit('connection', socket, botUpgradeRequest());
  return handle;
}

/**
 * Start the play-bot population.
 *
 * Deliberately takes its bot ids rather than reading the roster itself: the
 * roster is a database concern and this module is about behaviour, so a test
 * can run three bots without seeding anything.
 */
export function startBotPlayers(deps: BotPlayersDeps): BotPlayers {
  const maxTables = deps.maxHostedTables ?? MAX_HOSTED_TABLES;
  const bots: BotHandle[] = [];

  for (const id of deps.botIds) {
    const handle: BotHandle = connectBot(deps.wss, id, (msg) => onServerMessage(handle, msg));
    bots.push(handle);
  }

  const clock = deps.now ?? Date.now;

  /** Put this bot back to "seated, nothing being played". */
  function endMatch(bot: BotHandle): void {
    bot.half = null;
    bot.scores = [0, 0];
    bot.countdownUntil = 0;
  }

  function onServerMessage(bot: BotHandle, msg: WSServerMessage): void {
    switch (msg.type) {
      case 'room_created':
        bot.roomId = msg.roomId;
        bot.seat = 0;
        bot.hasOpponent = false;
        endMatch(bot);
        break;
      case 'room_joined':
        bot.roomId = msg.roomId;
        bot.seat = msg.playerIndex;
        bot.hasOpponent = true;
        endMatch(bot);
        // The guest half of the lobby handshake. Readiness clears whenever the
        // host edits the terms, so this is re-sent on `room_config` too.
        bot.send({ type: 'player_ready', ready: true });
        break;
      case 'opponent_joined':
        bot.hasOpponent = true;
        break;
      case 'room_config':
        bot.rules = msg.config.rules;
        bot.winningScore = msg.config.winningScore;
        // A yes to old rules is not a yes to new ones — the relay cleared this
        // bot's readiness, so say yes again to the terms it can now see.
        if (bot.seat === 1) bot.send({ type: 'player_ready', ready: true });
        break;
      case 'ready_state':
        // The host starts once the guest has readied. `start_match` is refused
        // before that, so this is the only moment it can be sent.
        if (bot.seat === 0 && msg.ready[1] && bot.hasOpponent && !bot.half) {
          bot.send({ type: 'start_match' });
        }
        break;
      case 'game_start': {
        bot.rules = msg.config.rules;
        bot.winningScore = msg.config.winningScore;
        bot.scores = [0, 0];
        bot.half = new BotHalf(bot.difficulty, bot.trueSkillMu, bot.rules);
        bot.opponentPaddleX = 0.5;
        // No serve fires under the countdown, the same three seconds every
        // phone waits — the relay does not enforce it, the client does, so a
        // bot that ignored it would be serving into a counter.
        bot.countdownUntil = clock() + COUNTDOWN_MS;
        if (msg.servingPlayer === bot.seat) {
          bot.half.beginServe(0.5);
        }
        break;
      }
      case 'ball_incoming': {
        if (!bot.half) break;
        const b = msg.ball;
        bot.half.receive({
          x: b.x,
          // Just over the net, where the relay's transform hands it over.
          y: 0.02,
          vx: b.vx,
          vy: b.vy,
          spin: b.spin,
          radius: ballRadiusFor(bot.rules),
          active: true,
        });
        break;
      }
      case 'opponent_paddle':
        // Already mirrored into this bot's frame by the relay.
        bot.opponentPaddleX = msg.x;
        break;
      case 'score_update': {
        if (!bot.half || bot.seat === null) break;
        bot.scores = [msg.p1Score, msg.p2Score];
        if (Math.max(msg.p1Score, msg.p2Score) >= bot.winningScore) {
          // The relay has recorded it. Nothing is counted after the whistle.
          endMatch(bot);
          break;
        }
        bot.half.ball = null;
        if (msg.nextServer === bot.seat) {
          bot.half.beginServe(
            playerPressure({
              playerScore: bot.scores[bot.seat === 0 ? 1 : 0],
              opponentScore: bot.scores[bot.seat],
              maxRally: 0,
            })
          );
        }
        break;
      }
      case 'opponent_left':
        // The table outlives its guest. The bot keeps the seat and waits for
        // somebody else — which is the whole offer a hosted table makes.
        bot.hasOpponent = false;
        endMatch(bot);
        break;
      case 'error':
        // A refusal is information, not a fault: an unplaced bot really is
        // barred from a bracketed room, which is the gate working. Dropping
        // the seat is what matters — the bot must not believe it holds one.
        if (msg.code === 'VENUE_LOCKED' || msg.code === 'ROOM_FULL' || msg.code === 'ROOM_MID_MATCH') {
          bot.roomId = null;
          bot.seat = null;
          bot.hasOpponent = false;
          endMatch(bot);
        }
        break;
      default:
        break;
    }
  }

  /**
   * One physics frame for every bot that is in a match.
   *
   * Each bot owns ONE half and crosses the net over the wire, exactly as a
   * phone does — `BotHalf.step` is the same code `BotMatch` runs locally, so
   * the two cannot drift about the physics the way the relay and the P2P
   * replica once did.
   */
  function stepMatches(dt: number): void {
    const now = clock();
    for (const bot of bots) {
      const half = bot.half;
      if (!half || bot.seat === null) continue;
      if (now < bot.countdownUntil) continue;

      const step = half.step(dt, paddleWidthFor(bot.rules));

      if (step.served) {
        // `aiServeAim` wants the opponent's paddle in the OPPONENT's own
        // coordinates and mirrors it itself. What arrived on the wire was
        // already mirrored into this bot's frame, so it is mirrored back.
        half.serve(1 - bot.opponentPaddleX, ballRadiusFor(bot.rules));
      }

      if (now - bot.lastPaddleAt >= 1000 / BOT_PADDLE_HZ) {
        bot.lastPaddleAt = now;
        bot.send({ type: 'paddle_move', x: half.paddleX });
      }

      if (step.crossed) {
        bot.send({ type: 'ball_cross_net', ball: step.crossed });
      }

      if (step.missed) {
        // Past MY baseline, so the OTHER seat scored. The relay owns the
        // score; this only reports what happened on this court.
        bot.send({ type: 'point_scored', scorer: bot.seat === 0 ? 'p2' : 'p1' });
      }
    }
  }

  /** Bots holding a table with nobody opposite — a seat a human can take. */
  const waiting = (): BotHandle[] => bots.filter((b) => b.roomId !== null && !b.hasOpponent);
  /** Bots at a table with somebody opposite. */
  const paired = (): BotHandle[] => bots.filter((b) => b.roomId !== null && b.hasOpponent);
  const idle = (): BotHandle[] => bots.filter((b) => b.roomId === null);

  /**
   * How many open tables to keep even when bots could be playing instead.
   *
   * A population that pairs itself off completely is a room browser with
   * nothing joinable in it, which is the opposite of the first job. One is
   * enough to make the room look occupied AND leave a door open.
   */
  const RESERVE_OPEN_TABLES = 1;

  function tick(): void {
    // Nothing here ever takes a seat away from a live match. Leaving a room a
    // human might be about to join is worse than one table too many, and a bot
    // mid-match must never be yanked — that fires `vacateSeat`, which the relay
    // judges as an abandon and records as a real ranked loss against an account
    // that did nothing. So this only opens a table, or sits one waiting bot
    // down at another waiting bot's table.

    // 1. Keep tables open. This is the population's first job: a room browser
    //    with somebody in it, waiting for a human.
    const want = Math.min(maxTables, bots.length);
    let short = want - (waiting().length + paired().length);
    for (const bot of idle()) {
      if (short <= 0) break;
      bot.send({
        type: 'create_room',
        playerId: bot.id,
        // Listed, or the table is invisible and the whole point is missed.
        visibility: 'public',
        venueRoomId: BOT_TABLE_VENUES[0],
      } as WSClientMessage);
      short--;
    }

    // 2. Sit spare bots down against each other, up to the cap.
    //
    // Deliberately NOT through the shared matchmaking queue. `findPair` is
    // O(n^2) and `sweepQueue` calls it once per pair it makes, synchronously,
    // on the loop relaying paddle_move for every live match — measured at
    // 110ms of blocked event loop for a 1000-long queue (scripts/bot-sim.mjs).
    // Bots pairing among themselves keeps the shared queue human-sized, which
    // is the whole reason that measurement was taken.
    //
    // A JOINER is taken from the bots already waiting at a table, not from the
    // idle ones — with a small population every bot is hosting within a tick
    // of boot, so drawing only from idle meant a pair could never form at all.
    // `join_room` vacates whatever seat the socket already held, and the relay
    // reaps the emptied table; no match was in play, so nothing is abandoned.
    const maxPlaying = deps.maxPlayingMatches ?? MAX_PLAYING_BOT_MATCHES;
    for (;;) {
      const free = waiting();
      const livePairs = paired().length / 2;
      if (livePairs >= maxPlaying) break;
      // Two to make a match, plus whatever is being held open for humans.
      if (free.length < 2 + RESERVE_OPEN_TABLES) break;
      const host = free[0];
      const joiner = free[free.length - 1];
      if (!host.roomId || host.id === joiner.id) break;
      joiner.send({ type: 'join_room', roomId: host.roomId, playerId: joiner.id });
      // The relay answers synchronously through the in-process socket, so the
      // next `waiting()` already reflects this. If it ever stops being
      // synchronous this loop would spin, which is what the break above is for.
      if (!joiner.hasOpponent) break;
    }
  }

  const bookkeeping = setInterval(tick, deps.tickMs ?? SCHEDULER_TICK_MS);
  bookkeeping.unref?.();
  // The physics, on ONE timer for the whole population. N timers is N wakeups
  // competing with the relay on a single thread, and the difference is the
  // feature working or not once the population is more than a handful.
  let lastStep = clock();
  const physics = setInterval(() => {
    const now = clock();
    const dt = Math.min(0.25, (now - lastStep) / 1000);
    lastStep = now;
    if (dt > 0) stepMatches(dt);
  }, MATCH_TICK_MS);
  physics.unref?.();
  // One pass immediately, so a freshly booted server does not show an empty
  // room browser for the length of the first interval.
  tick();

  return {
    bots,
    tick,
    stepMatches,
    stop() {
      clearInterval(bookkeeping);
      clearInterval(physics);
      for (const bot of bots) bot.close();
    },
  };
}
