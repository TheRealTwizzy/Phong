import { describe, expect, it } from 'vitest';
import {
  acceptRtcSignal,
  applyMatchSync,
  breakStreakOnPoint,
  clampInt,
  countReturn,
  clearSeatStreaks,
  resetStreaks,
  startMatchStreaks,
  generateRoomCode,
  isRoomEmpty,
  partitionHeartbeats,
  performanceWeight,
  reapRooms,
  Room,
  ROOM_CODE_ALPHABET,
  MAX_SDP_CHARS,
  startMatch,
} from '../server/room';
import { normalizeRoomConfig } from '../src/matchRules';

// The relay's room rules, tested directly for the first time.
//
// These lived in server.ts, where the only way to reach them was to spawn a
// process — so the honest cases got covered by tests/duelRecord.test.ts and
// the ADVERSARIAL ones got covered by nothing. applyMatchSync in particular
// takes a score from a peer over a channel the server cannot see, and its own
// comment describes an attack ("a phone naming a match number out of thin air
// could blank a live room's score and take the result away from the other
// player") that no test had ever exercised.
//
// Gameplay is client-authoritative by design (CLAUDE.md §5). That makes these
// guards the whole of what stands between a modified client and the other
// player's result, which is a poor thing to leave unpinned.

const room = (over: Partial<Room> = {}): Room => ({
  id: 'ABCD',
  players: [null, null],
  scores: [0, 0],
  streaks: [0, 0],
  bestStreaks: [0, 0],
  earnedStreaks: [0, 0],
  earnedBests: [0, 0],
  crossingsThisPoint: 0,
  syncRev: 0,
  servingPlayer: 0,
  rematchVotes: [false, false],
  config: normalizeRoomConfig({ winningScore: 5 }),
  matchOver: false,
  ready: [false, false],
  inPlay: false,
  matchSeq: 1,
  lastActive: 0,
  startRatings: null,
  startRatingsSeq: 0,
  relayCounted: false,
  soloSince: 0,
  venueRoomId: 'casual',
  visibility: 'private',
  joinKey: null,
  spectators: [null, null],
  ...over,
});

let revCounter = 0;
const nextRev = (): number => (revCounter += 1);

const sync = (over: Partial<Parameters<typeof applyMatchSync>[1]> = {}) => ({
  matchSeq: 1,
  p1Score: 0,
  p2Score: 0,
  bestStreaks: [0, 0] as [number, number],
  streaks: [0, 0] as [number, number],
  earnedBests: [0, 0] as [number, number],
  servingPlayer: 0 as 0 | 1,
  crossingsThisPoint: 0,
  // A logical clock, so the room can spot a snapshot arriving behind one it
  // already applied. Every real snapshot describes a NEW event, so the default
  // counts up — a fixed one would have consecutive calls in a test look like
  // the same moment reported twice, which the room is now right to reject.
  rev: nextRev(),
  ...over,
});

