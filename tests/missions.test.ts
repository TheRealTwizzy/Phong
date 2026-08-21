import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { MatchEndPayload } from '../src/types';
import {
  MISSION_DEFS,
  MISSION_DAILY_XP_CAP,
  applyMatchToProgress,
  missionDayKey,
  msUntilMissionReset,
} from '../src/game/missions';
import { practiceXp, PRACTICE_XP_DAILY_CAP, PRACTICE_XP_SESSION_CAP } from '../src/rating';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-missions-test-'));
process.env.DATA_DIR = TMP;

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const match = (playerId: string, overrides: Partial<MatchEndPayload> = {}): MatchEndPayload => ({
  playerId,
  username: 'Tester',
  playerScore: 5,
  opponentScore: 2,
  maxRally: 9,
  mode: 'solo',
  difficulty: 'pro',
  isWinner: true,
  ...overrides,
});

const init = (id: string, username: string) => {
  db.getProfile(id);
  const r = db.initializeProfile(id, username);
  if (!r.ok) throw new Error(`init failed: ${r.code}`);
};

const byId = (id: string, playerId: string) => db.getMissions(playerId).find((m) => m.id === id)!;

describe('mission definitions', () => {
  it('keys the day in UTC, not local time', () => {
    const d = new Date('2026-08-21T23:30:00Z');
    expect(missionDayKey(d)).toBe('2026-08-21');
    // Same instant, and still the same key regardless of the host timezone.
    expect(missionDayKey(new Date('2026-08-22T00:30:00Z'))).toBe('2026-08-22');
  });

  it('counts down to the next UTC midnight', () => {
    const ms = msUntilMissionReset(new Date('2026-08-21T23:00:00Z'));
    expect(ms).toBe(60 * 60 * 1000);
  });

  it('holds rally progress at the best of the day and never sums it', () => {
    const rally = MISSION_DEFS.find((m) => m.type === 'rally')!;
    let p = applyMatchToProgress(rally, 0, match('x', { maxRally: 5 }));
    expect(p).toBe(5);
    p = applyMatchToProgress(rally, p, match('x', { maxRally: 3 }));
    expect(p).toBe(5); // a worse rally does not regress or accumulate
    p = applyMatchToProgress(rally, p, match('x', { maxRally: 40 }));
    expect(p).toBe(rally.target); // and never banks surplus past the target
  });

  it('caps every mission at its target', () => {
    for (const def of MISSION_DEFS) {
      const p = applyMatchToProgress(def, def.target, match('x', { playerScore: 99, maxRally: 99 }));
      expect(p).toBeLessThanOrEqual(def.target);
    }
  });
});

