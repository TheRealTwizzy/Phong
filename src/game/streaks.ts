import { GameMode, PlayerStats } from '../types';

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
  const [earnedStreak, earnedBest] = bump(s.earnedStreak, s.earnedBest);
  return { ...s, streak, bestStreak, earnedStreak, earnedBest };
}

/**
 * This player let the ball past. The only thing that ends their streak — and
 * it ends theirs alone, whatever it does to the score.
 */
export function ownMiss(s: PlayerStats): PlayerStats {
  return { ...s, streak: 0, earnedStreak: 0 };
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
export function startMatchStreaks(
  s: PlayerStats,
  carried: number,
  oppCarried = 0
): PlayerStats {
  const from = Math.max(0, Math.round(carried) || 0);
  const oppFrom = Math.max(0, Math.round(oppCarried) || 0);
  return {
    ...s,
    streak: from,
    bestStreak: from,
    // From zero, always: this is the half that gets paid, and nothing carried
    // in was earned here.
    earnedStreak: 0,
    earnedBest: 0,
    // The opponent's run carries too, and in a duel the relay tells both
    // phones what each seat walks in on. Zero is the default because usually
    // nobody knows: a solo opponent is an AI that has just been constructed,
    // and the opponent's side is display only — the relay rates and pays each
    // player on their own run, never on what the other phone thinks it is.
    oppStreak: oppFrom,
    oppBestStreak: oppFrom,
  };
}

/** Wipe both runs outright — for a reset, not for a new match. */
export function clearStreaks(s: PlayerStats): PlayerStats {
  return {
    ...s,
    streak: 0,
    bestStreak: 0,
    earnedStreak: 0,
    earnedBest: 0,
    oppStreak: 0,
    oppBestStreak: 0,
  };
}

// ---------------------------------------------------------------------------
// Which run does the next match open on?
// ---------------------------------------------------------------------------
//
// Two sources, and a precedence between them.
//
// The stored run lives on the profile, per mode, and that is right: it has to
// survive a reload, a different browser and a different room. But the profile
// only learns a match's ending run when that match's POST comes back, and Play
// Again is a button the player can press long before that. Read from the
// profile alone, a replay opens on the run from BEFORE the match just played —
// throwing away a run a winning point had left intact, and then reporting the
// smaller number, which overwrites the correct one the server is holding.
//
// So the page remembers what it last saw for itself. That memory is only ever
// written by finishing a match here, which makes it at least as current as any
// profile this page is holding, and it is deliberately never cleared: a
// profile refreshed by the heartbeat can easily arrive BEFORE the match POST
// does, and clearing on one would put the stale value straight back.

/** What this page last saw its own run end on, per mode. */
export type CarryStore = Partial<Record<GameMode, number>>;

/**
 * Remember where a finished match left this player's run.
 *
 * Split banks nothing and carries nothing — only one of the two people at that
 * phone has an account — so it is not recorded even locally.
 */
export function rememberCarry(store: CarryStore, mode: GameMode, endStreak: number): void {
  if (mode === 'split') return;
  store[mode] = Math.max(0, Math.round(endStreak) || 0);
}

/**
 * The run a new match in `mode` opens on.
 *
 * `stored` is what the profile says. What this page saw for itself wins, per
 * the note above; the profile is the fallback, and the only source after a
 * reload or in a browser that has not played this mode yet.
 */
export function carriedStreak(store: CarryStore, mode: GameMode, stored: number): number {
  if (mode === 'split') return 0;
  const local = store[mode];
  if (local !== undefined) return local;
  return Math.max(0, Math.round(stored) || 0);
}