describe('applyMatchSync — a score reported by a peer', () => {
  it('ignores anything arriving before the host has started a match', () => {
    // The replica only reports from game_start onward, so a sync against a
    // room still in its lobby did not come from a match.
    const r = room({ matchSeq: 0 });
    expect(applyMatchSync(r, sync({ matchSeq: 1, p1Score: 5 })).decided).toBe(false);
    expect(r.scores).toEqual([0, 0]);
    expect(r.inPlay).toBe(false);
  });

  it('ignores a report from a match that has already been replaced', () => {
    const r = room({ matchSeq: 3 });
    applyMatchSync(r, sync({ matchSeq: 2, p1Score: 4 }));
    expect(r.scores).toEqual([0, 0]);
  });

  it('REFUSES to adopt a match number invented mid-rally', () => {
    // The attack the guard exists for: a live 3-1 room, and one phone claims
    // to be playing match 9. Adopting that would blank the score and take the
    // other player's result away from them.
    const r = room({ matchSeq: 1, scores: [3, 1], inPlay: true, matchOver: false });
    const result = applyMatchSync(r, sync({ matchSeq: 9, p1Score: 0, p2Score: 0 }));
    expect(result.decided).toBe(false);
    expect(r.matchSeq).toBe(1);
    expect(r.scores).toEqual([3, 1]);
  });

  it('adopts a higher match number once the last match is genuinely over', () => {
    // The peers agreed a rematch between themselves; the relay never ran
    // startMatch for it, so their numbering is the only thing that tells the
    // two results apart.
    const r = room({ matchSeq: 1, scores: [5, 2], matchOver: true, ready: [true, true] });
    applyMatchSync(r, sync({ matchSeq: 2, p1Score: 1, p2Score: 0, bestStreaks: [4, 4] as any }));
    expect(r.matchSeq).toBe(2);
    expect(r.scores).toEqual([1, 0]);
    expect(r.matchOver).toBe(false);
    expect(r.rematchVotes).toEqual([false, false]);
    expect(r.ready).toEqual([false, false]);
  });

  it('takes the score as a maximum, so a stale report cannot walk it back', () => {
    // Reports are absolute, not deltas, and arrive from both peers over an
    // unordered link. A late one carrying an older score must not undo a point.
    const r = room();
    applyMatchSync(r, sync({ p1Score: 3, p2Score: 2, bestStreaks: [12, 12] as any }));
    applyMatchSync(r, sync({ p1Score: 1, p2Score: 0, bestStreaks: [2, 2] as any }));
    expect(r.scores).toEqual([3, 2]);
    expect(r.bestStreaks[0]).toBe(12);
  });

  it('holds a reported score inside the room own winning score', () => {
    // Nothing stops a modified client claiming 9999. The room's terms do.
    const r = room();
    applyMatchSync(r, sync({ p1Score: 9999, p2Score: -40 }));
    expect(r.scores).toEqual([5, 0]);
  });

  it('survives junk in every numeric field', () => {
    const r = room();
    applyMatchSync(r, sync({ p1Score: NaN, p2Score: Infinity, bestStreaks: [-12, -12] as any } as any));
    // Note Infinity lands on 0, not on the winning score. clampInt treats a
    // non-finite number as unusable rather than as "very large", so claiming
    // an infinite score does not hand anyone the match — it reports nothing.
    expect(r.scores).toEqual([0, 0]);
    expect(r.bestStreaks[0]).toBe(0);

    const r2 = room();
    applyMatchSync(r2, sync({ p1Score: 'three', bestStreaks: ['lots', 'lots'] as any } as any));
    expect(r2.scores).toEqual([0, 0]);
    expect(Number.isFinite(r2.bestStreaks[0])).toBe(true);
  });

  it('does not let a NaN match number pass for the current one', () => {
    const r = room({ matchSeq: 2, scores: [1, 1] });
    applyMatchSync(r, sync({ matchSeq: NaN, p1Score: 5 } as any));
    expect(r.scores).toEqual([1, 1]);
  });

  it('puts the match in play, which is what makes a walk-out an abandon', () => {
    const r = room();
    expect(r.inPlay).toBe(false);
    applyMatchSync(r, sync({ p1Score: 1 }));
    expect(r.inPlay).toBe(true);
  });

  it('reports the match decided exactly once, and leaves the loser serving', () => {
    const r = room();
    expect(applyMatchSync(r, sync({ p1Score: 4, p2Score: 1 })).decided).toBe(false);
    expect(applyMatchSync(r, sync({ p1Score: 5, p2Score: 1 })).decided).toBe(true);
    expect(r.matchOver).toBe(true);
    expect(r.servingPlayer).toBe(1);
    // A second report of the same finished match must not record it again —
    // that is the difference between a duel being paid once and twice.
    expect(applyMatchSync(r, sync({ p1Score: 5, p2Score: 1 })).decided).toBe(false);
  });

  it('refuses a snapshot claiming BOTH seats won, rather than repairing it', () => {
    // The reported bug, stated at the boundary that let it in. A replica stops
    // at the first score to reach the cap, so no honest peer reports two
    // winners — but the two scores are clamped INDEPENDENTLY, so [999, 999]
    // used to land as [5, 5], report the match decided, and leave
    // recordRoomMatch's `mine > theirs` false for BOTH seats: two ranked
    // losses and two red down-arrows off one message.
    const r = room();
    applyMatchSync(r, sync({ p1Score: 3, p2Score: 2, bestStreaks: [7, 7] as any }));

    expect(applyMatchSync(r, sync({ p1Score: 5, p2Score: 5 })).decided).toBe(false);
    expect(applyMatchSync(r, sync({ p1Score: 999, p2Score: 999 })).decided).toBe(false);
    expect(applyMatchSync(r, sync({ p1Score: 6, p2Score: 5 })).decided).toBe(false);

    // Nothing of the refused snapshots is kept — not the score, and not the
    // fields a snapshot ASSIGNS. A peer that is wrong about who won is not one
    // whose serving seat or streaks are worth taking either.
    expect(r.scores).toEqual([3, 2]);
    expect(r.matchOver).toBe(false);
    expect(r.bestStreaks).toEqual([7, 7]);

    // And the room is still able to hear the real result afterwards, so the
    // refusal costs the honest peer nothing.
    expect(applyMatchSync(r, sync({ p1Score: 5, p2Score: 2 })).decided).toBe(true);
    expect(r.scores).toEqual([5, 2]);
  });

  it('does not start play, or burn a revision, on a two-winner snapshot', () => {
    // Refused BEFORE the revision is bumped, so a malformed snapshot cannot
    // spend a number a legitimate one still wants — and before inPlay can be
    // set, or a walk-out during the countdown becomes an abandon for a match
    // nobody played. Same reasoning as the 0-0 guard below.
    const r = room();
    applyMatchSync(r, sync({ p1Score: 5, p2Score: 5, rev: 40, crossingsThisPoint: 9 }));
    expect(r.inPlay).toBe(false);
    expect(r.syncRev).toBe(0);
    expect(applyMatchSync(r, sync({ p1Score: 5, p2Score: 1, rev: 40 })).decided).toBe(true);
  });

  it('clears rematch votes when the match decides, so none are banked early', () => {
    const r = room({ rematchVotes: [true, false] });
    applyMatchSync(r, sync({ p1Score: 5 }));
    expect(r.rematchVotes).toEqual([false, false]);
  });

  it('does not start play on a snapshot describing a match that has not begun', () => {
    // applyMatchSync is the untrusted-peer boundary, and a snapshot is a
    // claim rather than an observation. One naming a new match with a 0-0
    // score and no crossings describes no gameplay at all — so taking it as
    // "a ball is in play" makes a player who leaves during the countdown, or
    // before the first serve, an abandon: a ranked rating penalty for a match
    // nobody played.
    const r = room({ matchOver: true, inPlay: true, scores: [5, 3] });
    applyMatchSync(r, sync({ matchSeq: 2, p1Score: 0, p2Score: 0, crossingsThisPoint: 0 }));

    expect(r.matchSeq).toBe(2); // the snapshot still did its actual job
    expect(r.scores).toEqual([0, 0]);
    expect(r.matchOver).toBe(false);
    // ...and the new match has had no ball in it. Both halves matter: the
    // rematch branch has to clear the PREVIOUS match's true, and the write at
    // the end must not immediately set it again.
    expect(r.inPlay).toBe(false);
  });

  it('starts play on the first crossing of that new match', () => {
    // The other side of the same rule — this must not become "a P2P duel is
    // never in play", which would take abandon detection away entirely.
    const r = room({ matchOver: true, inPlay: true, scores: [5, 3] });
    applyMatchSync(r, sync({ matchSeq: 2, crossingsThisPoint: 0 }));
    expect(r.inPlay).toBe(false);

    applyMatchSync(r, sync({ matchSeq: 2, crossingsThisPoint: 1 }));
    expect(r.inPlay).toBe(true);
  });

  it('starts play on a point scored, even with the point phase reset', () => {
    // crossingsThisPoint goes back to zero the moment a point lands, so a
    // snapshot reporting a score carries no crossings — the score itself is
    // the evidence.
    const r = room();
    applyMatchSync(r, sync({ p1Score: 1, crossingsThisPoint: 0 }));
    expect(r.inPlay).toBe(true);
  });
});

