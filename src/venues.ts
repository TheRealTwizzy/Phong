import { AIDifficulty, GameMode, PlayerProfile } from './types';
import { TIER_ORDER, Tier } from './rating';

// Buildings, rooms and who may enter them — shared by client and server, like
// profileRules.ts, matchRules.ts, rating.ts and achievements.ts. The server
// imports from here so the menu's lock and the relay's refusal cannot drift:
// the menu is the client, so a bracket it draws is a bracket the relay has to
// enforce (the same reasoning that put DIFFICULTY_LOCKED behind
// /api/match/record rather than trusting the picker).
//
// The shape is a place, not a filter. A player walks into a BUILDING (what
// kind of game), picks a ROOM (who they are playing and at what level), and —
// in PvP — sits at a TABLE inside it. Solo and Training rooms have no tables:
// there is no host to wait for and no opponent to seat, so a room there opens
// the pre-match sheet directly.

export type BuildingId = 'solo' | 'pvp' | 'training';

/**
 * The hidden room the matchmaking queue seats its pairs in. Never listed and
 * never browsable — `listable: false` below is what excludes it, as DATA
 * rather than a special case in the listing route.
 */
export const MATCHMAKING_ROOM = '_queue';

/**
 * The venue a table created without one belongs to.
 *
 * Load-bearing for compatibility: an old bundle, the invite flow and the test
 * harness all call `create_room` with no venue, and this default must be a
 * room whose gate can never refuse anybody — otherwise those callers start
 * being turned away by a bracket they never asked to enter.
 *
 * It used to be `casual`, and that had to stop the moment Casual became the
 * room that does not rate. The name was carrying two unrelated jobs — "the
 * ungated PvP bracket" and "where a table with no venue lives" — and making
 * one of them unranked would have taken the ladder away from the other: every
 * invite-code duel, every old bundle, every table the test harness seats.
 * Casual is somewhere a player WALKS INTO and chooses; this is where a table
 * lands when nobody chose at all, which is a private match two people arranged
 * between themselves, and those rate exactly as they always have.
 */
export const DEFAULT_VENUE_ROOM = '_default';

export interface BuildingDef {
  id: BuildingId;
  labelKey: string;
  descKey: string;
  /** lucide icon name, resolved by the component. */
  icon: string;
}

// The first two reuse the copy the mode rows used to carry: the strings are
// still true of the building, and tests/i18n.test.ts fails on a key nothing
// quotes — so reusing them is what keeps them alive rather than orphaned.
export const BUILDINGS: BuildingDef[] = [
  { id: 'solo', labelKey: 'mode_solo', descKey: 'menu_solo_desc', icon: 'bot' },
  { id: 'pvp', labelKey: 'mode_multiplayer', descKey: 'menu_multiplayer_desc', icon: 'smartphone' },
  { id: 'training', labelKey: 'building_training', descKey: 'building_training_desc', icon: 'dumbbell' },
];

/**
 * The building the menu opens on.
 *
 * Solo rather than the headline PvP, because it is the one a player alone
 * with one phone can start right now — and because a brand-new player has
 * nothing else available anyway.
 */
export const DEFAULT_BUILDING: BuildingId = 'solo';

/**
 * Who may PLAY in a room. Brackets are enforced at BOTH ends — a Legend may
 * not drop into BEGINNER — because a bracket with only a floor is a bracket a
 * veteran can farm. Spectating is gated by neither (see `spectators` below):
 * watching the top of the ladder costs nobody a match.
 */
export interface RoomGate {
  level?: number;
  /** Inclusive. */
  tierMin?: Tier;
  /** Inclusive. */
  tierMax?: Tier;
}

export interface RoomDef {
  id: string;
  building: BuildingId;
  /**
   * Absent only for a room that is never rendered (the queue's). A room
   * nothing draws needs no copy, and an unused key fails tests/i18n.test.ts.
   */
  labelKey?: string;
  descKey?: string;
  gate?: RoomGate;
  /** Solo rooms only: the rung this room plays. A room IS a difficulty. */
  difficulty?: AIDifficulty;
  /** Training rooms only: the mode this room starts. */
  mode?: GameMode;
  /**
   * Whether tables here may open spectator seats.
   *
   * FALSE in the top three brackets, and that is the whole answer to the
   * spectator/ranked question: a spectator watches the hidden half live with
   * sonar forced on and can simply describe it over a voice call, which is
   * the sonar rule (CLAUDE.md §12) with a second person attached. Drawing the
   * line by ROOM rather than per-match is still what keeps that off the match
   * itself: there is no sticky per-match flag, no forceUnranked, and nothing
   * in MatchRules, and a match in a room that permits watching rates exactly
   * as it always did.
   *
   * What has changed is the claim that came after it — that this needed no
   * new `unrankedReasons` case. `ranked` below is one, added deliberately and
   * for a DIFFERENT question. The room now answers two: who may watch, and
   * whether the ladder moves. They are separate answers that happen to be
   * given by the same object, and `spectators` is still not one of the things
   * that unranks a match.
   */
  spectators?: boolean;
  /**
   * Whether a match played at a table here moves the VISIBLE ladder.
   *
   * Absent means yes — the same shape as `listable`, where a room states the
   * exception rather than the rule. (Note that `spectators` two fields up is
   * read as `=== true` instead; the asymmetry is deliberate, since a room that
   * forgets to say is safer closed for watching and safer rated for playing.)
   *
   * FALSE in `casual` alone, whose own description has promised exactly this
   * in seven locales since the room shipped — "Any rank welcome. Play for the
   * game, not the ladder." — while the server rated it like any other bracket.
   * The copy was right and the code disagreed with it.
   */
  ranked?: boolean;
  /** Whether the room browser lists this room at all. */
  listable?: boolean;
}

