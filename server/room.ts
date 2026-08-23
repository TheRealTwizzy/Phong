import type { WebSocket } from 'ws';
import { RoomMatchConfig } from '../src/types';

// The relay's room: what a duel IS, and the rules both phones are held to.
//
// Split out of server.ts so it can be tested without booting a process. The
// rules in here are the ones a client cannot be trusted with — a P2P match
// scores over a DataChannel and reports the result with match_sync, so
// applyMatchSync is taking a score from an untrusted peer and deciding what
// the room believes. That code was reachable only through a spawned server,
// and its adversarial cases had no test at all.
//
// Nothing here touches the database or a socket. Sending stays the caller's
// job: startMatch returns the game_start payload to broadcast, and
// applyMatchSync reports whether the match just became recordable rather than
// recording it itself. That is what keeps this module pure, and pure is what
// makes it testable.

export interface PlayerSession {
  ws: WebSocket;
  playerId: string;
  playerName: string;
  playerIndex: 0 | 1;
  /**
   * The device id the cookie actually verified, or null for a socket that
   * arrived without one. playerId falls back to a synthetic value so a room
   * still works; this does not — the relay records a finished duel onto real
   * profiles, and it must never invent one to do it.
   */
  deviceId: string | null;
  /**
   * The session that held the account when this socket was seated. The
   * upgrade check is a snapshot: ownership can move while the socket stays
   * open, and a displaced socket that keeps playing would have its result
   * written by the relay, which is the exploit again with extra steps.
   */
  sessionId: string | null;
}

export interface Room {
  id: string;
  players: (PlayerSession | null)[];
  scores: [number, number];
  rallyCount: number;
  maxRallyInMatch: number;
  servingPlayer: 0 | 1;
  rematchVotes: [boolean, boolean];
  /**
   * The terms both phones play by. The host owns them; the server normalizes
   * whatever arrives and is the only thing either client reads them from.
   */
  config: RoomMatchConfig;
  /**
   * Whether the room's current match has been decided. The server can tell,
   * now that it owns the winning score — which is what lets it refuse a
   * rematch vote from a match still in progress and re-open the settings
   * between matches.
   */
  matchOver: boolean;
  /**
   * The lobby handshake: the guest readies, and only then can the host start.
   * Cleared whenever the terms change — a guest readied under different rules
   * has not agreed to these — and reset by every match start.
   */
  ready: [boolean, boolean];
  /**
   * Whether a ball has actually been put in play since the last start. The
   * match "begins" when the guest joins, but nobody has served yet — so the
   * lobby is still open and the host can keep setting the terms. The first
   * ball over the net locks them.
   */
  inPlay: boolean;
  /**
   * Which match of this room is being played, counting from 1. A room outlives
   * every match in it, so this is what tells one from the next — it is how a
   * result reported late is matched to the match it came from instead of to
   * whatever the room holds by then, and it is half of the key each match is
   * recorded under (see duelMatchKey).
   */
  matchSeq: number;
  lastActive: number;
}

/** What a client is told when the room's match (re)starts. */
export interface GameStartPayload {
  type: 'game_start';
  servingPlayer: 0 | 1;
  config: RoomMatchConfig;
  matchSeq: number;
}

/**
 * Start (or restart) the room's match on terms both phones can see.
 *
 * Returns the payload to broadcast rather than sending it, so the rules can be
 * checked without a socket. The caller must broadcast it: a phone that is not
 * told has not started.
 */
export function startMatch(room: Room, servingPlayer: 0 | 1): GameStartPayload {
  room.scores = [0, 0];
  room.rallyCount = 0;
  room.maxRallyInMatch = 0;
  room.rematchVotes = [false, false];
  room.servingPlayer = servingPlayer;
  room.matchOver = false;
  room.inPlay = false;
  room.ready = [false, false];
  room.matchSeq += 1;
  // The config rides along with every start: a phone can never begin a match
  // on terms it has not been told, however it arrived in the room. So does the
  // sequence number, so both phones can name the match they are playing when
  // they report its result.
  return {
    type: 'game_start',
    servingPlayer,
    config: room.config,
    matchSeq: room.matchSeq,
  };
}