describe('startMatch', () => {
  it('resets everything the last match left behind', () => {
    const r = room({
      scores: [5, 3],
      streaks: [9, 4],
      bestStreaks: [31, 12],
      earnedStreaks: [5, 2],
      earnedBests: [7, 3],
      crossingsThisPoint: 3,
      rematchVotes: [true, true],
      matchOver: true,
      inPlay: true,
      ready: [true, true],
      matchSeq: 4,
    });
    const payload = startMatch(r, 1);

    expect(r.scores).toEqual([0, 0]);
    // Streaks are deliberately NOT among the things a match start resets —
    // see the rally-streak cases below.
    expect(r.crossingsThisPoint).toBe(0);
    expect(r.rematchVotes).toEqual([false, false]);
    expect(r.matchOver).toBe(false);
    expect(r.inPlay).toBe(false);
    expect(r.ready).toEqual([false, false]);
    expect(r.servingPlayer).toBe(1);
    // A room outlives its matches; the sequence is what tells them apart.
    expect(r.matchSeq).toBe(5);
    expect(payload).toEqual({
      type: 'game_start',
      servingPlayer: 1,
      config: r.config,
      matchSeq: 5,
      // The runs each seat walks in on. The relay is the only party that knows
      // both, so it is the one that tells them — including the P2P replica,
      // which sees no other relay message all match.
      streaks: [9, 4],
    });
  });

  it('carries the room terms, so no phone can start on terms it was not told', () => {
    const r = room({ config: normalizeRoomConfig({ winningScore: 10 }) });
    expect(startMatch(r, 0).config.winningScore).toBe(10);
  });
});

describe('performanceWeight', () => {
  it('is neutral for a match with no points at all', () => {
    expect(performanceWeight(0, 0, 0)).toBe(1);
  });

  it('rewards a dominant win over a narrow one', () => {
    expect(performanceWeight(5, 0, 10)).toBeGreaterThan(performanceWeight(5, 4, 10));
  });

  it('punishes a heavy loss more than a close one', () => {
    expect(performanceWeight(0, 5, 10)).toBeLessThan(performanceWeight(4, 5, 10));
  });

  it('softens a loss that came with long rallies', () => {
    expect(performanceWeight(2, 5, 40)).toBeGreaterThan(performanceWeight(2, 5, 0));
  });

  it('stays inside a band narrower than its own clamp', () => {
    // CLAUDE.md §7 describes this as "bounded to a 0.5-1.5 weight", which is
    // the clamp — but the clamp is unreachable. margin maxes at +/-1 and
    // rallyQuality at 0..1, so the real range is 0.625..1.375. Pinned as it
    // actually behaves: a rating nudge, never a driver.
    const samples: number[] = [];
    for (const mine of [0, 1, 3, 5, 10, 15]) {
      for (const theirs of [0, 1, 3, 5, 10, 15]) {
        for (const rally of [0, 5, 20, 100, 5000]) {
          samples.push(performanceWeight(mine, theirs, rally));
        }
      }
    }
    expect(Math.min(...samples)).toBeCloseTo(0.625, 5);
    expect(Math.max(...samples)).toBeCloseTo(1.375, 5);
    expect(samples.every((w) => w >= 0.5 && w <= 1.5)).toBe(true);
  });
});

describe('generateRoomCode', () => {
  it('is four characters a player can read off a phone', () => {
    for (let i = 0; i < 200; i++) expect(generateRoomCode()).toMatch(/^[A-Z0-9]{4}$/);
  });

  it('never uses the characters people transcribe wrongly', () => {
    // 0/O and 1/I are the pairs a player gets wrong copying a code between two
    // phones, which is the only way a code is ever entered.
    for (const bad of ['0', 'O', '1', 'I']) {
      expect(ROOM_CODE_ALPHABET).not.toContain(bad);
    }
    const codes = Array.from({ length: 500 }, generateRoomCode).join('');
    expect(codes).not.toMatch(/[01OI]/);
  });

  it('draws on the whole alphabet', () => {
    // A generator stuck on a subset would collide far sooner than 32^4 says.
    const seen = new Set(Array.from({ length: 4000 }, generateRoomCode).join(''));
    expect(seen.size).toBe(ROOM_CODE_ALPHABET.length);
  });
});

describe('clampInt', () => {
  it('floors, bounds, and refuses to pass junk through', () => {
    expect(clampInt(3.9, 0, 10)).toBe(3);
    expect(clampInt(-5, 0, 10)).toBe(0);
    expect(clampInt(99, 0, 10)).toBe(10);
    expect(clampInt(NaN, 2, 10)).toBe(2);
    expect(clampInt(undefined, 2, 10)).toBe(2);
    expect(clampInt('7', 0, 10)).toBe(7);
  });
});


// A socket is a `ws` WebSocket in production; here it only ever has to answer
// the one question reapRooms asks of it.
const seat = (open: boolean, idx: 0 | 1 = 0) =>
  ({
    ws: { readyState: open ? 1 : 3 } as never,
    playerId: `p${idx}`,
    playerName: `Player ${idx + 1}`,
    playerIndex: idx,
    deviceId: `d${idx}`,
    sessionId: `s${idx}`,
  }) as never;

const live = (sock: { readyState: number }) => sock.readyState === 1;
const OPTS = { isLive: live as never, idleMs: 1000, unpairedTtlMs: 5000 };
const MINUTE = 60_000;

