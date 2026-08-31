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

/**
 * Somebody watching a table rather than playing at it.
 *
 * Deliberately NOT a PlayerSession with a flag, and deliberately without a
 * field called `playerIndex`: a name like that is how a spectator's slot
 * eventually gets passed to something that indexes `streaks`, `ready`,
 * `rematchVotes` or a seat rating — every one of which is a two-element array
 * about the two people actually playing. The slot is `side`, it says only
 * which player is being watched, and it is derived from the seat taken rather
 * than read off a message.
 *
 * It keeps deviceId/sessionId not because a spectator is ever recorded — it
 * never is, on either profile — but because evictStaleSockets,
 * closeDisplacedSockets and closeAccountSockets walk the live socket set and
 * must be able to evict a watching socket for the same reasons they evict a
 * playing one.
 */
export interface SpectatorSession {
  ws: WebSocket;
  playerId: string;
  playerName: string;
  /** Which player this seat sits beside. Derived from the slot, never sent. */
  side: 0 | 1;
  deviceId: string | null;
  sessionId: string | null;
}

export interface Room {
  id: string;
  players: (PlayerSession | null)[];
  scores: [number, number];
  /**
   * A rally streak per SEAT: that player's own consecutive successful returns,
   * broken only when THAT player fails to return one. See StreakState.
   */
  streaks: [number, number];
  bestStreaks: [number, number];
  /**
   * The same runs counted from ZERO at the start of this match — the work
   * actually done here. bestStreaks opens on what each seat carried in, which
   * is right for a career best and wrong for a reward: XP is paid per rally,
   * so a carried run would be paid for again in every match it spans.
   */
  earnedStreaks: [number, number];
  earnedBests: [number, number];
  /**
   * Balls over the net since the last point. Only ever consulted to answer
   * "was that the serve?", which is a question about the first crossing of a
   * point by whoever is serving.
   */
  crossingsThisPoint: number;
  /**
   * The highest P2P snapshot revision applied to the CURRENT match.
   *
   * Both peers report every crossing, over two separate sockets, and the
   * fields saying where a run IS are assigned rather than maxed — they have to
   * be, since a run legitimately falls to zero. A snapshot arriving BEHIND one
   * already applied would therefore lower a live run back to a value the rally
   * has passed, and a fallback to the relay in that window would resume from
   * it. The peers process the same events in the same order, so their
   * revisions mean the same thing and either one's is good for the pair.
   */
  syncRev: number;
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
   * Whether BOTH seats have taken part in a WebRTC handshake for this table.
   *
   * match_sync is a REPLICA's account of a match the relay never saw, so it is
   * only meaningful from a peer that has one — and a peer only has one once
   * the DataChannel was negotiated, which can only happen through rtc_signal
   * here. On a table where that never happened there is no replica, and a
   * snapshot is simply a client asserting a score.
   *
   * "An offer was relayed" is NOT enough, and shipping it that way was the
   * bug: a seated attacker on an otherwise relayed table could send one
   * rtc_signal — any payload at all, an empty object included — arm this, and
   * then forge a decisive snapshot, filing a real ranked loss against an
   * opponent whose client never rendered a thing. One preparatory frame,
   * needing nothing from the victim. A handshake takes TWO seats and the relay
   * stamps which one each signal came from, so an offer from one seat and an
   * answer from the other is a thing a lone socket cannot manufacture.
   *
   * It narrows rather than closes, and the difference is worth stating: on a
   * table where the victim's own client IS negotiating P2P, this becomes true
   * legitimately and a modified peer can still lie in a snapshot. That is the
   * client-authoritative trade the trust model already documents. What this
   * removes is the case where the victim was never party to a DataChannel at
   * all — a spectated table, a client with P2P off, a browser without WebRTC.
   *
   * Kept across a transport fallback, because a link that opens and dies leaves
   * a peer that legitimately still holds the replica it built — that is the
   * one-sided fallback relayCounted exists for, and it must keep working. But
   * it belongs to the PAIR that negotiated it, not to the table: a room
   * outlives its occupants, so one left set forever meant a player could leave,
   * a stranger take the empty seat, and that newcomer forge a snapshot against
   * a victim who was never party to any DataChannel — the original exploit
   * back, needing only that somebody once played P2P here. clearP2PEvidence
   * resets it whenever a playing seat empties or changes hands.
   */
  p2pOffered?: boolean;
  /** The seat whose valid `offer` was relayed, if any. See p2pOffered. */
  rtcOfferFrom?: 0 | 1;
  /** The seat whose valid `answer` was relayed, if any. See p2pOffered. */
  rtcAnswerFrom?: 0 | 1;
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
  /**
   * Since when this room has had nobody to play against — null while both
   * seats are filled.
   *
   * Distinct from lastActive, which any traffic refreshes: a host sitting on
   * the court behind the lobby sheet streams paddle_move, so an idle clock
   * alone can never expire a room with one player in it.
   *
   * This started life as `pairedAt`, set once when a second player arrived and
   * deliberately never cleared, on the grounds that a room which HAS been a
   * duel is one a rematch can still happen in. That is true only while the
   * other player is still there. Once a guest leaves, the room is back to one
   * player and exempt from the clock that exists for exactly that — so an
   * unpaired room could be made simply by having a guest join and leave, which
   * is the leak the TTL was written to close.
   */
  soloSince: number | null;
  /**
   * Both seats' hidden ratings as they stood BEFORE this match was recorded,
   * and the matchSeq they were sampled for. Data only — the sampling itself
   * needs the database and so lives in server.ts (see duelStartRatings).
   *
   * A duel is recorded by two independent paths: the relay writes it the
   * moment the score decides it, and each phone POSTs its own copy as the
   * fallback for a match the relay never saw. Whichever commits first moves
   * that player's rating, so a path reading the opponent's rating live got a
   * post-match number and rated its seat against an opponent that had already
   * moved. Sampling once per match and sharing it makes the pair the same
   * whichever path gets there first — and keying it on matchSeq is what keeps
   * it honest across restarts, since every way a room begins a new match
   * (startMatch, and a rematch the peers agree between themselves in
   * applyMatchSync) advances that number.
   */
  startRatings: [SeatRating | null, SeatRating | null] | null;
  startRatingsSeq: number;
  /**
   * Whether the relay has counted a gameplay event for the CURRENT match —
   * a crossing or a point that arrived over the WebSocket rather than the
   * peers' DataChannel.
   *
   * A P2P snapshot is trustworthy because both peers run the same replica over
   * the same events in the same order. A fallback breaks that, and it breaks
   * it for ONE peer at a time: the peer that notices first relays its next
   * crossing, which the relay counts, while the other peer is told about it
   * only as a `ball_incoming` — a message its replica never sees. From that
   * moment its snapshots describe a match missing that return, and the fields
   * a snapshot ASSIGNS would put the relay back to it.
   *
   * A revision cannot catch that: the diverged peer's next revision is
   * genuinely later than anything it has sent, and the relay's own crossings
   * deliberately do not advance that counter (they are not the peers' events
   * to count). So the answer is not an ordering but an authority — once the
   * relay is counting, it owns where the run and the point are.
   *
   * Nothing is lost by it. A peer stops sending snapshots the moment it falls
   * back (`sendGame` returns false, so the replica never counts and never
   * syncs), so a snapshot arriving after this flag is set can only be from a
   * peer that is missing what the relay counted. The MAXED fields — scores and
   * the peaks — keep being applied, since a peer still scoring over its own
   * link knows things the relay does not, and a maximum cannot go backwards.
   */
  relayCounted: boolean;
  /**
   * The venue room this table sits in (`src/venues.ts`) — a PvP bracket, or
   * the hidden queue room. Normalized against a whitelist by the caller, never
   * taken as free client text: the browser is keyed on it, so an arbitrary
   * string would make that listing an unbounded index keyed on whatever a
   * caller sends.
   */
  venueRoomId: string;
  /**
   * Whether the room browser lists this table.
   *
   * `private` is today's invite-code table exactly, and it is the DEFAULT for
   * a `create_room` that names nothing — which is what keeps the invite flow,
   * old bundles and the test harness working unchanged. It is also the entire
   * security boundary protecting those tables: the listing is an
   * unauthenticated read of live room state, so a bug that lists a private
   * table makes every private room's 4-letter code harvestable.
   */
  visibility: 'public' | 'private';
  /**
   * The lock on a PRIVATE table: a 4-character key, and the only way in.
   *
   * Null while the table is public, because a public table needs no key — it
   * is in the room's browser and anyone in the bracket can sit down.
   *
   * A private table is deliberately NOT joinable by its room id. The id is
   * how the relay indexes the table and it appears in `GET /api/room/:id`;
   * if it also opened the door, the key would be decorative. Re-generated
   * every time the host turns Private on, so sharing a key is a decision that
   * can be taken back: the old one stops working the moment the lock is
   * re-set.
   */
  joinKey: string | null;
  /**
   * The two watching seats: slot 0 sits beside player 0, slot 1 beside
   * player 1.
   *
   * A PARALLEL array rather than a widened `players`, and that is the whole
   * design. `players[0]`/`players[1]` and the `playerIndex === 0 ? 1 : 0` that
   * falls out of them are load-bearing in every gameplay handler in server.ts
   * and in every function in this file — startMatch, applyMatchSync,
   * countReturn, breakStreakOnPoint, isRoomEmpty, performanceWeight — all of
   * which are about the two people playing. A four-seat array would put a
   * spectator's index within reach of all of them; a second array is reachable
   * by none of them.
   *
   * Whether a table HAS these seats is `config.spectators`, a term of the
   * match like the winning score, and a room whose venue forbids them has it
   * forced false server-side.
   */
  spectators: (SpectatorSession | null)[];
}

