import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { db, RecordMatchContext } from './server/db';
import { BOT_ROSTER } from './server/bots';
import {
  clearSessionCookie,
  deviceIdentity,
  deviceIdFromCookieHeader,
  issueSession,
  blockReleasedDevice,
  requireActiveSession,
  resetDeviceIdentity,
  mintSessionId,
  requireRestorableSession,
  resolveSession,
  setSessionCookie,
  sessionIdentity,
} from './server/auth';
import { buildId } from './server/build';
import { hasUnlock, playableDifficulty } from './src/achievements';
import { normalizeDifficulty } from './src/rating';
import { transformBallForOpponent } from './server/transform';
import {
  acceptRtcSignal,
  applyMatchSync,
  clearP2PEvidence,
  clearSeatStreaks,
  resetTableForNextPair,
  clampInt,
  generateRoomCode,
  performanceWeight,
  PlayerSession,
  partitionHeartbeats,
  Room,
  SeatRating,
  startMatch as resetRoomForMatch,
  reapRooms,
  breakStreakOnPoint,
  countReturn,
} from './server/room';
import { validateAvatarPng } from './server/image';
import {
  createRateLimit,
  limitSpent,
  noteAttempt,
  sweepExpired,
  RateLimitState,
} from './server/rateLimit';
import { MatchEndPayload, MatchEndResult, RoomMatchConfig, SpectatorSnapshot, TableSeat, TableSeatInfo } from './src/types';
import { DEFAULT_ROOM_CONFIG, duelMatchKey, normalizeRoomConfig } from './src/matchRules';
import { Candidate, findPair } from './server/matchmaking';
import {
  DEFAULT_VENUE_ROOM,
  MATCHMAKING_ROOM,
  normalizeVenueRoomId,
  roomAllowsSpectators,
  roomById,
  roomEntryVerdict,
  type EntryVerdict,
  roomsOf,
} from './src/venues';
import { validateUsername } from './src/profileRules';
import {
  REPORTS_PER_DAY,
  REPORT_CATEGORIES,
  REPORT_TEXT_MIN,
  ReportCategory,
} from './src/reportRules';
import { APP_VERSION } from './src/version';
import { Rating, aiRating, newRating, winProbability } from './src/rating';


/**
 * Which seat of a table a socket holds.
 *
 * A union rather than a pair of nullable indices: two nullables describe four
 * states of which only three are legal, and the illegal one — playing and
 * watching at once — is the orphaned-seat bug class CLAUDE.md §5 records. A
 * union makes it unrepresentable, and it is what lets every existing
 * `playerIndex !== null` guard refuse a watching socket without any of them
 * being rewritten to know the word spectator.
 */
type Seat = { role: 'player'; index: 0 | 1 } | { role: 'spectator'; slot: 0 | 1 };

const rooms = new Map<string, Room>();

/**
 * Set once SIGTERM/SIGINT has started closing sockets.
 *
 * A shutdown closes every client with 1001, and each close fires vacateSeat,
 * where `abandoned` is true of every live duel. So a deploy filed a real
 * ranked LOSS against whichever seat's handler ran first and a real ranked WIN
 * to the other, spent the day's abandon forgiveness, and bumped the career
 * counters — for two players who did not leave. Neither did anything wrong;
 * the server did.
 */
let shuttingDown = false;

/**
 * The ranked queue: everybody currently looking for a game.
 *
 * An in-process array beside the room map, and single-instance by design for
 * the same reason — the relay is the only participant that can see both
 * players, so pairing lives where the sockets are (CLAUDE.md §5, §10).
 *
 * Each entry carries `take`, a callback minted INSIDE the socket's own
 * connection scope. A socket's seat is closure state (`currentRoomId`,
 * `seat`), which nothing outside that closure can write — so the sweep does
 * not try to: it builds the room and then asks each socket to take its seat.
 */
interface QueueEntry {
  ws: WebSocket;
  deviceId: string | null;
  sessionId: string | null;
  playerId: string;
  playerName: string;
  joinedAt: number;
  rttMs: number | null;
  take: (roomId: string, index: 0 | 1) => void;
}

const queue: QueueEntry[] = [];

/** Drop this socket from the queue, however it came to be leaving. */
function leaveQueue(ws: WebSocket): boolean {
  const at = queue.findIndex((e) => e.ws === ws);
  if (at === -1) return false;
  queue.splice(at, 1);
  return true;
}

/**
 * The duel run this device already has going. A rally streak carries between
 * matches, and a new ROOM is not a reason to lose one — so a seat opens on it
 * rather than on zero. Server-side, from the store, because a client-supplied
 * streak would be a client-supplied rating input.
 */
function carriedStreak(deviceId: string | null): number {
  if (!deviceId) return 0;
  try {
    return Math.max(0, Math.round(db.getModeStats(deviceId).multiplayer?.currentStreak ?? 0));
  } catch {
    return 0;
  }
}

/**
 * Everything the table's absolute state is made of, to everyone at it.
 *
 * Watchers included, and byte-identically: the score, the terms, the
 * readiness, the rematch votes and a match starting are facts about the
 * match rather than about a point of view, so a spectator gets the player's
 * own copy and App.tsx's existing handlers work unmodified.
 *
 * Note what does NOT come through here and must not be added: `match_recorded`
 * carries another player's XP, missions and rank direction, and `opponent_left`
 * would report a departure to somebody who lost nobody. Both are sent to named
 * sockets instead.
 */
function broadcast(room: Room, payload: unknown): void {
  const json = JSON.stringify(payload);
  for (const p of room.players) {
    if (p?.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(json);
  }
  for (const w of room.spectators) {
    if (w?.ws && w.ws.readyState === WebSocket.OPEN) w.ws.send(json);
  }
}

/**
 * Everyone who sees seat `side`'s court from seat `side`'s point of view: the
 * player sitting there, plus whoever is watching over their shoulder.
 *
 * The whole client design in one function. A spectator on side S receives the
 * byte-identical copy of everything player S receives — pre-mirrored opponent
 * paddle, sender-frame opponent ball, transformed ball_incoming — so App.tsx's
 * existing handlers need no spectating branch at all. The only NEW frames are
 * the ones about S's own court, which player S does not need because they are
 * simulating it.
 */
function viewersOf(room: Room, side: 0 | 1): WebSocket[] {
  const out: WebSocket[] = [];
  const player = room.players[side];
  if (player?.ws && player.ws.readyState === WebSocket.OPEN) out.push(player.ws);
  const watcher = room.spectators[side];
  if (watcher?.ws && watcher.ws.readyState === WebSocket.OPEN) out.push(watcher.ws);
  return out;
}

/**
 * The socket watching seat `side`'s own court, or null.
 *
 * What goes here is RAW — no mirror, no transform — because the watcher draws
 * that player's court in that player's own coordinates. A stray `1 - x` here
 * is the likeliest bug in the whole feature and is invisible against a
 * symmetric fixture: a paddle at 0.5 looks right either way, which is why
 * every test of it uses an asymmetric position.
 */
function watcherBeside(room: Room, side: 0 | 1): WebSocket | null {
  const watcher = room.spectators[side];
  if (!watcher?.ws || watcher.ws.readyState !== WebSocket.OPEN) return null;
  return watcher.ws;
}

/**
 * How the matchup looks, from each side's own point of view.
 *
 * Per-side rather than broadcast, and computed server-side, so neither client
 * ever sees the other's hidden rating — only its own odds. A watcher gets the
 * number belonging to the player they are sitting beside, which is the same
 * rule as everything else in the fan-out.
 */
function sendMatchPrediction(room: Room): void {
  const [a, b] = room.players;
  // A CPU table has odds too, and they are the ones the pre-match sheet has
  // always shown for a solo match: the rung's anchor, adapted to this player.
  // Sent so a WATCHER gets the same panel a duel's watcher gets — without it
  // the one surface that says what the match is worth goes blank exactly when
  // somebody sits down to watch it.
  if (room.config.cpu) {
    const human = a ?? b;
    if (!human) return;
    const mine = db.matchmakingRating(human.playerId) ?? newRating();
    const p = winProbability(mine, aiRating(room.config.cpu, mine.mu));
    const seat = a ? 0 : 1;
    sendAll(viewersOf(room, seat), { type: 'match_prediction', winProbability: p });
    // And the watcher on the CPU's side sees it from that side, which is what
    // every other frame at this table already does for them.
    sendAll(viewersOf(room, seat === 0 ? 1 : 0), {
      type: 'match_prediction',
      winProbability: 1 - p,
    });
    return;
  }
  if (!a || !b) return;
  // Two ratings, not two profiles. `getProfile` is four queries and, for
  // anyone on the top rung, a full table scan for a ladder position nothing
  // here renders. `newRating()` is byte-for-byte what its lazy mint would have
  // produced for a row that is not there, so nothing about this moves.
  const r0 = db.matchmakingRating(a.playerId) ?? newRating();
  const r1 = db.matchmakingRating(b.playerId) ?? newRating();
  const p0 = winProbability(r0, r1);
  for (const side of [0, 1] as const) {
    sendAll(viewersOf(room, side), {
      type: 'match_prediction',
      winProbability: side === 0 ? p0 : 1 - p0,
    });
  }
}

/** One serialization, however many recipients — as `broadcast` already does. */
function sendAll(sockets: WebSocket[], payload: unknown): void {
  if (sockets.length === 0) return;
  const json = JSON.stringify(payload);
  for (const socket of sockets) socket.send(json);
}

/**
 * A fresh key for a table being locked, unique against every live table's id
 * AND every other live key.
 *
 * Both namespaces, because a code typed into the join box is resolved against
 * both: a key that collided with a room id would open a table its holder was
 * never given.
 */
function codeIsFree(code: string): boolean {
  if (rooms.has(code)) return false;
  for (const room of rooms.values()) {
    if (room.joinKey === code) return false;
  }
  return true;
}

function mintJoinKey(): string {
  for (let i = 0; i < 200; i++) {
    const key = generateRoomCode();
    if (codeIsFree(key)) return key;
  }
  // 32^4 codes against a single-instance room map: unreachable in practice,
  // and a null key is refused rather than silently opening the table.
  return '';
}

/**
 * A fresh ROOM ID, unique against the same two namespaces a join key is.
 *
 * `mintJoinKey` above has always checked both, and minting an id checked only
 * `rooms` — which is the same collision from the other side. `roomForCode`
 * resolves a typed code against ids and keys together, so a new table given an
 * id equal to a live table's join key would answer to that key: the four
 * characters somebody was privately handed would start opening a stranger's
 * table, and the table they were invited to would become unreachable by the
 * only code that opens it.
 */
function mintRoomCode(): string {
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode();
    if (codeIsFree(code)) return code;
  }
  return '';
}

/**
 * The table a typed code addresses, or null.
 *
 * A PUBLIC table answers to its id — that is what the browser hands out. A
 * PRIVATE one answers ONLY to its current key: its id is still how the relay
 * indexes it and is still visible on `GET /api/room/:id`, so letting the id
 * open the door would make the key decorative.
 */
function roomForCode(code: string): Room | null {
  const direct = rooms.get(code);
  if (direct && direct.visibility !== 'private') return direct;
  for (const room of rooms.values()) {
    if (room.joinKey && room.joinKey === code) return room;
  }
  // An unlisted table that never had a key set — an old bundle, the invite
  // flow, the harness — is still reachable by its id, exactly as before.
  if (direct && direct.joinKey === null) return direct;
  return null;
}

/** The wire seat a watching slot is addressed by: 0/1 play, 2/3 watch. */
const spectatorSeat = (slot: 0 | 1): TableSeat => (slot === 0 ? 2 : 3);

/**
 * Which playing seat the CPU is in, when the table has one.
 *
 * Derived rather than stored: it is whichever playing seat holds no human, so
 * a host who swaps sides takes the CPU with them rather than landing on top of
 * it, and there is no second field that can disagree with `players`.
 *
 * Seat 1 is the answer for an empty table too — a table with a CPU and nobody
 * at all is on its way to being reaped, and the host seat is the one a
 * newcomer takes.
 */
const cpuSeatOf = (room: Room): 0 | 1 => (room.players[0] ? 1 : 0);

/**
 * A stand-in for "something is in this seat" where the something is a machine.
 *
 * `swap_seat` asks whether a target seat is occupied and compares against
 * null; a CPU is not a `PlayerSession` and never will be (see
 * RoomMatchConfig.cpu), so it needs a non-null value to answer with that is
 * obviously not a session.
 */
const CPU_HOLDS_SEAT = Object.freeze({ cpu: true });

/**
 * Who is sitting where, told to each socket separately.
 *
 * Per-socket rather than broadcast because `yourSeat` differs by recipient —
 * and because that is the one field a client cannot work out for itself once
 * seats can change hands. It names the table too: a watcher never receives
 * `room_created` or `room_joined`, so this is the only message that tells
 * them which room they are in.
 */
function broadcastTableState(room: Room): void {
  // The CPU's chair, described the way Match History already describes a solo
  // opponent — `AI-<difficulty>` / `AI (<difficulty>)`. `isLinkableId` matches
  // neither `dev_` nor `bot-`, so that id is already refused as a tap target
  // and nothing has to learn about it to stop opening a profile for a machine.
  const cpuIdx = room.config.cpu ? cpuSeatOf(room) : null;
  const playing = (i: 0 | 1): TableSeatInfo =>
    cpuIdx === i && room.config.cpu
      ? {
          seat: i,
          playerId: `AI-${room.config.cpu}`,
          playerName: `AI (${room.config.cpu})`,
          enabled: true,
          occupant: 'cpu',
        }
      : {
          seat: i,
          playerId: room.players[i]?.playerId ?? null,
          playerName: room.players[i]?.playerName ?? null,
          enabled: true,
          ...(room.players[i] ? { occupant: 'human' as const } : {}),
        };
  const seats: TableSeatInfo[] = [
    playing(0),
    playing(1),
    { seat: 2, playerId: room.spectators[0]?.playerId ?? null, playerName: room.spectators[0]?.playerName ?? null, enabled: room.config.spectators },
    { seat: 3, playerId: room.spectators[1]?.playerId ?? null, playerName: room.spectators[1]?.playerName ?? null, enabled: room.config.spectators },
  ];
  const send = (ws: WebSocket | undefined, yourSeat: TableSeat | null): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'table_state',
        roomId: room.id,
        seats,
        yourSeat,
        spectatorsEnabled: room.config.spectators,
        isPrivate: room.visibility === 'private',
        // Only ever sent to sockets already AT this table, which is the whole
        // point of a key: you get it by being let in, or by being told it.
        joinKey: room.joinKey,
        // Which venue this TABLE is in, which is not the same question as
        // which room the player was browsing when they got here. They differ
        // for anyone who arrived on a join key rather than by tapping a listed
        // table — and Casual does not move the ladder, so a lobby that guessed
        // from the browse venue would tell the guest the opposite of the truth
        // about the match they are about to play. Sent here rather than on
        // room_created/room_joined because a watcher receives neither, and
        // their badge should be right too.
        venueRoomId: room.venueRoomId,
      })
    );
  };
  room.players.forEach((p, i) => send(p?.ws, i as TableSeat));
  room.spectators.forEach((w, i) => send(w?.ws, spectatorSeat(i as 0 | 1)));
}

/**
 * Where the match already stands, for a watcher who has just sat down.
 *
 * The easy one to forget. A spectator arriving at 3-2 has missed `game_start`
 * and every `score_update` since, and the relay is the only party that knows —
 * so without this their court renders 0-0 until the next point happens to
 * arrive. Sent on arrival, and again on a side flip.
 */
function sendSpectatorSync(room: Room, ws: WebSocket): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const snapshot: SpectatorSnapshot = {
    p1Score: room.scores[0],
    p2Score: room.scores[1],
    servingPlayer: room.servingPlayer,
    matchSeq: room.matchSeq,
    inPlay: room.inPlay,
    matchOver: room.matchOver,
    config: room.config,
    streaks: [room.streaks[0], room.streaks[1]],
  };
  ws.send(JSON.stringify({ type: 'spectator_sync', snapshot }));
}

/**
 * Close every watching socket at a table that is going away.
 *
 * One function for both departures, for the same reason `vacateSeat` is one
 * implementation for two: the reaper sweeps a table, and the last player
 * leaving deletes one, and a watcher left attached to a room no longer in the
 * map would sit on a court whose every message the relay silently drops.
 *
 * The slots are cleared as well as closed, because the room object can
 * outlive this call — a reap hands the caller the room after deleting it, and
 * the close handler that would otherwise clear the slot runs against a room
 * `rooms.get` can no longer find.
 */
function ejectSpectators(room: Room, reason: string): void {
  room.spectators.forEach((w, i) => {
    if (!w) return;
    room.spectators[i] = null;
    try {
      if (w.ws.readyState === WebSocket.OPEN) w.ws.close(1000, reason);
    } catch {
      /* already gone */
    }
  });
}

/**
 * Start (or restart) the room's match and tell both phones.
 *
 * The state change lives in server/room.ts, where it can be tested without a
 * socket; the broadcast has to happen here, and every start must do both — a
 * phone that is not told has not started.
 */
function startMatch(room: Room, servingPlayer: 0 | 1): void {
  const payload = resetRoomForMatch(room, servingPlayer);
  // Eagerly, not on whatever touches the room's recording first — see the
  // note on duelStartRatings.
  duelStartRatings(room);
  broadcast(room, payload);
}

/**
 * The terms every queue match is played on, and they are not negotiable.
 *
 * Stock physics, sonar off, no watching seats, and the ranked auto-serve floor
 * `normalizeRoomConfig` forces. That fixity is what makes skipping the ready
 * handshake sound: the guest-ready step exists because a room's terms are the
 * host's to change, and "a yes to old rules is not a yes to new ones". A queue
 * table has no host and no editable terms, the searching UI states them before
 * anybody joins, so QUEUEING IS THE YES. `set_room_config` is refused outright
 * on one of these tables, which keeps that premise true by construction rather
 * than by everyone remembering it.
 */
const queueRoomConfig = (): RoomMatchConfig =>
  roomConfigFor(MATCHMAKING_ROOM, DEFAULT_ROOM_CONFIG);

/** A queue entry as the pure pairing rules see it. */
function queueCandidate(entry: QueueEntry): Candidate | null {
  if (!entry.deviceId) return null;
  // The RATING, never the profile. `sweepQueue` rebuilds this list once per
  // pairing, so a sweep asks for every queued entry N+1 times every two
  // seconds, synchronously, on the relay's event loop — and `getProfile` is
  // four queries, a conditional write and, for a queued Overlord, a full
  // unindexed COUNT over `players` for a ladder position that pairs nobody.
  // `newRating()` matches what its lazy mint produced, so a row that has gone
  // away mid-queue still pairs exactly as it did.
  const rating = db.matchmakingRating(entry.deviceId) ?? newRating();
  return {
    deviceId: entry.deviceId,
    mu: rating.mu,
    sigma: rating.sigma,
    joinedAt: entry.joinedAt,
    rttMs: entry.rttMs,
  };
}

/**
 * Seat a paired-up two and start their match, with no lobby in between.
 *
 * Everything a host's `start_match` does, done by the relay: the table is
 * built in the hidden queue room, both sockets are told they have a seat in
 * the ordinary `room_created`/`room_joined` shapes so their existing handlers
 * work unchanged, and `startMatch` broadcasts the `game_start` that closes
 * both lobbies. From the first serve it is an ordinary table under every rule
 * in this file — including the per-phone 3-second countdown, which arms on
 * `game_start` and runs when each player actually reaches the court.
 */
function seatQueuePair(a: QueueEntry, b: QueueEntry): void {
  // A pairing, not a join. The gap between `queue:join` and this one is the
  // question the queue is always asked: is anybody there to play?
  db.bumpCounter('queue:paired');
  const code = mintRoomCode();
  if (!code) return; // absurd, but never overwrite a live table or a live key

  const session = (entry: QueueEntry, index: 0 | 1): PlayerSession => ({
    ws: entry.ws,
    playerId: entry.playerId,
    playerName: entry.playerName,
    playerIndex: index,
    deviceId: entry.deviceId,
    sessionId: entry.sessionId,
  });

  const room: Room = {
    id: code,
    players: [session(a, 0), session(b, 1)],
    // Both sat down before startMatch bumps matchSeq off 0. See Room.seatSince.
    seatSince: [0, 0],
    scores: [0, 0],
    streaks: [carriedStreak(a.deviceId), carriedStreak(b.deviceId)],
    bestStreaks: [carriedStreak(a.deviceId), carriedStreak(b.deviceId)],
    earnedStreaks: [0, 0],
    earnedBests: [0, 0],
    crossingsThisPoint: 0,
    syncRev: 0,
    servingPlayer: 0,
    rematchVotes: [false, false],
    config: queueRoomConfig(),
    matchOver: false,
    inPlay: false,
    // Both seats consented by queueing, so the handshake is already done.
    ready: [true, true],
    matchSeq: 0,
    lastActive: Date.now(),
    // Both seats filled from the first instant: no unpaired clock to run.
    soloSince: null,
    startRatings: null,
    startRatingsSeq: 0,
    relayCounted: false,
    venueRoomId: MATCHMAKING_ROOM,
    // A queue table is never shared, never browsed and never locked: the relay
    // seats both players itself, so there is nobody to hand a key to.
    joinKey: null,
    // Never listed and never watched: a queue table is not a place, it is a
    // pairing. `listable: false` on the room def already keeps it out of the
    // browser; this keeps it out of the seats.
    visibility: 'private',
    spectators: [null, null],
  };
  rooms.set(code, room);

  a.take(code, 0);
  b.take(code, 1);

  const publicOf = (entry: QueueEntry) =>
    entry.deviceId ? db.getPublicProfile(entry.deviceId) : null;
  const oppOf = [publicOf(b), publicOf(a)];

  ([a, b] as const).forEach((entry, i) => {
    const idx = i as 0 | 1;
    const other = room.players[idx === 0 ? 1 : 0]!;
    if (entry.ws.readyState !== WebSocket.OPEN) return;
    entry.ws.send(JSON.stringify({ type: 'queue_state', status: 'found', opponent: oppOf[idx] }));
    entry.ws.send(
      JSON.stringify(
        idx === 0
          ? { type: 'room_created', roomId: code, playerIndex: 0 }
          : {
              type: 'room_joined',
              roomId: code,
              playerIndex: 1,
              opponentName: other.playerName,
              opponentId: other.playerId,
            }
      )
    );
    // Seat 0 learns who arrived the way a host does; seat 1 was told above.
    if (idx === 0) {
      entry.ws.send(
        JSON.stringify({
          type: 'opponent_joined',
          opponentName: other.playerName,
          opponentId: other.playerId,
        })
      );
    }
    entry.ws.send(JSON.stringify({ type: 'room_config', config: room.config }));
  });

  broadcastTableState(room);
  sendMatchPrediction(room);
  startMatch(room, 0);
}

