import { describe, expect, it } from 'vitest';
import {
  applyMatchSync,
  breakStreakOnPoint,
  clampInt,
  countReturn,
  resetStreaks,
  startMatchStreaks,
  generateRoomCode,
  isRoomEmpty,
  performanceWeight,
  reapRooms,
  Room,
  ROOM_CODE_ALPHABET,
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
  servingPlayer: 0,
  rematchVotes: [false, false],
  config: normalizeRoomConfig({ winningScore: 5 }),
  matchOver: false,
  ready: [false, false],
  inPlay: false,
  matchSeq: 1,
  lastActive: 0,
  createdAt: 0,
  pairedAt: null,
  ...over,
});

const sync = (over: Partial<Parameters<typeof applyMatchSync>[1]> = {}) => ({
  matchSeq: 1,
  p1Score: 0,
  p2Score: 0,
  bestStreaks: [0, 0] as [number, number],
  streaks: [0, 0] as [number, number],
  earnedBests: [0, 0] as [number, number],
  servingPlayer: 0 as 0 | 1,
  crossingsThisPoint: 0,
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

  it('clears rematch votes when the match decides, so none are banked early', () => {
    const r = room({ rematchVotes: [true, false] });
    applyMatchSync(r, sync({ p1Score: 5 }));
    expect(r.rematchVotes).toEqual([false, false]);
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
      ['HELD', room({ players: [seat(true, 0), seat(false, 1)], lastActive: MINUTE, createdAt: MINUTE })],
    ]);
    expect(reapRooms(rooms, MINUTE, OPTS)).toEqual([]);
    expect(rooms.size).toBe(1);
  });

  it('deletes a live room that has gone quiet past the idle clock', () => {
    const rooms = new Map<string, Room>([
      ['IDLE', room({ players: [seat(true, 0), seat(true, 1)], lastActive: 0, pairedAt: 0, createdAt: 0 })],
    ]);
    expect(reapRooms(rooms, 5000, OPTS)[0].reason).toBe('idle');
  });

  it('keeps a live room that is still talking', () => {
    const rooms = new Map<string, Room>([
      ['BUSY', room({ players: [seat(true, 0), seat(true, 1)], lastActive: 4500, pairedAt: 0, createdAt: 0 })],
    ]);
    expect(reapRooms(rooms, 5000, OPTS)).toEqual([]);
  });

  // The one rule that can expire a busy room, and the reason it had to exist:
  // lastActive is refreshed by every paddle_move, so a host sitting alone on a
  // court streams their own room's idle clock forward for as long as they hold
  // the phone. Nothing else in here can ever reach that room.
  it('expires a room that never got a second player, however busy its first is', () => {
    const rooms = new Map<string, Room>([
      ['SOLO', room({ players: [seat(true, 0), null], createdAt: 0, lastActive: 9000, pairedAt: null })],
    ]);
    expect(reapRooms(rooms, 9000, OPTS)[0].reason).toBe('unpaired');
  });

  it('leaves an unpaired room alone until its TTL is up', () => {
    const rooms = new Map<string, Room>([
      ['WAIT', room({ players: [seat(true, 0), null], createdAt: 0, lastActive: 4000, pairedAt: null })],
    ]);
    expect(reapRooms(rooms, 4000, OPTS)).toEqual([]);
  });

  // pairedAt is never cleared, so a guest leaving does not hand the room back
  // to the unpaired clock — a room that has been a duel is one a rematch can
  // still happen in, and only the idle clock judges that.
  it('never applies the unpaired TTL to a room that has been a duel', () => {
    const rooms = new Map<string, Room>([
      ['USED', room({ players: [seat(true, 0), null], createdAt: 0, lastActive: 9000, pairedAt: 10 })],
    ]);
    expect(reapRooms(rooms, 9000, OPTS)).toEqual([]);
  });

  it('hands back what it removed and leaves the rest of the map alone', () => {
    const rooms = new Map<string, Room>([
      ['GONE', room({ id: 'GONE', lastActive: MINUTE })],
      ['KEPT', room({ id: 'KEPT', players: [seat(true, 0), null], createdAt: MINUTE, lastActive: MINUTE })],
    ]);
    const dead = reapRooms(rooms, MINUTE, OPTS);
    expect(dead).toHaveLength(1);
    expect(dead[0].room.id).toBe('GONE');
    expect([...rooms.keys()]).toEqual(['KEPT']);
  });
});

describe('isRoomEmpty', () => {
  it('reads a seat holding a dead socket as vacant', () => {
    expect(isRoomEmpty(room({ players: [seat(false, 0), null] }), live as never)).toBe(true);
    expect(isRoomEmpty(room({ players: [seat(true, 0), null] }), live as never)).toBe(false);
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

  it('does not let a peer name a seat that does not exist as the server', () => {
    const r = room({ servingPlayer: 1 });
    applyMatchSync(r, sync({ p1Score: 1, servingPlayer: 7 as unknown as 0 | 1 }));
    expect(r.servingPlayer).toBe(1);
  });
});