/**
 * A seat's TWO ratings, as src/rating.ts models them, sampled before the match.
 *
 * Both, because the two updates rate against different things: the hidden
 * estimator predicts the match and moves the hidden estimator, while the
 * visible ladder moves against the visible ladder. One pair standing in for
 * both is how a ranked duel came to be rated against a number drawn from the
 * other estimator — and the two genuinely diverge, by design: a solo match
 * moves mmrMu and never rankMu, SOLO_MU_CAPS caps one while AI_ADAPT_BAND
 * moves the other, and any match that is `ranked` but not `ranksThisMatch`
 * (a Rookie solo) moves the first and not the second.
 */
export interface SeatRating {
  mmr: { mu: number; sigma: number };
  rank: { mu: number; sigma: number };
}

/** What a client is told when the room's match (re)starts. */
export interface GameStartPayload {
  type: 'game_start';
  servingPlayer: 0 | 1;
  config: RoomMatchConfig;
  matchSeq: number;
  /**
   * The run each seat walks in on, [p1, p2]. A streak carries between matches
   * and between rooms, and the relay is the one that knows both — it seeds a
   * seat from the store when it is taken. Sent so a phone starts its match on
   * the same numbers the relay will record it on, and so the P2P replica,
   * which never sees another relay message all match, starts there too.
   */
  streaks: [number, number];
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
  startMatchStreaks(room, servingPlayer);
  room.rematchVotes = [false, false];
  room.servingPlayer = servingPlayer;
  room.matchOver = false;
  room.inPlay = false;
  room.ready = [false, false];
  room.matchSeq += 1;
  // Each match's snapshot revisions count from zero, so the last match's
  // high-water mark must not outlive it and reject all of this one's. And a
  // fresh match starts with the peers authoritative again: a fallback belongs
  // to the match it happened in.
  room.syncRev = 0;
  room.relayCounted = false;
  // The config rides along with every start: a phone can never begin a match
  // on terms it has not been told, however it arrived in the room. So does the
  // sequence number, so both phones can name the match they are playing when
  // they report its result.
  return {
    type: 'game_start',
    servingPlayer,
    config: room.config,
    matchSeq: room.matchSeq,
    streaks: [room.streaks[0], room.streaks[1]],
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
  sync: {
    matchSeq: number;
    p1Score: number;
    p2Score: number;
    bestStreaks: [number, number];
    streaks: [number, number];
    earnedBests: [number, number];
    servingPlayer: 0 | 1;
    crossingsThisPoint: number;
    rev: number;
  }
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
    startMatchStreaks(room, room.servingPlayer);
    room.matchOver = false;
    room.rematchVotes = [false, false];
    room.ready = [false, false];
    // A new match has had no ball in it yet. Left carrying the PREVIOUS
    // match's true, a player leaving during the countdown or before the
    // first serve is charged an abandon — and, past the daily forgiveness, a
    // ranked rating penalty — for a match nobody played. Our own client only
    // ever names a new matchSeq at that match's first crossing, by which
    // point this would be true anyway. This is the untrusted-peer boundary
    // though, and a seat that starts a new match here has not thereby put a
    // ball in play: what it claims and what it has done are separate.
    room.inPlay = false;
    // A new match's revisions start over, so the old high-water mark would
    // reject every snapshot of it. The peers agreed this rematch between
    // themselves, so their link is up and they are authoritative again.
    room.syncRev = 0;
    room.relayCounted = false;
  }
  if (room.matchOver) return { decided: false };