/** Whole number from an untrusted client field, held inside [lo, hi]. */
export function clampInt(value: unknown, lo: number, hi: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Fold a P2P duel's own account of itself back into the room.
 *
 * A P2P match scores over the DataChannel, so none of it passes through here:
 * the relay saw a room that was still 0-0 and had never started. That was not
 * merely a blind spot — /api/match/record cross-checks a duel against room
 * state, so it overwrote every P2P result with 0-0 and filed BOTH players a
 * loss, which is why a P2P win never counted toward "win a match".
 *
 * The report is absolute rather than a delta, and applied as a maximum, so a
 * lost message heals on the next one and a duplicate changes nothing. Both
 * peers send it and both agree — the replica in src/net/p2p.ts runs the relay's
 * own scoring rules — so neither phone depends on the other's report arriving.
 * It is no more trusted than a point_scored: gameplay is client-authoritative
 * either way (see CLAUDE.md §5), and the scores are still held inside the
 * room's own winning score.
 *
 * Returns whether this sync is what decided the match, so the caller can
 * record it. Recording from in here would drag the database into a module
 * whose whole value is that it does not need one.
 */
export function applyMatchSync(
  room: Room,
  sync: { matchSeq: number; p1Score: number; p2Score: number; maxRally: number }
): { decided: boolean } {
  // Nothing to sync before the host has started a match: the replica only
  // reports from game_start onward, so a sync arriving in a lobby is noise.
  if (room.matchSeq < 1) return { decided: false };
  const seq = Math.floor(Number(sync.matchSeq));
  if (!Number.isFinite(seq) || seq < room.matchSeq) return { decided: false };
  // A match can only be superseded by one that follows a finished match —
  // the same rule the relay applies to a rematch vote. Without it, a phone
  // naming a match number out of thin air could blank a live room's score and
  // take the result away from the other player.
  if (seq > room.matchSeq && !room.matchOver) return { decided: false };
  if (seq > room.matchSeq) {
    // The peers agreed a rematch between themselves, so the relay never ran
    // startMatch for it. Adopt their numbering and start the match over here,
    // or the new match's scores would read as a regression and be ignored.
    room.matchSeq = seq;
    room.scores = [0, 0];
    room.rallyCount = 0;
    room.maxRallyInMatch = 0;
    room.matchOver = false;
    room.rematchVotes = [false, false];
    room.ready = [false, false];
  }
  if (room.matchOver) return { decided: false };

  const cap = room.config.winningScore;
  room.scores = [
    Math.max(room.scores[0], clampInt(sync.p1Score, 0, cap)),
    Math.max(room.scores[1], clampInt(sync.p2Score, 0, cap)),
  ];
  room.maxRallyInMatch = Math.max(room.maxRallyInMatch, clampInt(sync.maxRally, 0, 100000));
  room.inPlay = true;

  if (room.scores[0] >= cap || room.scores[1] >= cap) {
    room.matchOver = true;
    room.rematchVotes = [false, false];
    room.servingPlayer = room.scores[0] >= cap ? 1 : 0;
    return { decided: true };
  }
  return { decided: false };
}

/**
 * TrueSkill-2 style performance weight from SERVER-OBSERVED data only.
 * Dominating (5-0) counts for a little more than scraping through (5-4), and
 * a loser who sustained long rallies is punished a little less. Deliberately
 * bounded so it nudges the rating rather than driving it.
 */
export function performanceWeight(myScore: number, oppScore: number, maxRally: number): number {
  const total = myScore + oppScore;
  if (total <= 0) return 1;
  const margin = (myScore - oppScore) / total; // -1..1
  const rallyQuality = Math.min(1, maxRally / 20); // 0..1
  const weight = 1 + 0.3 * margin + 0.15 * (rallyQuality - 0.5);
  return Math.max(0.5, Math.min(1.5, weight));
}

/**
 * A 4-letter room code a player can read off one phone and type into another.
 *
 * The alphabet drops 0/O and 1/I deliberately: the code is transcribed by a
 * human looking at a small screen, and those are the pairs they get wrong.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += ROOM_CODE_ALPHABET.charAt(Math.floor(Math.random() * ROOM_CODE_ALPHABET.length));
  }
  return code;
}
