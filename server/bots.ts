import { PLACEMENT_GAMES } from '../src/rating';

// The pace-setters on the leaderboard.
//
// A launched deployment has no players, and the boards deliberately refuse
// rows of zeros — so the first person to open the leaderboard saw an empty
// list, and the second saw themselves alone at rank 1. Neither tells you what
// the ladder is or what climbing it would look like.
//
// This roster is NOT a fake player base. Every row is labelled BOT in the UI,
// carries `rank: null` so it never occupies a human's rank number, and is
// hidden entirely by the humans-only toggle. That is the whole reason the
// leaderboard was built with a null-rank lane: bot rows are a scale drawn
// beside the ladder, not competitors on it.
//
// Note this reverses the launch decision to seed nothing (see the comment in
// tests/leaderboard.test.ts). It is one call in server.ts and one meta flag,
// so it reverts cleanly.

export interface BotSeed {
  /** Must start with `bot-`; that prefix is what every bot check keys on. */
  id: string;
  username: string;
  /** Rating anchor. Drives the visible tier through `tierFor`. */
  mu: number;
  xp: number;
  matchesPlayed: number;
  matchesWon: number;
  highestRally: number;
  totalPointsScored: number;
}

/**
 * Eight rungs from Rookie to Legend.
 *
 * The apex is deliberately vacant: nothing here reaches Cyber Overlord (μ37),
 * so the top of the ladder belongs to whoever actually earns it. A bot parked
 * at the summit would make the board's most motivating slot decorative.
 *
 * Every column moves with μ — win rate, level and best rally all rise
 * together — because a Legend with a losing record reads as furniture the
 * moment anyone looks twice. `tests/bots.test.ts` pins that monotonicity
 * rather than trusting the table to stay hand-consistent.
 *
 * `rankedGames` tracks `matchesPlayed`: the elo board renders it next to the
 * tier, and "5 ranked" beside 231 matches would contradict itself on screen.
 */
export const BOT_ROSTER: BotSeed[] = [
  { id: 'bot-ladder-01', username: 'CircuitPup',  mu: 17,   xp: 2900,  matchesPlayed: 24,  matchesWon: 8,   highestRally: 9,  totalPointsScored: 104 },
  { id: 'bot-ladder-02', username: 'StaticDrift', mu: 20,   xp: 4900,  matchesPlayed: 41,  matchesWon: 18,  highestRally: 13, totalPointsScored: 182 },
  { id: 'bot-ladder-03', username: 'HaloJet',     mu: 23,   xp: 7600,  matchesPlayed: 63,  matchesWon: 32,  highestRally: 17, totalPointsScored: 284 },
  { id: 'bot-ladder-04', username: 'NovaTrace',   mu: 25.5, xp: 10600, matchesPlayed: 88,  matchesWon: 48,  highestRally: 21, totalPointsScored: 398 },
  { id: 'bot-ladder-05', username: 'IronEcho',    mu: 27,   xp: 13400, matchesPlayed: 112, matchesWon: 64,  highestRally: 25, totalPointsScored: 509 },
  { id: 'bot-ladder-06', username: 'VoltHalcyon', mu: 29,   xp: 17600, matchesPlayed: 147, matchesWon: 89,  highestRally: 30, totalPointsScored: 668 },
  { id: 'bot-ladder-07', username: 'ZeroKelvin',  mu: 32,   xp: 22300, matchesPlayed: 186, matchesWon: 119, highestRally: 36, totalPointsScored: 848 },
  { id: 'bot-ladder-08', username: 'ObsidianArc', mu: 35,   xp: 27700, matchesPlayed: 231, matchesWon: 158, highestRally: 43, totalPointsScored: 1056 },
];

/** A roster row as `insertBot` wants it — losses and wins kept consistent. */
export function botProfileFields(bot: BotSeed) {
  return {
    id: bot.id,
    username: bot.username,
    mu: bot.mu,
    xp: bot.xp,
    matchesPlayed: bot.matchesPlayed,
    matchesWon: bot.matchesWon,
    matchesLost: bot.matchesPlayed - bot.matchesWon,
    highestRally: bot.highestRally,
    totalPointsScored: bot.totalPointsScored,
    multiplayerWins: bot.matchesWon,
    rankedGames: Math.max(PLACEMENT_GAMES, bot.matchesPlayed),
  };
}
