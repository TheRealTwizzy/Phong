import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { MatchEndPayload } from '../src/types';
import { OVERLORD_MIN_DUELS } from '../src/rating';
import { missionDayKey } from '../src/game/missions';

// The apex is earned in duels, through the store.
//
// Every solo cap sits 0.1 under a tier floor, so the tier above a farmed rung
// was one dominant duel away: a solo-farmed 36.9 became Cyber Overlord off two
// duels. `tierFor` now asks for OVERLORD_MIN_DUELS ranked duels as well, and
// tests/rating.test.ts holds the function. What only the store can answer is
// the plumbing around it — which matches COUNT as a ranked duel, that the
// trophy for the apex waits for the badge rather than firing off the rating,
// and that the count is what the profile the client reads actually carries.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-apex-gate-test-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const duel = (playerId: string, key: string, overrides: Partial<MatchEndPayload> = {}): MatchEndPayload => ({
  playerId,
  username: `Tester-${playerId}`,
  playerScore: 7,
  opponentScore: 3,
  bestStreak: 8, endStreak: 0, earnedStreak: 8,
  mode: 'multiplayer',
  isWinner: true,
  matchKey: key,
  ...overrides,
});

const init = (id: string, username: string) => {
  db.getProfile(id);
  const r = db.initializeProfile(id, username);
  if (!r.ok) throw new Error(`init failed: ${r.code}`);
};

/** Stand a placed player at a rating with a chosen duel count, by hand. */
const seed = (id: string, rankMu: number, rankedDuels: number, achievements: string[] = []) => {
  const raw = new DatabaseSync(DB_FILE);
  try {
    const changed = raw
      .prepare(
        `UPDATE players SET rankMu = ?, rankSigma = 2, rankedGames = 10, rankedDuels = ?, achievements = ? WHERE id = ?`
      )
      .run(rankMu, rankedDuels, JSON.stringify(achievements), id).changes;
    expect(changed).toBe(1);
  } finally {
    raw.close();
  }
};

describe('what counts as a ranked duel', () => {
  it('counts a rated duel, won or lost, and nothing that is not one', () => {
    init('a_count', 'ApexCount');
    db.recordMatch(duel('a_count', 'c-1'));
    expect(db.getProfile('a_count').rankedDuels).toBe(1);
    db.recordMatch(duel('a_count', 'c-2', { playerScore: 2, opponentScore: 7, isWinner: false }));
    expect(db.getProfile('a_count').rankedDuels).toBe(2);
    // A ranked SOLO match is a ranked game and not a duel.
    db.recordMatch(duel('a_count', 'c-3', { mode: 'solo', difficulty: 'pro' }));
    expect(db.getProfile('a_count').rankedGames).toBe(3);
    expect(db.getProfile('a_count').rankedDuels).toBe(2);
    // A duel on party rules did not test the rating.
    db.recordMatch(duel('a_count', 'c-4', { rules: { paddleScale: 1.6 } }));
    expect(db.getProfile('a_count').rankedDuels).toBe(2);
    // Nor did one in a venue that does not move the ladder.
    db.recordMatch(duel('a_count', 'c-5'), { venueRoomId: 'casual' });
    expect(db.getProfile('a_count').rankedDuels).toBe(2);
    // And a replayed match is counted once, like everything else it does.
    db.recordMatch(duel('a_count', 'c-1'));
    expect(db.getProfile('a_count').rankedDuels).toBe(2);
  });
});

