import { PlayerProfile, TitleId } from '../types';
import { TIER_ORDER, Tier } from '../rating';
import { findMission } from './missions';
import { COSMETICS } from './cosmetics';

// Titles: the second permanent reward type, beside cosmetics.
//
// A title is a word a player wears beside their name on the two profile cards
// — their own and the public one — and nowhere else. Deliberately NOT in the
// header pill: that capsule is exactly the 60px the toast stack is offset by,
// measured to the sub-pixel, and a third row there puts every notice over the
// header it exists to clear (CLAUDE.md §1).
//
// Why a second type exists at all: an elite task banks a permanent unlock the
// first time it is completed, and until this file every one of those was a
// THEME. Ten more elite tasks would have meant ten more themes against a
// palette-distinctness floor that the closest existing pair clears by 0.003,
// with the amber and blue bands already full. A title costs seven strings and
// no palette, so the elite pool can grow without spending the floor.
//
// The mechanics are the cosmetic's, on purpose: the same `unlockRequirement`
// arms, the same "absent from the picker until owned" rule, the same PUT to
// equip, the same server-side re-derivation that refuses a locked one. What is
// different is the fallback — an unknown title normalizes to NULL, never to a
// default, because a title is optional and "no title" is a real state.
//
// `MissionDef.unlocks` names a title id here exactly as it names a cosmetic id,
// and `elite_completions.unlockId` banks that string verbatim. So the two
// catalogues share ONE id namespace and must never collide (tests/titles.test.ts
// holds it), and an `unlocks` value is never renamed once shipped.

export interface TitleDef {
  id: TitleId;
  /** Spelled in full, never built from the id — tests/i18n.test.ts scans for the literal. */
  nameKey: string;
  unlockRequirement: {
    achievementId?: string;
    eliteMissionId?: string;
    minTier?: Tier;
    minLevel?: number;
  };
}

export const TITLES: Record<TitleId, TitleDef> = {
  // Banked by an elite task, the first time it is ever completed.
  unbroken: { id: 'unbroken', nameKey: 'title_unbroken', unlockRequirement: { eliteMissionId: 'elite_streak_10' } },
  scoreboard: { id: 'scoreboard', nameKey: 'title_scoreboard', unlockRequirement: { eliteMissionId: 'elite_points_120' } },
  sniper: { id: 'sniper', nameKey: 'title_sniper', unlockRequirement: { eliteMissionId: 'elite_aces_15' } },
  wallbreaker: { id: 'wallbreaker', nameKey: 'title_wallbreaker', unlockRequirement: { eliteMissionId: 'elite_wall_1000' } },
  clutch: { id: 'clutch', nameKey: 'title_clutch', unlockRequirement: { eliteMissionId: 'elite_close_3' } },
  'cold-steel': { id: 'cold-steel', nameKey: 'title_cold-steel', unlockRequirement: { eliteMissionId: 'elite_cyber_shutout' } },
  // Earned from the deep rungs of the achievement tree.
  centurion: { id: 'centurion', nameKey: 'title_centurion', unlockRequirement: { achievementId: 'level_100', minLevel: 100 } },
  overlord: { id: 'overlord', nameKey: 'title_overlord', unlockRequirement: { achievementId: 'tier_overlord', minTier: 'overlord' } },
  'chaos-ender': { id: 'chaos-ender', nameKey: 'title_chaos-ender', unlockRequirement: { achievementId: 'chaos_50' } },
  fixture: { id: 'fixture', nameKey: 'title_fixture', unlockRequirement: { achievementId: 'veteran_1000' } },
  metronome: { id: 'metronome', nameKey: 'title_metronome', unlockRequirement: { achievementId: 'rally_300' } },
  regular: { id: 'regular', nameKey: 'title_regular', unlockRequirement: { achievementId: 'daily_100' } },
  duelist: { id: 'duelist', nameKey: 'title_duelist', unlockRequirement: { achievementId: 'duels_100' } },
  juggernaut: { id: 'juggernaut', nameKey: 'title_juggernaut', unlockRequirement: { achievementId: 'streak_30' } },
  'ten-thousand': { id: 'ten-thousand', nameKey: 'title_ten-thousand', unlockRequirement: { achievementId: 'points_10000' } },
};

export const TITLE_IDS = Object.keys(TITLES) as TitleId[];

/**
 * Whether this profile may wear the title. The arms are ORed exactly as
 * `isCosmeticUnlocked` ORs its own, including the trailing `unranked` guard on
 * the tier arm: TIER_ORDER has no `unranked` entry, so `indexOf` is -1 on both
 * sides and `-1 >= -1` would pass without it.
 */
export function isTitleUnlocked(titleId: TitleId, profile: PlayerProfile | null): boolean {
  const title = TITLES[titleId];
  if (!title || !profile) return false;
  const req = title.unlockRequirement;

  if (req.achievementId && profile.achievements?.includes(req.achievementId)) return true;
  if (req.eliteMissionId) {
    const mission = findMission(req.eliteMissionId);
    if (mission?.unlocks && profile.eliteUnlocks?.includes(mission.unlocks)) return true;
  }
  if (req.minLevel && profile.level >= req.minLevel) return true;
  if (
    req.minTier &&
    profile.tier !== 'unranked' &&
    TIER_ORDER.indexOf(profile.tier) >= TIER_ORDER.indexOf(req.minTier)
  ) {
    return true;
  }
  return false;
}

/**
 * Whatever arrived — a request body, a row written by an older build — resolved
 * to a title this build has, or null. Null and not a default, deliberately:
 * `normalizeCosmeticId` falls back to the shipped default because a player
 * always wears SOME look, and a title is the reward type where wearing none is
 * the ordinary state. Routing a title through the cosmetic normalizer is the
 * mistake to watch for — it would answer 'neon'.
 */
export function normalizeTitleId(value: unknown): TitleId | null {
  if (typeof value !== 'string') return null;
  return value in TITLES ? (value as TitleId) : null;
}

/**
 * The display key for whatever an elite task's `unlocks` names — a cosmetic or
 * a title — so the mission card and the unlock toast can say what was banked
 * without knowing which catalogue it came from. Null for an id neither has,
 * which is what an older bundle meets when a newer server deals a task it has
 * never heard of.
 */
export function unlockNameKey(unlockId: string): string | null {
  if (unlockId in COSMETICS) return COSMETICS[unlockId as keyof typeof COSMETICS].nameKey;
  if (unlockId in TITLES) return TITLES[unlockId as TitleId].nameKey;
  return null;
}
