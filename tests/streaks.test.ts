import { describe, expect, it } from 'vitest';
import { PlayerStats } from '../src/types';
import {
  CarryStore,
  carriedStreak,
  opponentMiss,
  opponentReturn,
  ownMiss,
  ownReturn,
  rememberCarry,
  startMatchStreaks,
} from '../src/game/streaks';

// The client's half of the rally-streak rule.
//
// Reported in these words: "a rally streak must never be determined by the
// opponent's hit/miss". It was, twice over — one counter both players
// incremented, reset whenever EITHER of them scored. Your number rose when
// your opponent returned a ball and fell to zero when they missed one.
//
// The relay's half of the same rule is pinned in tests/room.test.ts and,
// end to end through a real server, in tests/duelRecord.test.ts. This is the
// half only the client can know: a solo match has no relay in it at all.
//
// It lives in src/game/streaks.ts rather than inside App.tsx for the reason
// server/room.ts lives outside server.ts — a rule wants a test, and testing
// this one through the component would mean a canvas, a paddle, a real AI and
// a great deal of luck. That was tried: a scripted browser match cannot be
// relied on to produce a single rally, and TESTING.md is explicit that a
// flaky suite is worse than none.

const base = (over: Partial<PlayerStats> = {}): PlayerStats => ({
  score: 0,
  opponentScore: 0,
  streak: 0,
  bestStreak: 0,
  earnedStreak: 0,
  earnedBest: 0,
  oppStreak: 0,
  oppBestStreak: 0,
  aces: 0,
  matchesWon: 0,
  ...over,
});

describe('a rally streak belongs to one player', () => {
  it('counts this player’s own returns, and raises their best with them', () => {
    let s = base();
    s = ownReturn(ownReturn(ownReturn(s)));
    expect(s.streak).toBe(3);
    expect(s.bestStreak).toBe(3);
    // And leaves the opponent's alone entirely.
    expect(s.oppStreak).toBe(0);
    expect(s.oppBestStreak).toBe(0);
  });

  it('counts the opponent’s returns against the opponent', () => {
    let s = base({ streak: 4, bestStreak: 9 });
    s = opponentReturn(opponentReturn(s));
    expect(s.oppStreak).toBe(2);
    expect(s.oppBestStreak).toBe(2);
    // THE bug: these used to be the same number, so this was +2 for the
    // player as well.
    expect(s.streak).toBe(4);
    expect(s.bestStreak).toBe(9);
  });

  it('ends only on this player’s own miss', () => {
    const s = ownMiss(base({ streak: 6, bestStreak: 6, oppStreak: 3, oppBestStreak: 3 }));
    expect(s.streak).toBe(0);
    expect(s.bestStreak).toBe(6);
    // The opponent was mid-streak of their own and stays that way.
    expect(s.oppStreak).toBe(3);
  });

  it('survives the opponent’s miss, which is a point WON', () => {
    // The rule in one case. Under the shared counter this zeroed both.
    const s = opponentMiss(base({ streak: 6, bestStreak: 6, oppStreak: 4, oppBestStreak: 7 }));
    expect(s.streak).toBe(6);
    expect(s.oppStreak).toBe(0);
    expect(s.oppBestStreak).toBe(7);
  });

  it('runs across points, so a run of won points is one streak', () => {
    let s = base();
    // Return, return, the opponent misses (point won), return again.
    s = ownReturn(ownReturn(s));
    s = opponentMiss(s);
    s = ownReturn(s);
    s = opponentMiss(s);
    s = ownReturn(s);
    expect(s.streak).toBe(4);
    expect(s.bestStreak).toBe(4);
  });

  it('keeps the best once the run ends', () => {
    let s = base();
    for (let i = 0; i < 11; i++) s = ownReturn(s);
    s = ownMiss(s);
    expect(s.streak).toBe(0);
    expect(s.bestStreak).toBe(11);
    // A shorter run afterwards does not walk the best backwards.
    s = ownReturn(ownReturn(s));
    expect(s.bestStreak).toBe(11);
  });

  it('never touches the score, which is somebody else’s job', () => {
    const s = base({ score: 3, opponentScore: 2, aces: 1, matchesWon: 5 });
    for (const f of [ownReturn, ownMiss, opponentReturn, opponentMiss]) {
      const out = f(s);
      expect(out.score).toBe(3);
      expect(out.opponentScore).toBe(2);
      expect(out.aces).toBe(1);
      expect(out.matchesWon).toBe(5);
    }
  });
});