describe('reapRooms', () => {
  // The reason this exists. `vacateSeat` runs off a close event, so a socket
  // that dies without one — a half-open connection, or a seat orphaned when
  // its socket took another — leaves a room no player can reach and no
  // handler will ever delete. The old sweep could not see one: it only asked
  // whether the room had been quiet for half an hour.
  it('deletes a room whose every seat is a socket that has already gone', () => {
    const rooms = new Map<string, Room>([
      ['DEAD', room({ players: [seat(false, 0), seat(false, 1)], lastActive: MINUTE })],
    ]);
    const dead = reapRooms(rooms, MINUTE, OPTS);
    expect(dead.map((d) => [d.id, d.reason])).toEqual([['DEAD', 'empty']]);
    expect(rooms.size).toBe(0);
  });

  it('deletes a room with no seats taken at all', () => {
    const rooms = new Map<string, Room>([['NONE', room({ lastActive: MINUTE })]]);
    expect(reapRooms(rooms, MINUTE, OPTS)[0].reason).toBe('empty');
    expect(rooms.size).toBe(0);
  });

  // Half-empty is not empty: the host is waiting, and waiting is what a lobby
  // is for. Only the unpaired clock may end that, and not for a while.
  it('keeps a room while one socket is still live', () => {
    const rooms = new Map<string, Room>([
      ['HELD', room({ players: [seat(true, 0), seat(false, 1)], lastActive: MINUTE, soloSince: MINUTE })],
    ]);
    expect(reapRooms(rooms, MINUTE, OPTS)).toEqual([]);
    expect(rooms.size).toBe(1);
  });

  it('deletes a live room that has gone quiet past the idle clock', () => {
    const rooms = new Map<string, Room>([
      ['IDLE', room({ players: [seat(true, 0), seat(true, 1)], lastActive: 0, soloSince: null })],
    ]);
    expect(reapRooms(rooms, 5000, OPTS)[0].reason).toBe('idle');
  });

  it('keeps a live room that is still talking', () => {
    const rooms = new Map<string, Room>([
      ['BUSY', room({ players: [seat(true, 0), seat(true, 1)], lastActive: 4500, soloSince: null })],
    ]);
    expect(reapRooms(rooms, 5000, OPTS)).toEqual([]);
  });

  // The one rule that can expire a busy room, and the reason it had to exist:
  // lastActive is refreshed by every paddle_move, so a host sitting alone on a
  // court streams their own room's idle clock forward for as long as they hold
  // the phone. Nothing else in here can ever reach that room.
  it('expires a room that never got a second player, however busy its first is', () => {
    const rooms = new Map<string, Room>([
      ['SOLO', room({ players: [seat(true, 0), null], soloSince: 0, lastActive: 9000 })],
    ]);
    expect(reapRooms(rooms, 9000, OPTS)[0].reason).toBe('unpaired');
  });

  it('leaves an unpaired room alone until its TTL is up', () => {
    const rooms = new Map<string, Room>([
      ['WAIT', room({ players: [seat(true, 0), null], soloSince: 0, lastActive: 4000 })],
    ]);
    expect(reapRooms(rooms, 4000, OPTS)).toEqual([]);
  });

  // A room that HAS been a duel and is back to one player gets the clock too.
  // This used to be exempt: the flag was set once when a second player arrived
  // and never cleared, on the grounds that such a room is one a rematch can
  // still happen in — true only while the other player is still there. Once
  // the guest leaves it is a one-player room like any other, and exempting it
  // meant the leak the TTL exists for could be made simply by having somebody
  // join and leave.
  it('applies the unpaired TTL again once a room is back to one player', () => {
    const rooms = new Map<string, Room>([
      // Paired at some point, alone again since t=0, and busy ever since.
      ['USED', room({ players: [seat(true, 0), null], soloSince: 0, lastActive: 9000 })],
    ]);
    expect(reapRooms(rooms, 9000, OPTS)[0].reason).toBe('unpaired');
  });

  it('stops the clock for as long as both seats are filled', () => {
    // Long past the unpaired TTL and still talking, so only that clock could
    // reach it — and it must not, because there are two of them in there.
    const rooms = new Map<string, Room>([
      ['DUEL', room({ players: [seat(true, 0), seat(true, 1)], soloSince: null, lastActive: 9_000_000 })],
    ]);
    expect(reapRooms(rooms, 9_000_000, OPTS)).toEqual([]);
  });

  it('hands back what it removed and leaves the rest of the map alone', () => {
    const rooms = new Map<string, Room>([
      ['GONE', room({ id: 'GONE', lastActive: MINUTE })],
      ['KEPT', room({ id: 'KEPT', players: [seat(true, 0), null], soloSince: MINUTE, lastActive: MINUTE })],
    ]);
    const dead = reapRooms(rooms, MINUTE, OPTS);
    expect(dead).toHaveLength(1);
    expect(dead[0].room.id).toBe('GONE');
    expect([...rooms.keys()]).toEqual(['KEPT']);
  });
});

const watcher = (alive: boolean, side: 0 | 1) =>
  ({
    ws: { readyState: alive ? 1 : 3 },
    playerId: `w${side}`,
    playerName: `Watcher ${side + 1}`,
    side,
    deviceId: `wd${side}`,
    sessionId: `ws${side}`,
  }) as never;

describe('isRoomEmpty', () => {
  it('reads a seat holding a dead socket as vacant', () => {
    expect(isRoomEmpty(room({ players: [seat(false, 0), null] }), live as never)).toBe(true);
    expect(isRoomEmpty(room({ players: [seat(true, 0), null] }), live as never)).toBe(false);
  });

  // "Empty" is narrower than "nobody is connected", deliberately: a table
  // nobody can PLAY at is a table the reaper takes, however many people are
  // watching it. That is "no empty tables in the database" for free, and the
  // safety net for a player socket that dies half-open.
  it('counts a table with only spectators as empty', () => {
    const watched = room({
      players: [null, null],
      spectators: [watcher(true, 0), watcher(true, 1)],
    });
    expect(isRoomEmpty(watched, live as never)).toBe(true);
  });

  it('does not let a live spectator keep a dead player seat alive', () => {
    const stale = room({
      players: [seat(false, 0), null],
      spectators: [watcher(true, 0), null],
    });
    expect(isRoomEmpty(stale, live as never)).toBe(true);
  });
});