  const cap = room.config.winningScore;
  // A snapshot claiming BOTH seats at the winning score describes a match that
  // cannot exist. A replica stops at the first score to reach the cap — the
  // same rule this function applies at the bottom — so no honest peer can ever
  // report it.
  //
  // What made it worth guarding is what happened next. The two scores below
  // are clamped INDEPENDENTLY, so a snapshot of [999, 999] landed as
  // [cap, cap], reported the match decided, and recordRoomMatch's
  // `mine > theirs` was then false for BOTH seats: two ranked losses, two red
  // down-arrows and two loss rows filed off one malformed message, while each
  // phone's own score_update — which tests its own side first — showed them
  // both VICTORY.
  //
  // The whole snapshot is refused rather than repaired. This is the
  // untrusted-peer boundary, and a peer that is wrong about who won the match
  // is not a peer whose streaks, peaks or serving seat are worth taking
  // either. Refused BEFORE the revision is bumped, so it burns no revision a
  // legitimate snapshot might still want, and before inPlay can be set — the
  // same reasoning as the 0-0 guard further down.
  if (clampInt(sync.p1Score, 0, cap) >= cap && clampInt(sync.p2Score, 0, cap) >= cap) {
    return { decided: false };
  }
  // At or behind one already applied. Equal used to be kept, on the grounds
  // that both peers report the same revision for the same event — they run the
  // same replica over the same events in the same order — so the second copy
  // says the same thing. True while the link is up, and wrong at the moment it
  // goes down: after a fallback the relay counts crossings itself with
  // countReturn, which moves room.streaks and room.crossingsThisPoint without
  // touching this clock (it is the PEERS' clock, and the relay must not share
  // it — see the note beside countReturn in server.ts). A duplicate arriving
  // after one of those would ASSIGN both fields back to the moment before it.
  // A duplicate that really is identical loses nothing by being dropped, so
  // rejecting it costs nothing either way.
  // A snapshot that names no revision says nothing about when it happened, so
  // it is taken as current and moves the mark for nobody — the same rule a
  // result with no age gets. That keeps the relay's contract honest for any
  // caller that has not been told about revisions, rather than silently
  // refusing everything it sends.
  const claimedRev = Number(sync.rev);
  if (Number.isFinite(claimedRev)) {
    const rev = clampInt(claimedRev, 0, Number.MAX_SAFE_INTEGER);
    if (rev <= room.syncRev) return { decided: false };
    room.syncRev = rev;
  }