describe('server-owned mission state', () => {
  it('starts every mission at zero and unclaimed', () => {
    init('m_fresh', 'MissionFresh');
    const missions = db.getMissions('m_fresh');
    expect(missions).toHaveLength(MISSION_DEFS.length);
    expect(missions.every((m) => m.current === 0 && !m.claimed)).toBe(true);
  });

  it('advances progress only from a recorded match', () => {
    init('m_prog', 'MissionProg');
    expect(byId('mission_games', 'm_prog').current).toBe(0);
    db.recordMatch(match('m_prog', { playerScore: 4, maxRally: 6 }));
    expect(byId('mission_games', 'm_prog').current).toBe(1);
    expect(byId('mission_win', 'm_prog').current).toBe(1);
    expect(byId('mission_points', 'm_prog').current).toBe(4);
    expect(byId('mission_rally', 'm_prog').current).toBe(6);
    // Solo does not advance the multiplayer mission.
    expect(byId('mission_multi', 'm_prog').current).toBe(0);
    db.recordMatch(match('m_prog', { mode: 'multiplayer' }));
    expect(byId('mission_multi', 'm_prog').current).toBe(1);
  });

  it('refuses to pay an unfinished mission', () => {
    init('m_early', 'MissionEarly');
    const res = db.claimMission('m_early', 'mission_games');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('MISSION_INCOMPLETE');
  });

  it('refuses an unknown mission id', () => {
    init('m_bogus', 'MissionBogus');
    expect(db.claimMission('m_bogus', 'not_a_mission').code).toBe('MISSION_UNKNOWN');
  });

  it('pays a completed mission exactly once, no matter how often it is claimed', () => {
    init('m_once', 'MissionOnce');
    db.recordMatch(match('m_once', { isWinner: true }));
    const before = db.getProfile('m_once').xp;

    const first = db.claimMission('m_once', 'mission_win');
    expect(first.ok).toBe(true);
    expect(first.earnedXp).toBe(MISSION_DEFS.find((m) => m.id === 'mission_win')!.xpReward);
    const afterFirst = db.getProfile('m_once').xp;
    expect(afterFirst).toBe(before + first.earnedXp!);

    // This is the regression guard. Mission rewards used to be claimed by
    // POSTing an `xpDelta` the client chose, with mission state in
    // localStorage: clearing site data re-armed all five, and the endpoint
    // could simply be called in a loop. Replaying a claim must now pay zero.
    for (let i = 0; i < 25; i++) {
      const again = db.claimMission('m_once', 'mission_win');
      expect(again.ok).toBe(false);
      expect(again.code).toBe('MISSION_CLAIMED');
    }
    expect(db.getProfile('m_once').xp).toBe(afterFirst);
  });

  it('bounds a whole day of mission XP by the definition table', () => {
    init('m_cap', 'MissionCap');
    // Play enough to finish everything available today.
    for (let i = 0; i < 15; i++) {
      db.recordMatch(match('m_cap', { mode: 'multiplayer', playerScore: 5, maxRally: 12 }));
    }
    const before = db.getProfile('m_cap').xp;
    let paid = 0;
    // Claim every mission repeatedly; only the first of each may pay.
    for (let round = 0; round < 5; round++) {
      for (const def of MISSION_DEFS) {
        const r = db.claimMission('m_cap', def.id);
        if (r.ok) paid += r.earnedXp!;
      }
    }
    expect(paid).toBe(MISSION_DAILY_XP_CAP);
    expect(db.getProfile('m_cap').xp).toBe(before + MISSION_DAILY_XP_CAP);
  });

  it('gives a fresh set of missions on the next UTC day', () => {
    init('m_day', 'MissionDay');
    const today = new Date('2026-08-21T12:00:00Z');
    const tomorrow = new Date('2026-08-22T12:00:00Z');
    db.recordMatch(match('m_day'));
    expect(db.getMissions('m_day', today).some((m) => m.current > 0)).toBe(true);
    const next = db.getMissions('m_day', tomorrow);
    expect(next.every((m) => m.current === 0 && !m.claimed)).toBe(true);
  });

  it('returns the advanced missions on the match result itself', () => {
    init('m_result', 'MissionResult');
    const res = db.recordMatch(match('m_result'));
    expect(res.missions).toHaveLength(MISSION_DEFS.length);
    expect(res.missions.find((m) => m.id === 'mission_games')!.current).toBe(1);
  });
});

describe('Practice Wall XP', () => {
  it('pays nothing for a couple of taps', () => {
    expect(practiceXp(0)).toBe(0);
    expect(practiceXp(2)).toBe(0);
    expect(practiceXp(3)).toBeGreaterThan(0);
  });

  it('rises with the streak but flattens, so grinding cannot beat real matches', () => {
    const short = practiceXp(5);
    const long = practiceXp(50);
    expect(long).toBeGreaterThan(short);
    // A 10x longer streak must not pay 10x — the curve is deliberately concave.
    expect(long).toBeLessThan(short * 10);
    expect(practiceXp(100000)).toBeLessThanOrEqual(PRACTICE_XP_SESSION_CAP);
  });

  it('caps what a day of drilling can pay, and survives a restart', () => {
    init('p_drill', 'Driller');
    let total = 0;
    for (let i = 0; i < 40; i++) {
      total += db.recordPractice('p_drill', 500).earnedXp;
    }
    expect(total).toBe(PRACTICE_XP_DAILY_CAP);
    expect(db.recordPractice('p_drill', 500).earnedXp).toBe(0);
  });

  it('records no match, moves no rating, and feeds no missions', () => {
    init('p_drill2', 'Driller2');
    const before = db.getProfile('p_drill2');
    db.recordPractice('p_drill2', 30);
    const after = db.getProfile('p_drill2');
    expect(after.xp).toBeGreaterThan(before.xp);
    expect(after.matchesPlayed).toBe(before.matchesPlayed);
    expect(after.mmrMu).toBe(before.mmrMu);
    expect(after.rankMu).toBe(before.rankMu);
    expect(db.getMissions('p_drill2').every((m) => m.current === 0)).toBe(true);
    expect(db.getMatchHistory('p_drill2')).toHaveLength(0);
  });

  it('refills the allowance on the next UTC day', () => {
    init('p_drill3', 'Driller3');
    const today = new Date('2026-08-21T12:00:00Z');
    const tomorrow = new Date('2026-08-22T12:00:00Z');
    for (let i = 0; i < 40; i++) db.recordPractice('p_drill3', 500, today);
    expect(db.recordPractice('p_drill3', 500, today).earnedXp).toBe(0);
    expect(db.recordPractice('p_drill3', 500, tomorrow).earnedXp).toBeGreaterThan(0);
  });
});