describe('rally streaks', () => {
  // Reported as a bug: "a rally streak must never be determined by the
  // opponent's hit/miss". It was, twice over — a single counter both players
  // incremented, reset whenever EITHER of them scored. So your rally number
  // went up when your opponent returned a ball and back to zero when they
  // missed one, and told you almost nothing about your own play.

  const st = (over: Partial<Room> = {}) => room(over);

  it('does not count the serve for the player serving it', () => {
    const r = st({ servingPlayer: 0 });
    expect(countReturn(r, 0)).toBe(false);
    expect(r.streaks).toEqual([0, 0]);
    // And the receiver's return of it IS their first.
    expect(countReturn(r, 1)).toBe(true);
    expect(r.streaks).toEqual([0, 1]);
  });

  it("counts a crossing that only looks like a serve for the player who did not serve", () => {
    // First ball of the point, but from the seat that is NOT serving — which
    // is what a receiver's return is. Keying the exclusion on "first crossing"
    // alone would have swallowed it.
    const r = st({ servingPlayer: 1 });
    expect(countReturn(r, 0)).toBe(true);
    expect(r.streaks).toEqual([1, 0]);
  });

  it('credits each return to its own player and nobody else', () => {
    const r = st({ servingPlayer: 0 });
    countReturn(r, 0); // serve
    countReturn(r, 1);
    countReturn(r, 0);
    countReturn(r, 1);
    countReturn(r, 1); // two in a row is physically odd but must still only be theirs
    expect(r.streaks).toEqual([1, 3]);
    expect(r.bestStreaks).toEqual([1, 3]);
  });

  it('ends only the streak of the player who let the ball past', () => {
    const r = st({ servingPlayer: 0 });
    countReturn(r, 0); // serve
    countReturn(r, 1);
    countReturn(r, 0);
    countReturn(r, 1);
    expect(r.streaks).toEqual([1, 2]);
    // Seat 0 takes the point, so seat 1 is the one who missed.
    breakStreakOnPoint(r, 0, 1);
    expect(r.streaks).toEqual([1, 0]);
    // THE rule: winning a point is not a reason to lose your own streak.
    expect(r.bestStreaks).toEqual([1, 2]);
  });

  it('carries a surviving streak across the point rather than restarting it', () => {
    const r = st({ servingPlayer: 0 });
    countReturn(r, 0); // serve
    countReturn(r, 1);
    countReturn(r, 0);
    breakStreakOnPoint(r, 0, 1); // seat 0 scores, seat 1 missed
    // Seat 1 now serves; seat 0's return of that continues their run.
    countReturn(r, 1); // serve, not a return
    countReturn(r, 0);
    expect(r.streaks[0]).toBe(2);
    expect(r.bestStreaks[0]).toBe(2);
  });

  it('opens a fresh point after one is scored, so the next serve is a serve', () => {
    const r = st({ servingPlayer: 0 });
    countReturn(r, 0);
    countReturn(r, 1);
    breakStreakOnPoint(r, 1, 0);
    expect(r.crossingsThisPoint).toBe(0);
    expect(r.servingPlayer).toBe(0);
    expect(countReturn(r, 0)).toBe(false);
  });

  it('keeps a best streak once it has been set, however the streak ends', () => {
    const r = st({ servingPlayer: 1 });
    for (let i = 0; i < 9; i++) countReturn(r, 0);
    expect(r.bestStreaks[0]).toBe(9);
    breakStreakOnPoint(r, 1, 1);
    expect(r.streaks[0]).toBe(0);
    expect(r.bestStreaks[0]).toBe(9);
  });

  // A run belongs to a player, not to a chair. When a seat changes hands the
  // numbers must not be inherited — startMatchStreaks opens bestStreaks ON
  // streaks, so a value left behind becomes the next occupant's opening peak,
  // and a peak is permanent: the career best, the mode best and the rally
  // achievements are all keyed on it.
  it('clears ONE seat when that seat changes hands, leaving the other running', () => {
    const r = st({
      streaks: [4, 7],
      bestStreaks: [9, 12],
      earnedStreaks: [3, 6],
      earnedBests: [5, 8],
    });
    clearSeatStreaks(r, 0);
    expect(r.streaks).toEqual([0, 7]);
    expect(r.bestStreaks).toEqual([0, 12]);
    expect(r.earnedStreaks).toEqual([0, 6]);
    expect(r.earnedBests).toEqual([0, 8]);
  });

  it('does not let a cleared seat inherit a peak from its last occupant', () => {
    const r = st({ streaks: [11, 0], bestStreaks: [11, 0] });
    clearSeatStreaks(r, 0);
    startMatchStreaks(r, 0);
    expect(r.bestStreaks[0]).toBe(0);
  });

  it('is cleared wholesale by resetStreaks, best streaks included', () => {
    const r = st({ streaks: [4, 7], bestStreaks: [9, 12], crossingsThisPoint: 5 });
    resetStreaks(r, 1);
    expect(r.streaks).toEqual([0, 0]);
    expect(r.bestStreaks).toEqual([0, 0]);
    expect(r.crossingsThisPoint).toBe(0);
    expect(r.servingPlayer).toBe(1);
  });

  // A streak carries between matches, not only between points: a new match is
  // not a miss, and a miss is the only thing that ends one.
  it('survives a new match, with the per-match peak reset TO it', () => {
    const r = st({ streaks: [4, 7], bestStreaks: [9, 12], crossingsThisPoint: 5 });
    startMatchStreaks(r, 1);
    expect(r.streaks).toEqual([4, 7]);
    expect(r.bestStreaks).toEqual([4, 7]);
    expect(r.crossingsThisPoint).toBe(0);
    expect(r.servingPlayer).toBe(1);
  });

  it('carries through startMatch, so a rematch continues the run', () => {
    const r = st({ scores: [5, 3], streaks: [6, 0], bestStreaks: [11, 4], matchSeq: 1 });
    startMatch(r, 0);
    expect(r.scores).toEqual([0, 0]);
    expect(r.streaks).toEqual([6, 0]);
    // The last match's peak does not follow it into the next one.
    expect(r.bestStreaks).toEqual([6, 0]);
    // And one more return continues rather than restarts.
    countReturn(r, 0); // serve
    countReturn(r, 1);
    countReturn(r, 0);
    expect(r.streaks[0]).toBe(7);
  });
});