/**
 * One pass of the queue. Pairs as many as it can, then stops.
 *
 * A loop rather than one pair per tick: four people joining at once should not
 * wait two sweeps for the second match. It stops the moment `findPair` says
 * no, so a queue with nothing legal in it costs one comparison pass.
 */
function sweepQueue(now: number): void {
  // A socket that died without a close event yet is not in the queue for our
  // purposes: pairing against it would seat a phantom.
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].ws.readyState !== WebSocket.OPEN) queue.splice(i, 1);
  }
  // Built ONCE, then drained. It used to be rebuilt inside the loop, so a
  // sweep that made K pairs asked the database for every queued entry K+1
  // times — every two seconds, synchronously, on the loop that also relays
  // `paddle_move` for every live match. Nothing in a rating changes between
  // two pairings of one sweep, so the rebuild could only ever produce the list
  // it already had, minus the two just seated.
  const byId = new Map<string, QueueEntry>();
  let candidates: Candidate[] = [];
  for (const entry of queue) {
    const candidate = queueCandidate(entry);
    // A cookieless socket has no rating to pair on and no profile to record
    // onto. It can play a private duel; it cannot be matchmade.
    if (!candidate || byId.has(candidate.deviceId)) continue;
    byId.set(candidate.deviceId, entry);
    candidates.push(candidate);
  }

  for (;;) {
    const pair = findPair(candidates, now);
    if (!pair) return;
    const a = byId.get(pair[0].deviceId)!;
    const b = byId.get(pair[1].deviceId)!;
    leaveQueue(a.ws);
    leaveQueue(b.ws);
    seatQueuePair(a, b);
    // The two seated leave the list rather than the list being rebuilt around
    // them. `findPair` is pure over this array, so this is the same answer.
    const seated = new Set([pair[0].deviceId, pair[1].deviceId]);
    candidates = candidates.filter((c) => !seated.has(c.deviceId));
  }
}

interface LiveSocket {
  ws: WebSocket;
  deviceId: string;
  sessionId: string | null;
}

/**
 * Every relay socket that arrived with a verified device. Small — one entry
 * per connected phone — and the only thing it is for is displacement.
 */
const liveSockets = new Set<LiveSocket>();

/**
 * Whether a seat still holds the account it was seated under. The upgrade
 * check cannot answer this on its own: ownership moves while sockets stay
 * open, and the relay writes a finished duel onto both seats itself.
 */
/**
 * How long before it was sent a client's report describes, in ms.
 *
 * Every write that ASSIGNS the carried run is ordered by this, and they all
 * have to use the same one — a stamp taken on arrival makes a request that
 * stalled look newer than whatever overtook it, which is exactly how the
 * writes that used to lack an age could invert. Both readings come from the
 * caller's own clock, so the difference carries none of its offset.
 */
/**
 * The ceiling on a reported age, mirroring db.ts's MAX_RESULT_AGE_MS. Anything
 * at or past it is simply "old", and bumpModeStats clamps to the same figure,
 * so naming it here only has to agree in spirit.
 */
const MAX_CLIENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function clientAgeMs(body: { endedAt?: unknown; clientNow?: unknown } | undefined): number | undefined {
  const ended = Number(body?.endedAt);
  const sent = Number(body?.clientNow);
  if (!Number.isFinite(ended) || !Number.isFinite(sent)) return undefined;
  const age = sent - ended;
  // A NEGATIVE difference means the clock moved backwards between the two
  // readings — an NTP correction, or a hand-set clock — so the elapsed time
  // is not knowable from them. "Just now" is the reading that lets this
  // result overwrite whatever is stored, which makes it the wrong guess: a
  // match queued while the clock ran fast, replayed after the correction,
  // would land on top of a newer one. Read as old as we allow instead. It
  // costs at most the carry from a live report whose ordering the client's
  // own write chain already handles, and that is the side to be wrong on.
  if (age < 0) return MAX_CLIENT_AGE_MS;
  return age > 0 ? age : undefined;
}

/**
 * `chainId`, sanitized to a plain string or null.
 *
 * Purely a self-reported ordering hint — see the note on `MatchEndPayload`
 * in src/types.ts — so this is not a trust boundary, just a type guard: a
 * malformed value (the wrong JSON type, or an implausibly long string) must
 * not reach a SQL bind parameter, which is the only thing that could throw.
 */
function chainIdOf(body: { chainId?: unknown } | undefined): string | null {
  const v = body?.chainId;
  return typeof v === 'string' && v.length > 0 && v.length <= 100 ? v : null;
}

function seatStillHoldsAccount(seat: { deviceId: string | null; sessionId: string | null }): boolean {
  if (!seat.deviceId) return false;
  if (db.releasedDevice(seat.deviceId)) return false;
  // A browser signed in to an account that has since moved to another browser
  // is not holding it, and must lose its seat exactly as a tombstoned one
  // does. This is NOT covered by the owner check below: the account's row was
  // renamed away from this device id, so `activeSessionId` finds no row at
  // all — and "no recorded owner" reads as "nothing has displaced this seat".
  // Without this line the whole eviction silently stopped working the moment
  // transfers began linking instead of releasing.
  const link = db.linkedAccount(seat.deviceId);
  if (link && !link.holdsIt) return false;
  const owner = db.activeSessionId(seat.deviceId);
  // No recorded owner means nothing has displaced this seat.
  return !owner || owner === seat.sessionId;
}

/**
 * Write both seats' runs for a duel that is ending WITHOUT being decided.
 *
 * `recordRoomMatch` writes the runs when a score decides a match. A duel can
 * also just stop: somebody walks out, or the room is reaped for going quiet.
 * Written from `room.streaks`, which the relay owns — a duel's runs belong to
 * the room, not to either phone, which is why db.reportStreak refuses this
 * mode to clients. Both seats, always: the player still sitting there is
 * bounced just as abruptly and their run is just as real.
 *
 * One implementation for both endings, for the reason vacateSeat is one
 * implementation for both departures — two copies of a rule are two rules.
 * Counts no match and pays nothing.
 */
function persistDuelStreaks(room: Room): void {
  if (!room.inPlay || room.matchOver) return;
  if (!room.players[0] || !room.players[1]) return;
  for (const seat of [0, 1] as const) {
    const player = room.players[seat];
    if (!player?.deviceId) continue;
    try {
      if (seatStillHoldsAccount({ deviceId: player.deviceId, sessionId: player.sessionId })) {
        db.recordDuelStreak(player.deviceId, room.streaks[seat]);
      }
    } catch (e) {
      console.error('duel streak record failed:', e);
    }
  }
}

/**
 * The terms of a match, narrowed by the venue the table sits in.
 *
 * Whether a table may be WATCHED is the venue's answer, not the host's: the
 * top three PvP brackets have no spectator seats, because a spectator sees
 * the hidden half live with the sonar forced on and can simply describe it
 * over a voice call — the sonar rule (CLAUDE.md §12) with a second person
 * attached. Drawing that line by ROOM is what keeps every other match rating
 * exactly as it always did: no per-match flag and no forceUnranked.
 *
 * It used to add "and no new unrankedReasons case". There is one now — the
 * venue itself, because a Casual table does not move the ladder — but it is a
 * case about a different question, and watching is still not among the things
 * that unrank a match. This function narrows the CONFIG; the ranked verdict
 * is derived in recordMatch from the room's own venueRoomId.
 *
 * One function for both the create and the edit path, so a host cannot open
 * seats a bracket forbids by asking twice.
 */
function roomConfigFor(
  venueRoomId: string,
  raw: Partial<RoomMatchConfig> | null | undefined,
  deviceId?: string | null
): RoomMatchConfig {
  const config = normalizeRoomConfig(raw);
  if (!roomAllowsSpectators(venueRoomId)) config.spectators = false;
  // The AI rung has to be one this player earned. The menu draws the lock and
  // the menu is the client — the same reason DIFFICULTY_LOCKED sits behind
  // /api/match/record rather than trusting the picker. It belongs HERE, in the
  // function both the create and the edit path already share, for the reason
  // stated above about the watching seats: a rule enforced at one of the two
  // doors is a rule you get past by asking twice.
  //
  // Clamped down to the best earned rung rather than refused, which is what
  // `playableDifficulty` is for: a refusal leaves the host tapping a row that
  // does nothing, and this is the same clamp the client applies to a stored
  // setting after a wipe. A cookieless socket keeps whatever it named, since
  // it has no profile to judge against and no way to record the match either.
  if (config.cpu && deviceId) {
    config.cpu = playableDifficulty(db.getProfile(deviceId).achievements, config.cpu);
  }
  return config;
}

/**
 * Close any socket this device holds under a DIFFERENT session. Called when a
 * session is issued, so the device that just lost the account finds out in
 * milliseconds instead of at its next heartbeat — and cannot land another
 * point in between.
 */
