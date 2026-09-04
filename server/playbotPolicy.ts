// What an autonomous play-bot CHOOSES — which opponent, which venue, whether
// to play again — and, more importantly, what it can never choose.
//
// Pure over what it is handed, the shape `server/matchmaking.ts` and
// `server/room.ts` already use: a bot's choices are worth arguing about in a
// test rather than on a live server. No clock, no random source, no database
// reach, so nothing it decides depends on state a test cannot see and two bots
// cannot coordinate through a shared one.
//
// THE BOUNDARY, because it is easy to blur: this file owns an autonomous
// bot's OWN preferences. It does not own how the shared queue ranks pairs —
// that is `server/matchmaking.ts`, whose pair-class precedence is a queue
// concept and knows nothing about which opponent a bot would LIKE.
//
// §2.11: diversity is a PREFERENCE, not a prohibition. Where comparably
// suitable opponents are available a bot prefers the less recently played one,
// so the same-pair ladder is a safeguard rather than the mechanism that
// normally controls pairing. It is NEVER a refusal — a bot with no comparable
// alternative plays the opponent it has, low population is a legitimate reason
// to repeat one, and an explicit human Rematch is legitimate play that nothing
// here may block or decline.
//
// What a bot must not do is feed wins, trade wins, coordinate, team up, or
// select opponents in order to farm. That is enforced by SHAPE rather than by
// a rule: nothing here takes or returns a score, a winner or an outcome, so
// there is no surface through which any of it could be expressed.

import { winProbability, type Rating } from '../src/rating';
import type { PlaybotTraits } from './playbotTraits';

/** Somebody this bot could play, as the caller knows them. */
export interface PolicyCandidate {
  id: string;
  isBot: boolean;
  mu: number;
  sigma: number;
  /** Completed matches with THIS bot in the rolling window — §2.3's counter. */
  recentPairCount: number;
  /** When they last played, ms epoch, or null for never. */
  lastPlayedAt: number | null;
}

export interface PolicySelf {
  id: string;
  mu: number;
  sigma: number;
  traits: PlaybotTraits;
}

/**
 * How far from a coin flip a match may be and still count as "comparably
 * suitable" — the band inside which the diversity preference decides.
 *
 * Wide enough that an ordinary roster offers a bot several comparable
 * opponents, so the preference has something to choose BETWEEN; narrow enough
 * that it never prefers a fresh mismatch over a suitable repeat, which is the
 * failure that would make bots play games nobody learns anything from.
 */
export const COMPARABLE_BAND = 0.15;

const rating = (x: { mu: number; sigma: number }): Rating => ({ mu: x.mu, sigma: x.sigma });

/** Distance from an even match. 0 is a coin flip, 0.5 is a certainty. */
const imbalance = (self: PolicySelf, c: PolicyCandidate): number =>
  Math.abs(winProbability(rating(self), rating(c)) - 0.5);

/**
 * Who this bot would rather play.
 *
 * Suitability FIRST, then diversity within it. Reversed, a bot would prefer a
 * fresh hopeless opponent over a suitable repeat, and §2.11 is explicit that
 * the preference is between COMPARABLY suitable ones.
 *
 * Returns null only when there is nobody at all. There is deliberately no
 * "refuse" branch: every non-empty candidate list produces an opponent.
 */
export function chooseOpponent(ctx: {
  self: PolicySelf;
  candidates: PolicyCandidate[];
  now: number;
}): PolicyCandidate | null {
  const others = ctx.candidates.filter((c) => c.id !== ctx.self.id);
  if (!others.length) return null;

  // The most suitable opponent available sets the bar; anyone within the band
  // of it is comparable, and the preference decides among those. On a roster
  // with one plausible opponent the band holds exactly them, which is what
  // makes "never a refusal" fall out rather than needing its own branch.
  const best = Math.min(...others.map((c) => imbalance(ctx.self, c)));
  const comparable = others.filter((c) => imbalance(ctx.self, c) <= best + COMPARABLE_BAND);

  return [...comparable].sort((a, b) => {
    // Less recently played, by how MUCH first and by how LONG ago second.
    if (a.recentPairCount !== b.recentPairCount) return a.recentPairCount - b.recentPairCount;
    const at = a.lastPlayedAt ?? -Infinity;
    const bt = b.lastPlayedAt ?? -Infinity;
    if (at !== bt) return at - bt;
    // A total order, so the answer never depends on the order they arrived in.
    return a.id < b.id ? -1 : 1;
  })[0];
}

/**
 * Where this bot goes to play.
 *
 * `allowed` is the set of venues the bracket gate says it may enter, supplied
 * by the caller: this must never propose a room the relay would refuse, or a
 * bot spends its life being turned away. `roll` is injected for the same
 * reason nothing here reads a clock.
 */
export function chooseVenue(a: {
  traits: PlaybotTraits;
  /** [0,1). */
  roll: number;
  allowed: string[];
}): string | null {
  if (!a.allowed.length) return null;
  const ranked = a.allowed.filter((v) => v !== 'casual');
  const casual = a.allowed.filter((v) => v === 'casual');
  const wantsRanked = a.roll < a.traits.rankedBias;
  const pool = wantsRanked ? (ranked.length ? ranked : casual) : casual.length ? casual : ranked;
  return pool[Math.floor(a.roll * pool.length) % pool.length];
}

/**
 * Whether this bot plays that opponent again.
 *
 * A HUMAN's request is accepted unconditionally, at any pair count, including
 * past the same-pair hard cap — where the match simply rates nothing. That is
 * a rating decision and never a reason to refuse somebody a game.
 *
 * Between two bots there is nobody to disappoint, so the preference applies:
 * appetite, tapered by how much of this pair has already been played.
 */
export function acceptsRematch(a: {
  traits: PlaybotTraits;
  fromHuman: boolean;
  recentPairCount: number;
  /** [0,1). */
  roll: number;
}): boolean {
  if (a.fromHuman) return true;
  // Tapered to zero across the bot-involved pair ladder's own span, so a bot
  // stops OFFERING at about the point the ladder stops rating — a preference
  // that tracks the safeguard rather than duplicating it.
  const taper = Math.max(0, 1 - a.recentPairCount / 12);
  return a.roll < a.traits.rematchAppetite * taper;
}