describe('the heartbeat sweep', () => {
  // readyState answers "did this close", not "is anyone there". The sweep is
  // what turns the second question into the first, and everything downstream —
  // isRoomEmpty, vacateSeat, soloSince — is already correct once it does.
  const sweep = (sockets: string[], answered: Set<string>) =>
    partitionHeartbeats(sockets, (s) => answered.has(s));

  it('terminates what did not answer and probes the rest', () => {
    const { dead, probe } = sweep(['a', 'b', 'c'], new Set(['a', 'c']));
    expect(dead).toEqual(['b']);
    expect(probe).toEqual(['a', 'c']);
  });

  it('keeps a socket alive as long as it keeps answering', () => {
    // The state machine over two rounds, which is what the caller runs: probe,
    // clear the flag, and let a pong set it again. A live socket must never be
    // terminated however many sweeps it survives.
    const answered = new Set(['live']);
    for (let round = 0; round < 5; round++) {
      const { dead, probe } = sweep(['live'], answered);
      expect(dead).toEqual([]);
      expect(probe).toEqual(['live']);
      answered.delete('live'); // the caller clears it when it probes
      answered.add('live'); //    the pong comes back
    }
  });

  it('gives up on a socket that stops answering', () => {
    // The half-open case: the probe goes out, nothing comes back, and the next
    // sweep terminates it. Two intervals worst case, which is the bound the
    // room TTLs are chosen against.
    const answered = new Set(['gone']);
    expect(sweep(['gone'], answered).dead).toEqual([]);
    answered.delete('gone'); // probed, and no pong ever arrives
    expect(sweep(['gone'], answered).dead).toEqual(['gone']);
  });

  it('does not terminate a socket on its first sweep', () => {
    // A socket that connected between sweeps has not been asked yet. Treating
    // "never answered" as "dead" would cut off every new connection.
    expect(sweep(['fresh'], new Set(['fresh'])).dead).toEqual([]);
  });
});