/**
 * Rooms, in the order they are shown. PvP brackets ascend; solo rungs ascend.
 *
 * The PvP tier bands deliberately OVERLAP at their edges (intermediate ends
 * at master, advanced begins at ace) so a player sitting on a boundary has
 * two rooms open rather than one, and a rating that wobbles across a floor
 * does not lock them out of the room they were just playing in.
 */
export const ROOMS: RoomDef[] = [
  // ---- PVP: bracketed by tier and level -----------------------------------
  {
    id: 'casual',
    building: 'pvp',
    labelKey: 'room_casual',
    descKey: 'room_casual_desc',
    // Play for the game, not the ladder — which is what room_casual_desc has
    // said all along. Gated like a Rookie solo rather than like Practice:
    // hidden MMR still learns from the match, so the pre-match odds and the
    // queue stay honest, and only the visible tier stands still.
    ranked: false,
    spectators: true,
    listable: true,
  },
  {
    id: 'beginner',
    building: 'pvp',
    labelKey: 'room_beginner',
    descKey: 'room_beginner_desc',
    gate: { tierMax: 'contender' },
    spectators: true,
    listable: true,
  },
  {
    id: 'intermediate',
    building: 'pvp',
    labelKey: 'room_intermediate',
    descKey: 'room_intermediate_desc',
    gate: { level: 5, tierMin: 'contender', tierMax: 'master' },
    spectators: true,
    listable: true,
  },
  {
    id: 'advanced',
    building: 'pvp',
    labelKey: 'room_advanced',
    descKey: 'room_advanced_desc',
    gate: { level: 12, tierMin: 'ace', tierMax: 'grandmaster' },
    spectators: false,
    listable: true,
  },
  {
    id: 'elite',
    building: 'pvp',
    labelKey: 'room_elite',
    descKey: 'room_elite_desc',
    gate: { level: 20, tierMin: 'grandmaster', tierMax: 'legend' },
    spectators: false,
    listable: true,
  },
  {
    id: 'pro',
    building: 'pvp',
    labelKey: 'room_pro',
    descKey: 'room_pro_desc',
    gate: { level: 30, tierMin: 'legend' },
    spectators: false,
    listable: true,
  },
  // The queue's own room. Not in the PvP building's browser and not listable:
  // a pair is seated here by the relay, never walked into.
  { id: MATCHMAKING_ROOM, building: 'pvp', spectators: false, listable: false },
  // Where a table with no venue lives. Not listed and not walked into — it is
  // reached only by a caller that named nothing, so it needs no gate and no
  // browser. Spectators stay ALLOWED because the lobby asks
  // roomAllowsSpectators(venueRoomId || DEFAULT_VENUE_ROOM) while seated, and
  // closing them here would take the watching toggle off every invite table.
  { id: DEFAULT_VENUE_ROOM, building: 'pvp', spectators: true, listable: false },

  // ---- SOLO AI: one room per rung. Gated by the achievement chain, not by
  // a RoomGate — the ladder is walked through UNLOCKS in achievements.ts, and
  // duplicating that here would be a second answer to the same question.
  // No descKey: the rung's NAME and its win-chance are what a player picks on,
  // and a line of prose under each of five rows was five lines of prose to
  // scroll past. The odds beside the row say the same thing in a number.
  { id: 'rookie', building: 'solo', labelKey: 'room_rookie', difficulty: 'rookie' },
  { id: 'ai_pro', building: 'solo', labelKey: 'room_ai_pro', difficulty: 'pro' },
  { id: 'ai_elite', building: 'solo', labelKey: 'room_ai_elite', difficulty: 'elite' },
  { id: 'cyber', building: 'solo', labelKey: 'room_cyber', difficulty: 'cyber' },
  { id: 'chaos', building: 'solo', labelKey: 'room_chaos', difficulty: 'chaos' },

  // ---- TRAINING: no opponent to rate against, so nothing to gate ----------
  { id: 'practice', building: 'training', labelKey: 'mode_practice', descKey: 'menu_practice_desc', mode: 'practice' },
  { id: 'split', building: 'training', labelKey: 'mode_split', descKey: 'menu_split_desc', mode: 'split' },
];