describe('a streak carries between matches', () => {
  // A match ending is not a miss, and a miss is the only thing that ends a
  // run. So the next match opens on whatever this player walked in with.

  it('opens a match on the run this player already had', () => {
    const s = startMatchStreaks(base({ score: 5, opponentScore: 3 }), 12);
    expect(s.streak).toBe(12);
    // The per-match peak starts AT the carried run: it is genuinely part of
    // the longest streak this match will contain.
    expect(s.bestStreak).toBe(12);
    // The score is the caller's business, like it is for every other function
    // in here — this one only ever answers questions about streaks.
    expect(s.score).toBe(5);
    expect(s.opponentScore).toBe(3);
  });

  it('starts the opponent from nothing, because they are a different opponent', () => {
    const s = startMatchStreaks(base({ oppStreak: 8, oppBestStreak: 14 }), 12);
    expect(s.oppStreak).toBe(0);
    expect(s.oppBestStreak).toBe(0);
  });

  it('carries a run through a match and out the other side', () => {
    let s = startMatchStreaks(base(), 6);
    s = ownReturn(ownReturn(s));       // 8
    s = opponentMiss(s);               // a point won: untouched
    expect(s.streak).toBe(8);
    // Next match, opened on where the last one left off.
    s = startMatchStreaks(s, s.streak);
    expect(s.streak).toBe(8);
    s = ownReturn(s);
    expect(s.streak).toBe(9);
    expect(s.bestStreak).toBe(9);
  });

  it('carries nothing when the last match ended on a miss', () => {
    let s = startMatchStreaks(base(), 6);
    s = ownReturn(s);                  // 7
    s = ownMiss(s);                    // ended on a miss
    expect(s.streak).toBe(0);
    expect(s.bestStreak).toBe(7);      // the peak is still the peak
    s = startMatchStreaks(s, s.streak);
    expect(s.streak).toBe(0);
    expect(s.bestStreak).toBe(0);
  });

  it('refuses a nonsense carry rather than propagating it', () => {
    for (const junk of [-5, NaN, undefined as unknown as number, 'lots' as unknown as number]) {
      expect(startMatchStreaks(base(), junk).streak).toBe(0);
    }
    expect(startMatchStreaks(base(), 7.6).streak).toBe(8);
  });
});


describe('what a match EARNED is not what its run reached', () => {
  // XP is paid per rally. bestStreak opens on whatever was carried in, so
  // paying on it pays for the same run again in every match it spans — and on
  // the Practice Wall, where a session is entered and left at will, that was a
  // farm: carry a run in, open the wall, leave without touching the ball, and
  // collect for it again, up to the daily cap, every day.

  it('starts a match having earned nothing, however long the run walked in', () => {
    const s = startMatchStreaks(base(), 40);
    expect(s.streak).toBe(40);
    expect(s.bestStreak).toBe(40);
    expect(s.earnedStreak).toBe(0);
    expect(s.earnedBest).toBe(0);
  });

  it('counts only the returns made here', () => {
    let s = startMatchStreaks(base(), 10);
    s = ownReturn(ownReturn(s));
    // The run really is 12 — that is what a career best is about.
    expect(s.bestStreak).toBe(12);
    // Two of them were made here, and that is what gets paid.
    expect(s.earnedBest).toBe(2);
  });

  it('ends the earned run on a miss, like the run itself', () => {
    let s = startMatchStreaks(base(), 10);
    s = ownReturn(ownReturn(ownReturn(s)));
    s = ownMiss(s);
    expect(s.streak).toBe(0);
    expect(s.earnedStreak).toBe(0);
    // Both peaks stand.
    expect(s.bestStreak).toBe(13);
    expect(s.earnedBest).toBe(3);
  });

  it('leaves the earned run alone when the OPPONENT misses', () => {
    let s = startMatchStreaks(base(), 6);
    s = ownReturn(s);
    s = opponentMiss(s);
    expect(s.earnedStreak).toBe(1);
    expect(s.streak).toBe(7);
  });
});