function closeDisplacedSockets(deviceId: string, keepSessionId: string): void {
  for (const entry of liveSockets) {
    if (entry.deviceId !== deviceId || entry.sessionId === keepSessionId) continue;
    try {
      entry.ws.send(JSON.stringify({ type: 'session_invalid', status: 'superseded', build: buildId() }));
      entry.ws.close(4001, 'session superseded');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Close every registered socket that no longer holds the account it was
 * seated under, whatever made that true. Used after a transfer, where the
 * device that gave the account away is still sitting on an open socket.
 */
function evictStaleSockets(): void {
  for (const entry of liveSockets) {
    if (seatStillHoldsAccount(entry)) continue;
    const status = db.releasedDevice(entry.deviceId) ? 'released' : 'superseded';
    try {
      entry.ws.send(JSON.stringify({ type: 'session_invalid', status, build: buildId() }));
      entry.ws.close(4001, `session ${status}`);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Close every socket belonging to a set of browsers, whatever they were doing.
 *
 * For the one case the two functions above cannot answer: an account that has
 * been DELETED. `seatStillHoldsAccount` asks whether anything has displaced
 * this seat, and after a delete nothing has — the row is simply gone, so
 * `activeSessionId` finds no owner and "no owner" reads as "nothing took it
 * from you". The upgrade check refuses a NEW socket for a device with no live
 * session, but an already-open one sails past both, and the relay writes a
 * finished duel onto whichever seats it is holding. So the sockets are named
 * explicitly rather than inferred.
 */
function closeAccountSockets(deviceIds: string[]): void {
  const gone = new Set(deviceIds);
  for (const entry of liveSockets) {
    if (!gone.has(entry.deviceId)) continue;
    try {
      entry.ws.send(JSON.stringify({ type: 'session_invalid', status: 'released', build: buildId() }));
      entry.ws.close(4001, 'account deleted');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Write a decided duel onto BOTH players' profiles, from the score the relay
 * owns, and hand each of them the result.
 *
 * A duel used to be recorded only by whichever phone POSTed it, so a result
 * reached a profile only if that player's client survived the final point. A
 * phone that locked, backgrounded, dropped its signal or was simply closed on
 * the losing screen recorded nothing at all — the match had happened for one
 * player and not for the other. The relay knows who won the moment the score
 * decides it, so it is what writes the result; the clients' POSTs stay as the
 * fallback for a match the relay never saw, and the shared match key means
 * whichever of them arrives second is recognised rather than paid again.
 */
/**
 * Both seats' ratings as they stood before this match was recorded — sampled
 * once, by whichever recording path reaches the room first, and reused by
 * every path after it.
 *
 * A duel reaches the ladder by two routes: the relay writes it the moment the
 * score decides it, and each phone POSTs its own copy as the fallback for a
 * match the relay never saw. Both used to read the opponent's rating live, so
 * whichever committed first moved that player's rating and the second was
 * rated against an opponent that had already played the match. In a P2P duel
 * the two routes travel different connections — the deciding match_sync over
 * the WebSocket, the POST over HTTP — so which one lands first is a race, and
 * the loser of it was rated against a post-match opponent.
 *
 * Populated EAGERLY, the instant a match begins — every one of the three
 * ways a room begins a new match calls this right after matchSeq changes:
 * `startMatch()` (a host's first `start_match`, and a relay-mediated
 * `rematch_request`) and the P2P-agreed-rematch branch inside
 * `applyMatchSync`. It used to be lazy — populated on first touch by whichever
 * recording path reached the room first — on the reasoning that every
 * recording path samples strictly before it writes anything, so the first
 * touch is always pre-match. True for THIS room's own two recording paths
 * racing each other, and not the whole story: nothing stops an UNRELATED
 * write — a solo match this same player is also playing, queued and replayed
 * mid-duel — from moving mmrMu between game_start and whenever this room's
 * own recording first happens to touch the cache, which is exactly the
 * post-match precondition this cache exists to keep out. Idempotent per
 * matchSeq either way, so a lazy touch that still lands first (a build that
 * predates one of the three call sites, say) is not wrong, only later than it
 * needs to be.
 *
 * Read from the VERIFIED device id, never from playerId, which falls back to
 * a synthetic value for a socket that arrived without a cookie — getProfile
 * mints for an id it has not seen, so a synthetic one would have handed back
 * a stray empty profile's default rating as the opponent's.
 */
function duelStartRatings(room: Room): Array<SeatRating | null> {
  if (!room.startRatings || room.startRatingsSeq !== room.matchSeq) {
    const sample = (seat: 0 | 1): SeatRating | null => {
      const player = room.players[seat];
      if (!player?.deviceId || !seatStillHoldsAccount(player)) return null;
      const p = db.getProfile(player.deviceId);
      return {
        mmr: { mu: p.mmrMu, sigma: p.mmrSigma },
        rank: { mu: p.rankMu, sigma: p.rankSigma },
      };
    };
    room.startRatings = [sample(0), sample(1)];
    room.startRatingsSeq = room.matchSeq;
  }
  return room.startRatings;
}

/**
 * The relay has counted a gameplay event for this match, so it owns the match
 * from here — and both phones have to be on the relay for that to mean
 * anything.
 *
 * A DataChannel does not die for both peers at the same instant. The one that
 * notices falls back on its own; the other keeps playing peer-to-peer against
 * somebody who is no longer receiving it, and keeps sending the relay
 * snapshots of a replica that is now missing whatever the relay counted. Every
 * way of reconciling those two accounts after the fact trades one wrong answer
 * for another — the relay either discards a return it counted, or discards the
 * point the still-open peer scored. So they are not reconciled: the peers are
 * put back on one transport, and the relay is the only thing keeping score.
 *
 * `relayCounted` stays as the guard behind it, because a broadcast is a
 * request and a client takes a moment to act on one (or is an older bundle
 * that does not know the message at all).
 */
function takeOverFromP2P(room: Room): void {
  if (room.relayCounted) return;
  room.relayCounted = true;
  endP2P(room);
}

/**
 * Ask both phones to come off their DataChannel, WITHOUT claiming the relay
 * has counted anything.
 *
 * Split out of takeOverFromP2P because the two callers want different halves.
 * A fallback wants both: the relay has counted an event, so it owns the match.
 * A watcher sitting down at a table that is already peer-to-peer wants only
 * the message — the relay has counted nothing, and setting `relayCounted`
 * would make applyMatchSync discard the peers' true streaks and peaks (which
 * are permanent, being maxima) to protect against a divergence that has not
 * happened.
 */
function endP2P(room: Room): void {
  broadcast(room, { type: 'p2p_fallback' });
}

/**
 * Options for a match the score did not decide. `winnerSeat` names the seat
 * the match is awarded to — the survivor of an abandon — whatever the score
 * stands at; `forgivenLoss` records the OTHER seat's loss un-ranked, which is
 * how the day's first disconnect spares the leaver's ladder without erasing
 * the loss (or the survivor's win, which always rates on its own merits).
 */
function recordRoomMatch(room: Room, opts: { winnerSeat?: 0 | 1; forgivenLoss?: boolean } = {}): void {
  const seats: Array<0 | 1> = [0, 1];
  // Both seats must still be occupied — the abandon path calls this BEFORE
  // vacating the leaver's seat, so a decided match and an abandoned one are
  // both recorded off the same complete room.
  if (!room.players[0] || !room.players[1]) return;
  // A level score decided nothing, and `isWinner` below is `mine > theirs` —
  // false for BOTH seats — so recording one would file a LOSS against each
  // player. That is the worst available answer to "we cannot tell who won",
  // and it is what a [cap, cap] match_sync used to produce before
  // applyMatchSync learned to refuse one. Nothing is recorded instead: a duel
  // with no winner has no result to file, and leaving the matchKey unstamped
  // keeps it recoverable rather than half-paid.
  //
  // The abandon path is exempt because it NAMES its winner: a walk-out at 0-0
  // is a real result and `winnerSeat` says whose.
  if (opts.winnerSeat === undefined && room.scores[0] === room.scores[1]) {
    console.error(
      `refusing to record an undecided duel in ${room.id}: ${room.scores.join('-')}`
    );
    return;
  }

  const matchKey = duelMatchKey(room.id, room.matchSeq);
  const rules = room.config.rules;
  const ratingBefore = duelStartRatings(room);
  const recorded: Array<{
    seat: 0 | 1;
    player: NonNullable<Room['players'][0]>;
    result: MatchEndResult;
  }> = [];
  for (const seat of seats) {
    const me = room.players[seat];
    const them = room.players[seat === 0 ? 1 : 0];
    // No verified cookie, no profile to record onto — never invent one. Nor
    // for a device whose account was claimed away DURING this duel: it holds
    // nothing, and `getProfile` would mint it a stray empty profile to fail
    // against. The other seat is still recorded.
    if (!me?.deviceId || !them) continue;
    // Not just "was this device released" — also "does this seat still hold
    // the account". A socket displaced mid-duel would otherwise have its
    // result written here by the relay, under an account it no longer holds.
    if (!seatStillHoldsAccount(me)) continue;

    const mine = room.scores[seat];
    const theirs = room.scores[seat === 0 ? 1 : 0];
    const isWinner = opts.winnerSeat !== undefined ? seat === opts.winnerSeat : mine > theirs;
    const payload: MatchEndPayload = {
      playerId: me.deviceId,
      username: me.playerName,
      opponentId: them.playerId,
      opponentName: them.playerName,
      playerScore: mine,
      opponentScore: theirs,
      bestStreak: room.bestStreaks[seat],
      endStreak: room.streaks[seat],
      earnedStreak: room.earnedBests[seat],
      mode: 'multiplayer',
      isWinner,
      rules,
      roomId: room.id,
      matchSeq: room.matchSeq,
      matchKey,
    };

    const context: RecordMatchContext = {
      performanceWeight: performanceWeight(mine, theirs, room.earnedBests[seat]),
      // From the ROOM, never from a client. Casual tables do not move the
      // visible ladder, and this is the only place that can say so honestly.
      venueRoomId: room.venueRoomId,
    };
    const oppRating = ratingBefore[seat === 0 ? 1 : 0];
    if (oppRating) {
      context.opponentRating = oppRating.mmr;
      context.opponentRankRating = oppRating.rank;
    }
    // Only the LEAVER's copy is spared the ladder by a forgiven abandon; the
    // survivor's win rates on its own merits either way.
    if (opts.forgivenLoss && !isWinner) context.forceUnranked = true;

    try {
      // Recorded now, pushed after the loop. Both seats' ratings move in this
      // one function and seat 0 is written first, so anything derived from the
      // WHOLE table — `ladderPosition` is the only one today — would see the
      // opponent's pre-match row and answer for a ladder that is one update
      // out of date. Two adjacent Overlords swapping order in a duel is
      // exactly when it is wrong, and exactly when somebody is looking.
      recorded.push({ seat, player: me, result: db.recordMatch(payload, context) });
    } catch (e: any) {
      // An uninitialized profile can't hold a match (it has no identity yet);
      // anything else is worth seeing in the log. Either way the other seat
      // still gets its result.
      if (e?.message !== 'PROFILE_NOT_INITIALIZED') {
        console.error(`duel record failed for seat ${seat} in ${room.id}:`, e);
      }
    }
  }

  for (const { seat, player, result } of recorded) {
    // Re-derived against both committed rows. Only the position is taken, not
    // the whole profile: everything else in `result` is this seat's own record
    // of its own match and is already final, while this one field is a
    // statement about every other player.
    try {
      result.profile.ladderPosition = db.getProfile(player.deviceId!).ladderPosition;
    } catch (e: any) {
      console.error(`ladder position refresh failed for seat ${seat} in ${room.id}:`, e);
    }
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify({ type: 'match_recorded', matchKey, result }));
    }
  }
}



async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  /**
   * A 500, without telling the caller what broke.
   *
   * Twenty-three routes answered `{ error: e.message }`, so an internal
   * failure handed the client the SQLite error text — table and column names,
   * constraint names, and file paths. That is the same class of leak as
   * publishing the server source map, arriving one exception at a time, and
   * every one of these routes is reachable by anybody who can load the page.
   * The message still goes to the log, which is where it is useful.
   */
  const serverError = (res: express.Response, e: unknown): void => {
    console.error('[500]', e);
    if (!res.headersSent) res.status(500).json({ error: 'SERVER_ERROR' });
  };

  // Behind Traefik/Caddy in production; needed for req.secure (Secure cookies).
  //
  // The HOP COUNT is load-bearing, and `true` was wrong for more than cookies.
  // `true` trusts the WHOLE X-Forwarded-For chain, so `req.ip` becomes its
  // leftmost entry — which is a header the client writes. The recovery-code
  // sign-in limiter keys on `req.ip`, so an attacker sending a different
  // forwarded address per request had an unlimited allowance against every
  // account at once, and the per-device key beside it does not save that: a
  // request arriving with no cookie is minted a fresh device id, so that key
  // is attacker-chosen too. The code is a credential the player KEEPS now
  // rather than a one-shot token, which is exactly what made it worth guessing.
  //
  // One hop is what both documented deployments have — Dokploy's Traefik, and
  // the compose stack's Caddy — and it makes `req.ip` the address the proxy
  // actually observed. Overridable because the right answer is a property of
  // the deployment and not of this file: two proxies is 2, and no proxy at all
  // is 0, which is also the safe value for running the server directly.
  const trustHops = Number(process.env.TRUST_PROXY_HOPS);
  app.set(
    'trust proxy',
    process.env.TRUST_PROXY_HOPS && Number.isFinite(trustHops) && trustHops >= 0 ? trustHops : 1
  );
  // Express advertises itself by default; there is nothing to gain by it.
  app.disable('x-powered-by');

  /**
   * Response headers, set HERE rather than in `deploy/Caddyfile`.
   *
   * The compose stack's Caddy is one of two deployment paths and not the
   * primary one — Dokploy's Traefik is, and this repo does not configure it —
   * so a header set at the proxy covers whichever path the person editing it
   * happened to be thinking about. Set on the app, they hold for both, for
   * `npm start`, and for anything anyone puts in front later.
   *
   * The CSP is deliberately checkable rather than ambitious. The built
   * `index.html` carries no inline script and no inline style (verified), the
   * bundle and stylesheet are hashed files under `/assets`, and the only
   * inline styling in the app is the `style` ATTRIBUTE the equipped cosmetic
   * publishes on `#app-root-container` — which is what `'unsafe-inline'` in
   * `style-src` is for and what a policy without it would break silently, in
   * production, on every theme. `connect-src` carries `ws:`/`wss:` because the
   * relay shares this origin, and `img-src` carries `blob:`/`data:` for the
   * avatar pipeline, which builds a 256x256 PNG in the browser.
   *
   * `PHONG_CSP=off` disables it, because a policy that breaks a deployment
   * must be switchable off by whoever is holding the pager rather than by a
   * redeploy.
   */
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // `frame-ancestors` above is the modern form; this is for the browsers
    // that only understand the old one.
    res.setHeader('X-Frame-Options', 'DENY');
    if (process.env.PHONG_CSP !== 'off') res.setHeader('Content-Security-Policy', CSP);
    // Only over a connection that is already HTTPS, and only in production:
    // Caddy does not add this by default and neither does Traefik. Deliberately
    // WITHOUT `includeSubDomains` or `preload` — this is a leaf host, so
    // neither buys anything here, and they are the halves that are hard to
    // take back.
    if (req.secure && process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    next();
  });

  app.use(express.json());

  // The device cookie is established by the NAVIGATION, before a line of JS
  // runs — not by whichever API call happens to land first.
  //
  // `deviceIdentity` was mounted on /api alone, so the HTML document set no
  // cookie at all and the first /api calls from the booting client were the
  // ones that minted it. Those calls are CONCURRENT (the session mint and the
  // heartbeat's first tick both fire on mount), and on anything slower than
  // localhost several are in flight before any of them has come back. Each
  // arrives with no cookie, so each mints its OWN device identity and appends
  // its own Set-Cookie; the browser keeps whichever response lands last.
  // Measured on a phone-latency connection: THREE identities per page load.
  //
  // Usually the last one wins everything and it merely litters the players
  // table. But the window stays open for as long as the slowest of those
  // requests, and a player who onboards inside it — which the invitation flow
  // pushes them to do, since the link drops them straight on the modal —
  // locks their username to the identity the cookie is about to stop being.
  // The next profile read comes back uninitialized, onboarding re-opens, and
  // the name they just chose is taken. By themselves, seconds earlier. That is
  // "they got signed out and their account still exists but they lost access":
  // no transfer, no eviction, just a cookie race on a slow connection.
  //
  // A document GET always precedes the JS it delivers, so establishing the
  // cookie here means every /api call carries one and nothing mints a second.
  // index.html is served no-cache (see buildId), so this is reached on every
  // load rather than only the first.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next(); // its own mount, below
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!String(req.headers.accept || '').includes('text/html')) return next();
    // The top of the funnel: somebody opened the game. Everything below is a
    // fraction of this number, which is what makes the rest legible.
    db.bumpCounter('visit');
    return deviceIdentity(req, res, next);
  });

  app.use('/api', deviceIdentity, sessionIdentity);

  // -------------------------------------------------------------------------
  // Rate limits. The rules live in server/rateLimit.ts, which is pure and
  // unit-tested; this is the express wiring and the calibration.
  //
  // Keyed on the DEVICE and the IP together, and the IP is what actually binds
  // here — a caller with no cookie is handed a NEW device id by
  // `deviceIdentity` on every request, so the device key cannot see a burst
  // from one. It is kept anyway because it is the half that survives a shared
  // NAT, where one IP is a building. See the `trust proxy` note above for why
  // req.ip is a hop count and not `true`: with `true` it is the client's own
  // X-Forwarded-For entry, which is an unlimited allowance.
  const limitKeysFor = (req: express.Request): string[] => [`d:${req.deviceId}`, `i:${req.ip}`];

  /**
   * Requests that originate ON THIS HOST are not counted.
   *
   * Not a convenience: it is what keeps the ceilings meaningful. Every test in
   * this repo drives a real server from 127.0.0.1 — `tests/duelRecord.test.ts`
   * alone onboards 87 accounts in about twenty seconds — and that is the exact
   * shape of the attack. No single number can permit it and refuse an
   * attacker, so a ceiling loose enough for the harness would be decoration.
   *
   * Exempting loopback is sound because a caller that can reach this process
   * from the same host already has the host, and every deployment path here
   * puts a proxy in front (DEPLOYMENT.md): behind Traefik or Caddy the socket
   * peer is the proxy's container address and `req.ip` resolves to the real
   * client through the one trusted hop, so a remote player is never loopback.
   *
   * It does mean the browser suites never exercise the 429, so the coverage
   * has to be deliberate rather than incidental: the rules are unit-tested in
   * `server/rateLimit.ts`, and `tests/rateLimit.test.ts` drives a real route
   * past its ceiling with an `X-Forwarded-For`, which the single trusted hop
   * turns into a non-loopback `req.ip`.
   */
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const isLocalCaller = (req: express.Request): boolean => LOOPBACK.has(String(req.ip || ''));

  /**
   * Count every REQUEST, not every failure.
   *
   * The sign-in limiter below counts failures, because a correct code is not
   * an attack however often it is presented. These routes are the opposite: a
   * SUCCESSFUL call is the one that costs a row or a username, so counting
   * failures alone would leave the thing being defended undefended.
   */
  const limited =
    (state: RateLimitState) =>
    (req: express.Request, res: express.Response, next: express.NextFunction): void => {
      if (isLocalCaller(req)) {
        next();
        return;
      }
      const now = Date.now();
      const keys = limitKeysFor(req);
      if (limitSpent(state, keys, now)) {
        res.status(429).json({ error: 'TOO_MANY_REQUESTS' });
        return;
      }
      noteAttempt(state, keys, now);
      next();
    };

  const MINUTE = 60 * 1000;
  /**
   * Each ceiling is set against what ONE PLAYER does, with room for a bad
   * connection retrying, and nothing else. The harness is not a consideration
   * here — it is exempt as loopback — which is what lets these be tight
   * enough to matter rather than loose enough to be decoration.
   */
  // A page load mints one session and a reload mints another. Ten a minute is
  // a player mashing refresh; a hundred is a script making a players row per
  // call.
  const sessionLimit = createRateLimit(MINUTE, 20);
  // Onboarding happens once per account, ever. This allowance is for somebody
  // retrying a name that was taken, not for a script walking a dictionary —
  // and an initialized row is never pruned, so every call it permits is
  // permanent.
  const onboardLimit = createRateLimit(10 * MINUTE, 10);
  // The picker checks as the player types, debounced, so this has to tolerate
  // real typing while refusing enumeration of the account namespace.
  const usernameCheckLimit = createRateLimit(MINUTE, 40);
  // 512KB of BLOB per call, and a player changes their avatar approximately
  // never.
  const avatarLimit = createRateLimit(10 * MINUTE, 10);

  // Bounded, for the reason sweepExpired documents.
  setInterval(() => {
    const now = Date.now();
    for (const state of [sessionLimit, onboardLimit, usernameCheckLimit, avatarLimit]) {
      sweepExpired(state, now);
    }
  }, 10 * MINUTE).unref?.();

  // Health check
  app.get('/api/health', (req, res) => {
    // Touch the store. This answered 'ok' off nothing but process liveness,
    // and Docker's HEALTHCHECK, Render's healthCheckPath, Dokploy's probe and
    // the e2e runner all key on it — so a container with a corrupt database, a
    // full disk or a vanished volume reported healthy while every match write
    // threw. One indexed read; the cost is nil.
    try {
      db.healthCheck();
    } catch (e: any) {
      console.error('[health] datastore unreachable:', e?.message);
      return res.status(503).json({ status: 'degraded', build: buildId() });
    }
    res.json({ status: 'ok', activeRooms: rooms.size, build: buildId(), version: APP_VERSION });
  });

  // ---- Session: which one device is holding this account right now --------
  //
  // The heartbeat. Cheap, unauthenticated, and safe to call from a device
  // that has just lost its account — being told so is precisely what it is
  // for. The client polls this while it plays, so an eviction lands within
  // seconds instead of at the final whistle of a match that will then be
  // refused.
  app.get('/api/session', (req, res) => {
    const session = req.session!;
    res.json({
      status: session.status,
      build: buildId(),
      deviceId: req.deviceId,
      // Which session the account is actually held by. Cookies are scoped to
      // the ORIGIN, not to a page, so two tabs on one device share this one
      // and the newest value wins for both — the server cannot tell them
      // apart. Reporting the id lets a tab compare it against the one IT was
      // given and notice it has been displaced.
      sessionId: session.sessionId,
      // Only ever the fact of the move, never the profile it moved to: a
      // released device has no claim on the account's details any more.
      ...(session.status === 'released' ? { released: true } : {}),
    });
  });

  // Take the account for this browser. Called on every load, and after any
  // status the client cannot play under. A device that was transferred away
  // cannot start a session at all — it has no account to start one on.
  app.post('/api/session', limited(sessionLimit), (req, res) => {
    try {
      if (req.session!.status === 'released') {
        return res.status(409).json({ error: 'DEVICE_RELEASED', sessionStatus: 'released', build: buildId() });
      }
      // A browser already signed in to an account that is currently living on
      // another browser takes it back here, with no code asked for. The device
      // cookie of a member IS the credential — the code is what gets a browser
      // into the set, not what it presents every time afterwards. Without this
      // `issueSession` would call getProfile and mint the member a fresh empty
      // profile, which is the whole failure being fixed.
      const link = db.linkedAccount(req.deviceId!);
      if (link && !link.holdsIt) {
        const sessionId = mintSessionId();
        const restored = db.reclaimLinkedAccount(req.deviceId!, sessionId);
        if (restored) {
          setSessionCookie(req, res, sessionId, req.deviceId!);
          // Whatever the account was doing on the browser it just left stops
          // now, not at that client's next heartbeat.
          evictStaleSockets();
          return res.json({ status: 'active', sessionId, build: buildId(), profile: restored });
        }
      }
      const sessionId = issueSession(req, res, req.deviceId!);
      // Whatever this device was holding open under an older session is over
      // NOW, not at that client's next heartbeat — otherwise the displaced
      // phone has seconds in which to keep scoring on an account it has just
      // lost, and the relay would write the result.
      closeDisplacedSockets(req.deviceId!, sessionId);
      res.json({ status: 'active', sessionId, build: buildId(), profile: db.getProfile(req.deviceId!) });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Start over as a new player. The one way off a released device: the
  // account this browser used to hold is alive on another device, so it is
  // issued a fresh device identity rather than handed the old one back.
  app.post('/api/session/reset', (req, res) => {
    try {
      // Only a released device may take this door. It is documented and
      // surfaced as the escape hatch for one, but the endpoint served anyone
      // who called it — and for a device that still HELD its account, a reset
      // swapped the cookie for a fresh identity while the initialized profile
      // stayed behind under the old one. The account would not be deleted,
      // merely unreachable: stranded under an id no browser holds any more.
      if (req.session!.status !== 'released') {
        return res.status(409).json({
          error: 'DEVICE_NOT_RELEASED',
          sessionStatus: req.session!.status,
          build: buildId(),
        });
      }
      const previous = req.deviceId!;
      const deviceId = resetDeviceIdentity(req, res);
      // The tombstone is KEPT. It used to be deleted here on the grounds that
      // the old identity is gone from the cookie jar and will never be
      // presented again — true, and precisely why deleting it hurts: the row
      // is the only record that this browser's account moved, and where it
      // moved to. Once it is gone an account left behind by a reset is not
      // merely unreachable, it is untraceable, and "my account still exists
      // but I lost access" has no answer. One row per transfer is nothing.
      const sessionId = issueSession(req, res, deviceId);
      // The old identity's sockets belong to a device that no longer exists.
      closeDisplacedSockets(previous, sessionId);
      res.json({ status: 'active', sessionId, build: buildId(), profile: db.getProfile(deviceId) });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Hand the account back voluntarily (the tab is closing). Best-effort: the
  // next load displaces whatever still holds it anyway.
  app.post('/api/session/end', (req, res) => {
    const session = req.session!;
    // A page hands back ITS OWN session, and the id it names is the only way
    // the server can tell which page is talking. `phong_session` is an ORIGIN
    // cookie: two tabs on one phone present the same value, so a closing tab
    // arrives holding whatever the NEWEST load minted. Ending that, and
    // clearing the shared cookie with it, signed the tab still sitting in a
    // lobby out of its own account — its next request carried no session, the
    // relay refused the socket at the upgrade, and the join died. Which tab
    // the player closed decided whether the other one could still play.
    const named = typeof req.body?.sessionId === 'string' ? req.body.sessionId : null;
    if (named && named !== session.sessionId) {
      return res.json({ status: 'not_mine' });
    }
    if (session.status === 'active' && session.sessionId) {
      db.endSession(req.deviceId!, session.sessionId);
    }
    clearSessionCookie(req, res);
    res.json({ status: 'ended' });
  });

  // ICE servers for the P2P (WebRTC) private-session mode. STUN is enough on
  // most networks; when TURN_URL + TURN_STATIC_SECRET are set (coturn with
  // use-auth-secret), time-limited credentials are minted per request so the
  // shared secret never reaches clients.
  // Behind a live session: these are TURN credentials, valid for six hours,
  // and the route was open to anyone who could reach the host. A relay for
  // arbitrary traffic is what a TURN server is, so handing them out
  // unauthenticated is offering the deployment's bandwidth to the internet.
  // Every legitimate caller is a player about to negotiate a duel, and holds
  // one already.
  app.get('/api/rtc-config', requireActiveSession, (req, res) => {
    const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ];

    const turnUrl = process.env.TURN_URL;
    const turnSecret = process.env.TURN_STATIC_SECRET;
    if (turnUrl && turnSecret) {
      const ttlSeconds = 6 * 60 * 60;
      // coturn's REST scheme is `expiry:name`, and the name was the constant
      // "phong" — so every credential the deployment ever issued was
      // identical apart from its timestamp, which makes an abusive one neither
      // attributable to a device nor revocable without rotating the secret for
      // everybody. The device id is what this server knows the caller by.
      const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${req.deviceId || 'phong'}`;
      const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
      iceServers.push({ urls: turnUrl.split(',').map((u) => u.trim()), username, credential });
    }

    res.json({ iceServers });
  });

  /**
   * The tables open in one venue room, for the browser.
   *
   * Registered BEFORE anything `/api/room/:roomId`-shaped, the same ordering
   * care `/api/profile/:id` documents — a two-segment pattern registered first
   * would swallow this one.
   *
   * Three filters, and each is load-bearing:
   *  - the venue, so a bracket lists its own tables and no others;
   *  - `visibility === 'public'`, which is the ENTIRE boundary protecting
   *    today's invite-code tables. This is an unauthenticated read of live
   *    room state, so a bug here makes every private room's 4-letter code
   *    harvestable;
   *  - has-a-live-player, which is what makes "empty tables are never listed"
   *    true inside the 15-second window before the reaper sweeps one.
   */
  app.get('/api/rooms/:venueRoomId/tables', (req, res) => {
    const venueRoomId = normalizeVenueRoomId(req.params.venueRoomId);
    const def = roomById(venueRoomId);
    // A room nothing may browse has no listing, rather than an empty one: the
    // queue's room is excluded as DATA (listable: false), not by a special
    // case here.
    if (!def || def.listable === false) {
      return res.status(404).json({ error: 'ROOM_NOT_LISTABLE' });
    }
    const tables = [];
    for (const room of rooms.values()) {
      if (room.venueRoomId !== venueRoomId) continue;
      if (room.visibility !== 'public') continue;
      const seated = room.players.filter((p) => p && p.ws.readyState === WebSocket.OPEN);
      if (seated.length === 0) continue;
      tables.push({
        id: room.id,
        hostName: room.players[0]?.playerName ?? null,
        hostId: room.players[0]?.playerId ?? null,
        // The CPU counts as an occupant, so a browsing player is not offered
        // a table as "1/2, waiting" and then answered ROOM_FULL when they tap
        // it. `cpu` rides along in `config` below, so a row can say WHAT it is
        // full of — "Alice vs Cyber" is a table worth walking up to, and
        // "Alice, 2/2" is one you skip.
        playerCount: room.players.filter(Boolean).length + (room.config.cpu ? 1 : 0),
        isFull: room.players.filter(Boolean).length + (room.config.cpu ? 1 : 0) >= 2,
        inPlay: room.inPlay,
        config: room.config,
        waitingMs: room.soloSince === null ? null : Date.now() - room.soloSince,
        spectatorCount: room.spectators.filter(Boolean).length,
        spectatorsEnabled: room.config.spectators,
      });
    }
    res.json({ venueRoomId, tables });
  });

  // Room status check
  app.get('/api/room/:roomId', (req, res) => {
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms.get(roomId);
    if (!room) {
      return res.status(404).json({ exists: false, message: 'Room not found' });
    }
    const playerCount = room.players.filter(Boolean).length;
    res.json({
      exists: true,
      roomId,
      playerCount,
      isFull: playerCount >= 2,
      // Whether a ball has actually been put in play since the last start.
      // Read-only; lets a client (and the e2e) tell a waiting room from a
      // live one.
      inPlay: room.inPlay,
      // How long this room has had nobody to play against, in ms, or null
      // while both seats are filled. The clock that expires a one-player room
      // however busy its occupant keeps it — including one whose guest has
      // been and gone. Beside inPlay for the same reason: a waiting room and a
      // live one are different things and this endpoint exists to say which.
      waitingMs: room.soloSince === null ? null : Date.now() - room.soloSince,
      // Added, never redefining playerCount/isFull above: existing clients and
      // the browser suites read those and they still mean PLAYERS.
      venueRoomId: room.venueRoomId,
      visibility: room.visibility,
      // Watchers, counted separately for the same reason: playerCount means
      // PLAYERS and must keep meaning that.
      spectatorCount: room.spectators.filter(Boolean).length,
      spectatorsEnabled: room.config.spectators,
    });
  });

  // Player Profile API
  // The profile belongs to the device identity in the signed cookie; clients
  // can no longer name (or forge) a player id. Profiles are minted lazily in
  // an UNINITIALIZED state — onboarding (POST /api/profile/initialize) locks
  // in the unique username before the player can record matches.
  app.get('/api/profile/me', blockReleasedDevice, (req, res) => {
    try {
      const profile = db.getProfile(req.deviceId!);
      res.json(profile);
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // First-arrival onboarding: claim a unique username (starts the 365-day
  // rename lock). One-shot per profile.
  app.post('/api/profile/initialize', requireActiveSession, limited(onboardLimit), (req, res) => {
    try {
      const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      const result = db.initializeProfile(req.deviceId!, username);
      // Counted on SUCCESS only. A refused name is a player still trying, and
      // folding those in would make the drop-off between visiting and
      // onboarding look smaller than it is — which is the one number this
      // whole table exists to show honestly.
      if (result.ok) db.bumpCounter('onboarded');
      if (!result.ok) {
        const status = result.code === 'USERNAME_INVALID' ? 400 : 409;
        return res.status(status).json({ error: result.code });
      }
      res.json(result.profile);
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Live availability probe for the onboarding / rename forms.
  app.get('/api/username-check', limited(usernameCheckLimit), (req, res) => {
    try {
      const u = typeof req.query.u === 'string' ? req.query.u.trim() : '';
      const check = validateUsername(u);
      if (!check.ok) {
        return res.json({ valid: false, available: false, reason: check.reason });
      }
      res.json({ valid: true, available: db.isUsernameAvailable(u, req.deviceId!) });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Rename (365-day lock), and equip a cosmetic. XP is never accepted from the
  // client: mission rewards are claimed by id at /api/missions/claim and paid
  // from the server's own definition table.
  app.put('/api/profile/me', requireActiveSession, (req, res) => {
    try {
      const { username, cosmetic } = req.body ?? {};
      let profile = null;

      if (username !== undefined) {
        if (typeof username !== 'string') {
          return res.status(400).json({ error: 'USERNAME_INVALID' });
        }
        const result = db.changeUsername(req.deviceId!, username.trim());
        if (!result.ok) {
          const status =
            result.code === 'USERNAME_INVALID' ? 400 : result.code === 'USERNAME_TAKEN' ? 409 : 403;
          return res.status(status).json({ error: result.code, unlockAt: result.unlockAt });
        }
        profile = result.profile;
      }

      if (cosmetic !== undefined) {
        if (typeof cosmetic !== 'string') {
          return res.status(400).json({ error: 'COSMETIC_INVALID' });
        }
        // db.setCosmetic re-derives the unlock from the profile this server
        // holds. The picker never draws a locked cosmetic, but the picker is
        // the client — this is the half that decides, the same way
        // DIFFICULTY_LOCKED sits behind /api/match/record rather than being
        // trusted to the menu.
        const result = db.setCosmetic(req.deviceId!, cosmetic);
        if (!result.ok) {
          const status = result.code === 'COSMETIC_INVALID' || result.code === 'COSMETIC_UNKNOWN' ? 400 : 403;
          return res.status(status).json({ error: result.code });
        }
        profile = result.profile;
      }

      if (!profile) {
        return res.status(400).json({ error: 'BAD_REQUEST' });
      }
      res.json(profile);
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Avatar upload: the client sends a pre-cropped 256×256 PNG as the raw
  // body. The parser is scoped to this route so the global JSON limit stays
  // untouched; validation is dependency-free (see server/image.ts).
  app.post(
    '/api/profile/me/avatar',
    requireActiveSession,
    limited(avatarLimit),
    express.raw({ type: 'image/png', limit: '600kb' }),
    (req, res) => {
      try {
        const me = db.getProfile(req.deviceId!);
        if (!me.initialized) {
          return res.status(403).json({ error: 'PROFILE_NOT_INITIALIZED' });
        }
        const buf = req.body as Buffer;
        if (!Buffer.isBuffer(buf) || buf.length === 0) {
          return res
            .status(400)
            .json({ error: 'AVATAR_INVALID', message: 'Send a PNG body with Content-Type: image/png' });
        }
        const check = validateAvatarPng(buf);
        if (!check.ok) {
          return res
            .status(check.code === 'AVATAR_TOO_LARGE' ? 413 : 400)
            .json({ error: check.code, message: check.message });
        }
        const avatarVersion = db.setAvatar(req.deviceId!, buf);
        res.json({ hasAvatar: true, avatarVersion });
      } catch (e: any) {
        serverError(res, e);
      }
    }
  );

  app.delete('/api/profile/me/avatar', requireActiveSession, (req, res) => {
    try {
      db.deleteAvatar(req.deviceId!);
      res.json({ hasAvatar: false });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Public, cacheable avatar image. The client cache-busts with
  // ?v=<avatarVersion> so immutable caching is safe.
  app.get('/api/avatar/:playerId', (req, res) => {
    try {
      const avatar = db.getAvatar(req.params.playerId);
      if (!avatar) {
        return res.status(404).end();
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(Buffer.from(avatar.data));
    } catch (e: any) {
      serverError(res, e);
    }
  });

  /**
   * Failed sign-in attempts, per device and per IP.
   *
   * The code used to be single-use — it rotated the moment it was spent, so
   * guessing it was a race against a moving target. It is a credential the
   * player KEEPS now, which is what makes signing in on a second browser
   * possible at all, and that makes it worth guessing: eight characters of a
   * 31-letter alphabet is a large space, but the search is against every
   * account at once and nothing was counting the attempts.
   *
   * Deliberately in memory. The relay is single-instance by design (rooms live
   * in process memory), a restart clearing the counters costs an attacker more
   * than it gains them, and this does not need to survive a deploy.
   */
  const signInAttempts = new Map<string, { n: number; until: number }>();
  const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;
  const SIGN_IN_MAX = 10;
  const tooManySignIns = (key: string): boolean => {
    const now = Date.now();
    const hit = signInAttempts.get(key);
    if (!hit || hit.until < now) return false;
    return hit.n >= SIGN_IN_MAX;
  };
  const noteFailedSignIn = (key: string): void => {
    const now = Date.now();
    const hit = signInAttempts.get(key);
    if (!hit || hit.until < now) {
      signInAttempts.set(key, { n: 1, until: now + SIGN_IN_WINDOW_MS });
      return;
    }
    hit.n += 1;
  };
  // Bounded: without this the map is a slow leak keyed by attacker-chosen ids.
  setInterval(() => {
    const now = Date.now();
    for (const [key, hit] of signInAttempts) if (hit.until < now) signInAttempts.delete(key);
  }, SIGN_IN_WINDOW_MS).unref?.();

  // Sign in to an account on this browser with its code. The account moves
  // here, and BOTH browsers stay members of it — see db.signInWithCode.
  app.post('/api/profile/claim', requireRestorableSession, (req, res) => {
    try {
      const code = String(req.body?.code || '');
      if (!code.trim()) {
        return res.status(400).json({ error: 'Recovery code required' });
      }
      const limitKeys = [`d:${req.deviceId}`, `i:${req.ip}`];
      if (limitKeys.some(tooManySignIns)) {
        return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
      }
      // A RELEASED device is allowed through this door, and deliberately so:
      // it is the browser whose account was transferred away, and the session
      // wall offers it exactly one button — "start as a new player" — which
      // mints a new device identity and leaves the account behind reachable by
      // nobody. Restoring is the non-destructive order of the same two moves,
      // and it grants nothing extra: the credential is the account's own
      // recovery code, and the same call was already reachable by pressing
      // "start fresh" first. A released device holds no session to hand to the
      // row, so it takes one on the way in.
      // Signing in to one account from a browser that already holds another,
      // initialized one would delete the second: players.id IS a device id, so
      // the incoming row has to take this device's place. Refused rather than
      // done silently — losing an account is precisely what this endpoint is
      // for avoiding. A placeholder profile carries nothing and is replaced.
      const here = db.getProfile(req.deviceId!);
      if (here.initialized && db.linkedAccount(req.deviceId!)?.holdsIt !== false) {
        const target = db.profileByRecoveryCode(code);
        if (target && target.id !== req.deviceId) {
          return res.status(409).json({ error: 'BROWSER_HAS_ACCOUNT', username: here.username });
        }
      }
      const wasReleased = req.session!.status === 'released';
      const profile = db.signInWithCode(code, req.deviceId!, req.session!.sessionId);
      if (!profile) {
        for (const key of limitKeys) noteFailedSignIn(key);
        return res.status(404).json({ error: 'No profile matches that code' });
      }
      if (wasReleased) {
        // claimProfileByCode has already cleared this device's tombstone, so
        // the account is here again and only a session is missing. Issuing it
        // now is what makes the restore land in one move instead of leaving
        // the player looking at the wall they just escaped.
        issueSession(req, res, req.deviceId!);
      }
      // The device that just gave the account away may be sitting on an open
      // socket in a live duel. It stops being able to play the moment the
      // transfer lands, not whenever it next asks.
      evictStaleSockets();
      res.json(profile);
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Retire this account's sign-in code and mint a new one. The counterpart to
  // the code being reusable: a player who has shared or lost one needs a way
  // to make it worthless without losing the account.
  app.post('/api/profile/me/recovery-code', requireActiveSession, (req, res) => {
    try {
      const code = db.rotateRecoveryCode(req.deviceId!);
      if (!code) return res.status(404).json({ error: 'PROFILE_NOT_FOUND' });
      res.json({ recoveryCode: code });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Delete this account and everything that belongs to it. There is no undo,
  // and nothing here pretends otherwise.
  //
  // The confirmation is the player's own username, matched EXACTLY — case and
  // all, untrimmed. That is enforced here and not only in the two-step flow
  // the Settings sheet puts in front of it, because the client is also where a
  // stale bundle, a replayed request or a mis-wired automation comes from, and
  // the one call with no way back is not one to accept on a bare verb.
  //
  // The device cookie is untouched: this is still the same browser, it simply
  // has no account any more. The next profile read mints it a fresh
  // uninitialized one and onboarding opens — exactly the state a new phone is
  // in, which is what "deleted" has to mean if the username is to be free
  // again and this browser is to be usable at all.
  app.delete('/api/profile/me', requireActiveSession, (req, res) => {
    try {
      const me = db.getProfile(req.deviceId!);
      if (!me.initialized) {
        // Nothing to delete, and no name to type at it either.
        return res.status(403).json({ error: 'PROFILE_NOT_INITIALIZED' });
      }
      const confirm = typeof req.body?.username === 'string' ? req.body.username : '';
      // Deliberately not trimmed and deliberately not case-folded. "Type your
      // username exactly" is the step; a forgiving compare turns it into a
      // button with one more tap in front of it.
      if (confirm !== me.username) {
        return res.status(400).json({ error: 'USERNAME_MISMATCH' });
      }
      const result = db.deleteAccount(req.deviceId!);
      if (!result.deleted) {
        return res.status(404).json({ error: 'NOT_FOUND' });
      }
      // Every browser that belonged to the account comes off the relay now,
      // rather than at its next heartbeat — see closeAccountSockets for why
      // neither of the other two eviction paths covers this one.
      closeAccountSockets(result.devices);
      // The session named an account that no longer exists, so it is spent.
      // The device cookie stays: sessions are disposable, the browser is not.
      clearSessionCookie(req, res);
      res.json({ deleted: true, username: result.username });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  /** The one page size history is served in, own and public alike. */
  const HISTORY_PAGE_SIZE = 10;

  /**
   * The history filters as the UI speaks them, coerced leniently the way the
   * leaderboard's params are: an unknown tab is 'all', an unknown ranked
   * filter is no filter, a bad page is page 1. `tab` maps to the stored mode
   * ('pvp' is the multiplayer mode's UI name); practice rows are ranked 0 by
   * construction, so a ranked filter on that tab is harmless rather than an
   * error.
   */
  const parseHistoryQuery = (
    q: Record<string, unknown>
  ): { mode?: 'multiplayer' | 'solo' | 'practice'; ranked?: 'ranked' | 'unranked'; page: number } => {
    const tab = String(q.tab ?? 'all');
    const mode =
      tab === 'pvp' ? ('multiplayer' as const)
      : tab === 'solo' ? ('solo' as const)
      : tab === 'practice' ? ('practice' as const)
      : undefined;
    const ranked = q.ranked === 'ranked' || q.ranked === 'unranked' ? q.ranked : undefined;
    const claimed = Math.floor(Number(q.page));
    const page = Number.isFinite(claimed) ? Math.min(Math.max(claimed, 1), 1000) : 1;
    return { mode, ranked, page };
  };

  // Public match history — the same rows the player's own history shows,
  // already free of anything private (usernames and scores are match facts,
  // and a deleted opponent arrives pre-scrubbed). Refuses ids that resolve to
  // no public profile, exactly as /api/profile/:id does — including 'me',
  // which is never a stored id. Registered before /api/profile/:id for the
  // same reason that route stays last among its literal siblings; the
  // two-segment pattern cannot shadow the one-segment ones either way.
  app.get('/api/profile/:id/matches', (req, res) => {
    try {
      if (!db.getPublicProfile(req.params.id)) {
        return res.status(404).json({ error: 'NOT_FOUND' });
      }
      const { mode, ranked, page } = parseHistoryQuery(req.query);
      const { matches, total } = db.getMatchHistoryPage(req.params.id, {
        mode,
        ranked,
        limit: HISTORY_PAGE_SIZE,
        offset: (page - 1) * HISTORY_PAGE_SIZE,
      });
      res.json({ matches, total, page, pageSize: HISTORY_PAGE_SIZE });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Public profile view — anyone can look up any player by id (tapping a
  // username in the UI). Sanitized server-side: no recovery code, no
  // activity timestamps. MUST stay registered after every literal
  // /api/profile/<segment> route so ":id" never shadows them.
  app.get('/api/profile/:id', (req, res) => {
    try {
      const profile = db.getPublicProfile(req.params.id);
      if (!profile) {
        return res.status(404).json({ error: 'NOT_FOUND' });
      }
      res.json({ profile });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Match Result & Stats Recording API
  app.post('/api/match/record', requireActiveSession, (req, res) => {
    try {
      const me = db.getProfile(req.deviceId!);
      if (!me.initialized) {
        return res.status(403).json({ error: 'PROFILE_NOT_INITIALIZED' });
      }
      const payload: MatchEndPayload = {
        ...req.body,
        playerId: req.deviceId!,
        username: me.username,
        // Sanitized rather than trusted: chainId/runSeq are a self-reported
        // ordering hint (see MatchEndPayload), not a credential, so there is
        // nothing here to verify against — only a type to enforce so a
        // malformed value cannot reach a SQL bind.
        chainId: chainIdOf(req.body),
      };

      // Only the two modes that ARE matches record here. Practice and Split
      // Screen never call this route (practice reports through its own
      // /api/practice/record; split writes nothing) — but a hand-rolled
      // payload naming them used to walk straight into recordMatch, where
      // normalizeDifficulty defaults 'pro' and ranksThisMatch never checked
      // the mode, so a "practice" result could move rankedGames and rating.
      if (payload.mode !== 'solo' && payload.mode !== 'multiplayer') {
        return res.status(400).json({ error: 'BAD_REQUEST' });
      }

      // The achievement tree gates the ladder, so the gate is enforced here
      // too — the menu hides a locked difficulty, but the menu is the client.
      // Gameplay is client-authoritative, so a solo payload is entirely
      // self-reported and only ever feeds XP — except for the one term below
      // that a vouched room can add. A PvP payload, though, can be checked
      // against the room state the relay owns: when the room is still live we
      // use OUR scores and rally count, not the client's, and only then do the
      // TrueSkill-2 performance signals apply.
      const context: RecordMatchContext = {};

      if (payload.mode === 'solo') {
        const difficulty = normalizeDifficulty(payload.difficulty);
        if (!hasUnlock(me.achievements, 'difficulty', difficulty)) {
          return res.status(403).json({ error: 'DIFFICULTY_LOCKED', difficulty });
        }

        // A solo match played AT A TABLE does not move the visible ladder if
        // that table opened its watching seats: a watcher sees the hidden half
        // live, and here only one side has a rating at stake.
        //
        // The room has to be VOUCHED before anything is read off it, because
        // `roomId` on a solo payload is a free variable — the relay records
        // nothing for a CPU table, so this POST is the only copy of the match
        // and every server-side term of it is client-chosen. Unvouched, this
        // is a one-way ladder ratchet: win, and POST with your own table;
        // lose, and POST with the id of any table whose seats are open — or
        // one you created privately from the same socket a moment earlier —
        // and take no rating hit. server/db.ts:122 names that exact failure
        // for the duel path.
        //
        // Four clauses, and each covers what the others leave. The caller
        // must hold a PLAYING seat at the room by their own device id; the
        // table must actually have the CPU they claim to have played; the
        // sequence must be the match the room is on; and it must be one that
        // started AFTER they sat down, so a newcomer cannot claim the match
        // before theirs. A room that has been reaped fails all of them and the
        // match rates exactly as a menu-started one does — the same
        // absence-versus-safety call `RecordMatchContext.venueRoomId`
        // documents, decided the same way.
        const room = payload.roomId ? rooms.get(payload.roomId.toUpperCase()) : undefined;
        if (room) {
          const seat = room.players.findIndex((p) => p && p.deviceId === req.deviceId);
          const seq = payload.matchSeq;
          const satAt = seat >= 0 ? room.seatSince?.[seat as 0 | 1] ?? null : null;
          const vouched =
            seat >= 0 &&
            room.config.cpu === difficulty &&
            seq !== undefined &&
            seq === room.matchSeq &&
            satAt !== null &&
            seq > satAt;
          if (vouched && room.config.spectators) context.forceUnrankedLadder = true;
        }
      }

      if (payload.mode === 'multiplayer') {
        const room = payload.roomId ? rooms.get(String(payload.roomId).toUpperCase()) : undefined;
        const seat = room?.players.findIndex((p) => p?.playerId === req.deviceId!) ?? -1;
        // Which match in that room this result is from. A client that doesn't
        // say (an older bundle still open in a tab) means the one the room is
        // on, which for a result being reported now is the one that just
        // ended — so it is deduped against the relay's own record of it
        // rather than paid a second time.
        const claimed = Number(payload.matchSeq);
        const seq = Number.isFinite(claimed) ? Math.floor(claimed) : room?.matchSeq;
        // A duel is recorded under a key both the relay and this client can
        // derive, so the relay's record of the same match (see recordRoomMatch)
        // and this POST cannot pay it twice — whichever arrives second is
        // answered with what the first one paid.
        if (payload.roomId && seq !== undefined) {
          payload.matchKey = duelMatchKey(String(payload.roomId), seq);
        }
        // The room may only speak for the match this result actually came
        // from. A room is reused by every rematch and reset to 0-0 by each
        // one, so an unqualified cross-check overwrote a slow or replayed POST
        // with the NEXT match's blank score and filed it as a 0-0 loss.
        // ...and only for one it has something to SAY about. A level score is
        // the relay behind the client rather than ahead of it: in a P2P duel
        // the deciding match_sync travels the WebSocket while this POST travels
        // HTTP, so the winner's own report legitimately arrives first, against
        // a room still reading 0-0. Overwriting from that room set
        // `playerScore = 0` and `isWinner = mine > theirs` = FALSE, filing the
        // WINNER a 0-0 loss — and the shared matchKey then deduped the relay's
        // correct record away, so it stood. Two red down-arrows off an ordinary
        // race, no malformed message needed. When the room cannot decide the
        // match, the client's own account of it stands, exactly as it does when
        // there is no room at all.
        const level = room ? room.scores[0] === room.scores[1] : false;
        if (room && seat >= 0 && room.matchSeq === seq && !level) {
          const mine = room.scores[seat];
          const theirs = room.scores[seat === 0 ? 1 : 0];
          payload.playerScore = mine;
          payload.opponentScore = theirs;
          payload.bestStreak = room.bestStreaks[seat];
          payload.endStreak = room.streaks[seat];
          payload.earnedStreak = room.earnedBests[seat];
          payload.isWinner = mine > theirs;

          // The same pre-match pair the relay records from, so this POST and
          // the relay's own write rate the two seats against each other as
          // they stood at the start rather than against whichever of them
          // happened to be committed first.
          const oppRating = duelStartRatings(room)[seat === 0 ? 1 : 0];
          if (oppRating) {
            context.opponentRating = oppRating.mmr;
            context.opponentRankRating = oppRating.rank;
          }
          context.performanceWeight = performanceWeight(mine, theirs, room.earnedBests[seat]);
          // The venue is the relay's answer or it is no answer at all — the
          // menu is the client, and a payload-named venue would be a free
          // ladder-loss dodge. Outside this branch there is no live room to
          // ask, so the match rates on its rules alone; see the note on
          // RecordMatchContext.venueRoomId for why that is the safe side.
          context.venueRoomId = room.venueRoomId;
        }

        // Whether a room can DECIDE this match and whether one can VOUCH for it
        // are different questions, and only the second one gates the ladder.
        // The branch above deliberately stands aside for a room that cannot
        // decide — a rematch has reset it, or in a P2P duel the winner's own
        // POST legitimately outran the deciding match_sync — and in all of
        // those the relay is recording its own copy and roomId+matchSeq
        // already gave the result a matchKey.
        //
        // Vouching asks three things, and it took two goes to get past the
        // first. Originally none of them were asked: the client's scores
        // stood; matchKey is only derived when a roomId is present, so a POST
        // without one skipped the recorded_matches ledger entirely and could
        // be replayed without limit; and isRankedRules(undefined) and
        // roomCountsForRank(undefined) are both true, so it rated, against an
        // even fallback opponent. About 25 scripted POSTs carried rankMu from
        // 25 to 37 — Cyber Overlord, the top-100 ladder position,
        // tier_overlord, legend-aurora, duel_10/duel_50, and elite_duel_3's
        // permanent theme.
        //
        // Asking only for a live seat closed the roomless version and left the
        // same exploit one step away, which review found: CREATE a room, sit
        // in it alone, and POST stock-rule wins against it. The room exists and
        // the seat is yours, so it vouched — and since a fresh room mints a
        // fresh matchKey, the whole thing repeats without limit. Measured:
        // rankMu 25.000 -> 45.817 and tier overlord over 25 rooms, no opponent
        // and no match ever started.
        //
        // So: a live seat, an opponent in the other one, and a claimed
        // sequence naming a match this room ACTUALLY STARTED. matchSeq is 0 on
        // a fresh room and startMatch is the only thing that bumps it, and
        // start_match is refused until a guest has readied — so `seq >= 1` is
        // exactly "two people agreed to play this", which no lone socket can
        // manufacture. The legitimate P2P race still passes all three: the
        // room is on this matchSeq with both seats filled, and it is only the
        // SCORE that is behind.
        //
        // The strictness costs one narrow case, taken deliberately: a pure-P2P
        // duel in which no deciding match_sync ever reached the relay AND the
        // opponent's socket closed before this POST landed would rate as
        // unvouched. The replica syncs on every crossing, so the relay has
        // almost always already recorded that match itself — and the failure
        // modes are not symmetric. Being strict costs an unusual duel its rank
        // while still paying its XP; being loose costs the ladder.
        //
        // XP is still paid: that is the documented trade for a match the server
        // cannot fully verify, and the same one a solo result already gets. The
        // ladder is not moved, and a device-scoped key brings the ledger back
        // so a replay is answered with what the first one paid.
        // ...and neither of those is "the caller played THIS match", which is
        // what the ladder actually needs and what two more review rounds went
        // on finding. `seq <= room.matchSeq` accepts every sequence the room
        // has EVER played, and matchSeq does not move when a seat changes
        // hands — so a newcomer taking a vacated seat could POST a fabricated
        // ranked win under each historical sequence, every one a fresh
        // (playerId, matchKey) for them. Measured over a three-match room:
        // 25.000 -> 30.762 and three ranked games, having played nothing.
        //
        // Two conditions, because each covers what the other leaves. `current`
        // alone still hands a newcomer the most recent match — they take the
        // WINNER's vacated seat, the cross-check reads room.scores[seat] and
        // files that win as theirs. `played` alone leaves an older sequence
        // rated against an even FALLBACK opponent, since the cross-check skips
        // unless the room is on that match and context.opponentRating is never
        // set.
        //
        // `current` costs nothing real: matchSeq only advances past N through
        // startMatch or the P2P adoption, both of which require matchOver,
        // which is set in exactly three places and each is followed
        // immediately by recordRoomMatch under the same duel:ROOM:N key. So a
        // room past N already recorded N, and a late POST short-circuits on
        // the ledger before forceUnranked is ever read.
        const since = room?.seatSince?.[seat];
        const played = seq !== undefined && since !== null && since !== undefined && seq > since;
        const current = !!room && seq === room.matchSeq && seq !== undefined && seq >= 1;
        const opposed = !!room && !!room.players[0] && !!room.players[1];
        if (!room || seat < 0 || !played || !current || !opposed) {
          context.forceUnranked = true;
          if (!payload.matchKey) {
            payload.matchKey = `unvouched:${req.deviceId}:${seq ?? 'x'}`;
          }
        }
      }

      const result = db.recordMatch(payload, context);
      // Counted once per match rather than once per REPORT: the same match
      // legitimately arrives up to three times (relay, client POST, on-device
      // replay), and the ledger is what tells them apart. Without this guard
      // the funnel would report roughly double the duels actually played.
      if (!result.alreadyRecorded) {
        db.bumpCounter(`match:${payload.mode}`);
        if (payload.mode === 'solo' && payload.difficulty) {
          db.bumpCounter(`match:solo:${normalizeDifficulty(payload.difficulty)}`);
        }
      }
      res.json(result);
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Global Leaderboard API
  app.get('/api/leaderboard', (req, res) => {
    try {
      // Both validated at the edge as well as in db.getLeaderboard. `sort` was
      // a bare cast, so any other value reached the query and 500'd with the
      // SQL error text; `limit` was Math.min(100, parseInt('abc')) === NaN,
      // and the loop guard `out.length >= NaN` is never true, so ?limit=abc
      // returned the whole board from an unauthenticated route.
      const asked = String(req.query.sort ?? 'elo');
      const sort = (['elo', 'level', 'rally', 'wins'] as const).includes(asked as any)
        ? (asked as 'elo' | 'level' | 'rally' | 'wins')
        : 'elo';
      const parsed = parseInt(String(req.query.limit ?? '50'), 10);
      const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 50;
      const includeBots = req.query.bots === '1' || req.query.bots === 'true';
      const leaderboard = db.getLeaderboard(sort, limit, includeBots);
      res.json({ leaderboard });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Practice Wall: no match is recorded and no rating moves; the client
  // reports the streak it reached and the server decides what it is worth.
  // Where a run stands, when no match is ending to say so — a player who
  // carried a run in, missed, and quit. It counts no match and pays nothing;
  // solo and practice only, since the relay owns a duel's runs. See
  // db.reportStreak for why this grants a client nothing it did not have.
  app.post('/api/profile/me/streak', requireActiveSession, (req, res) => {
    try {
      const me = db.getProfile(req.deviceId!);
      if (!me.initialized) return res.status(403).json({ error: 'PROFILE_NOT_INITIALIZED' });
      const mode = String(req.body?.mode || '');
      if (mode !== 'solo' && mode !== 'practice') {
        return res.status(400).json({ error: 'BAD_MODE' });
      }
      const endStreak = Number(req.body?.endStreak);
      if (!Number.isFinite(endStreak) || endStreak < 0) {
        return res.status(400).json({ error: 'BAD_REQUEST' });
      }
      // Ordered by the same age every other write to the run carries. It is
      // sent as it happens, but "as it happens" is when it LEAVES the device,
      // not when it arrives: stamped on arrival, a report that stalled for a
      // second would outrank the match result that overtook it in flight.
      const out = db.reportStreak(req.deviceId!, mode, endStreak, clientAgeMs(req.body), {
        chainId: chainIdOf(req.body),
        runSeq: Number(req.body?.runSeq),
      });
      if (!out.ok) return res.status(400).json({ error: 'BAD_REQUEST' });
      res.json({ modeStats: out.modeStats });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  /**
   * Tell us what went wrong.
   *
   * Behind `requireActiveSession` like everything else that writes
   * (convention §8), and behind an initialized profile, because a report with
   * no account behind it is one nobody can follow up.
   *
   * The allowance is counted from the TABLE rather than from memory, unlike
   * the sign-in limiter: an in-memory counter is reset by every deploy, and a
   * deploy is exactly when a wave of reports arrives. It is per player per UTC
   * day, the same shape the daily mission tables already use.
   *
   * `context` is attached by the CLIENT and is diagnostics, not testimony:
   * build id, locale, screen, the last match key. Nobody reports a build id by
   * hand, and a report without one costs an afternoon. It is bounded and
   * stringified rather than trusted — see db.fileReport.
   *
   * Note what this deliberately does NOT do: it does not act. An abuse report
   * names a subject and stops there, because acting on one is a judgement a
   * person makes with `moderate.cjs`, not something a route infers from a
   * stranger's say-so. A route that could hide an avatar on report would be a
   * route that lets one player hide another's.
   */
  app.post('/api/report', requireActiveSession, (req, res) => {
    try {
      const me = db.getProfile(req.deviceId!);
      if (!me.initialized) return res.status(403).json({ error: 'PROFILE_NOT_INITIALIZED' });

      const category = String(req.body?.category || '');
      if (!REPORT_CATEGORIES.includes(category as ReportCategory)) {
        return res.status(400).json({ error: 'BAD_CATEGORY' });
      }
      const text = String(req.body?.text || '').trim();
      if (text.length < REPORT_TEXT_MIN) return res.status(400).json({ error: 'TOO_SHORT' });

      if (db.reportsToday(me.id) >= REPORTS_PER_DAY) {
        return res.status(429).json({ error: 'TOO_MANY_REPORTS' });
      }

      const id = db.fileReport({
        playerId: me.id,
        username: me.username,
        category,
        text,
        // Only meaningful for `abuse`; stored as given and never resolved
        // here, because resolving it would be acting on it.
        subjectId: req.body?.subjectId ? String(req.body.subjectId) : null,
        context: { ...(req.body?.context ?? {}), build: buildId(), version: APP_VERSION },
      });
      db.bumpCounter(`report:${category}`);
      res.json({ ok: true, id });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  app.post('/api/practice/record', requireActiveSession, (req, res) => {
    try {
      const me = db.getProfile(req.deviceId!);
      if (!me.initialized) return res.status(403).json({ error: 'PROFILE_NOT_INITIALIZED' });
      const streak = Number(req.body?.bestStreak);
      if (!Number.isFinite(streak) || streak < 0) {
        return res.status(400).json({ error: 'BAD_REQUEST' });
      }
      // `bestStreak` is the run's peak; `earnedStreak` is how much of it was
      // built in THIS session and is the only one XP is paid on; `endStreak` is
      // where it stands, so the next session continues it. All three are
      // bounded against each other in recordPractice.
      res.json(
        db.recordPractice(req.deviceId!, {
          bestStreak: streak,
          earnedStreak: Number(req.body?.earnedStreak),
          endStreak: Number(req.body?.endStreak),
          // How many returns this visit made in total, which is a COUNT and
          // not a run — see recordPractice for why the daily curve cannot be
          // fed the peak. Absent from an older bundle, and recordPractice
          // falls back to the peak there, which is exactly what it did before.
          earnedReturns: req.body?.earnedReturns === undefined
            ? undefined
            : Number(req.body?.earnedReturns),
          ageMs: clientAgeMs(req.body),
          chainId: chainIdOf(req.body),
          runSeq: Number(req.body?.runSeq),
        })
      );
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Daily missions. Progress is advanced server-side by /api/match/record, so
  // these two routes only read state and pay out a completed mission once.
  app.get('/api/missions', blockReleasedDevice, (req, res) => {
    try {
      res.json({
        missions: db.getMissions(req.deviceId!),
        rerolls: db.rerollsRemaining(req.deviceId!),
      });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  app.post('/api/missions/claim', requireActiveSession, (req, res) => {
    try {
      const { missionId } = req.body ?? {};
      if (typeof missionId !== 'string') {
        return res.status(400).json({ error: 'BAD_REQUEST' });
      }
      const result = db.claimMission(req.deviceId!, missionId);
      if (!result.ok) {
        const status = result.code === 'MISSION_UNKNOWN' ? 404 : 409;
        return res.status(status).json({ error: result.code });
      }
      res.json({
        profile: result.profile,
        missions: result.missions,
        earnedXp: result.earnedXp,
        unlocked: result.unlocked,
        // The free replacement dealt into the slot this claim emptied. It
        // costs neither allowance, which is why `rerolls` below is unchanged.
        newMissionId: result.newMissionId,
        rerolls: db.rerollsRemaining(req.deviceId!),
      });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Reroll one mission for another from its own pool. Allowances are per UTC
  // day and expire with it — they never bank up.
  app.post('/api/missions/reroll', requireActiveSession, (req, res) => {
    try {
      const { missionId } = req.body ?? {};
      if (typeof missionId !== 'string') {
        return res.status(400).json({ error: 'BAD_REQUEST' });
      }
      const result = db.rerollMission(req.deviceId!, missionId);
      if (!result.ok) {
        const status = result.code === 'MISSION_UNKNOWN' ? 404 : 409;
        return res.status(status).json({ error: result.code, rerolls: db.rerollsRemaining(req.deviceId!) });
      }
      res.json({
        missions: result.missions,
        rerolls: result.rerolls,
        newMissionId: result.newMissionId,
      });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Achievements API
  app.get('/api/achievements', blockReleasedDevice, (req, res) => {
    try {
      const list = db.getAchievementsList(req.deviceId!);
      res.json({ achievements: list });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  // Match History API. Filters and paging are shared with the public
  // per-player route above — one parser, so the two views of a history can
  // never disagree about what a tab means.
  app.get('/api/matches/me', blockReleasedDevice, (req, res) => {
    try {
      const { mode, ranked, page } = parseHistoryQuery(req.query);
      const { matches, total } = db.getMatchHistoryPage(req.deviceId!, {
        mode,
        ranked,
        limit: HISTORY_PAGE_SIZE,
        offset: (page - 1) * HISTORY_PAGE_SIZE,
      });
      // `matches` keeps its name and shape: a stale bundle still open across
      // the deploy reads data.matches and slices ten for itself.
      res.json({ matches, total, page, pageSize: HISTORY_PAGE_SIZE });
    } catch (e: any) {
      serverError(res, e);
    }
  });

  const server = http.createServer(app);
  // maxPayload, because ws defaults to 100 MiB and every frame is JSON.parsed
  // synchronously on the event loop that serves every live match. The largest
  // legitimate message here is an SDP offer relayed by rtc_signal, comfortably
  // under 16KB; gameplay messages are tens of bytes.
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  // A ws server emits 'error' with no fallback, and an EventEmitter 'error'
  // with no listener THROWS. See the per-socket listener in the connection
  // handler below for why that is fatal here.
  wss.on('error', (err) => console.warn('[ws] server error:', (err as Error)?.message));

  // Sweep the rooms nobody is in.
  //
  // Short, because the case it exists for is a room with no live socket at
  // all, and one of those is pure garbage the moment it appears — there is
  // nobody to notice a delay and nobody to inconvenience by being quick. The
  // old sweep ran once a minute and only ever asked "has this been quiet for
  // half an hour", which cannot see an empty room whose seat still holds a
  // socket that is already gone, and cannot see a one-player room at all
  // because its own paddle_move traffic keeps refreshing lastActive.
  /** Whether each socket answered the last heartbeat probe. */
  const alive = new WeakMap<WebSocket, boolean>();

  const ROOM_IDLE_MS = 30 * 60 * 1000;
  const ROOM_UNPAIRED_TTL_MS = 30 * 60 * 1000;
  const ROOM_SWEEP_MS = 15 * 1000;
  setInterval(() => {
    const dead = reapRooms(rooms, Date.now(), {
      isLive: (sock) => sock.readyState === WebSocket.OPEN,
      idleMs: ROOM_IDLE_MS,
      unpairedTtlMs: ROOM_UNPAIRED_TTL_MS,
    });
    for (const { id, reason, room } of dead) {
      // The runs, before anything else. reapRooms deletes the room from the
      // map as it sweeps, so by the time the close below reaches a seat's
      // handler there is no room left to find and vacateSeat returns at its
      // first line — a duel reaped mid-rally lost both players' runs back to
      // whatever their last COMPLETED match had stored.
      //
      // Streaks only, and no abandon: that is a penalty for walking out on
      // somebody who was still playing, and a room reaped for going quiet for
      // half an hour has nobody left to have walked out on.
      // Guarded, and per room, for the same reason the queue sweep below is:
      // reapRooms has ALREADY deleted these from the map, so a throw here —
      // a full disk, a volume remounted read-only — would abort the sweep with
      // the rooms gone and their occupants' sockets never closed, sitting on
      // courts the relay no longer knows about. The close below is what
      // returns them to the menu, and it must not be skipped because a write
      // failed. Losing a run to a failing disk is the small half of that.
      try {
        persistDuelStreaks(room);
      } catch (e) {
        console.error(`room ${id}: could not persist streaks on reap:`, e);
      }
      // An empty room has nothing attached by definition; the other two can
      // still have somebody sitting on a court that no longer exists. Closing
      // their socket is what returns them to the menu — the client reads an
      // unexpected close as an ejection, which is exactly what this is.
      if (reason !== 'empty') {
        for (const seat of room.players) {
          if (seat && seat.ws.readyState === WebSocket.OPEN) seat.ws.close(1000, reason);
        }
      }
      // Watchers, ALWAYS — including 'empty'. "An empty room has nothing
      // attached by definition" was true when only players could attach, and
      // `empty` now means no live PLAYER: a table watched by two people and
      // played by nobody is exactly the case this branch used to skip.
      ejectSpectators(room, reason);
      console.log(`room ${id} reaped: ${reason}`);
    }
  }, ROOM_SWEEP_MS).unref?.();

  // The queue's own sweep. Faster than the room reaper because a player is
  // sitting looking at a spinner: two seconds is the longest anybody waits
  // past the moment a legal pairing exists, and `queue_join` sweeps
  // immediately as well, so the timer only matters for a band that has just
  // widened past a pair already waiting.
  const QUEUE_SWEEP_MS = 2000;
  setInterval(() => {
    try {
      sweepQueue(Date.now());
    } catch (e) {
      // A pairing that throws must not take the interval down with it: the
      // queue would then be a place players enter and are never called from.
      console.error('queue sweep failed:', e);
    }
  }, QUEUE_SWEEP_MS).unref?.();

  /**
   * Liveness, asked for rather than assumed.
   *
   * `readyState` answers "did this socket close", not "is anyone there". A
   * peer whose network vanishes without a close handshake leaves it reading
   * OPEN until a write times out at the TCP layer, which can be many minutes —
   * and in the meantime every branch of the room reaper is blind: the seat
   * looks live so the room is not empty, `vacateSeat` never ran so `soloSince`
   * is null, and the surviving player's own paddle_move keeps `lastActive`
   * fresh. They sit opposite a phantom and the room never expires.
   *
   * A terminate here fires the close handler, which is the only thing that
   * vacates a seat — so nothing downstream changes, it just becomes true.
   * Twice the sweep interval is the worst case, comfortably inside every TTL.
   */
  const HEARTBEAT_MS = 30 * 1000;
  setInterval(() => {
    const { dead, probe } = partitionHeartbeats(wss.clients, (sock) => alive.get(sock) !== false);
    for (const sock of dead) {
      alive.delete(sock);
      sock.terminate();
    }
    for (const sock of probe) {
      alive.set(sock, false);
      sock.ping();
    }
  }, HEARTBEAT_MS).unref?.();

  /**
   * Sweep the empty placeholder rows away — see `db.pruneStaleGuests`.
   *
   * Hourly rather than on every request, and guarded like the room reaper is:
   * a failing disk should log a line, not take a sweep (or the process) down.
   * The window is a week by default, which is long enough that a real visitor
   * who loaded the game and did not onboard has plainly moved on, and short
   * enough that the table's steady state is a week of traffic rather than
   * everything that ever reached the host.
   */
  const GUEST_TTL_MS =
    Number(process.env.GUEST_PROFILE_TTL_DAYS) > 0
      ? Number(process.env.GUEST_PROFILE_TTL_DAYS) * 24 * 60 * 60 * 1000
      : 7 * 24 * 60 * 60 * 1000;
  const sweepGuests = () => {
    try {
      const gone = db.pruneStaleGuests(GUEST_TTL_MS);
      if (gone > 0) console.log(`[db] pruned ${gone} stale guest profile(s)`);
    } catch (e) {
      console.error('guest prune failed:', e);
    }
  };
  sweepGuests();
  setInterval(sweepGuests, 60 * 60 * 1000).unref?.();

  wss.on('connection', (ws: WebSocket, upgradeReq: http.IncomingMessage) => {
    // Answered the last probe. A fresh socket has not been probed yet, so it
    // starts alive rather than one sweep away from being terminated.
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.addEventListener('close', () => alive.delete(ws));
    // Every socket needs this, and its absence took the whole process down.
    // ws raises receiver and socket faults as an 'error' emit, and an
    // EventEmitter 'error' with no listener throws — from a raw-socket I/O
    // callback, so the try/catch around the message handler below cannot see
    // it. One invalid-UTF-8 text frame, one unmasked client frame, or RSV1 set
    // with no permessage-deflate negotiated, from any unauthenticated socket
    // (/ws accepts cookieless ones), exited the process. Rooms live in memory,
    // so that dropped every live duel, every queued player and every spectator
    // on the spot, without taking the graceful SIGTERM path.
    ws.on('error', (err) => console.warn('[ws] socket error:', (err as Error)?.message));

    const cookieDeviceId = deviceIdFromCookieHeader(upgradeReq.headers.cookie);

    // A duel is the relay's own record-keeping: it writes a finished match
    // onto both seats' profiles. So the same rule the REST routes hold to
    // applies at the upgrade — a device that handed its account to another
    // device, or a session displaced by a newer load, does not get a court.
    // Without this the exploit simply moved: barred from recording a solo
    // match, an evicted device could still play (and be recorded for) a duel.
    let cookieSessionId: string | null = null;
    if (cookieDeviceId) {
      const session = resolveSession(cookieDeviceId, upgradeReq.headers.cookie);
      if (session.status !== 'active') {
        ws.send(JSON.stringify({ type: 'session_invalid', status: session.status, build: buildId() }));
        ws.close(4001, 'session not active');
        return;
      }
      cookieSessionId = session.sessionId;
      // Registered so a later session on this device can displace it. The
      // check above is a snapshot; this is what keeps it true afterwards.
      const entry: LiveSocket = { ws, deviceId: cookieDeviceId, sessionId: cookieSessionId };
      liveSockets.add(entry);
      ws.on('close', () => liveSockets.delete(entry));
    }

    let currentRoomId: string | null = null;
    /**
     * Which seat of `currentRoomId` this socket holds, if any.
     *
     * A discriminated union rather than two nullable numbers, because two
     * nullables give four states of which only three are legal — and the
     * illegal one, both set at once, is precisely the orphaned-seat bug class
     * CLAUDE.md §5 already records (a socket that took a second seat while
     * the first still believed it held one). Here it is unrepresentable.
     *
     * Everything downstream asks `playerIndex()`, which is null for a
     * spectator — so every gameplay handler, every host-only guard and every
     * seat-indexed write refuses a watching socket through a check that was
     * already there rather than through a new one somebody has to remember.
     * `match_sync` matters most: it can decide a match and trigger
     * recordRoomMatch, and it is closed by that one rename.
     */
    let seat: Seat | null = null;
    let currentPlayerId: string = '';

    /** The playing seat this socket holds — null for a spectator or nobody. */
    const playerIndex = (): 0 | 1 | null => (seat?.role === 'player' ? seat.index : null);

    /**
     * Whether this socket may take a seat in a room.
     *
     * The relay stamps a seat's display name at join time and never revisits
     * it, so a player who joins before choosing a username is shown to their
     * opponent as Paddle-XXXX for the life of the room — and the app gates
     * everything else behind onboarding, so a seat was the one thing an
     * unidentified player could still take.
     *
     * Only a cookie that resolves to a real, uninitialized profile is
     * refused. A socket with no cookie at all is the synthetic-id fallback
     * the load test and other tooling run on; it records nothing either way.
     */
    /**
     * Whether this socket's player may PLAY in a venue room.
     *
     * The menu draws these brackets, and the menu is the client — so the same
     * predicate is asked here, exactly as DIFFICULTY_LOCKED is enforced behind
     * /api/match/record rather than trusted to the picker. `roomEntryVerdict`
     * lives in src/venues.ts and is imported by both, so they cannot drift.
     *
     * Deliberately NOT asked of a private table: an invite is an invite, and
     * two friends in different brackets are exactly who the code flow exists
     * for. A cookieless socket (the load test's path) is not judged either —
     * it has no profile to judge.
     */
    /**
     * The bracket verdict, when it refuses — never a formatted sentence.
     *
     * The English prose that used to be built here went straight into the
     * client's `alert()`, so this was one of the places the product spoke
     * English in seven locales. The client already renders a verdict as a
     * localized sentence for the room list (`lockReason`), so handing it the
     * verdict keeps ONE copy of that wording rather than a second one here
     * that would drift. `message` below is the English fallback for a bundle
     * that does not understand the code.
     */
    const venueRefusal = (venueRoomId: string): EntryVerdict | null => {
      if (!cookieDeviceId) return null;
      const room = roomById(venueRoomId);
      if (!room?.gate) return null;
      const profile = db.getProfile(cookieDeviceId);
      const verdict = roomEntryVerdict(room, profile);
      return verdict.ok ? null : verdict;
    };

    /** English fallback for a verdict, for `error.message`. */
    const venueRefusalText = (verdict: EntryVerdict): string => {
      if (verdict.reason === 'level') return `This room needs level ${verdict.needLevel}.`;
      if (verdict.reason === 'tier_low') return `This room needs ${verdict.needTier} or above.`;
      return `This room is for ${verdict.maxTier} and below.`;
    };

    const seatRefusal = (): boolean => {
      if (!cookieDeviceId) return false;
      return !db.getProfile(cookieDeviceId).initialized;
    };

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // An uninitialized profile takes no seat of ANY kind: a seat's display
        // name is stamped at join time and never revisited, so a watcher would
        // sit in the table state as Paddle-XXXX for the life of the room.
        if (
          msg.type === 'create_room' ||
          msg.type === 'join_room' ||
          msg.type === 'spectate_room' ||
          msg.type === 'swap_seat' ||
          // Queueing IS asking for a seat, just not yet at a named table.
          msg.type === 'queue_join'
        ) {
          if (seatRefusal()) {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'NEEDS_USERNAME',
                message: 'Pick a username before joining a match.',
              })
            );
            return;
          }
        }

        if (msg.type === 'create_room') {
          const venueRoomId = normalizeVenueRoomId(msg.venueRoomId);
          // Judged BEFORE the room is built and before vacateSeat runs: a
          // refused create must not cost the player the seat they already
          // hold, still less charge them an abandon for a match they are in.
          const venueRefused = venueRefusal(venueRoomId);
          if (venueRefused) {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'VENUE_LOCKED',
                verdict: venueRefused,
                message: venueRefusalText(venueRefused),
              })
            );
            return;
          }
          const code = mintRoomCode();
          if (!code) {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'ROOM_NOT_FOUND',
                message: 'Could not open a table right now. Try again.',
              })
            );
            return;
          }
          // Taking a seat means giving up the one this socket already holds.
          // The handlers below just overwrite currentRoomId and the seat, so
          // without this the old room keeps a PlayerSession whose socket has
          // moved on: when that socket eventually closes, vacateSeat only
          // reaches the newer room, and the older one is left with a seat no
          // close event will ever clear. Walking out of a live duel to open
          // another room is an abandon, and vacateSeat is what judges that.
          //
          // Here, and in join_room only once the destination has been
          // checked: a room is always created, but a join can be refused, and
          // a refused join must not cost the seat the player already had —
          // still less charge them an abandon for a match they are still in.
          // Taking a seat and holding a queue place are the same
          // commitment, so taking one gives up the other.
          leaveQueue(ws);
          vacateSeat();

          currentPlayerId = cookieDeviceId || msg.playerId || `p_${Date.now()}`;
          // Display names come from the cookie-verified profile, never from
          // the message — usernames are unique identities now.
          const hostName = cookieDeviceId ? db.getProfile(cookieDeviceId).username : 'Player 1';
          const room: Room = {
            id: code,
            // The host sits down at matchSeq 0. See Room.seatSince.
            seatSince: [0, null],
            players: [
              {
                ws,
                playerId: currentPlayerId,
                playerName: hostName,
                playerIndex: 0,
                deviceId: cookieDeviceId || null,
                sessionId: cookieSessionId,
              },
              null,
            ],
            scores: [0, 0],
            // A duel streak carries between matches, so a seat starts on
            // whatever run this player already had going in this mode. Read
            // from the store rather than taken from the client: it decides
            // what the match is rated and paid on.
            streaks: [carriedStreak(cookieDeviceId), 0],
            bestStreaks: [carriedStreak(cookieDeviceId), 0],
            earnedStreaks: [0, 0],
            earnedBests: [0, 0],
            crossingsThisPoint: 0,
            syncRev: 0,
            servingPlayer: 0,
            rematchVotes: [false, false],
            config: roomConfigFor(venueRoomId, msg.config || DEFAULT_ROOM_CONFIG, cookieDeviceId),
            matchOver: false,
            inPlay: false,
            ready: [false, false],
            matchSeq: 0,
            lastActive: Date.now(),
            // One player, from this moment — the clock that expires a room
            // nobody ever joins, and a room somebody has left.
            soloSince: Date.now(),
            // Sampled lazily by whichever recording path reaches the room
            // first; matchSeq 0 is no match, so nothing is cached yet.
            startRatings: null,
            startRatingsSeq: 0,
            relayCounted: false,
            // Whitelisted, never free client text — the browser is keyed on
            // this. An unnamed venue lands in the ungated default, which is
            // what keeps the invite flow and old bundles working unchanged.
            venueRoomId,
            // PRIVATE unless the caller asks otherwise, for the same reason:
            // a table created by anything that predates this is an
            // invite-code table exactly as it always was.
            visibility: msg.visibility === 'public' ? 'public' : 'private',
            // Locked tables get their key when the host turns the lock on;
            // an unlisted one created without ever touching that toggle (an
            // old bundle, the harness) is addressed by its id as it always was.
            joinKey: null,
            // Both watching seats start vacant. Whether they can be taken at
            // all is config.spectators, a term of the match.
            spectators: [null, null],
          };

          rooms.set(code, room);
          currentRoomId = code;
          seat = { role: 'player', index: 0 };

          ws.send(
            JSON.stringify({
              type: 'room_created',
              roomId: code,
              playerIndex: 0,
            })
          );
          ws.send(JSON.stringify({ type: 'room_config', config: room.config }));
          broadcastTableState(room);
        } else if (msg.type === 'join_room') {
          const code = (msg.roomId || '').toUpperCase().trim();
          // A public table answers to its id; a locked one answers only to its
          // current key. See roomForCode.
          const room = roomForCode(code);

          if (!room) {
            ws.send(JSON.stringify({ type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found. Check the 4-letter code.' }));
            return;
          }

          if (currentRoomId === room.id) {
            // Already at this table, in EITHER kind of seat. Refused rather
            // than treated as a move, because the vacate below would empty
            // this very room and delete it, and the seat would then be taken
            // in an object no longer in the map — a room only its own sockets
            // could reach. Moving between seats here is swap_seat's job, and
            // it has guards of its own (the match lock above all) that a
            // vacate-then-seat would walk straight past.
            ws.send(
              JSON.stringify({ type: 'error', code: 'ALREADY_AT_TABLE', message: 'You are already at this table — use a seat.' })
            );
            return;
          }

          // The FIRST free playing seat, not seat 1. `vacateSeat` empties
          // whichever seat left and keeps the room alive, so a host who taps
          // Main Menu after a match leaves a table with seat 0 empty and seat
          // 1 held — still in the map, still listed by
          // `/api/rooms/:venueRoomId/tables` (it has a live player), and
          // refusing every arrival as "already full (2 players)" for up to the
          // 30-minute unpaired TTL, because this test asked about seat 1 and
          // the write below always went to seat 1.
          //
          // Seat 0 is the host seat, so whoever takes it is the host — which
          // is already the rule `swap_seat` established when it made a
          // pre-match move into seat 0 legal. Readiness and rematch votes are
          // cleared below, so a table adopted this way starts its handshake
          // from scratch rather than inheriting the departed pair's.
          const joinIdx: 0 | 1 | null =
            room.players[0] === null ? 0 : room.players[1] === null ? 1 : null;
          if (joinIdx === null) {
            ws.send(JSON.stringify({ type: 'error', code: 'ROOM_FULL', message: 'Room is already full (2 players).' }));
            return;
          }
          const otherIdx: 0 | 1 = joinIdx === 0 ? 1 : 0;

          // Taking a CPU's chair, which is the whole point of a listed CPU
          // table: you play the machine until somebody takes its seat.
          //
          // Only BETWEEN matches. Mid-match the arrival is refused as full and
          // the browser offers Watch instead — a human appearing on the far
          // half of a rally in progress is a different match than the one
          // either side agreed to, and the host's result is already being
          // rated against a CPU.
          //
          // The eviction has to clear the pair state itself, because a CPU
          // seat never passes through `vacateSeat` — nothing clears `scores`,
          // `inPlay`, `matchOver`, `startRatings` or the departing seat's
          // streaks. Leave it and the pair sit at a table stuck `matchOver` at
          // the CPU match's final score, with a Start button that does nothing
          // and no error to explain it.
          if (room.config.cpu) {
            if (room.inPlay && !room.matchOver) {
              ws.send(
                JSON.stringify({ type: 'error', code: 'ROOM_FULL', message: 'That table is mid-match — watch, or try again when it ends.' })
              );
              return;
            }
            room.config = { ...room.config, cpu: null };
            resetTableForNextPair(room, joinIdx);
          }

          // A PUBLIC table is one this player browsed to, so the bracket that
          // listed it applies to them as well as to its host. A PRIVATE table
          // is an invitation, and an invitation is not bracketed: two friends
          // in different brackets are exactly who the code flow exists for,
          // and e2e-invite's guest is a brand-new level-1 player. Checked here
          // rather than only at create, because the browser is polled and a
          // table can be listed to somebody who then fails the gate.
          //
          // Above vacateSeat for the same reason as everything else here:
          // nothing that can REFUSE may run after the old seat is given up.
          if (room.visibility === 'public') {
            const joinRefused = venueRefusal(room.venueRoomId);
            if (joinRefused) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  code: 'VENUE_LOCKED',
                  verdict: joinRefused,
                  message: venueRefusalText(joinRefused),
                })
              );
              return;
            }
          }

          // The destination is real and has room, so the old seat can go. See
          // the note in create_room: nothing above this line may fail.
          // Taking a seat and holding a queue place are the same
          // commitment, so taking one gives up the other.
          leaveQueue(ws);
          vacateSeat();

          currentPlayerId = cookieDeviceId || msg.playerId || `p_${Date.now()}`;
          const guestName = cookieDeviceId
            ? db.getProfile(cookieDeviceId).username
            : joinIdx === 0
              ? 'Player 1'
              : 'Player 2';
          // Where this occupant came in, so the vouch in /api/match/record can
          // tell a match they played from one the room merely remembers.
          // Indexed on the seat ACTUALLY taken: an arrival can now adopt a
          // hostless table by taking seat 0, and pinning this to seat 1 would
          // leave `seatSince[0]` null — which fails closed, so that player's
          // duel would record un-ranked for a match they really played.
          (room.seatSince ??= [null, null])[joinIdx] = room.matchSeq;
          room.players[joinIdx] = {
            ws,
            playerId: currentPlayerId,
            playerName: guestName,
            playerIndex: joinIdx,
            deviceId: cookieDeviceId || null,
            sessionId: cookieSessionId,
          };
          room.streaks[joinIdx] = carriedStreak(cookieDeviceId);
          room.bestStreaks[joinIdx] = Math.max(room.bestStreaks[joinIdx], room.streaks[joinIdx]);
          room.rematchVotes = [false, false];
          room.lastActive = Date.now();
          // Two players: the solo clock stops. It restarts if either of them
          // leaves, which is what a room going back to one player IS.
          room.soloSince = null;
          currentRoomId = room.id;
          seat = { role: 'player', index: joinIdx };

          // Notify joining player
          ws.send(
            JSON.stringify({
              type: 'room_joined',
              roomId: room.id,
              playerIndex: joinIdx,
              opponentName: room.players[otherIdx]?.playerName || 'Player 1',
              opponentId: room.players[otherIdx]?.playerId || 'p1',
            })
          );

          // The guest plays the host's match, so they are told its terms before
          // the first serve — and can read them in the lobby.
          ws.send(JSON.stringify({ type: 'room_config', config: room.config }));

          // Notify whoever was already sitting here — which is not always the
          // host, now that an arrival can be the one taking seat 0.
          const sitting = room.players[otherIdx];
          if (sitting?.ws && sitting.ws.readyState === WebSocket.OPEN) {
            sitting.ws.send(
              JSON.stringify({
                type: 'opponent_joined',
                opponentName: room.players[joinIdx]?.playerName || 'Player 2',
                opponentId: room.players[joinIdx]?.playerId || 'p2',
              })
            );
          }

          // The match does NOT start on join any more: the guest readies in
          // the lobby, then the host starts. Both begin from a clean slate.
          room.ready = [false, false];
          broadcast(room, { type: 'ready_state', ready: room.ready });

          // Tell each phone how the matchup looks BEFORE the first serve.
          // Computed server-side so neither client ever sees the other's
          // hidden rating.
          sendMatchPrediction(room);

          // Anyone watching learns the second seat is filled the way the host
          // does, and never through `opponent_left`-shaped news about people
          // they were not playing.
          broadcastTableState(room);

        } else if (msg.type === 'spectate_room') {
          const code = String(msg.roomId || '').toUpperCase();
          // Same lock as join_room: a locked table is not watchable by its id
          // either, or the key would be a door with a window beside it.
          const room = roomForCode(code);
          if (!room) {
            ws.send(JSON.stringify({ type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found.' }));
            return;
          }
          if (!room.config.spectators) {
            ws.send(JSON.stringify({ type: 'error', code: 'NO_WATCH_SEATS', message: 'This table has no seats to watch from.' }));
            return;
          }

          // A seat may be ASKED for, or left to the relay. Which of the two
          // watching seats you are in is a detail a viewer does not care
          // about — they care which side they are watching, and that is what
          // swap_seat is for — so the browser names none and takes whichever
          // is free. Naming one is still allowed: a swap names the side it wants.
          //
          // When one IS named it is strict enum membership, and deliberately
          // NOT clampInt: that turns junk into `lo`, which in a seat namespace
          // is seat 0 — the HOST seat. clampInt exists for bounded gameplay
          // scalars, and for an enum it silently reinterprets garbage as a
          // privileged request.
          let slot: 0 | 1;
          if (msg.seat === undefined || msg.seat === null) {
            const free = room.spectators[0] === null ? 0 : room.spectators[1] === null ? 1 : null;
            if (free === null) {
              ws.send(JSON.stringify({ type: 'error', code: 'WATCH_SEATS_FULL', message: 'Both seats are taken.' }));
              return;
            }
            slot = free;
          } else if (msg.seat === 2 || msg.seat === 3) {
            slot = msg.seat === 2 ? 0 : 1;
          } else {
            ws.send(JSON.stringify({ type: 'error', code: 'NOT_A_SEAT', message: 'That is not a seat you can watch from.' }));
            return;
          }

          if (currentRoomId === room.id) {
            // Already at this table. Refused rather than treated as a move for
            // the same reason join_room refuses it: the vacate below would run
            // against the very room being taken a seat in.
            ws.send(JSON.stringify({ type: 'error', code: 'ALREADY_AT_TABLE', message: 'You are already at this table.' }));
            return;
          }
          // Non-null, not non-live: a seat holding a socket that has died is
          // occupied until its close handler clears it, and treating it as
          // free orphans the session sitting in it.
          if (room.spectators[slot] !== null) {
            ws.send(JSON.stringify({ type: 'error', code: 'SEAT_TAKEN', message: 'That seat is taken.' }));
            return;
          }
          // One account, one seat at a table. Without this an account
          // displaced across two devices — which is a live state, not a
          // hypothetical — could hold two of the four seats.
          if (cookieDeviceId) {
            const already =
              room.players.some((p) => p?.deviceId === cookieDeviceId) ||
              room.spectators.some((w) => w?.deviceId === cookieDeviceId);
            if (already) {
              ws.send(JSON.stringify({ type: 'error', code: 'ALREADY_AT_TABLE', message: 'You already have a seat at this table.' }));
              return;
            }
          }

          // Nothing above this line may fail. Same rule as create_room and
          // join_room: a refused seat must never cost the one already held.
          // Taking a seat and holding a queue place are the same
          // commitment, so taking one gives up the other.
          leaveQueue(ws);
          vacateSeat();

          currentPlayerId = cookieDeviceId || msg.playerId || `p_${Date.now()}`;
          const watcherName = cookieDeviceId ? db.getProfile(cookieDeviceId).username : 'Spectator';
          room.spectators[slot] = {
            ws,
            playerId: currentPlayerId,
            playerName: watcherName,
            // Derived from the slot taken, never read off the message: slot 0
            // sits beside player 0.
            side: slot,
            deviceId: cookieDeviceId || null,
            sessionId: cookieSessionId,
          };
          currentRoomId = room.id;
          seat = { role: 'spectator', slot };

          // Deliberately NOT touched: `soloSince`. Clearing it would exempt a
          // one-player table from the only clock that can expire a busy one,
          // so a host could park a table forever by having a friend sit down —
          // which is the `pairedAt` leak that field was rewritten to close.
          // `lastActive` is left alone for the same reason: watchers arriving
          // and leaving must not hold a dead table past the idle clock.

          ws.send(JSON.stringify({ type: 'room_config', config: room.config }));
          broadcastTableState(room);
          sendSpectatorSync(room, ws);
          // The odds too, since a watcher missed the join that first sent them.
          sendMatchPrediction(room);
          // Belt and braces: rtc_signal is refused for a table with seats
          // open, so this table should already be relayed — but a link that
          // opened before the seats did would leave this watcher in front of
          // a frozen court. Again endP2P, not takeOverFromP2P.
          endP2P(room);

        } else if (msg.type === 'set_table_visibility' && currentRoomId && playerIndex() === 0) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          // The host owns the lock, and only between matches — the same window
          // set_room_config uses, and for the same reason: the terms of a
          // table are not something either phone changes mid-rally.
          if (room.inPlay && !room.matchOver) return;
          // A queue table is nobody's to lock: the relay seated the pair and
          // there is no third person it could be shared with.
          if (room.venueRoomId === MATCHMAKING_ROOM) return;

          if (msg.private) {
            room.visibility = 'private';
            // A FRESH key every time the lock is turned on, even if it was
            // already on. That is what makes sharing a key a decision that can
            // be taken back: whoever was given the old one is now locked out.
            room.joinKey = mintJoinKey();
          } else {
            room.visibility = 'public';
            // No key while the table is open — it is in the room's browser,
            // and a key nobody needs is one somebody can still be given.
            room.joinKey = null;
          }
          broadcastTableState(room);
        } else if (msg.type === 'queue_join') {
          db.bumpCounter('queue:join');
          // A seat and a queue place are the same commitment, so nobody holds
          // both: the relay would otherwise seat somebody who is already
          // mid-duel, and the abandon would be charged to them for a match
          // they never asked to leave.
          if (currentRoomId && seat) {
            ws.send(JSON.stringify({ type: 'error', code: 'LEAVE_TABLE_FIRST', message: 'Leave your table before queueing.' }));
            return;
          }
          if (!cookieDeviceId) {
            // No profile means no rating to pair on and nothing to record
            // onto. A cookieless socket can still play a private duel — that
            // is the load test's path — but it cannot be matchmade.
            ws.send(JSON.stringify({ type: 'error', code: 'NEEDS_USERNAME', message: 'Pick a username before queueing.' }));
            return;
          }
          // Re-joining is not a reset: keeping the original joinedAt is what
          // stops a client widening or narrowing its own band by rejoining.
          const already = queue.find((e) => e.ws === ws);
          const rttMs =
            typeof msg.rttMs === 'number' && Number.isFinite(msg.rttMs) && msg.rttMs >= 0
              ? Math.min(5000, Math.round(msg.rttMs))
              : null;
          if (already) {
            already.rttMs = rttMs;
          } else {
            currentPlayerId = cookieDeviceId;
            queue.push({
              ws,
              deviceId: cookieDeviceId,
              sessionId: cookieSessionId,
              playerId: cookieDeviceId,
              playerName: db.getProfile(cookieDeviceId).username,
              joinedAt: Date.now(),
              rttMs,
              // Minted here, inside this socket's own scope, because a seat is
              // closure state and nothing outside this closure can write it.
              take: (roomId, index) => {
                currentRoomId = roomId;
                seat = { role: 'player', index };
              },
            });
          }
          ws.send(JSON.stringify({ type: 'queue_state', status: 'searching' }));
          // Answer immediately when there is already somebody waiting, rather
          // than making the NEWCOMER sit out a tick of the sweep — which is
          // why a re-join does not force one. Re-joining changes nothing the
          // sweep reads except an `rttMs` tiebreak, so sweeping for it is work
          // with no possible new answer, and it is work an unmetered message
          // could ask for in a loop: the sweep is O(N) reads and O(N^2) erf
          // over the queue.
          if (!already) sweepQueue(Date.now());
        } else if (msg.type === 'queue_cancel') {
          leaveQueue(ws);
          ws.send(JSON.stringify({ type: 'queue_state', status: 'cancelled' }));
        } else if (msg.type === 'swap_seat' && currentRoomId && seat) {
          const room = rooms.get(currentRoomId);
          if (!room) return;

          // Strict enum membership again, and again NOT clampInt: `lo` here is
          // seat 0, the host's.
          const target = msg.seat;
          if (target !== 0 && target !== 1 && target !== 2 && target !== 3) {
            ws.send(JSON.stringify({ type: 'error', code: 'NOT_A_SEAT', message: 'That is not a seat.' }));
            return;
          }
          const here: TableSeat = seat.role === 'player' ? seat.index : spectatorSeat(seat.slot);
          // Already there. Silently, with no broadcast and no re-seed: a
          // repeated tap must not clear anybody's readiness or reset a run.
          if (target === here) return;

          const toPlayer = target === 0 || target === 1;
          const targetIdx: 0 | 1 = (toPlayer ? target : target === 2 ? 0 : 1) as 0 | 1;

          // Non-null, not non-live: a seat holding a socket that has died is
          // occupied until its close handler clears it, and treating it as
          // free would orphan the session sitting in it.
          //
          // A CPU seat counts as occupied even though it is not in `players`.
          // Without this the host swapping onto it finds `players[1]` null,
          // is not refused, and ends up sharing the chair: `playerIndex()`
          // becomes 1, so every host-only guard — set_room_config,
          // start_match, set_table_visibility — then refuses the only person
          // at the table, the CPU cannot be removed, and the table is wedged.
          const cpuSeat = room.config.cpu ? cpuSeatOf(room) : null;
          const occupied = toPlayer
            ? room.players[targetIdx] ?? (cpuSeat === targetIdx ? CPU_HOLDS_SEAT : null)
            : room.spectators[targetIdx];
          if (occupied !== null) {
            ws.send(JSON.stringify({ type: 'error', code: 'SEAT_TAKEN', message: 'That seat is taken.' }));
            return;
          }
          if (!toPlayer && !room.config.spectators) {
            // Re-checked at claim time: the browser is polled, so a table
            // listed as offering seats can be tapped after the host shut them.
            ws.send(JSON.stringify({ type: 'error', code: 'NO_WATCH_SEATS', message: 'This table has no seats to watch from.' }));
            return;
          }

          // The match lock, and it is deliberately STRICTER than
          // set_room_config's `!inPlay || matchOver` — by exactly the
          // countdown window, because `startRatings` is already sampled for
          // this matchSeq by then and a swap would invalidate the pre-match
          // pair both seats are rated against.
          //
          // A player may never become a spectator mid-match. The bookkeeping
          // reason is the abandon path, but the real one is that "stand up,
          // look at the hidden half, sit back down" is a two-second cheat in
          // a game whose whole premise is the blind half-court. A watcher
          // moving 2↔3 is exempt: it touches no playing seat.
          const touchesPlayer = toPlayer || seat.role === 'player';
          const midMatch = room.matchSeq > 0 && !room.matchOver;
          if (touchesPlayer && midMatch) {
            ws.send(JSON.stringify({ type: 'error', code: 'SEATS_LOCKED', message: 'Seats are locked until the match ends.' }));
            return;
          }

          // A court cannot be emptied by standing up. `leave_room` is the only
          // way out of a duel, and it is judged as an abandon.
          if (seat.role === 'player' && !toPlayer) {
            const other = room.players[seat.index === 0 ? 1 : 0];
            if (!other) {
              ws.send(JSON.stringify({ type: 'error', code: 'NEEDS_A_PLAYER', message: 'Somebody has to be playing.' }));
              return;
            }
          }

          // Nothing below this line can fail, so nothing above it may move a
          // seat. Node is single-threaded and nothing here awaits, so the
          // occupancy checks above and these assignments are one step —
          // carriedStreak is synchronous and must stay so.
          const wasSide: 0 | 1 | null = seat.role === 'spectator' ? seat.slot : null;
          if (seat.role === 'player') {
            const leaving = seat.index;
            room.players[leaving] = null;
            room.ready[leaving] = false;
            room.rematchVotes[leaving] = false;
            // A run belongs to a player, not to a chair: startMatchStreaks
            // opens bestStreaks ON streaks, so a value left behind becomes the
            // next occupant's opening PEAK, and a peak is permanent.
            //
            // Deliberately NOT persistDuelStreaks. "A seat is emptying, write
            // its run back" is a reasonable-looking instinct and is wrong
            // here: nothing was ever taken from the store — the seat was
            // SEEDED from it — so there is nothing to write back, and the
            // player's own stored run is untouched and will seed them again.
            clearSeatStreaks(room, leaving);
            // Same reason as vacateSeat: a playing seat changing hands ends
            // whatever handshake its previous occupant was party to.
            clearP2PEvidence(room);
          } else {
            room.spectators[seat.slot] = null;
          }

          const who = {
            ws,
            playerId: currentPlayerId,
            playerName: cookieDeviceId ? db.getProfile(cookieDeviceId).username : 'Player',
            deviceId: cookieDeviceId || null,
            sessionId: cookieSessionId,
          };
          if (toPlayer) {
            (room.seatSince ??= [null, null])[targetIdx] = room.matchSeq;
            room.players[targetIdx] = { ...who, playerIndex: targetIdx };
            room.streaks[targetIdx] = carriedStreak(cookieDeviceId);
            room.bestStreaks[targetIdx] = room.streaks[targetIdx];
            room.earnedStreaks[targetIdx] = 0;
            room.earnedBests[targetIdx] = 0;
          } else {
            room.spectators[targetIdx] = { ...who, side: targetIdx };
          }
          seat = toPlayer
            ? { role: 'player', index: targetIdx }
            : { role: 'spectator', slot: targetIdx };

          // A yes given against opponent A is not a yes against opponent B.
          room.ready = [false, false];
          room.rematchVotes = [false, false];
          // The pre-match rating pair is about a pair of players; a different
          // pair is a different sample.
          room.startRatings = null;
          room.startRatingsSeq = 0;
          // The `??` is load-bearing: a lone host must not be able to restart
          // the 30-minute unpaired TTL by swapping 0↔1 over and over.
          room.soloSince = room.players[0] && room.players[1] ? null : (room.soloSince ?? Date.now());
          // `lastActive` is deliberately NOT written — two watchers swapping
          // back and forth would otherwise hold a dead table past the idle
          // clock, and closing that by not writing the field beats closing it
          // with a role check.

          broadcast(room, { type: 'ready_state', ready: room.ready });
          broadcast(room, { type: 'rematch_state', votes: room.rematchVotes });
          broadcastTableState(room);
          sendMatchPrediction(room);
          // A watcher whose SIDE changed is looking at a different court, so
          // it is re-seeded — including one who has just sat down to watch
          // after playing.
          if (seat.role === 'spectator' && seat.slot !== wasSide) sendSpectatorSync(room, ws);

        } else if (msg.type === 'paddle_move' && currentRoomId && playerIndex() !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();

          const me = playerIndex() as 0 | 1;
          const oppIdx = me === 0 ? 1 : 0;
          // Coerced and clamped exactly as ball_pos does fifteen lines below.
          // This was the one gameplay stream forwarded raw: `1 - msg.x` on a
          // string is NaN, which serializes as null and lands as 1 on the
          // opponent; 1e308 drew their chevron at -1e308; and an object was
          // relayed to the spectator whole, bounded only by ws's 100 MiB
          // default. Every other message on this socket already validates.
          const px = Math.max(0, Math.min(1, Number(msg.x) || 0));
          // Mirrored for the far side of the net — the opponent and anyone
          // watching over their shoulder get the identical bytes.
          sendAll(viewersOf(room, oppIdx), { type: 'opponent_paddle', x: 1 - px });
          // RAW for the watcher on THIS side: they are drawing this player's
          // own court in this player's own coordinates, so a mirror here would
          // put the paddle on the wrong side of a screen nobody is mirroring.
          const mine = watcherBeside(room, me);
          if (mine) mine.send(JSON.stringify({ type: 'watched_paddle', x: px }));
        } else if (msg.type === 'ball_pos' && currentRoomId && playerIndex() !== null) {
          // The sonar's ball feed: each phone streams its OWN half's ball at
          // ~15Hz so the other side's radar has something real to draw — a
          // duel has no local simulation of the opponent's court. Forwarded
          // in the SENDER's frame (the radar mirrors, exactly as it does for
          // the solo AI's half), clamped, and never stored: pure telemetry.
          const room = rooms.get(currentRoomId);
          if (!room) return;
          const me = playerIndex() as 0 | 1;
          const oppIdx = me === 0 ? 1 : 0;
          const x = Math.max(0, Math.min(1, Number(msg.x) || 0));
          const y = Math.max(0, Math.min(1, Number(msg.y) || 0));
          sendAll(viewersOf(room, oppIdx), { type: 'opponent_ball', x, y });
          // Again raw, and again the same sample: the watcher's own half IS
          // this player's half. Deliberately not sent any faster than the
          // ~20Hz the players already stream — raising it for a watched table
          // would spend the players' bandwidth on somebody else's view.
          const mine = watcherBeside(room, me);
          if (mine) mine.send(JSON.stringify({ type: 'watched_ball', x, y }));
        } else if (msg.type === 'cpu_frame' && currentRoomId) {
          // Everything a WATCHER needs about a CPU table, in one frame from
          // the host.
          //
          // Guarded on the TABLE having a CPU and on the sender being the
          // human playing at it — deliberately not on the usual
          // `playerIndex() !== null`, which is the natural thing to copy and
          // is exploitable: in a real two-human duel, seat 0 could send this
          // and inject a `ball_incoming` onto seat 1's live court, clearing
          // their serve and replacing the ball so the point can never end.
          // Guarded this way, the worst a forged frame can do is lie to a
          // spectator about a match with no second player's rating in it.
          const room = rooms.get(currentRoomId);
          if (!room || !room.config.cpu) return;
          const me = playerIndex();
          if (me === null || room.players[me] === null) return;
          const cpuIdx: 0 | 1 = me === 0 ? 1 : 0;
          room.lastActive = Date.now();

          // Bounded like every other gameplay stream. The stakes are lower
          // here — nothing on the far side has a rating — but a NaN
          // serializes as null and lands as 1 on a watcher's court, and
          // `bound` is the habit rather than the exception.
          const unit = (v: unknown): number => Math.max(0, Math.min(1, Number(v) || 0));
          const hostPaddle = unit(msg.hostPaddle);
          const cpuPaddle = unit(msg.cpuPaddle);
          const rawBall = msg.ball;
          const ball =
            rawBall && (rawBall.side === 0 || rawBall.side === 1)
              ? { side: rawBall.side as 0 | 1, x: unit(rawBall.x), y: unit(rawBall.y) }
              : null;

          // The relay's own copy of the score, for `spectator_sync` alone —
          // somebody sitting down at 3-2 has to see 3-2. Held inside the
          // room's winning score for the same reason applyMatchSync holds a
          // synced one, and never echoed back: the host is authoritative for
          // its own solo match and a `score_update` returning to it would
          // fight the local scoring.
          const cap = room.config.winningScore;
          const rawScores = Array.isArray(msg.scores) ? msg.scores : [0, 0];
          room.scores = [
            clampInt(rawScores[0], 0, cap),
            clampInt(rawScores[1], 0, cap),
          ];
          room.inPlay = msg.live === true;
          room.matchOver = room.scores[me] >= cap || room.scores[cpuIdx] >= cap;

          // Now the six frames, and the ONE rule that decides them: `watched_*`
          // is RAW (a watcher draws that player's court in that player's own
          // coordinates) and `opponent_*` is PRE-MIRRORED (it crosses the net).
          // A stray `1 - x` either way is invisible against a centred fixture,
          // which is why the suite that pins this uses an asymmetric one.
          const watchHost = watcherBeside(room, me);
          const watchCpu = watcherBeside(room, cpuIdx);
          if (watchHost) {
            watchHost.send(JSON.stringify({ type: 'watched_paddle', x: hostPaddle }));
            watchHost.send(JSON.stringify({ type: 'opponent_paddle', x: 1 - cpuPaddle }));
          }
          if (watchCpu) {
            watchCpu.send(JSON.stringify({ type: 'watched_paddle', x: cpuPaddle }));
            watchCpu.send(JSON.stringify({ type: 'opponent_paddle', x: 1 - hostPaddle }));
          }

          // The ball is a STATE — which half it is on, or nowhere — rather
          // than a crossing event, and that is what makes it correct by
          // construction. The CPU's serve materialises inside its own half and
          // the CPU's miss ends past its baseline: neither is a crossing, so a
          // design that emitted `watched_ball_left` only on one would leave
          // the watcher beside the CPU dead-reckoning a ghost ball off the
          // bottom of the screen after every point.
          const side = ball ? ball.side : null;
          const tellWatcher = (
            sock: WebSocket | null | undefined,
            seat: 0 | 1
          ): void => {
            if (!sock) return;
            if (side === seat && ball) {
              sock.send(JSON.stringify({ type: 'watched_ball', x: ball.x, y: ball.y }));
            } else {
              sock.send(JSON.stringify({ type: 'watched_ball_left' }));
              // The far half, in the SENDER's frame — the radar applies the
              // head-to-head mirror itself, exactly as it does in a duel.
              if (ball) sock.send(JSON.stringify({ type: 'opponent_ball', x: ball.x, y: ball.y }));
            }
          };
          tellWatcher(watchHost, me);
          tellWatcher(watchCpu, cpuIdx);
        } else if (msg.type === 'ball_cross_net' && currentRoomId && playerIndex() !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          // Nothing crosses the net between matches. Without this, countReturn
          // below kept counting after the final whistle: startMatchStreaks
          // opens the next match's PEAK on room.streaks, recordRoomMatch sends
          // that peak as bestStreak, and it lands in profile.highestRally — so
          // a spam loop between two matches wrote a permanent career best and
          // took the rally achievements and their cosmetics with it.
          // startMatch clears matchOver, so a rematch is unaffected.
          if (room.matchOver) return;
          // Same reason as point_scored below: a crossing from a lone socket
          // is not a rally. countReturn would bump room.bestStreaks, which
          // startMatchStreaks opens the NEXT match's peak on.
          if (!room.players[0] || !room.players[1]) return;
          room.lastActive = Date.now();
          // A ball over the net is the moment the terms stop being editable.
          room.inPlay = true;
          // A ball over the net from this seat is that player's return — and
          // it belongs to their streak alone. The serve is not one, which is
          // the only thing crossingsThisPoint is consulted for.
          // Read once into a local: the branch above already established this
          // is not null, but that is a call the compiler cannot narrow across.
          const crossingSeat = playerIndex();
          if (crossingSeat === null) return;
          countReturn(room, crossingSeat);
          // The relay is counting this match now, so it owns where the run and
          // the point are — and both phones are told to come off P2P, because
          // this crossing reaches the other one as a ball_incoming that its
          // replica never sees.
          takeOverFromP2P(room);
          // Deliberately NOT touching room.syncRev. That counter means one
          // thing — how far the PEERS' replica had got when it last reported —
          // and the relay counting its own crossings into it made two
          // independently advancing clocks share a number. A DataChannel does
          // not fail for both peers at the same instant: the one that notices
          // first relays its next crossing here, and the one that has not
          // noticed then sends a legitimate snapshot carrying the revision the
          // relay just took, which was refused as stale. It was not needed
          // either: a snapshot describing the moment BEFORE this crossing
          // carries the revision already applied, which the `<=` check in
          // applyMatchSync rejects on its own.

          const me = playerIndex() as 0 | 1;
          const oppIdx = me === 0 ? 1 : 0;
          sendAll(viewersOf(room, oppIdx), {
            type: 'ball_incoming',
            ball: transformBallForOpponent(msg.ball),
          });
          // The ball has left this half. The watcher on this side has no
          // physics to run it out with, so it is told outright rather than
          // left drawing a ball that is no longer there.
          const mine = watcherBeside(room, me);
          if (mine) mine.send(JSON.stringify({ type: 'watched_ball_left' }));
        } else if (msg.type === 'point_scored' && currentRoomId && playerIndex() !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          // The match is decided; there is no further point to report. The
          // score was unbounded, so `decided` stayed true and every subsequent
          // message re-ran recordRoomMatch — about thirty synchronous SQLite
          // queries each, on the loop that serves every other match.
          if (room.matchOver) return;
          // ...and there is no match in an empty room. Gameplay from a socket
          // sitting alone was scored into `room.scores`, which no seat change
          // resets, so a host could drive the score to one short of the cap
          // while seat 1 stood empty and land the decisive point the instant
          // any stranger sat down: measured, a real ranked LOSS (25.000 ->
          // 22.372) filed against a player who had done nothing but join, and
          // a free ranked win for the host. A room with one player in it has
          // nothing to report about a match.
          if (!room.players[0] || !room.players[1]) return;
          room.lastActive = Date.now();

          // A point can be won off a serve that never crossed, so this is the
          // other way a match becomes live.
          room.inPlay = true;
          // msg.scorer is either 'p1' or 'p2'
          const scorerIndex = msg.scorer === 'p1' ? 0 : 1;
          room.scores[scorerIndex]++;

          // Next server
          const nextServer: 0 | 1 = scorerIndex === 0 ? 1 : 0;
          // The scorer's OPPONENT is the one who let the ball past, so theirs
          // is the only streak that ends here. The scorer's runs on into the
          // next point — a rally streak is never decided by the other player.
          breakStreakOnPoint(room, scorerIndex, nextServer);
          takeOverFromP2P(room); // see the note beside countReturn above
          // Both phones end the match on this same number, so neither is left
          // playing on alone. Votes from before the final point are dropped:
          // a rematch is agreed about a match that is actually finished.
          const decided = room.scores[scorerIndex] >= room.config.winningScore;
          if (decided) {
            room.matchOver = true;
            room.rematchVotes = [false, false];
          }

          broadcast(room, {
            type: 'score_update',
            p1Score: room.scores[0],
            p2Score: room.scores[1],
            reason: `Point to ${room.players[scorerIndex]?.playerName || `Player ${scorerIndex + 1}`}`,
            nextServer,
          });

          // The score is out first — the DB write must never delay the point
          // both phones are waiting on — and the result follows it.
          if (decided) recordRoomMatch(room);
        } else if (msg.type === 'match_sync' && currentRoomId && playerIndex() !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          // A snapshot is a REPLICA's account of a match the relay did not
          // see, and only a peer that negotiated a DataChannel has one. On a
          // table where no offer was ever relayed there is no replica, so this
          // is just a client asserting a score — and applyMatchSync takes the
          // score as a maximum and will declare the match decided on it. One
          // message naming the winning score for your own seat therefore filed
          // a real ranked win for the sender and a real ranked loss for an
          // opponent whose client never rendered it, since match_sync
          // broadcasts no score_update.
          //
          // The scores are deliberately NOT step-limited instead: a snapshot
          // is absolute rather than a delta and is applied as a maximum by
          // design, because a P2P relay never sees the intervening points — so
          // capping the advance leaves a legitimate match undecidable. The
          // authority check is the honest boundary; the arithmetic is not.
          if (!room.p2pOffered) return;
          room.lastActive = Date.now();
          // Whether this call is about to start a NEW match — the peers
          // agreeing a rematch between themselves inside applyMatchSync,
          // rather than through start_match/rematch_request. Checked before
          // the call so a genuine change is unambiguous.
          const seqBefore = room.matchSeq;
          // Deliberately silent: in a P2P match both phones already have this
          // score from each other, so echoing it back would be a second
          // score_update arriving a round-trip late, mid-serve.
          // Recording is the caller's job now: server/room.ts stays free of
          // the database so its guards can be tested without one.
          const synced = applyMatchSync(room, playerIndex() as 0 | 1, msg);
          if (room.matchSeq !== seqBefore) duelStartRatings(room); // see the note there
          if (synced.decided) recordRoomMatch(room);
        } else if (msg.type === 'quick_chat' && currentRoomId && playerIndex() !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();

          const me = playerIndex() as 0 | 1;
          const oppIdx = me === 0 ? 1 : 0;
          const sender = room.players[me];
          // Sender name from server-side session state only — a client
          // message can't impersonate another username.
          const senderName = sender?.playerName || `Player ${me + 1}`;

          // A bubble is a fact about the table, so everyone at it sees it —
          // except the sender, who already drew their own.
          sendAll([...viewersOf(room, oppIdx), watcherBeside(room, me)].filter(Boolean) as WebSocket[], {
            type: 'quick_chat',
            text: String(msg.text || '').slice(0, 100),
            senderName,
            senderIdx: me,
          });
        } else if (msg.type === 'rtc_signal' && currentRoomId && playerIndex() !== null) {
          // Pure pass-through: the server never inspects SDP or candidates,
          // it only ferries them between the two members of the room.
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();

          // A watched table is a RELAYED table, and this is the boundary that
          // makes that true rather than hoped for. Peer-to-peer play never
          // reaches the relay at all — paddles, balls and points all travel
          // the DataChannel — so a watcher at a P2P table would sit in front
          // of a frozen court. The client declines to offer a connection when
          // seats are open, but a client is a hint; the relay is the ONLY
          // signaling path, so refusing here is what a modified client cannot
          // get past. Silent: the offer simply never arrives, which is the
          // case p2p.ts already falls back from.
          if (room.config.spectators) return;
          // And a CPU table has no peer at all: the far half is simulated by
          // the host's own client, so there is nothing on the other end of a
          // DataChannel. The client does not offer one, but a client is a
          // hint and the relay is the only signalling path.
          if (room.config.cpu) return;

          const me = playerIndex() as 0 | 1;
          // Validates the payload and records what it advances of the
          // handshake; see Room.p2pOffered for why one seat's signal is not
          // enough to arm match_sync. A payload that is not one of the three
          // kinds is not a signal and is not forwarded.
          if (!acceptRtcSignal(room, me, msg.payload)) return;

          const oppIdx = me === 0 ? 1 : 0;
          const opponent = room.players[oppIdx];
          if (opponent?.ws && opponent.ws.readyState === WebSocket.OPEN) {
            opponent.ws.send(
              JSON.stringify({ type: 'rtc_signal', payload: msg.payload, fromIdx: me })
            );
          }
        } else if (msg.type === 'player_ready' && currentRoomId && playerIndex() !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();
          const readySeat = playerIndex();
          if (readySeat === null) return;
          room.ready[readySeat] = !!msg.ready;
          broadcast(room, { type: 'ready_state', ready: room.ready });
        } else if (msg.type === 'start_match' && currentRoomId && playerIndex() !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();
          // Host-only, both seated, the guest has readied, and nothing has
          // been played yet — rematches go through the two-vote handshake.
          // The other playing seat is either a person who has said yes, or a
          // CPU the host put there — and seating the CPU IS the yes, in the
          // same way `seatQueuePair` treats queueing as one. That is why the
          // CPU lives in `config` rather than in `ready`: a machine's consent
          // written into the slot a person uses would be a forged token, and
          // `set_room_config` clears that slot every time the host edits the
          // terms, which would disarm Start with no error and nothing to press.
          const oppIdx = 1;
          const opponentReady = room.config.cpu
            ? !room.players[oppIdx]
            : !!room.players[oppIdx] && room.ready[oppIdx];
          const canStart =
            playerIndex() === 0 &&
            !!room.players[0] &&
            opponentReady &&
            !room.inPlay &&
            !room.matchOver;
          if (!canStart) return;
          startMatch(room, 0);
        } else if (msg.type === 'set_room_config' && currentRoomId && playerIndex() !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();
          // The host owns the terms, and only while nothing is being played:
          // the guest cannot edit them, and neither side can change the ball
          // out from under a rally. Before the first serve and after the last
          // point, the settings are open.
          // A queue table's terms are fixed and disclosed BEFORE anybody
          // joins the queue, which is the whole reason skipping the ready
          // handshake is sound there. Refusing here keeps that premise true by
          // construction rather than by everyone remembering it.
          const between = !room.inPlay || room.matchOver;
          if (room.venueRoomId === MATCHMAKING_ROOM || playerIndex() !== 0 || !between) {
            ws.send(JSON.stringify({ type: 'room_config', config: room.config }));
            return;
          }
          const watchedBefore = room.config.spectators;
          const next = roomConfigFor(room.venueRoomId, msg.config, cookieDeviceId);
          // The seat holds ONE of them. Left alone, a host who seats a machine
          // while a guest is already sitting there wedges the table: once a
          // CPU is named `canStart` asks for an EMPTY opposite seat, so Start
          // would refuse with no error and no control to press — the same
          // silent-nothing failure the parallel-`Room.cpu` design was rejected
          // for. The chair's actual occupant wins; a host who wants the
          // machine has to watch the person leave first.
          //
          // Not in roomConfigFor, deliberately: that function is about the
          // TABLE'S terms and knows nothing about who is currently sitting at
          // it, and create_room has no second seat to check.
          if (next.cpu && room.players[playerIndex() === 0 ? 1 : 0]) next.cpu = null;
          room.config = next;
          broadcast(room, { type: 'room_config', config: room.config });
          // Closing the seats closes them on whoever is in them. The host owns
          // the terms, and "no spectators" is not a term that can be true while
          // two people are watching.
          if (watchedBefore && !room.config.spectators) ejectSpectators(room, 'spectator seats closed');
          // And OPENING them ends any peer-to-peer link, since a P2P match
          // never reaches the relay and so cannot be watched. Deliberately
          // endP2P and not takeOverFromP2P: the relay has counted nothing
          // here, and claiming it had would make applyMatchSync discard the
          // peers' true streaks and peaks — which are maxima, so permanent.
          if (!watchedBefore && room.config.spectators) endP2P(room);
          broadcastTableState(room);
          // The guest readied under the OLD terms; new terms need a new yes.
          if (room.ready[1]) {
            room.ready = [false, false];
            broadcast(room, { type: 'ready_state', ready: room.ready });
          }
        } else if (msg.type === 'rematch_request' && currentRoomId && playerIndex() !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();
          // A vote only means anything once the room agrees the match is done.
          if (!room.matchOver) return;
          const voteSeat = playerIndex();
          if (voteSeat === null) return;
          room.rematchVotes[voteSeat] = true;

          // A CPU table has one voter, and without this the SECOND match at
          // one can never start: the room stays matchOver at its final score
          // forever, `point_scored` is refused, and every watcher sees a
          // frozen scoreboard. Play Again is the most common thing a solo
          // player does, so this is not an edge case.
          const bothAgreed = room.config.cpu
            ? !!room.players[0] && !room.players[1]
            : room.rematchVotes[0] && room.rematchVotes[1] && !!room.players[0] && !!room.players[1];
          if (bothAgreed) {
            // Agreed: fresh match, the other side opens this time.
            startMatch(room, room.servingPlayer === 0 ? 1 : 0);
          } else {
            broadcast(room, { type: 'rematch_state', votes: room.rematchVotes });
          }
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
        } else if (msg.type === 'leave_room') {
          // Declared in the protocol and sent by the client since forever, and
          // handled nowhere: the relay only ever learned about a departure from
          // the socket close that happens to follow it. That worked, but it
          // made a documented message a no-op and left the room's cleanup
          // depending on a side effect. Leaving is now its own event, and the
          // close that follows finds the seat already empty.
          vacateSeat();
        }
      } catch (err) {
        console.error('WS Error:', err);
      }
    });

    /**
     * Empty a seat, however the player left it.
     *
     * Both ways in are the same event as far as the room is concerned: an
     * explicit `leave_room`, and the socket simply dying. Keeping one
     * implementation is what stops them judging an abandon differently —
     * quitting a live duel IS an abandon, and a player who walks out must not
     * get a better outcome than one whose phone died.
     */
    const vacateSeat = (): void => {
      if (!currentRoomId || !seat) return;
      const room = rooms.get(currentRoomId);
      if (!room) return;

      // A WATCHING seat leaves before any of the below is even computed, and
      // the early return is the point rather than an optimisation.
      //
      // `abandoned` is bothSeated && inPlay && !matchOver && currentPlayerId,
      // and every one of those four is true of a spectator closing a tab
      // mid-rally. Folded in as another `&&` this would call recordRoomMatch
      // with a watcher's SLOT standing in for a seat index: a real ranked
      // LOSS written to a player who did nothing, plus an abandon charged to
      // the watcher's own device. persistDuelStreaks does not save you from
      // it either — its own guard is `!inPlay || matchOver`, so mid-rally it
      // runs and writes both players' runs from a non-event.
      //
      // Nothing else here applies to a watcher: `ready` and `rematchVotes`
      // are indexed by PLAYING seat, `opponent_left` is false (the players
      // lost nobody), `soloSince` must not move (see below), and the table
      // does not die because somebody stopped watching it.
      if (seat.role === 'spectator') {
        if (room.spectators[seat.slot]?.ws === ws) room.spectators[seat.slot] = null;
        currentRoomId = null;
        seat = null;
        broadcastTableState(room);
        return;
      }

      const mine = seat.index;
      // Guard against running twice: `leave_room` is followed by the client
      // closing its socket, so the close handler arrives moments later. The
      // seat is already empty by then, and re-running would count a second
      // abandon for one departure.
      // Filled AND ours. The spectator branch above has always checked
      // `?.ws === ws`; this one only asked whether the seat was occupied, so
      // it would have run the whole abandon computation against a seat that
      // now belongs to somebody else. Not reachable today — a socket's own
      // `seat` is cleared the moment it gives one up — but the two branches
      // answering the same question differently is how the next path in
      // becomes a real one, and this is the branch that files a ranked loss.
      if (room.players[mine]?.ws !== ws) return;

      // A socket dying with a live, undecided ball is an abandon — the
      // opponent was denied a match they were in the middle of. Judged
      // BEFORE the seat empties, from state the relay owns: a client can
      // never report one, and the second player's departure from an
      // already-abandoned room records nothing.
      const bothSeated = !!(room.players[0] && room.players[1]);
      // ...and not when WE are the reason the socket closed. Falling through
      // leaves the persistDuelStreaks branch below, which is exactly the
      // "this departure records no match" case a deploy should take.
      const abandoned =
        bothSeated && room.inPlay && !room.matchOver && !!currentPlayerId && !shuttingDown;
      if (abandoned) {
        try {
          // Same rule as recordRoomMatch: a seat that no longer holds
          // its account has no profile to charge — and when the relay
          // itself closed that socket to displace it, charging the
          // player an abandon for our own eviction would be perverse.
          const verdict = seatStillHoldsAccount({
            deviceId: currentPlayerId!,
            sessionId: cookieSessionId,
          })
            ? db.recordAbandon(currentPlayerId!)
            : null;
          // An abandoned duel is a match both players PLAYED, and walking out
          // of it is losing it: the leaver takes a real loss and the survivor
          // a real win, at the standing score, before the seat empties so the
          // room is still whole. The old shape — a flat rating penalty and no
          // match anywhere — let a player quit every losing duel and keep a
          // 100% win rate while their opponents' wins evaporated with them.
          // The day's first abandon is forgiven ON THE RATING ONLY: the
          // leaver's copy records un-ranked, the facts record regardless, and
          // the survivor's win rates on its own merits either way. Streaks
          // ride the same records (persistDuelStreaks is for endings that
          // record no match), and the shared matchKey keeps any racing client
          // POST a no-op.
          recordRoomMatch(room, {
            winnerSeat: mine === 0 ? 1 : 0,
            forgivenLoss: verdict?.forgiven ?? false,
          });
          room.matchOver = true;
        } catch (e) {
          console.error('abandon record failed:', e);
        }
      } else {
        // No match to record from this departure (lobby leave, a finished
        // match, an already-abandoned room) — but both players' runs still
        // stand wherever the last crossing left them, and this is the one
        // moment to keep them. Internally guarded to the live-match case.
        persistDuelStreaks(room);
      }
      room.players[mine] = null;
      room.rematchVotes[mine] = false;
      room.ready[mine] = false;
      const oppIdx = mine === 0 ? 1 : 0;
      const opp = room.players[oppIdx];
      if (opp?.ws && opp.ws.readyState === WebSocket.OPEN) {
        opp.ws.send(JSON.stringify({ type: 'opponent_left' }));
      }
      if (!room.players[0] && !room.players[1]) {
        rooms.delete(currentRoomId);
        // The table is gone, so nobody is watching it. A watcher left attached
        // to a room no longer in the map would sit on a court whose every
        // message the relay silently drops.
        ejectSpectators(room, 'table closed');
      } else {
        // One player left in it. That is a room with nobody to play against,
        // however busy the survivor keeps it, so the clock starts again.
        room.soloSince = Date.now();
        // ...and the table goes back to being a lobby for whoever sits down
        // next. AFTER the abandon above, which reads the score. swap_seat has
        // always done most of this; vacateSeat did only the handshake, and
        // every field it left standing was read as the next pair's — see
        // resetTableForNextPair for what each one cost.
        resetTableForNextPair(room, mine);
        broadcastTableState(room);
      }
      currentRoomId = null;
      seat = null;
    };

    ws.on('close', () => vacateSeat());
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    // Imported lazily so the production bundle never loads (or ships) vite
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // The bundled server.cjs lives inside dist/ next to the client files, so
    // prefer its own directory — this makes `node /path/to/dist/server.cjs`
    // work from any cwd. Fall back to cwd/dist for unbundled runs.
    const bundleDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    const distPath = fs.existsSync(path.join(bundleDir, 'index.html'))
      ? bundleDir
      : path.join(process.cwd(), 'dist');
    // ONLY /assets and a NAMED LIST of root files are served. Mounting the
    // whole of dist/ published `server.cjs.map` — a 667KB source map carrying
    // `sourcesContent`, so every line of server.ts, server/auth.ts and
    // server/db.ts was a public GET, cookie HMAC construction and session
    // gates included — plus server.cjs, admin.cjs and moderate.cjs beside it.
    //
    // There IS a public/ dir now (Vite copies it into dist/), which is exactly
    // the change that would tempt someone to mount the directory and undo
    // that. It does not: the four files a browser asks for at the root are
    // listed by name below, and everything else at the root still falls
    // through to the SPA handler. An allowlist rather than a denylist, because
    // the next build output added to dist/ must not become public by default.
    //
    // The hashed assets under /assets are immutable and may be cached hard;
    // index.html must NOT be, or a client told its session is stale would
    // reload straight back onto the build it was already running and the deploy
    // would never reach it. It is served by the app.get('*') handler below,
    // which sets that header itself — so this mount needs no setHeaders at all.
    app.use(
      '/assets',
      express.static(path.join(distPath, 'assets'), {
        immutable: true,
        maxAge: '1y',
      })
    );
    // The root files a browser and a link preview ask for by name. The
    // favicon and the og image are hashed by nothing, so they are cached for a
    // day rather than a year: a wrong icon that cannot be corrected for twelve
    // months is the failure mode on the other side.
    //
    // Read ONCE, at boot, and served from memory — no file system access per
    // request at all. The first version did `fs.existsSync` and then
    // `sendFile` on every hit, and CodeQL was right to flag it: an
    // unauthenticated, unmetered handler doing file I/O is an amplifier. The
    // fix is not a rate limit, because rate-limiting a favicon breaks the
    // browsers and link previews it exists for. It is to stop touching the
    // disk: `existsSync` in particular is SYNCHRONOUS, on the one event loop
    // that is also relaying `paddle_move` for every live match, so this is a
    // real improvement rather than an alert quieted.
    //
    // Four small files, so holding them costs a few KB. Express computes an
    // ETag for a buffer body, so conditional requests still get their 304.
    const ROOT_FILE_TYPES: Record<string, string> = {
      '/favicon.svg': 'image/svg+xml',
      '/og.svg': 'image/svg+xml',
      '/manifest.webmanifest': 'application/manifest+json',
      '/robots.txt': 'text/plain; charset=utf-8',
    };
    const rootFiles = new Map<string, Buffer>();
    for (const route of Object.keys(ROOT_FILE_TYPES)) {
      try {
        rootFiles.set(route, fs.readFileSync(path.join(distPath, path.basename(route))));
      } catch {
        // A build without one of these is a 404 rather than a boot failure:
        // the game does not need a favicon to be playable, and falling through
        // to the SPA handler would answer /robots.txt with HTML.
        console.warn(`[static] ${route} is missing from the build`);
      }
    }
    app.get(Object.keys(ROOT_FILE_TYPES), (req, res) => {
      const body = rootFiles.get(req.path);
      if (!body) return res.status(404).end();
      res.setHeader('Content-Type', ROOT_FILE_TYPES[req.path]);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(body);
    });

    // The SPA handler, and the same treatment for the same reason: it answers
    // every unmatched GET — every deep link, every 404, every crawler — and
    // read the file off disk each time.
    //
    // Reading it once is safe precisely BECAUSE of the no-cache header's
    // reason: index.html is served no-cache so a client told its session is
    // stale reloads onto the new build rather than back onto the old one. A
    // new build is a new PROCESS (server/build.ts hashes the artifacts to
    // decide exactly that), so the file cannot change under a running one.
    const indexHtml = fs.readFileSync(path.join(distPath, 'index.html'));
    app.get('*', (req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(indexHtml);
    });
  }

  /**
   * The last handler, for anything no route caught.
   *
   * Express's default error handler answers with the stack trace in
   * development and, more importantly, leaves an unhandled synchronous throw
   * with no JSON shape at all — so a client parsing the body gets a parse
   * error instead of a status it can act on. Registered AFTER every route and
   * after the static mounts, which is the only place a four-argument handler
   * works.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    serverError(res, err);
  });

  // The leaderboard's pace-setters. One-shot and flagged in the DB, so this
  // is a no-op on every boot after the first — it lives here rather than in
  // the schema migrations because a curated roster is a deployment decision,
  // not a shape the database needs to be correct.
  db.seedBotRoster(BOT_ROSTER);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Split-Screen Half Pong server running at http://0.0.0.0:${PORT}`);
    // Say which file this process is actually persisting to, and how much is
    // already in it. An unmounted volume is otherwise completely silent: the
    // Dockerfile mkdir's /data as well as setting DATA_DIR, so a missing mount
    // leaves a writable directory in the image layer and the server starts
    // from zero players without a word. "0 players" in the log on a server
    // that had thousands is a five-second diagnosis; nothing was a permanent
    // loss discovered later.
    try {
      const d = db.describe();
      console.log(
        `[db] ${d.file} — ${(d.bytes / 1024).toFixed(0)}KB, ` +
          `${d.humans} account(s), ${d.players} row(s) incl. bots`
      );
      if (process.env.NODE_ENV === 'production' && d.humans === 0) {
        console.warn(
          '[db] WARNING: no accounts in this database. If this is not a first ' +
            'boot, DATA_DIR is not pointing at the volume you think it is.'
        );
      }
    } catch (e: any) {
      console.error('[db] could not describe the datastore:', e?.message);
    }
  });

  // Render stops the old instance on every deploy of a disk-backed service;
  // close sockets and the listener cleanly instead of dying mid-request.
  const shutdown = (signal: string, code = 0) => {
    // Re-entrant guard first of all: a fatal raised while we are already
    // shutting down must not restart the whole dance, and the shutdown path
    // itself is what would raise it.
    if (shuttingDown) return;
    // Before a single socket is closed: every close below runs vacateSeat.
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    for (const client of wss.clients) {
      client.close(1001, 'Server restarting');
    }
    wss.close();
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  fatalShutdown = shutdown;
}

/**
 * The last resort, and it EXITS. Set by startServer once the listener exists.
 *
 * These two handlers first shipped as bare `console.error`, on the reasoning
 * that a single-instance relay holding every room in memory should keep
 * serving the other matches rather than die on one socket's fault. That
 * reasoning was answering the wrong question: the thing it was written for —
 * one malformed frame ending the process — is closed by the `error` listeners
 * on `ws` and `wss`, where the fault has a known owner. What was left here was
 * a handler that suppresses Node's default termination for faults that have no
 * owner at all, and resuming after one of those is documented as unsafe
 * because the process may be halfway through a mutation.
 *
 * It is not hypothetical here. The room reaper's interval calls
 * `persistDuelStreaks(room)` unguarded, AFTER `reapRooms` has already deleted
 * rooms from the map — so a throw there (a full disk, a volume remounted
 * read-only) aborts the sweep with rooms gone and their sockets never closed,
 * and the old handler kept the process serving in exactly that state. Worse,
 * a process that never exits is one Docker's `restart: unless-stopped` and
 * Dokploy's supervisor cannot recover: the crash-and-restart they exist for
 * was being suppressed.
 *
 * So: log, then take the SAME controlled shutdown a SIGTERM takes, and exit
 * non-zero. Going through `shutdown` rather than `process.exit` directly is
 * what makes this safe for the players: it sets `shuttingDown` first, so the
 * close of every live socket falls through to `persistDuelStreaks` instead of
 * charging both seats of every duel in progress an abandon. A crash costs the
 * match; it must not also cost the rating.
 */
let fatalShutdown: ((signal: string, code?: number) => void) | null = null;
const onFatal = (label: string) => (err: unknown) => {
  console.error(`[fatal] ${label}:`, err);
  if (fatalShutdown) fatalShutdown(label, 1);
  else process.exit(1);
};
process.on('uncaughtException', onFatal('uncaught exception'));
process.on('unhandledRejection', onFatal('unhandled rejection'));

startServer().catch((err) => {
  console.error('[fatal] server failed to start:', err);
  process.exit(1);
});