describe('what a match earned, on the relay', () => {
  it('opens a match having earned nothing, and counts only returns made here', () => {
    const r = room({ streaks: [10, 4], bestStreaks: [10, 4], servingPlayer: 0 });
    startMatchStreaks(r, 0);
    expect(r.earnedStreaks).toEqual([0, 0]);
    expect(r.earnedBests).toEqual([0, 0]);
    countReturn(r, 0); // serve
    countReturn(r, 1);
    countReturn(r, 0);
    expect(r.bestStreaks).toEqual([11, 5]);
    expect(r.earnedBests).toEqual([1, 1]);
  });

  it('ends a seat’s earned run on its own miss only', () => {
    const r = room({ servingPlayer: 1 });
    countReturn(r, 0);
    countReturn(r, 0);
    expect(r.earnedStreaks[0]).toBe(2);
    breakStreakOnPoint(r, 0, 1); // seat 0 SCORED — seat 1 missed
    expect(r.earnedStreaks[0]).toBe(2);
    breakStreakOnPoint(r, 1, 0); // seat 1 scored — seat 0 missed
    expect(r.earnedStreaks[0]).toBe(0);
    expect(r.earnedBests[0]).toBe(2);
  });

  it('takes a P2P peer’s CURRENT runs as reported, not as a maximum', () => {
    // A P2P match sends the relay no crossings and no points, so room.streaks
    // would otherwise sit at whatever each seat was seeded with — and that is
    // what gets recorded as the run to carry. A run can legitimately fall to
    // zero, so a maximum is exactly the wrong operator.
    const r = room({ streaks: [10, 10], bestStreaks: [10, 10] });
    applyMatchSync(r, sync({ p1Score: 1, bestStreaks: [14, 12], streaks: [14, 0], earnedBests: [4, 2] }));
    expect(r.streaks).toEqual([14, 0]);
    expect(r.bestStreaks).toEqual([14, 12]);
    expect(r.earnedBests).toEqual([4, 2]);
  });

  it('refuses a peer’s claim to stand higher than its own peak', () => {
    const r = room();
    applyMatchSync(r, sync({ p1Score: 1, bestStreaks: [5, 5], streaks: [900, 900], earnedBests: [900, 900] }));
    expect(r.streaks).toEqual([5, 5]);
    expect(r.earnedBests).toEqual([5, 5]);
  });

  it('takes the point phase too, so a handover back lands mid-rally', () => {
    // A P2P link can die in the middle of a point: sendGame starts returning
    // false and crossings go to the relay again, which judges them with
    // countReturn — and countReturn asks "was this the serve?" from exactly
    // these two fields. Left where the last relayed point put them, the first
    // crossing after the handover is read as a serve and dropped.
    const r = room({ servingPlayer: 0, crossingsThisPoint: 0 });
    applyMatchSync(r, sync({ p1Score: 1, servingPlayer: 1, crossingsThisPoint: 3 }));
    expect(r.servingPlayer).toBe(1);
    expect(r.crossingsThisPoint).toBe(3);

    // And the very next relayed crossing is a return, not a serve.
    expect(countReturn(r, 1)).toBe(true);
    expect(r.streaks[1]).toBe(1);
  });

  it('ignores a snapshot that arrives behind one already applied', () => {
    // Both peers report every crossing, over two separate sockets, so one can
    // overtake the other. The fields saying where a run IS are assigned — they
    // have to be, since a run legitimately falls to zero — so a late snapshot
    // would walk a live run backwards to a moment the rally has passed, and a
    // fallback to the relay in that window would resume from it.
    const r = room({ syncRev: 0 });
    applyMatchSync(r, sync({ rev: 5, p1Score: 1, bestStreaks: [9, 4], streaks: [9, 4], earnedBests: [9, 4], crossingsThisPoint: 6 }));
    expect(r.streaks).toEqual([9, 4]);
    expect(r.crossingsThisPoint).toBe(6);

    // Crossing 3's snapshot, arriving after crossing 5's.
    const stale = applyMatchSync(r, sync({ rev: 3, p1Score: 1, bestStreaks: [7, 4], streaks: [7, 4], earnedBests: [7, 4], crossingsThisPoint: 4 }));
    expect(stale.decided).toBe(false);
    expect(r.streaks).toEqual([9, 4]);
    expect(r.crossingsThisPoint).toBe(6);

    // The same revision is rejected too. While the link is up that is merely
    // the other peer saying the same thing, and dropping it costs nothing; at
    // the moment the link goes DOWN it is a duplicate still in flight carrying
    // a revision the relay has already counted past itself, and applying it
    // would undo the return the relay has since counted.
    const duplicate = applyMatchSync(r, sync({ rev: 5, p1Score: 1, bestStreaks: [9, 4], streaks: [9, 4], earnedBests: [9, 4], crossingsThisPoint: 6 }));
    expect(duplicate.decided).toBe(false);
    expect(r.streaks).toEqual([9, 4]);

    // And the rally moves on.
    applyMatchSync(r, sync({ rev: 6, p1Score: 1, bestStreaks: [9, 5], streaks: [9, 5], earnedBests: [9, 5], crossingsThisPoint: 7 }));
    expect(r.streaks).toEqual([9, 5]);
  });

  it('does not let a snapshot in flight undo what the relay has since counted', () => {
    // The handover. The link dies, the rest of the point goes over the relay,
    // and the OTHER peer's copy of the last P2P event is still on the wire.
    // It carries the revision already applied, so it is refused — without
    // which it would put the streak back to before the relay's return.
    const r = room({ syncRev: 0, servingPlayer: 0 });
    applyMatchSync(r, sync({ rev: 4, p1Score: 0, bestStreaks: [3, 0], streaks: [3, 0], earnedBests: [3, 0], crossingsThisPoint: 4 }));
    expect(r.streaks).toEqual([3, 0]);

    // Fallback: the relay counts the next crossing itself, as server.ts does —
    // and deliberately does NOT touch syncRev while doing it (see below).
    countReturn(r, 0);
    expect(r.streaks).toEqual([4, 0]);

    // The duplicate of event 4 lands, describing the state one crossing ago.
    applyMatchSync(r, sync({ rev: 4, p1Score: 0, bestStreaks: [3, 0], streaks: [3, 0], earnedBests: [3, 0], crossingsThisPoint: 4 }));
    expect(r.streaks).toEqual([4, 0]);
    expect(r.crossingsThisPoint).toBe(5);
  });

  it('stops taking a diverged peer\u2019s account of the run once it is counting itself', () => {
    // The other half of the fallback, and the one a revision cannot catch.
    // The peer that noticed first relays a crossing; the relay counts it. The
    // peer that has NOT noticed is told about it only as a ball_incoming,
    // which its replica never sees — so its next snapshot is a genuinely later
    // revision describing a match one return short, and the fields it ASSIGNS
    // would undo what the relay counted.
    //
    // Nothing is lost by refusing them: a peer stops syncing the moment it
    // falls back, so a snapshot arriving after this can only be the diverged
    // one. The maxed fields keep being applied, because a peer still scoring
    // over its own link knows things the relay does not.
    const r = room({ syncRev: 0, servingPlayer: 0, config: normalizeRoomConfig({ winningScore: 5 }) });
    applyMatchSync(r, sync({ rev: 4, p1Score: 0, bestStreaks: [3, 0], streaks: [3, 0], earnedBests: [3, 0], crossingsThisPoint: 4 }));

    countReturn(r, 0); // relayed by the peer that fell back
    r.relayCounted = true; // as server.ts sets it beside that call
    expect(r.streaks).toEqual([4, 0]);
    expect(r.crossingsThisPoint).toBe(5);

    // The diverged peer's next event. Later revision, older picture.
    applyMatchSync(r, sync({ rev: 5, p1Score: 1, bestStreaks: [3, 0], streaks: [3, 0], earnedBests: [3, 0], servingPlayer: 1, crossingsThisPoint: 4 }));

    // The run and the point phase are the relay's now.
    expect(r.streaks).toEqual([4, 0]);
    expect(r.crossingsThisPoint).toBe(5);
    expect(r.servingPlayer).toBe(0);
    // The score still lands: it only ever goes up, and that peer saw a point
    // the relay did not. Refusing it would leave a half-fallen-back match
    // undecidable, which is worse than every problem it would solve.
    expect(r.scores[0]).toBe(1);
    // And the revision still moves, so the pair stays ordered.
    expect(r.syncRev).toBe(5);
  });

  it('stops merging peaks from a diverged replica too', () => {
    // A maximum looks safe because it cannot go down, and that is the problem.
    // Once the relay has taken over, the surviving peer's servingPlayer and
    // crossingsThisPoint are stale, so it can read a real SERVE as a return
    // and report one hit too many — and a maximum makes that permanent, into
    // the career best, the XP, the daily tasks and the performance weight.
    const r = room({ syncRev: 0, servingPlayer: 0 });
    applyMatchSync(r, sync({ rev: 1, bestStreaks: [2, 2], streaks: [2, 2], earnedBests: [2, 2], crossingsThisPoint: 3 }));
    expect(r.bestStreaks).toEqual([2, 2]);

    countReturn(r, 0);
    r.relayCounted = true;
    expect(r.bestStreaks).toEqual([3, 2]);

    // The diverged peer claims a peak the relay never saw it earn.
    applyMatchSync(r, sync({ rev: 2, bestStreaks: [9, 9], streaks: [9, 9], earnedBests: [9, 9], crossingsThisPoint: 3 }));
    expect(r.bestStreaks).toEqual([3, 2]);
    // Held where the last trustworthy snapshot and the relay's own count left
    // them — the claimed 9 lands nowhere.
    expect(r.earnedBests).toEqual([2, 2]);
  });

  it('hands authority back to the peers when a new match starts', () => {
    // A fallback belongs to the match it happened in. A rematch is a fresh
    // link as far as this is concerned — and the peers can agree one between
    // themselves, which the relay only learns about through applyMatchSync.
    const r = room({ syncRev: 9, servingPlayer: 0, relayCounted: true, matchOver: true, matchSeq: 1, scores: [5, 2] });
    applyMatchSync(r, sync({ matchSeq: 2, rev: 1, p1Score: 0, bestStreaks: [2, 2], streaks: [2, 2], earnedBests: [0, 0], servingPlayer: 1, crossingsThisPoint: 3 }));
    expect(r.matchSeq).toBe(2);
    expect(r.relayCounted).toBe(false);
    expect(r.streaks).toEqual([2, 2]);
    expect(r.servingPlayer).toBe(1);
    expect(r.crossingsThisPoint).toBe(3);
  });

  it('still takes a peer that has not noticed the link is down', () => {
    // A DataChannel does not fail for both peers at the same instant. The one
    // that notices first relays its next crossing; the one that has not
    // noticed keeps playing P2P and reports normally, and its snapshot is a
    // legitimate later event rather than a stale duplicate.
    //
    // This is why the relay must not count its own crossings into syncRev.
    // Sharing that number between two independently advancing clocks made the
    // second peer's next revision collide with the one the relay had just
    // taken, and its report — carrying the streak and possibly the final
    // score — was refused as stale.
    const r = room({ syncRev: 0, servingPlayer: 0 });
    applyMatchSync(r, sync({ rev: 4, p1Score: 0, bestStreaks: [3, 0], streaks: [3, 0], earnedBests: [3, 0], crossingsThisPoint: 4 }));
    countReturn(r, 0); // the relay handles one itself for the peer that fell back

    const late = applyMatchSync(r, sync({ rev: 5, p1Score: 0, bestStreaks: [3, 2], streaks: [3, 2], earnedBests: [3, 2], crossingsThisPoint: 5 }));
    expect(late.decided).toBe(false);
    expect(r.streaks).toEqual([3, 2]);
    expect(r.syncRev).toBe(5);
  });

  it('takes a snapshot that names no revision, and lets it move nothing', () => {
    // The relay's contract has to stay honest for a caller that does not send
    // one: unknown means current, not refused. It must also not claim the
    // mark, or the next real revision would look stale beside it.
    const r = room({ syncRev: 7 });
    const out = applyMatchSync(r, {
      matchSeq: 1, p1Score: 2, p2Score: 0,
      bestStreaks: [3, 1], streaks: [3, 1], earnedBests: [3, 1],
      servingPlayer: 0, crossingsThisPoint: 2,
    } as unknown as Parameters<typeof applyMatchSync>[1]);
    expect(out.decided).toBe(false);
    expect(r.scores).toEqual([2, 0]);
    expect(r.syncRev).toBe(7);
  });

  it('starts a new match’s revisions over', () => {
    // Revisions count from zero per match, so the last match's high-water mark
    // must not outlive it and reject every snapshot of the next one.
    const r = room({ syncRev: 400, matchOver: true, matchSeq: 1, scores: [5, 2] });
    applyMatchSync(r, sync({ matchSeq: 2, rev: 1, p1Score: 1, bestStreaks: [1, 0], streaks: [1, 0], earnedBests: [1, 0] }));
    expect(r.matchSeq).toBe(2);
    expect(r.scores).toEqual([1, 0]);
    expect(r.streaks).toEqual([1, 0]);
  });

  it('does not let a peer name a seat that does not exist as the server', () => {
    const r = room({ servingPlayer: 1 });
    applyMatchSync(r, sync({ p1Score: 1, servingPlayer: 7 as unknown as 0 | 1 }));
    expect(r.servingPlayer).toBe(1);
  });
});

