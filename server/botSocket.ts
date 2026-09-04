// The socket a play-bot holds, and the registry that says a socket IS one.
//
// A play-bot is driven through the relay's own `wss.on('connection')` handler
// rather than through a second implementation of seat logic. Everything
// downstream — `vacateSeat`, `playerIndex`, the message switch, the seat
// union, and above all the seat/queue exclusivity a bot needs — is
// per-connection closure state the bot then gets for free. Two implementations
// of one rule is exactly the drift CLAUDE.md records between the relay and the
// P2P replica, and this feature does not need a third copy.
//
// ---------------------------------------------------------------------------
// Why a registry and not a cookie
// ---------------------------------------------------------------------------
//
// The obvious design is to mint a bot a device+session cookie and let it come
// in through the front door like a phone. It cannot: `verifyToken` and
// `verifySessionToken` in server/auth.ts both hard-require the device id to
// match /^dev_[0-9a-f]{18}$/, and a bot id is `bot-...` by definition — the
// prefix is what every leaderboard filter, the ladder-position gate and
// `insertBot`'s own guard key on, so it cannot change. Making a bot pass would
// mean widening the shape check on the guard that closed the account-transfer
// exploit, in order to serve a caller that is not a browser and never will be.
// That is a bad trade in the wrong direction.
//
// So a bot is not authenticated by anything it presents. It is authenticated
// by BEING IN-PROCESS: this WeakSet is populated only by `BotSocket`'s own
// constructor, with objects this module itself built. There is no wire
// representation, no header, no field, and therefore nothing for a remote
// client to forge — which is a stronger guarantee than a cookie, not a weaker
// one. A socket that arrived over the network cannot be in this set, because
// nothing that handles network input ever adds to it.
//
// The one rule for anything added here: never populate this from a value that
// came off a socket. The moment it can be set remotely it stops being a fact
// about where the code is running and becomes a claim, and a claim is exactly
// what the cookie machinery exists to check.

import { EventEmitter } from 'node:events';
import type * as http from 'node:http';

/** Mirrors the `ws` readyState constants; the relay compares against OPEN. */
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

/**
 * Every live bot socket, and the bot account it belongs to.
 *
 * A WeakSet would be enough to answer "is this a bot", but the handler also
 * needs to know WHICH bot, so it is a WeakMap to the id. Weak so a closed
 * socket is collectable without anybody remembering to unregister it.
 */
const botSockets = new WeakMap<object, string>();

/**
 * The bot account this socket belongs to, or null for anything else.
 *
 * This is the ONLY way the relay learns a socket is a bot. Called with the
 * same object `wss.on('connection')` was handed.
 */
export function botIdForSocket(ws: object | null | undefined): string | null {
  if (!ws) return null;
  return botSockets.get(ws) ?? null;
}

/**
 * A `ws`-shaped socket that goes nowhere.
 *
 * The relay touches exactly `send`, `readyState`, `close`, `on` and
 * `addEventListener` on a seat's socket, plus `alive.set(ws)` and
 * `ws.on('pong')` in the connection handler. An EventEmitter with those five
 * covers all of it, which is why seating a bot needs no change to the relay's
 * hottest and most-exploited path.
 *
 * It is deliberately NOT added to `wss.clients`, because `ws` populates that
 * only on a genuine upgrade and this never was one. Two things follow, both
 * correct rather than merely convenient: `partitionHeartbeats` never probes or
 * terminates it (there is no network to partition, so a liveness probe would
 * be asking a question with no meaning), and `shutdown` never closes it — and
 * that is right too, because `shuttingDown` is set before any close, the
 * HUMAN's own close still fires their `vacateSeat`, and rooms live in memory
 * and go with the process anyway.
 */
export class BotSocket extends EventEmitter {
  public readyState: number = WS_OPEN;

  /** Everything the relay has sent this bot, handed to the driver parsed. */
  private readonly onServerMessage: (msg: unknown) => void;

  constructor(botId: string, onServerMessage: (msg: unknown) => void) {
    super();
    this.onServerMessage = onServerMessage;
    botSockets.set(this, botId);
    // A relay socket that never listens for 'error' is what took the whole
    // process down once already (CLAUDE.md §5): an EventEmitter 'error' with
    // no listener THROWS. The relay adds its own listener in the connection
    // handler, but this object exists before that and the driver can emit on
    // it, so it carries its own from birth.
    this.on('error', () => {});
  }

  /**
   * The relay sending to this bot.
   *
   * Parsed here rather than handed over raw because every caller in the relay
   * has already stringified, and the driver wants an object — doing it once,
   * in one place, keeps the driver from re-parsing per message type. A frame
   * that will not parse is dropped rather than thrown: this is the relay
   * talking to itself, so a throw here would surface inside somebody else's
   * `broadcast` and take an unrelated match down with it.
   */
  send(data: string | Buffer): void {
    if (this.readyState !== WS_OPEN) return;
    try {
      this.onServerMessage(JSON.parse(typeof data === 'string' ? data : data.toString()));
    } catch {
      // Deliberately silent: see above.
    }
  }

  /** The bot sending to the relay, as if a frame had arrived. */
  receive(msg: unknown): void {
    if (this.readyState !== WS_OPEN) return;
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    // The close handler is the ONLY thing that vacates a seat, so this has to
    // fire for a bot exactly as it does for a phone — otherwise a bot leaving
    // a room leaves the seat held by a socket no handler will ever trace back
    // to it, which is the orphaned-seat bug class §5 records.
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
    this.dispatchEvent('close');
  }

  /** `ws` supports both listener styles and the relay uses both. */
  addEventListener(type: string, listener: () => void): void {
    this.on(`__evt_${type}`, listener);
  }

  private dispatchEvent(type: string): void {
    this.emit(`__evt_${type}`);
  }

  /** The heartbeat never reaches a bot, but `ws.on('pong')` is registered. */
  ping(): void {
    this.emit('pong');
  }

  terminate(): void {
    this.close(1006, 'terminated');
  }
}

/**
 * The upgrade request a bot's connection is opened with.
 *
 * Carries NO cookie, deliberately. The handler reads the bot's identity from
 * the registry above, and a cookie header here would be a second, weaker
 * answer to the same question sitting right next to the strong one.
 */
export function botUpgradeRequest(): http.IncomingMessage {
  return { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as http.IncomingMessage;
}