const BY_ID = new Map(ROOMS.map((r) => [r.id, r]));

export const roomById = (id: string | null | undefined): RoomDef | undefined =>
  id ? BY_ID.get(id) : undefined;

export const roomsOf = (building: BuildingId): RoomDef[] =>
  ROOMS.filter((r) => r.building === building && r.listable !== false);

/**
 * A venue room id from an untrusted client, or the safe default.
 *
 * Whitelisted rather than accepted as free text: the table browser is keyed
 * on this, so an arbitrary string would make it an unbounded index keyed on
 * whatever a caller sends. The default is the ungated room, so a caller that
 * names nothing can never be refused by a bracket.
 */
export function normalizeVenueRoomId(value: unknown): string {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const room = BY_ID.get(key);
  return room && room.building === 'pvp' ? room.id : DEFAULT_VENUE_ROOM;
}

/** Whether tables in this venue may open spectator seats. */
export const roomAllowsSpectators = (venueRoomId: string): boolean =>
  roomById(normalizeVenueRoomId(venueRoomId))?.spectators === true;

/**
 * Whether a match at a table in this venue moves the visible ladder.
 *
 * Deliberately NOT built on `normalizeVenueRoomId`, which falls back to
 * DEFAULT_VENUE_ROOM for anything it does not recognise. This predicate is
 * asked by `recordMatch`, which sees solo and practice results too — and those
 * have no venue at all. Normalized, every one of them would resolve to the
 * default room and be judged by whatever that room happens to say, which is a
 * long way from "this match was not played at a table".
 *
 * So: no venue means yes, and an id this build does not know means yes. Both
 * are the same rule — only a room that says otherwise takes the ladder away.
 */
export function roomCountsForRank(venueRoomId: string | null | undefined): boolean {
  if (typeof venueRoomId !== 'string' || !venueRoomId.trim()) return true;
  return roomById(venueRoomId.trim().toLowerCase())?.ranked !== false;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Why a room is shut, if it is.
 *
 * Optional fields rather than a discriminated union, following the same
 * convention (and for the same reason) as UsernameResult in profileRules.ts:
 * `strictNullChecks` is off in this repo, so union narrowing does not apply
 * at the call sites and a union would simply fail to compile where it is read.
 */
export interface EntryVerdict {
  ok: boolean;
  reason?: 'level' | 'tier_low' | 'tier_high';
  /** reason 'level' */
  needLevel?: number;
  /** reason 'tier_low' */
  needTier?: Tier;
  /** reason 'tier_high' */
  maxTier?: Tier;
}

const OK: EntryVerdict = { ok: true };

/** Where a tier sits on the ladder. `unranked` is -1, and is handled apart. */
const tierRank = (tier: Tier): number => TIER_ORDER.indexOf(tier);

/**
 * Whether this profile may PLAY in this room.
 *
 * The one predicate both the menu and the relay ask, so a room the menu draws
 * as open is a room the relay will seat. Note what it deliberately does NOT
 * answer: whether they may SPECTATE (ungated — the bracket gates who plays),
 * and whether they may join a PRIVATE table by code (also ungated — an invite
 * is an invite, and two friends in different brackets are exactly who the
 * code flow exists for).
 *
 * An UNPLACED player (tier `unranked`, which is everybody until five ranked
 * games) is treated as below every floor: they may enter a room with no
 * tierMin — casual and beginner — and nothing above. That is deliberate
 * rather than incidental: a bracket is a statement about a rating, and an
 * unplaced player does not have one yet.
 */
export function roomEntryVerdict(
  room: RoomDef | undefined,
  profile: Pick<PlayerProfile, 'level' | 'tier'> | null | undefined
): EntryVerdict {
  if (!room?.gate) return OK;
  if (!profile) return OK; // nothing to judge yet; the relay re-checks on seat
  const gate = room.gate;
  if (gate.level !== undefined && (profile.level ?? 1) < gate.level) {
    return { ok: false, reason: 'level', needLevel: gate.level };
  }
  const tier = profile.tier ?? 'unranked';
  const rank = tierRank(tier);
  if (gate.tierMin !== undefined && rank < tierRank(gate.tierMin)) {
    // Covers `unranked` too: indexOf returns -1, which is below every floor.
    return { ok: false, reason: 'tier_low', needTier: gate.tierMin };
  }
  // A ceiling never excludes an unplaced player: they are below every floor,
  // so they belong in the low rooms rather than being refused by both ends.
  if (gate.tierMax !== undefined && rank >= 0 && rank > tierRank(gate.tierMax)) {
    return { ok: false, reason: 'tier_high', maxTier: gate.tierMax };
  }
  return OK;
}

export const canEnterRoom = (
  room: RoomDef | undefined,
  profile: Pick<PlayerProfile, 'level' | 'tier'> | null | undefined
): boolean => roomEntryVerdict(room, profile).ok;