  // The SCORE is taken whatever has happened to the transports. It only ever
  // goes up, and a peer still scoring over its own link knows points the relay
  // does not — refusing them would leave a half-fallen-back match undecidable.
  room.scores = [
    Math.max(room.scores[0], clampInt(sync.p1Score, 0, cap)),
    Math.max(room.scores[1], clampInt(sync.p2Score, 0, cap)),
  ];
  // The peaks are NOT, once the relay has taken over. A maximum looks safe
  // because it cannot go down, and that is exactly the problem: a diverged
  // replica reading a real serve as a return (its servingPlayer and
  // crossingsThisPoint are stale by then) reports one return too many, and a
  // maximum makes that permanent — into the career best, the XP, the daily
  // tasks and the performance weight.
  if (!room.relayCounted) {
    room.bestStreaks = [
      Math.max(room.bestStreaks[0], clampInt(sync.bestStreaks?.[0], 0, 100000)),
      Math.max(room.bestStreaks[1], clampInt(sync.bestStreaks?.[1], 0, 100000)),
    ];
  }
  // ASSIGNED, not maxed. A P2P match sends the relay no crossings and no
  // points, so room.streaks would otherwise sit at whatever each seat was
  // seeded with — and that is what gets recorded as the run to carry into the
  // next match: a live run saved as the value it started on, and a run that
  // has since been broken by a miss surviving anyway. A run can legitimately
  // go DOWN to zero, so a maximum is exactly the wrong operator here. Still
  // bounded by the peak: a run cannot stand higher than it ever reached.
  // ...but only while the peers are still the ones who know. See relayCounted:
  // once the relay has counted an event itself, a snapshot can only be coming
  // from the peer that has NOT noticed the link is down, and it describes a
  // match missing that event.
  if (!room.relayCounted) {
    room.streaks = [
      Math.min(clampInt(sync.streaks?.[0], 0, 100000), room.bestStreaks[0]),
      Math.min(clampInt(sync.streaks?.[1], 0, 100000), room.bestStreaks[1]),
    ];
  }
  // What was actually built in this match, which is what it is paid on.
  // Bounded by the peak for the same reason as everything else here: a client
  // reports these, and a match cannot have earned more than it reached.
  if (!room.relayCounted) {
    room.earnedBests = [
      Math.max(room.earnedBests[0], Math.min(clampInt(sync.earnedBests?.[0], 0, 100000), room.bestStreaks[0])),
      Math.max(room.earnedBests[1], Math.min(clampInt(sync.earnedBests?.[1], 0, 100000), room.bestStreaks[1])),
    ];
  }
  // Where the POINT is, not just where the score is. A P2P match can hand
  // gameplay back to the relay mid-rally — the DataChannel dies and sendGame
  // starts returning false — and from that moment the relay judges crossings
  // again with countReturn, which asks "was this the serve?" from exactly
  // these two fields. Left at whatever the last relayed point set them to, the
  // first crossing after the handover is read as a serve and dropped from the
  // streak, or a real serve is counted as a return.
  if (!room.relayCounted) {
    if (sync.servingPlayer === 0 || sync.servingPlayer === 1) {
      room.servingPlayer = sync.servingPlayer;
    }
    room.crossingsThisPoint = clampInt(sync.crossingsThisPoint, 0, 100000);
  }
  // Only on evidence that a ball has actually been in play. A snapshot is a
  // claim by an untrusted peer, and not every claim describes gameplay: one
  // naming a match with a 0-0 score and no crossings describes a match that
  // has not begun. Taking that as "play has started" makes a walk-out during
  // the countdown an abandon — past the daily forgiveness, a ranked rating
  // penalty for a match nobody played. A point scored, or a crossing in the
  // current point, is the evidence; nothing else is. (Scores are already the
  // running maximum here, so this cannot be argued backwards by a late
  // snapshot.)
  if (room.scores[0] > 0 || room.scores[1] > 0 || clampInt(sync.crossingsThisPoint, 0, 100000) > 0) {
    room.inPlay = true;
  }

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
export function performanceWeight(myScore: number, oppScore: number, bestStreak: number): number {
  const total = myScore + oppScore;
  if (total <= 0) return 1;
  const margin = (myScore - oppScore) / total; // -1..1
  const rallyQuality = Math.min(1, bestStreak / 14); // 0..1
  const weight = 1 + 0.3 * margin + 0.15 * (rallyQuality - 0.5);
  return Math.max(0.5, Math.min(1.5, weight));
}

// ---------------------------------------------------------------------------
// Reaping
// ---------------------------------------------------------------------------

/**
 * Whether a seat's socket can still be reached. Passed in rather than imported
 * so this module keeps its promise of touching no socket: it asks a question
 * about one, and server.ts answers it.
 */
export type SocketLiveness = (ws: WebSocket) => boolean;

export interface ReapOptions {
  isLive: SocketLiveness;
  /** How long a room with a live socket may go quiet before it is abandoned. */
  idleMs: number;
  /**
   * How long a room may sit with one player in it, however busy that player
   * is — whether a second has never arrived or has come and gone.
   */
  unpairedTtlMs: number;
}

export type ReapReason = 'empty' | 'idle' | 'unpaired';

export interface ReapedRoom {
  id: string;
  reason: ReapReason;
  room: Room;
}

/**
 * Which sockets a heartbeat sweep should give up on, and which to probe again.
 *
 * `readyState` is not liveness. A peer whose network vanishes without a close
 * handshake — a phone going through a tunnel, a NAT dropping the mapping —
 * leaves the server's socket reading OPEN, because nothing on the wire says
 * otherwise until a write eventually times out at the TCP layer, which can be
 * many minutes. Until then `isRoomEmpty` sees a live seat, `vacateSeat` has
 * never run so `soloSince` is null, and the surviving player's own paddle_move
 * keeps `lastActive` fresh: all three reap branches miss the room, and that
 * player sits opposite a phantom.
 *
 * So liveness is asked for rather than assumed. Each sweep terminates anything
 * that did not answer the last probe and probes the rest. A terminate fires
 * the close handler, which is the ONLY thing that vacates a seat — so the
 * whole room lifecycle downstream of this works unchanged, and simply becomes
 * true.
 *
 * Pure, and takes the flag as a reader for the same reason `isLive` is a
 * predicate: nothing in this file may touch a socket.
 */
export function partitionHeartbeats<T>(
  sockets: Iterable<T>,
  answeredLastProbe: (socket: T) => boolean
): { dead: T[]; probe: T[] } {
  const dead: T[] = [];
  const probe: T[] = [];
  for (const socket of sockets) {
    if (answeredLastProbe(socket)) probe.push(socket);
    else dead.push(socket);
  }
  return { dead, probe };
}

/**
 * Whether every PLAYING seat is either vacant or holds a socket that is
 * already gone.
 *
 * "Empty" is narrower than "nobody is connected", and that is deliberate: a
 * table with two spectators and no player is a table nobody can play at, so it
 * is empty and the reaper sweeps it within 15 seconds. That is the brief's
 * "no empty tables in the database" obtained for free — and, more usefully, it
 * is the safety net for a player socket that dies half-open, where `vacateSeat`
 * never runs and no other clock can expire the room.
 */
export function isRoomEmpty(room: Room, isLive: SocketLiveness): boolean {
  return !room.players.some((seat) => seat && isLive(seat.ws));
}

/**
 * Delete the rooms nobody can be in, and hand them back so the caller can
 * close whatever is still attached and say what it did.
 *
 * Three ways a room dies. `empty` is the one that matters and the reason this
 * exists: a seat holding a socket that has already gone is not a player, and
 * nothing on the disconnect path can clear it — `vacateSeat` runs off a close
 * event, and a socket that dies without one (a half-open TCP connection, which
 * the heartbeat in `partitionHeartbeats` is what makes visible here, or a
 * socket whose seat was orphaned when it took a second one) leaves a room that
 * no player can reach and no handler will ever remove.
 *
 * `idle` is the 30-minute clock this replaces, kept as-is. `unpaired` is new,
 * and it is the only rule that can expire a room whose one player is busy:
 * lastActive is refreshed by every paddle_move, so a host alone on a court
 * streams their own room's clock forward forever.
 *
 * Pure, and returns rather than acts, for the same reason as everything else
 * in this file: it can be tested without a socket, a timer or a process.
 */
export function reapRooms(
  rooms: Map<string, Room>,
  now: number,
  opts: ReapOptions
): ReapedRoom[] {
  const dead: ReapedRoom[] = [];
  for (const [id, room] of rooms) {
    let reason: ReapReason | null = null;
    if (isRoomEmpty(room, opts.isLive)) reason = 'empty';
    else if (now - room.lastActive > opts.idleMs) reason = 'idle';
    else if (room.soloSince !== null && now - room.soloSince > opts.unpairedTtlMs) {
      reason = 'unpaired';
    }
    if (reason) dead.push({ id, reason, room });
  }
  for (const { id } of dead) rooms.delete(id);
  return dead;
}

// ---------------------------------------------------------------------------
// Rally streaks
// ---------------------------------------------------------------------------

/**
 * A rally streak belongs to ONE player. It counts that player's own
 * consecutive successful returns, and it breaks only when THAT player fails to
 * return one — the opponent missing, which is a point you just won, leaves it
 * untouched. So a streak runs across points and ends on your own miss.
 *
 * The serve is not a return: the receiver's return OF the serve is the
 * receiver's first, and the server's own streak resumes on their first return
 * of that. Identifying the serve is the only reason crossingsThisPoint exists.
 *
 * What this replaced was a single counter both players incremented, reset
 * whenever either of them scored — so a player's rally number was mostly a
 * statement about their opponent, which is exactly what it was reported as.
 *
 * Kept here, pure, because the P2P replica in src/net/p2p.ts has to reach the
 * same numbers from the same events without a relay in the middle.
 */
export interface StreakState {
  streaks: [number, number];
  bestStreaks: [number, number];
  earnedStreaks: [number, number];
  earnedBests: [number, number];
  crossingsThisPoint: number;
  servingPlayer: 0 | 1;
}

/**
 * Open a new MATCH without ending anybody's run.
 *
 * A streak carries across matches, not only across points, so a match start is
 * not a reason to lose one — only a miss is. What resets is the per-match
 * high-water mark, and it resets TO the run each player walked in on, because
 * that run is genuinely part of the match's longest.
 */
export function startMatchStreaks(state: StreakState, servingPlayer: 0 | 1): void {
  state.bestStreaks = [state.streaks[0], state.streaks[1]];
  // From zero, always: nothing carried in was earned here.
  state.earnedStreaks = [0, 0];
  state.earnedBests = [0, 0];
  state.crossingsThisPoint = 0;
  state.servingPlayer = servingPlayer;
}

/** Wipe both runs outright. For a fresh room, not for a fresh match. */
export function resetStreaks(state: StreakState, servingPlayer: 0 | 1): void {
  state.streaks = [0, 0];
  state.bestStreaks = [0, 0];
  state.earnedStreaks = [0, 0];
  state.earnedBests = [0, 0];
  state.crossingsThisPoint = 0;
  state.servingPlayer = servingPlayer;
}

/**
 * Wipe ONE seat's runs, because the person sitting in it has left it.
 *
 * A run belongs to a player, not to a chair. When a seat changes hands its
 * numbers must not be inherited: `startMatchStreaks` opens `bestStreaks` ON
 * `streaks`, so a value left behind by the previous occupant becomes the next
 * one's opening peak — and a peak is what the career best, the mode best and
 * the rally achievements are keyed on, so it would be permanent.
 *
 * Deliberately separate from `resetStreaks`, which wipes BOTH seats for a
 * fresh room: this one is about a seat, and the other seat's run is still
 * running.
 */
export function clearSeatStreaks(state: StreakState, seat: 0 | 1): void {
  state.streaks[seat] = 0;
  state.bestStreaks[seat] = 0;
  state.earnedStreaks[seat] = 0;
  state.earnedBests[seat] = 0;
}

/**
 * A ball crossed the net from `seat`. Returns whether it counted as a return —
 * false for the serve, which opens a point rather than continuing one.
 */
/**
 * The most SDP a signal may carry. Real offers and answers run a few kilobytes;
 * this is generous enough never to bite an honest one and small enough that a
 * seated player cannot make the relay ferry megabytes for free.
 */
export const MAX_SDP_CHARS = 16 * 1024;

/**
 * Forget that this table ever negotiated a DataChannel.
 *
 * Called whenever a PLAYING seat empties or changes hands, and for exactly one
 * reason: p2pOffered is what lets match_sync speak for a match the relay never
 * saw, and it is evidence about the two people who exchanged the handshake. A
 * room survives its occupants — a seat vacated by one player is taken by the
 * next — so a flag that outlived them let a newcomer forge a decisive snapshot
 * against an opponent who had never been on a DataChannel with anybody. It is
 * NOT called on a transport fallback: that is the same pair, still holding the
 * replica they built, which is the case relayCounted exists to handle.
 */
export function clearP2PEvidence(room: Room): void {
  room.p2pOffered = false;
  room.rtcOfferFrom = undefined;
  room.rtcAnswerFrom = undefined;
}

/**
 * Take one `rtc_signal` from a seat: validate it, record what it advances of
 * the handshake, and say whether it should be relayed to the peer.
 *
 * Validating here rather than passing SDP through untouched is half the point.
 * The relay was a pure pass-through with no shape check at all — `quick_chat`
 * caps at 100 characters and this capped at nothing — so `{}` was a signal, and
 * a signal was enough to arm p2pOffered. Everything a client can put on the
 * wire that is not one of the three kinds is now simply not a signal: it is not
 * forwarded, and it advances nothing.
 *
 * `ice` deliberately advances nothing either. Candidates trickle in any order,
 * arrive from both seats, and a null one is the legitimate end-of-candidates
 * marker — so they are relayed but they are not evidence of anything, and
 * treating them as evidence would put the one-frame arming straight back.
 */
export function acceptRtcSignal(room: Room, seat: 0 | 1, payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const { kind, sdp } = payload as { kind?: unknown; sdp?: unknown };
  if (kind !== 'offer' && kind !== 'answer' && kind !== 'ice') return false;
  if (kind === 'ice') return true;
  if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_SDP_CHARS) return false;