describe('the badge and the trophy agree about the apex', () => {
  it('holds a rating past 37 at Legend until the duels are played, trophy included', () => {
    init('a_hold', 'ApexHold');
    seed('a_hold', 40, 0);
    expect(db.getProfile('a_hold').tier).toBe('legend');

    // A duel at mu 40 against a mu-25 default opponent barely moves the rating
    // and counts one duel; the tier trophies fire off the DERIVED tier, so the
    // ladder up to Legend lands and the apex does not.
    const res = db.recordMatch(duel('a_hold', 'h-1'));
    const earned = res.profile.achievements;
    expect(res.profile.tier).toBe('legend');
    expect(earned).toContain('legend_tier');
    expect(earned).not.toContain('tier_overlord');
    expect(res.profile.rankedDuels).toBe(1);
  });

  it('promotes on the duel that meets the count, and the trophies for it land then', () => {
    init('a_meet', 'ApexMeet');
    seed('a_meet', 40, OVERLORD_MIN_DUELS - 1, [
      'first_serve', 'first_duel', 'placed', 'tier_vanguard', 'tier_ace', 'master_tier', 'tier_grandmaster', 'legend_tier',
    ]);
    expect(db.getProfile('a_meet').tier).toBe('legend');
    const res = db.recordMatch(duel('a_meet', 'm-1'));
    expect(res.profile.rankedDuels).toBe(OVERLORD_MIN_DUELS);
    expect(res.profile.tier).toBe('overlord');
    expect(res.profile.achievements).toContain('tier_overlord');
    // The requirement is itself a rung on the Ascent branch, visible, so the
    // player can read what the apex asks for.
    expect(res.profile.achievements).toContain('duels_25');
    expect(res.tierChanged).toBe(true);
  });

  it('back-fills duel_25 for a player who already holds duel_50', () => {
    // duel_50 was re-parented onto the new duel_25 rung. An earned id is never
    // revoked, so a holder keeps it, and the rung under it lands on the next
    // match rather than leaving a hole in the chain.
    init('a_fifty', 'ApexFifty');
    const raw = new DatabaseSync(DB_FILE);
    try {
      raw
        .prepare(`UPDATE players SET multiplayerWins = 60, achievements = ? WHERE id = ?`)
        .run(JSON.stringify(['first_serve', 'first_duel', 'multiplayer_champ', 'duel_10', 'duel_50']), 'a_fifty');
    } finally {
      raw.close();
    }
    const res = db.recordMatch(duel('a_fifty', 'f-1'));
    expect(res.profile.achievements).toContain('duel_25');
    expect(res.profile.achievements).toContain('duel_50');
  });
});

describe('the deep rungs the release added, through the store', () => {
  it('grants the 500-return wall rung from a practice session', () => {
    init('a_wall', 'ApexWall');
    // The wall rungs hang off rally_10, the Rally branch's root, so a player
    // who has never returned seven balls in a match holds none of them.
    seed('a_wall', 25, 0, ['rally_10']);
    const res = db.recordPractice('a_wall', { bestStreak: 500, earnedStreak: 500, earnedReturns: 500 });
    const ids = res.newAchievements.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['wall_30', 'wall_90', 'wall_200', 'wall_500']));
  });

  it('reads a win-streak task off the pooled counter, and holds its best across a loss', () => {
    init('a_streak', 'ApexStreak');
    const day = new Date('2026-08-21T12:00:00Z');
    db.getMissions('a_streak', day);
    const raw = new DatabaseSync(DB_FILE);
    try {
      raw
        .prepare(`UPDATE daily_mission_slots SET missionId = 'mission_streak_5' WHERE playerId = ? AND dayKey = ? AND slot = 0`)
        .run('a_streak', missionDayKey(day));
    } finally {
      raw.close();
    }
    for (let i = 0; i < 3; i++) db.recordMatch(duel('a_streak', `s-${i}`), {}, day);
    const held = () => db.getMissions('a_streak', day).find((m) => m.id === 'mission_streak_5')!;
    expect(held().current).toBe(3);
    // A loss resets the run the player is ON, and the task keeps the best it saw.
    db.recordMatch(duel('a_streak', 's-loss', { playerScore: 1, opponentScore: 7, isWinner: false }), {}, day);
    expect(db.getProfile('a_streak').winStreak).toBe(0);
    expect(held().current).toBe(3);
    for (let i = 0; i < 5; i++) db.recordMatch(duel('a_streak', `s2-${i}`), {}, day);
    expect(held().current).toBe(5);
  });
});