describe('acceptRtcSignal', () => {
  // What this pins is the arming of match_sync, which is the single most
  // expensive thing a seated attacker can reach: applyMatchSync takes the
  // score as a MAXIMUM and declares the match decided on it, so one snapshot
  // naming the winning score for your own seat files a real ranked win for the
  // sender and a real ranked loss against an opponent whose client never
  // rendered a point of it — match_sync broadcasts no score_update.
  //
  // The guard shipped as `p2pOffered = true` on any relayed rtc_signal, before
  // the payload was looked at, so ONE frame of anything armed it and the
  // attacker needed nothing at all from the victim. A handshake takes two
  // seats and the relay stamps which seat each signal came from; that is the
  // part a lone socket cannot manufacture.
  const offer = { kind: 'offer', sdp: 'v=0' };
  const answer = { kind: 'answer', sdp: 'v=0' };

  it('does not arm a replica on one seat\'s signal', () => {
    const r = room();
    expect(acceptRtcSignal(r, 0, offer)).toBe(true);
    expect(r.p2pOffered).toBeFalsy();
  });

  it('does not arm a replica on both halves from the SAME seat', () => {
    // The attack, spelled out: a socket answering its own offer is not two
    // peers, however many frames it sends.
    const r = room();
    acceptRtcSignal(r, 0, offer);
    acceptRtcSignal(r, 0, answer);
    expect(r.p2pOffered).toBeFalsy();
  });

  it('arms a replica on an offer and an answer from different seats', () => {
    const r = room();
    acceptRtcSignal(r, 0, offer);
    acceptRtcSignal(r, 1, answer);
    expect(r.p2pOffered).toBe(true);
  });

  it('arms it whichever seat opens the negotiation', () => {
    const r = room();
    acceptRtcSignal(r, 1, offer);
    acceptRtcSignal(r, 0, answer);
    expect(r.p2pOffered).toBe(true);
  });

  it('refuses anything that is not one of the three signal kinds', () => {
    // Each of these was a valid signal before: the relay was a pure
    // pass-through with no shape check at all, so `{}` armed the replica and
    // was forwarded to the peer verbatim.
    for (const junk of [null, undefined, 'offer', 42, [], {}, { kind: 'bogus' }, { kind: 3 }]) {
      const r = room();
      expect(acceptRtcSignal(r, 0, junk), JSON.stringify(junk) ?? 'undefined').toBe(false);
      expect(r.p2pOffered).toBeFalsy();
      expect(r.rtcOfferFrom).toBeUndefined();
    }
  });

  it('refuses an offer or answer carrying no usable sdp', () => {
    for (const bad of [{ kind: 'offer' }, { kind: 'offer', sdp: '' }, { kind: 'answer', sdp: 7 }]) {
      const r = room();
      expect(acceptRtcSignal(r, 0, bad)).toBe(false);
      expect(r.rtcOfferFrom).toBeUndefined();
    }
  });

  it('bounds the sdp a seat may ask the relay to ferry', () => {
    const r = room();
    expect(acceptRtcSignal(r, 0, { kind: 'offer', sdp: 'v'.repeat(MAX_SDP_CHARS) })).toBe(true);
    expect(acceptRtcSignal(r, 0, { kind: 'offer', sdp: 'v'.repeat(MAX_SDP_CHARS + 1) })).toBe(false);
  });

  it('relays ice candidates but never arms a replica on them', () => {
    // Candidates trickle in any order and from both seats, and a null one is
    // the legitimate end-of-candidates marker — so counting them as evidence
    // would hand back the one-frame arming through a different door.
    const r = room();
    expect(acceptRtcSignal(r, 0, { kind: 'ice', candidate: null })).toBe(true);
    expect(acceptRtcSignal(r, 1, { kind: 'ice', candidate: { candidate: 'x' } })).toBe(true);
    expect(r.p2pOffered).toBeFalsy();
  });
});
