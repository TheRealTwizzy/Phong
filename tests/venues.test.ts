import { describe, expect, it } from 'vitest';
import {
  BUILDINGS,
  DEFAULT_VENUE_ROOM,
  MATCHMAKING_ROOM,
  ROOMS,
  canEnterRoom,
  normalizeVenueRoomId,
  roomAllowsSpectators,
  roomById,
  roomCountsForRank,
  roomEntryVerdict,
  roomsOf,
} from '../src/venues';
import { AI_DIFFICULTIES, TIER_ORDER } from '../src/rating';
import type { Tier } from '../src/rating';

// Buildings, rooms and who may enter them. This is the one predicate the menu
// and the relay share, so what it says is what both do: a room the menu draws
// as open is a room the relay will seat, and a bracket is enforced at BOTH
// ends because a bracket with only a floor is one a veteran can farm.

const who = (level: number, tier: Tier) => ({ level, tier });

describe('the venue catalogue', () => {
  it('gives every room a building that exists, and unique ids', () => {
    const ids = ROOMS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const buildings = new Set(BUILDINGS.map((b) => b.id));
    for (const room of ROOMS) expect(buildings.has(room.building)).toBe(true);
  });

  it('covers every AI rung with exactly one solo room', () => {
    // A solo room IS a difficulty, so a rung without a room is a rung no
    // player can reach once the menu is rooms rather than a picker.
    const covered = roomsOf('solo').map((r) => r.difficulty);
    expect([...covered].sort()).toEqual([...AI_DIFFICULTIES].sort());
  });

  it('keeps the matchmaking room out of the browser', () => {
    // Excluded as DATA, not by a special case in the listing route.
    expect(roomById(MATCHMAKING_ROOM)?.listable).toBe(false);
    expect(roomsOf('pvp').some((r) => r.id === MATCHMAKING_ROOM)).toBe(false);
  });

  it('never offers spectator seats in a top bracket, and always in the low ones', () => {
    // The whole spectator/ranked answer, drawn by room: a spectator sees the
    // hidden half live with sonar forced on, which is the sonar rule with a
    // second person attached.
    for (const id of ['advanced', 'elite', 'pro', MATCHMAKING_ROOM]) {
      expect({ id, spectators: roomAllowsSpectators(id) }).toEqual({ id, spectators: false });
    }
    for (const id of ['casual', 'beginner', 'intermediate', DEFAULT_VENUE_ROOM]) {
      expect({ id, spectators: roomAllowsSpectators(id) }).toEqual({ id, spectators: true });
    }
    // DEFAULT_VENUE_ROOM is on that list deliberately: the lobby asks
    // roomAllowsSpectators(venueRoomId || DEFAULT_VENUE_ROOM) while seated, so
    // closing seats there would take the watching toggle off every table
    // created without a venue — the whole invite flow.
  });
});

describe('which venues move the visible ladder', () => {
  // Casual's own description has promised this in seven locales since the room
  // shipped — "Any rank welcome. Play for the game, not the ladder." — while
  // the server rated it like any other bracket. The copy was right.

  it('takes the ladder away from casual and from nothing else', () => {
    expect(roomCountsForRank('casual')).toBe(false);
    for (const id of ['beginner', 'intermediate', 'advanced', 'elite', 'pro']) {
      expect({ id, rates: roomCountsForRank(id) }).toEqual({ id, rates: true });
    }
  });

  it('leaves the ranked queue rating, and the default venue with it', () => {
    // The queue exists to pair people for RANKED play, and a venue-less table
    // is a private match two people arranged themselves. Both would have been
    // silently unranked if the default room were still casual.
    expect(roomCountsForRank(MATCHMAKING_ROOM)).toBe(true);
    expect(roomCountsForRank(DEFAULT_VENUE_ROOM)).toBe(true);
    expect(DEFAULT_VENUE_ROOM).not.toBe('casual');
  });

  it('rates a match with no venue at all, and one this build has never heard of', () => {
    // The trap this predicate is shaped to avoid. recordMatch asks it for
    // SOLO and PRACTICE results too, and those carry no venue — routed through
    // normalizeVenueRoomId they would every one of them resolve to the default
    // room and be judged by whatever it happens to say, which is a long way
    // from "this match was not played at a table". Only a room that says
    // otherwise takes the ladder away.
    for (const nothing of [undefined, null, '', '   ']) {
      expect(roomCountsForRank(nothing as unknown as string)).toBe(true);
    }
    for (const unknown of ['nonsense', 'rookie', 'practice', 'CASUAL_X']) {
      expect({ unknown, rates: roomCountsForRank(unknown) }).toEqual({ unknown, rates: true });
    }
  });

  it('reads a venue the way the relay stores one, case and space included', () => {
    expect(roomCountsForRank('  CASUAL  ')).toBe(false);
  });
});

describe('normalizeVenueRoomId', () => {
  it('accepts a real PvP room and defaults everything else', () => {
    expect(normalizeVenueRoomId('intermediate')).toBe('intermediate');
    expect(normalizeVenueRoomId('  ELITE  ')).toBe('elite');
    expect(normalizeVenueRoomId(MATCHMAKING_ROOM)).toBe(MATCHMAKING_ROOM);
    for (const junk of [undefined, null, '', 'nonsense', 42, {}, 'rookie', 'practice']) {
      // A solo/training room is not a venue a table can live in either.
      expect(normalizeVenueRoomId(junk as unknown)).toBe(DEFAULT_VENUE_ROOM);
    }
  });

  it('defaults to a room whose gate can never refuse anybody', () => {
    // Load-bearing: an old bundle, the invite flow and the test harness all
    // create a table with no venue. If the default were gated, those callers
    // would start being turned away by a bracket they never asked for.
    expect(roomById(DEFAULT_VENUE_ROOM)?.gate).toBeUndefined();
    expect(canEnterRoom(roomById(DEFAULT_VENUE_ROOM), who(1, 'unranked'))).toBe(true);
  });
});

