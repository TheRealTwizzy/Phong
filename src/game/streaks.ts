import { PlayerStats } from '../types';

// A rally streak, from the client's side of it.
//
// Reported as a bug in these words: "a rally streak must never be determined
// by the opponent's hit/miss". It was, twice over — one counter that BOTH
// players incremented, reset whenever EITHER of them scored. Your number went
// up when your opponent returned a ball and back to zero when they missed
// one, and said almost nothing about you.
//
// The rule now: a streak counts ONE player's own consecutive successful
// returns and breaks only when THAT player fails to return one. The opponent
// missing is a point you won, not a streak you lost, so a streak runs across
// points and ends on your own miss. The serve is not a return.
//
// The relay reaches the same numbers from ball_cross_net and point_scored
// (see countReturn / breakStreakOnPoint in server/room.ts). This is the same
// rule for the side that can see its own paddle: a solo match has no relay at
// all, and in a duel the local half is known a frame before the relay says so.
//
// Pure, and separate from App.tsx, for the reason server/room.ts is separate
// from server.ts: this is a rule, and a rule wants a test rather than a
// canvas, a paddle and a lot of luck.

const bump = (current: number, best: number): [number, number] => {
  const next = current + 1;
  return [next, Math.max(best, next)];
};

/** This player returned the ball. Their streak, and nobody else's. */
export function ownReturn(s: PlayerStats): PlayerStats {
  const [streak, bestStreak] = bump(s.streak, s.bestStreak);
  return { ...s, streak, bestStreak };
}

/**
 * This player let the ball past. The only thing that ends their streak — and
 * it ends theirs alone, whatever it does to the score.
 */
export function ownMiss(s: PlayerStats): PlayerStats {
  return { ...s, streak: 0 };
}

/** The opponent returned the ball. Tracked, and kept apart. */
export function opponentReturn(s: PlayerStats): PlayerStats {
  const [oppStreak, oppBestStreak] = bump(s.oppStreak, s.oppBestStreak);
  return { ...s, oppStreak, oppBestStreak };
}

/** The opponent let the ball past: a point for this player, not a streak. */
export function opponentMiss(s: PlayerStats): PlayerStats {
  return { ...s, oppStreak: 0 };
}

/**
 * Open a new match on a run this player already had going.
 *
 * A streak carries between matches, not only between points — starting a match
 * is not a miss, and a miss is the only thing that ends one. The per-match
 * high-water mark starts AT the carried run, because that run is genuinely
 * part of this match's longest.
 *
 * The opponent's side does start from nothing: the opponent is a different
 * opponent, or an AI that has just been constructed.
 */
export function startMatchStreaks(s: PlayerStats, carried: number): PlayerStats {
  const from = Math.max(0, Math.round(carried) || 0);
  return { ...s, streak: from, bestStreak: from, oppStreak: 0, oppBestStreak: 0 };
}

/** Wipe both runs outright — for a reset, not for a new match. */
export function clearStreaks(s: PlayerStats): PlayerStats {
  return { ...s, streak: 0, bestStreak: 0, oppStreak: 0, oppBestStreak: 0 };
}