  if (kind === 'offer') room.rtcOfferFrom = seat;
  else room.rtcAnswerFrom = seat;

  // Both halves, from DIFFERENT seats. Same-seat is the whole attack: one
  // socket sending itself an offer and an answer is not a handshake.
  if (
    room.rtcOfferFrom !== undefined &&
    room.rtcAnswerFrom !== undefined &&
    room.rtcOfferFrom !== room.rtcAnswerFrom
  ) {
    room.p2pOffered = true;
  }
  return true;
}

export function countReturn(state: StreakState, seat: 0 | 1): boolean {
  const isServe = state.crossingsThisPoint === 0 && seat === state.servingPlayer;
  state.crossingsThisPoint += 1;
  if (isServe) return false;
  state.streaks[seat] += 1;
  if (state.streaks[seat] > state.bestStreaks[seat]) {
    state.bestStreaks[seat] = state.streaks[seat];
  }
  state.earnedStreaks[seat] += 1;
  if (state.earnedStreaks[seat] > state.earnedBests[seat]) {
    state.earnedBests[seat] = state.earnedStreaks[seat];
  }
  return true;
}

/**
 * `scorer` won the point, so the OTHER seat is the one that missed — and it is
 * the only one whose streak ends. `nextServer` is who serves the next point.
 */
export function breakStreakOnPoint(state: StreakState, scorer: 0 | 1, nextServer: 0 | 1): void {
  const missed = scorer === 0 ? 1 : 0;
  state.streaks[missed] = 0;
  state.earnedStreaks[missed] = 0;
  state.crossingsThisPoint = 0;
  state.servingPlayer = nextServer;
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