describe('who may play in a room', () => {
  it('lets an unplaced player into the ungated rooms and nothing above', () => {
    // Everybody is `unranked` until five ranked games. A bracket is a
    // statement about a rating, and they do not have one yet — so they are
    // below every floor, and a ceiling must not ALSO exclude them.
    const fresh = who(1, 'unranked');
    expect(canEnterRoom(roomById('casual'), fresh)).toBe(true);
    expect(canEnterRoom(roomById('beginner'), fresh)).toBe(true);
    expect(canEnterRoom(roomById('intermediate'), who(50, 'unranked'))).toBe(false);
    expect(canEnterRoom(roomById('pro'), who(50, 'unranked'))).toBe(false);
  });

  it('enforces the ceiling as well as the floor', () => {
    // The half that a floor-only bracket misses: a Legend must not be able to
    // drop into the new-player room.
    expect(canEnterRoom(roomById('beginner'), who(40, 'legend'))).toBe(false);
    expect(roomEntryVerdict(roomById('beginner'), who(40, 'legend'))).toEqual({
      ok: false,
      reason: 'tier_high',
      maxTier: 'contender',
    });
    expect(canEnterRoom(roomById('beginner'), who(1, 'rookie'))).toBe(true);
  });

  it('names the level a room needs, and checks it before the tier', () => {
    // Level first because it is the one a player can always act on: "play
    // more" is advice, "be a better player" is not. Judged on somebody who
    // clears NEITHER gate, which is the case the ordering is for.
    expect(roomEntryVerdict(roomById('intermediate'), who(2, 'unranked'))).toEqual({
      ok: false,
      reason: 'level',
      needLevel: 5,
    });
    expect(roomEntryVerdict(roomById('pro'), who(1, 'ace'))).toEqual({
      ok: false,
      reason: 'level',
      needLevel: 30,
    });
  });

  it('lets a met tier floor stand in for the level', () => {
    // The level is a PROXY for experience and the tier floor is a measurement
    // of it, so a player who clears the floor has already done the thing the
    // level was standing in for.
    expect(canEnterRoom(roomById('intermediate'), who(2, 'ace'))).toBe(true);
    expect(canEnterRoom(roomById('pro'), who(1, 'legend'))).toBe(true);
    // And it does not open a room whose CEILING excludes them.
    expect(canEnterRoom(roomById('beginner'), who(40, 'ace'))).toBe(false);
  });

  it('never locks a player out of every ranked bracket', () => {
    // The case this exists for: placement is five ranked games, five games is
    // roughly level 3-4, and winning most of them lands Ace. Ace is above
    // BEGINNER's ceiling and below INTERMEDIATE's level 5, so before the rule
    // above both refused — and so did every room over them. Casual was the
    // only room in the game such a player could enter, which is the opposite
    // of what being rated Ace should mean.
    // RANKED brackets only. Casual gates nobody, so including it makes this
    // invariant trivially true and says nothing — which is exactly the state
    // the bug left players in: one room, and not one that moves the ladder.
    const ranked = ROOMS.filter(
      (r) => r.building === 'pvp' && r.listable !== false && r.ranked !== false
    );
    expect(ranked.length).toBeGreaterThan(0);
    for (const tier of ['unranked', ...TIER_ORDER] as const) {
      for (const level of [1, 2, 3, 4, 5, 8, 12, 20, 30, 60]) {
        const open = ranked.filter((r) => canEnterRoom(r, who(level, tier)));
        expect(
          open.length,
          `level ${level} / ${tier} can enter no ranked bracket`
        ).toBeGreaterThan(0);
      }
    }
  });

  it('names the tier a room needs when the level is already there', () => {
    expect(roomEntryVerdict(roomById('pro'), who(40, 'master'))).toEqual({
      ok: false,
      reason: 'tier_low',
      needTier: 'legend',
    });
  });

  it('overlaps the brackets at their edges, so a boundary rating is never stranded', () => {
    // A rating that wobbles across a floor must not lock a player out of the
    // room they were just playing in, so adjacent bands share an edge tier.
    const onTheEdge = who(40, 'master');
    expect(canEnterRoom(roomById('intermediate'), onTheEdge)).toBe(true);
    expect(canEnterRoom(roomById('advanced'), onTheEdge)).toBe(true);
    const gm = who(40, 'grandmaster');
    expect(canEnterRoom(roomById('advanced'), gm)).toBe(true);
    expect(canEnterRoom(roomById('elite'), gm)).toBe(true);
  });

  it('leaves every player some PvP room they can enter', () => {
    // A ladder with a hole in it is unrecoverable: a player whose rating and
    // level land between two brackets would have nowhere to play.
    const tiers: Tier[] = [
      'unranked', 'rookie', 'contender', 'vanguard', 'ace',
      'master', 'grandmaster', 'legend', 'overlord',
    ];
    for (const tier of tiers) {
      for (const level of [1, 4, 5, 11, 12, 19, 20, 29, 30, 60]) {
        const open = roomsOf('pvp').filter((r) => canEnterRoom(r, who(level, tier)));
        expect({ tier, level, open: open.length > 0 }).toEqual({ tier, level, open: true });
      }
    }
  });

  it('gates nothing in the solo and training buildings', () => {
    // Solo rungs are walked through the achievement chain in achievements.ts;
    // a second gate here would be a second answer to the same question.
    for (const room of [...roomsOf('solo'), ...roomsOf('training')]) {
      expect({ id: room.id, gate: room.gate }).toEqual({ id: room.id, gate: undefined });
    }
  });
});
