// What one play-bot IS, as opposed to what its results have made of it.
//
// Pure and injectable, the shape `server/matchmaking.ts` and `server/room.ts`
// already use: traits can be argued about in a test without booting a process
// or opening a socket.
//
// THE DISTINCTION THIS FILE EXISTS TO KEEP is three things apart:
//
//   persistent skill/style   intrinsic playing capability and behaviour  (stable)
//   match results            update mmrMu/mmrSigma and rankMu/rankSigma  (earned)
//   earned MMR / rank        the bot's competitive standing              (derived)
//
// A bot's skill is NOT a rank anything steers it toward. Nothing retunes an
// individual bot's competence because a controller would like more accounts in
// some band: it plays at the capability it has, and where that lands it on the
// ladder is whatever its matches produce, through the same `updateRating` and
// the same `tierFor` a human goes through. CREATION MAY SEED; NOTHING AFTER
// CREATION MAY STEER.
//
// The consequence worth stating, because it is the opposite of how the solo AI
// works: a bot's competence comes from its `skill` trait and NOT from its
// rating. Solo derives competence from the player's mu so the ladder adapts;
// a bot must not, or its strength would chase its own results and the rating
// would stop being a measurement of anything.

import { MAX_SPIN_READ, MIN_AI_COMPETENCE } from '../src/game/physics';

/** One bot's stable identity. Every field is [0,1] and every field is earned by nobody. */
export interface PlaybotTraits {
  /** Intrinsic playing capability — the competence this bot plays at. */
  skill: number;
  /** How far that competence swings between rallies. */
  volatility: number;
  /** How hard it plays for the corners rather than centring the return. */
  aggression: number;
  /** How much of the ball's spin it reads, as a fraction of what it may. */
  spinRead: number;
  /** How much of its play it seeks in ranked venues rather than Casual. */
  rankedBias: number;
  /** How often it enters the quick-match queue. */
  queueAppetite: number;
  /** How often it opens a public table. */
  hostAppetite: number;
  /** How often it joins somebody else's. */
  joinAppetite: number;
  /** How readily it offers or accepts a rematch. */
  rematchAppetite: number;
}

export const TRAIT_KEYS = [
  'skill',
  'volatility',
  'aggression',
  'spinRead',
  'rankedBias',
  'queueAppetite',
  'hostAppetite',
  'joinAppetite',
  'rematchAppetite',
] as const;

/**
 * What a bot with no traits recorded plays like.
 *
 * Mid-ladder and unremarkable on every axis, deliberately: a roster row from
 * before traits existed should read as an ordinary bot rather than as an
 * extreme one, and a default that is anybody's best or worst would skew the
 * population the first time one is missed.
 */
export const DEFAULT_TRAITS: PlaybotTraits = {
  skill: 0.5,
  volatility: 0.05,
  aggression: 0.5,
  spinRead: 0.5,
  rankedBias: 0.5,
  queueAppetite: 0.5,
  hostAppetite: 0.5,
  joinAppetite: 0.5,
  rematchAppetite: 0.5,
};

/** The band each trait is generated and clamped into. */
const TRAIT_RANGE: Record<keyof PlaybotTraits, [number, number]> = {
  // Never below the competence floor: a bot that cannot return a ball is not
  // an opponent, it is a walkover, and the ladder would rate it as one.
  skill: [MIN_AI_COMPETENCE, 1],
  // The whole range a difficulty style uses (`AI_STYLES` spans 0 to 0.08), plus
  // a little. A swing wider than this stops being a style and becomes noise.
  volatility: [0, 0.12],
  aggression: [0, 1],
  spinRead: [0, MAX_SPIN_READ],
  rankedBias: [0, 1],
  queueAppetite: [0, 1],
  hostAppetite: [0, 1],
  joinAppetite: [0, 1],
  rematchAppetite: [0, 1],
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * A deterministic stream from a string, so seeding is reproducible.
 *
 * The same shape the daily-mission deal uses and for the same reason: a
 * roster rebuilt from the same ids produces the same population, so a bot a
 * player recognises plays the way they remember without anything being stored
 * twice.
 */
function streamFor(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

/**
 * Seed one bot's traits from its id.
 *
 * CREATION, and only creation. There is deliberately no function here that
 * takes a target rank, a demand signal or a population shape — the absence is
 * the design (§4.13), and a caller that wants a thin band filled seeds another
 * bot rather than retuning one that is already playing.
 */
export function seedTraits(botId: string): PlaybotTraits {
  const next = streamFor(botId);
  const out = {} as PlaybotTraits;
  for (const key of TRAIT_KEYS) {
    const [lo, hi] = TRAIT_RANGE[key];
    out[key] = lo + next() * (hi - lo);
  }
  return out;
}

/** Coerce anything read from the database or a caller into a usable set. */
export function normalizeTraits(raw: Partial<PlaybotTraits> | null | undefined): PlaybotTraits {
  const out = {} as PlaybotTraits;
  for (const key of TRAIT_KEYS) {
    const [lo, hi] = TRAIT_RANGE[key];
    const v = raw?.[key];
    out[key] = typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : DEFAULT_TRAITS[key];
  }
  return out;
}

/**
 * The `AIStyle` this bot plays with — the same two fields a solo difficulty
 * has, so the driver hands `OpponentAI` a style rather than a difficulty name.
 */
export function styleFor(t: PlaybotTraits): { volatility: number; aggression: number } {
  return { volatility: t.volatility, aggression: t.aggression };
}