describe('which run the next match opens on', () => {
  it('falls back to the profile when this page has played nothing', () => {
    const store: CarryStore = {};
    expect(carriedStreak(store, 'solo', 9)).toBe(9);
    expect(carriedStreak(store, 'practice', 0)).toBe(0);
  });

  it('prefers what this page saw over what the profile last said', () => {
    // The bug this exists for: a solo win can leave the run intact, and Play
    // Again is a synchronous button while the match POST is not. Read from the
    // profile alone, the replay opens on the run from BEFORE the match just
    // played — and then reports the smaller number back over the correct one.
    const store: CarryStore = {};
    rememberCarry(store, 'solo', 12);
    expect(carriedStreak(store, 'solo', 4)).toBe(12); // 4 is the stale profile
  });

  it('carries a broken run as broken, not as the peak it reached', () => {
    // A maximum here would be exactly the bug: a run legitimately ends at zero.
    const store: CarryStore = {};
    rememberCarry(store, 'solo', 12);
    rememberCarry(store, 'solo', 0);
    expect(carriedStreak(store, 'solo', 12)).toBe(0);
  });

  it('keeps the modes apart', () => {
    const store: CarryStore = {};
    rememberCarry(store, 'solo', 7);
    expect(carriedStreak(store, 'solo', 0)).toBe(7);
    // Practice has its own run and has not been played here, so the profile
    // still answers for it.
    expect(carriedStreak(store, 'practice', 3)).toBe(3);
  });

  it('carries nothing for split, from either source', () => {
    // Only one of the two people at that phone has an account to write to.
    const store: CarryStore = {};
    rememberCarry(store, 'split', 40);
    expect(store.split).toBeUndefined();
    expect(carriedStreak(store, 'split', 40)).toBe(0);
  });

  it('refuses a nonsense ending run rather than carrying it', () => {
    const store: CarryStore = {};
    rememberCarry(store, 'solo', -5);
    expect(carriedStreak(store, 'solo', 0)).toBe(0);
    rememberCarry(store, 'solo', Number.NaN);
    expect(carriedStreak(store, 'solo', 0)).toBe(0);
    expect(carriedStreak({}, 'solo', Number.NaN)).toBe(0);
  });
});

describe('the opponent’s run, where it is known', () => {
  it('starts a duel on what the relay says BOTH seats walk in on', () => {
    // game_start carries [p1, p2]. Passing only our own seat left the
    // telemetry overlay showing the opponent on zero until they built a new
    // run, while the relay and the P2P replica held the real number.
    const s = startMatchStreaks(base(), 7, 4);
    expect(s.streak).toBe(7);
    expect(s.bestStreak).toBe(7);
    expect(s.oppStreak).toBe(4);
    expect(s.oppBestStreak).toBe(4);
  });

  it('still starts the opponent at zero when nobody knows', () => {
    // A solo opponent is an AI that has just been constructed, so there is no
    // carried run to show — the argument is optional for exactly that.
    const s = startMatchStreaks(base(), 7);
    expect(s.oppStreak).toBe(0);
    expect(s.oppBestStreak).toBe(0);
  });

  it('pays and rates on nothing the opponent brought with them', () => {
    // The opponent's side is display only. Their carry must not reach the
    // earned figures, which are what this match is paid on.
    const s = startMatchStreaks(base(), 7, 40);
    expect(s.earnedStreak).toBe(0);
    expect(s.earnedBest).toBe(0);
  });
});
