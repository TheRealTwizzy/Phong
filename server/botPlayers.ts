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
import type { WSClientMessage, WSServerMessage } from '../src/types';

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

export interface BotHandle {
  readonly id: string;
  readonly socket: BotSocket;
  /** The room this bot holds a seat in, once the relay confirms one. */
  roomId: string | null;
  /** Which seat, from `room_created` / `room_joined`. */
  seat: 0 | 1 | null;
  send(msg: WSClientMessage): void;
  close(): void;
}

export interface BotPlayersDeps {
  wss: Pick<WebSocketServer, 'emit'>;
  /** The bot accounts to run. Ids must already exist as `bot-` player rows. */
  botIds: string[];
  maxHostedTables?: number;
  tickMs?: number;
  /** Injected in tests; defaults to the real timer. */
  now?: () => number;
}

export interface BotPlayers {
  /** Live handles, for tests and for a status readout. */
  readonly bots: BotHandle[];
  /** One pass of the population. Exposed so a test can step it directly. */
  tick(): void;
  stop(): void;
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
  const handle: BotHandle = {
    id: botId,
    socket,
    roomId: null,
    seat: null,
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

  function onServerMessage(bot: BotHandle, msg: WSServerMessage): void {
    switch (msg.type) {
      case 'room_created':
        bot.roomId = msg.roomId;
        bot.seat = 0;
        break;
      case 'room_joined':
        bot.roomId = msg.roomId;
        bot.seat = msg.playerIndex;
        break;
      case 'opponent_left':
        // The table outlives its guest; the bot keeps the seat and waits.
        break;
      case 'error':
        // A refusal is information, not a fault: an unplaced bot really is
        // barred from a bracketed room, which is the gate working. Dropping
        // the seat is what matters — the bot must not believe it holds one.
        if (msg.code === 'VENUE_LOCKED' || msg.code === 'ROOM_FULL' || msg.code === 'ROOM_MID_MATCH') {
          bot.roomId = null;
          bot.seat = null;
        }
        break;
      default:
        break;
    }
  }

  /** Bots currently holding a table of their own. */
  const hosting = (): BotHandle[] => bots.filter((b) => b.roomId !== null);

  function tick(): void {
    // Only ever ADDS a table, and only up to the cap. Nothing here ever takes
    // a seat away: leaving a room a human might be about to join is worse than
    // one table too many, and a bot mid-match must never be yanked — that
    // fires `vacateSeat`, which the relay judges as an abandon and records as
    // a real ranked loss against an account that did nothing.
    const want = Math.min(maxTables, bots.length);
    let short = want - hosting().length;
    if (short <= 0) return;
    for (const bot of bots) {
      if (short <= 0) break;
      if (bot.roomId !== null) continue;
      bot.send({
        type: 'create_room',
        playerId: bot.id,
        // Listed, or the table is invisible and the whole point is missed.
        visibility: 'public',
        venueRoomId: BOT_TABLE_VENUES[0],
      } as WSClientMessage);
      short--;
    }
  }

  const timer = setInterval(tick, deps.tickMs ?? SCHEDULER_TICK_MS);
  timer.unref?.();
  // One pass immediately, so a freshly booted server does not show an empty
  // room browser for the length of the first interval.
  tick();

  return {
    bots,
    tick,
    stop() {
      clearInterval(timer);
      for (const bot of bots) bot.close();
    },
  };
}
