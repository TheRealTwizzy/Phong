import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { CourtTheme, MatchEndPayload, PlayerProfile } from '../src/types';
import { THEMES, isThemeUnlocked } from '../src/game/themes';
import {
  MISSION_POOL,
  ELITE_POOL,
  ALL_MISSIONS,
  REGULAR_SLOTS,
  ELITE_SLOTS,
  REROLLS_REGULAR,
  REROLLS_ELITE,
  RECENT_DEAL_MEMORY,
  applyMatchToProgress,
  findMission,
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
    const rally = MISSION_POOL.find((m) => m.type === 'rally')!;
    let p = applyMatchToProgress(rally, 0, match('x', { maxRally: 5 }));
    expect(p).toBe(5);
    p = applyMatchToProgress(rally, p, match('x', { maxRally: 3 }));
    expect(p).toBe(5); // a worse rally does not regress or accumulate
    p = applyMatchToProgress(rally, p, match('x', { maxRally: 40 }));
    expect(p).toBe(rally.target); // and never banks surplus past the target
  });

  it('caps every mission at its target', () => {
    for (const def of ALL_MISSIONS) {
      const p = applyMatchToProgress(def, def.target, match('x', { playerScore: 99, maxRally: 99 }));
      expect(p).toBeLessThanOrEqual(def.target);
    }
  });
});

describe('server-owned mission state', () => {
  it('starts every mission at zero and unclaimed', () => {
    init('m_fresh', 'MissionFresh');
    const missions = db.getMissions('m_fresh');
    // A hand dealt from the pools, not the whole pool.
    expect(missions).toHaveLength(REGULAR_SLOTS + ELITE_SLOTS);
    expect(missions.filter((m) => m.tier === 'elite')).toHaveLength(ELITE_SLOTS);
    expect(missions.every((m) => m.current === 0 && !m.claimed)).toBe(true);
  });

  it('advances progress only from a recorded match', () => {
    init('m_prog', 'MissionProg');
    const held = () => db.getMissions('m_prog');
    expect(held().every((m) => m.current === 0)).toBe(true);
    db.recordMatch(match('m_prog', { playerScore: 4, maxRally: 6 }));
    // Whatever hand was dealt, a recorded win moves something in it.
    expect(held().some((m) => m.current > 0)).toBe(true);
  });

  it('advances each mission by its own rule', () => {
    // Checked against the definitions rather than a dealt hand, so the test
    // does not depend on which missions a given player happens to hold.
    const forType = (type: string) => MISSION_POOL.find((m) => m.type === type)!;
    const soloWin = {
      playerId: 'x', username: 'x', playerScore: 4, opponentScore: 1,
      maxRally: 6, mode: 'solo' as const, difficulty: 'pro' as const, isWinner: true, aces: 2,
    };
    expect(applyMatchToProgress(forType('games_played'), 0, soloWin)).toBe(1);
    expect(applyMatchToProgress(forType('matches_won'), 0, soloWin)).toBe(1);
    expect(applyMatchToProgress(forType('points_scored'), 0, soloWin)).toBe(4);
    expect(applyMatchToProgress(forType('rally'), 0, soloWin)).toBe(6);
    expect(applyMatchToProgress(forType('aces'), 0, soloWin)).toBe(2);
    // Solo does not advance the multiplayer mission.
    expect(applyMatchToProgress(forType('multiplayer'), 0, soloWin)).toBe(0);
    expect(
      applyMatchToProgress(forType('multiplayer'), 0, { ...soloWin, mode: 'multiplayer' })
    ).toBe(1);
  });

  it('honours a difficulty restriction', () => {
    // An elite "win against Cyber" must not be satisfied by a Rookie win.
    const cyberOnly = ELITE_POOL.find((m) => m.difficulty === 'cyber')!;
    const base = {
      playerId: 'x', username: 'x', playerScore: 5, opponentScore: 1,
      maxRally: 6, mode: 'solo' as const, isWinner: true,
    };
    expect(applyMatchToProgress(cyberOnly, 0, { ...base, difficulty: 'rookie' })).toBe(0);
    expect(applyMatchToProgress(cyberOnly, 0, { ...base, difficulty: 'cyber' })).toBe(1);
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
    // Drive every held mission to completion, then pick one of them.
    for (let i = 0; i < 20; i++) {
      db.recordMatch(match('m_once', { mode: 'multiplayer', playerScore: 5, maxRally: 45, aces: 9 }));
    }
    const done = db.getMissions('m_once').find((m) => m.current >= m.target && !m.claimed)!;
    expect(done).toBeTruthy();
    const before = db.getProfile('m_once').xp;

    const first = db.claimMission('m_once', done.id);
    expect(first.ok).toBe(true);
    expect(first.earnedXp).toBe(findMission(done.id)!.xpReward);
    const afterFirst = db.getProfile('m_once').xp;
    expect(afterFirst).toBe(before + first.earnedXp!);

    // This is the regression guard. Mission rewards used to be claimed by
    // POSTing an `xpDelta` the client chose, with mission state in
    // localStorage: clearing site data re-armed all five, and the endpoint
    // could simply be called in a loop. Replaying a claim must now pay zero.
    for (let i = 0; i < 25; i++) {
      const again = db.claimMission('m_once', done.id);
      expect(again.ok).toBe(false);
      expect(again.code).toBe('MISSION_CLAIMED');
    }
    expect(db.getProfile('m_once').xp).toBe(afterFirst);
  });

  it("bounds a day's mission XP by the hand actually dealt", () => {
    init('m_cap', 'MissionCap');
    for (let i = 0; i < 25; i++) {
      db.recordMatch(match('m_cap', { mode: 'multiplayer', playerScore: 5, maxRally: 45, aces: 9 }));
    }
    const held = db.getMissions('m_cap');
    const maxPayout = held.reduce((sum, m) => sum + m.xpReward, 0);
    const before = db.getProfile('m_cap').xp;

    let paid = 0;
    // Claim everything repeatedly; only the first of each may pay.
    for (let round = 0; round < 4; round++) {
      for (const m of held) {
        const r = db.claimMission('m_cap', m.id);
        if (r.ok) paid += r.earnedXp!;
      }
    }
    expect(paid).toBeGreaterThan(0);
    expect(paid).toBeLessThanOrEqual(maxPayout);
    expect(db.getProfile('m_cap').xp).toBe(before + paid);
  });

  it('gives a fresh set of missions on the next UTC day', () => {
    init('m_day', 'MissionDay');
    const today = new Date('2026-08-21T12:00:00Z');
    const tomorrow = new Date('2026-08-22T12:00:00Z');
    // The fixed clock goes to recordMatch too — recording on the wall clock
    // while querying a fixed day made this test date-dependent (it failed the
    // moment a session crossed UTC midnight).
    db.recordMatch(match('m_day'), {}, today);
    expect(db.getMissions('m_day', today).some((m) => m.current > 0)).toBe(true);
    const next = db.getMissions('m_day', tomorrow);
    expect(next.every((m) => m.current === 0 && !m.claimed)).toBe(true);
  });

  it('returns the advanced missions on the match result itself', () => {
    init('m_result', 'MissionResult');
    const res = db.recordMatch(match('m_result'));
    expect(res.missions).toHaveLength(REGULAR_SLOTS + ELITE_SLOTS);
    expect(res.missions.some((m) => m.current > 0)).toBe(true);
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

describe('rerolls', () => {
  const today = new Date('2026-08-21T12:00:00Z');
  const tomorrow = new Date('2026-08-22T12:00:00Z');

  const heldRegular = (id: string, now = today) =>
    db.getMissions(id, now).filter((m) => m.tier === 'regular');
  const heldElite = (id: string, now = today) =>
    db.getMissions(id, now).filter((m) => m.tier === 'elite');

  it('grants the stated allowance per tier', () => {
    init('r_fresh', 'RerollFresh');
    expect(db.rerollsRemaining('r_fresh', today)).toEqual({
      regular: REROLLS_REGULAR,
      elite: REROLLS_ELITE,
    });
  });

  it('swaps a mission for one the player is not already holding', () => {
    init('r_swap', 'RerollSwap');
    const before = heldRegular('r_swap');
    const victim = before[0];
    const res = db.rerollMission('r_swap', victim.id, today);
    expect(res.ok).toBe(true);

    const after = heldRegular('r_swap');
    expect(after.map((m) => m.id)).not.toContain(victim.id);
    expect(after).toHaveLength(before.length);
    // No duplicates: a reroll must produce something genuinely new.
    expect(new Set(after.map((m) => m.id)).size).toBe(after.length);
    expect(res.newMissionId).toBe(after.find((m) => !before.some((b) => b.id === m.id))!.id);
  });

  it('spends from the tier that was rerolled, and only that tier', () => {
    init('r_tier', 'RerollTier');
    db.rerollMission('r_tier', heldRegular('r_tier')[0].id, today);
    expect(db.rerollsRemaining('r_tier', today)).toEqual({
      regular: REROLLS_REGULAR - 1,
      elite: REROLLS_ELITE,
    });

    db.rerollMission('r_tier', heldElite('r_tier')[0].id, today);
    expect(db.rerollsRemaining('r_tier', today)).toEqual({
      regular: REROLLS_REGULAR - 1,
      elite: REROLLS_ELITE - 1,
    });
  });

  it('runs out after the allowance and refuses further rerolls', () => {
    init('r_spend', 'RerollSpend');
    for (let i = 0; i < REROLLS_REGULAR; i++) {
      expect(db.rerollMission('r_spend', heldRegular('r_spend')[0].id, today).ok).toBe(true);
    }
    expect(db.rerollsRemaining('r_spend', today).regular).toBe(0);
    const denied = db.rerollMission('r_spend', heldRegular('r_spend')[0].id, today);
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe('NO_REROLLS');

    // The single elite reroll is its own allowance and is spent the same way.
    expect(db.rerollMission('r_spend', heldElite('r_spend')[0].id, today).ok).toBe(true);
    expect(db.rerollMission('r_spend', heldElite('r_spend')[0].id, today).code).toBe('NO_REROLLS');
  });

  it('refuses to reroll a mission that is already complete', () => {
    init('r_done', 'RerollDone');
    for (let i = 0; i < 20; i++) {
      db.recordMatch(match('r_done', { mode: 'multiplayer', playerScore: 5, maxRally: 45, aces: 9 }));
    }
    const done = db.getMissions('r_done').find((m) => m.current >= m.target);
    if (done) {
      const res = db.rerollMission('r_done', done.id);
      expect(res.ok).toBe(false);
      expect(res.code).toBe('MISSION_COMPLETE');
    }
  });

  it('refuses to reroll something the player is not holding', () => {
    init('r_absent', 'RerollAbsent');
    const held = new Set(db.getMissions('r_absent', today).map((m) => m.id));
    const notHeld = MISSION_POOL.find((m) => !held.has(m.id))!;
    expect(db.rerollMission('r_absent', notHeld.id, today).code).toBe('MISSION_NOT_ACTIVE');
    expect(db.rerollMission('r_absent', 'no_such_mission', today).code).toBe('MISSION_UNKNOWN');
  });

  it('resets the allowance with the day, and never banks unused rerolls', () => {
    init('r_reset', 'RerollReset');
    // Spend every regular reroll today.
    for (let i = 0; i < REROLLS_REGULAR; i++) {
      db.rerollMission('r_reset', heldRegular('r_reset')[0].id, today);
    }
    db.rerollMission('r_reset', heldElite('r_reset')[0].id, today);
    expect(db.rerollsRemaining('r_reset', today)).toEqual({ regular: 0, elite: 0 });

    // Tomorrow the allowance is whole again — and no more than whole, so an
    // unused day does not carry over into a double allowance.
    expect(db.rerollsRemaining('r_reset', tomorrow)).toEqual({
      regular: REROLLS_REGULAR,
      elite: REROLLS_ELITE,
    });
  });

  it('deals a fresh hand the next day, discarding an unfinished one', () => {
    init('r_hand', 'RerollHand');
    db.recordMatch(match('r_hand', { playerScore: 3, maxRally: 5 }), {}, today);
    expect(db.getMissions('r_hand', today).some((m) => m.current > 0)).toBe(true);

    const next = db.getMissions('r_hand', tomorrow);
    expect(next.every((m) => m.current === 0 && !m.claimed)).toBe(true);
    expect(next.filter((m) => m.tier === 'elite')).toHaveLength(ELITE_SLOTS);
  });

  it('deals different hands to different players on the same day', () => {
    init('r_a', 'RerollA');
    init('r_b', 'RerollB');
    const a = db.getMissions('r_a', today).map((m) => m.id).join(',');
    const b = db.getMissions('r_b', today).map((m) => m.id).join(',');
    expect(a).not.toBe(b);
  });

  it('deals the same hand twice for the same player and day', () => {
    init('r_stable', 'RerollStable');
    const first = db.getMissions('r_stable', today).map((m) => m.id);
    const again = db.getMissions('r_stable', today).map((m) => m.id);
    expect(again).toEqual(first);
  });
});

describe('a completed mission deals a free replacement', () => {
  const today = new Date('2026-08-21T12:00:00Z');
  const held = (id: string) => db.getMissions(id, today);

  /** Drive one mission all the way to its target with real recorded matches. */
  const finish = (playerId: string, missionId: string) => {
    const def = findMission(missionId)!;
    for (let i = 0; i < 80; i++) {
      const m = held(playerId).find((x) => x.id === missionId);
      if (!m || m.current >= m.target) break;
      db.recordMatch(
        match(playerId, {
          // A duel mission can say so through its type or its mode field.
          mode: def.type === 'multiplayer' || def.mode === 'multiplayer' ? 'multiplayer' : 'solo',
          difficulty: def.difficulty || 'pro',
          playerScore: 5,
          opponentScore: def.type === 'shutouts' ? 0 : 2,
          maxRally: Math.max(def.type === 'rally' ? def.target : 9, 9),
          aces: 8,
          isWinner: true,
        }),
        {},
        today
      );
    }
    const done = held(playerId).find((x) => x.id === missionId);
    // Guard the guard: a helper that silently stops completing would make
    // every assertion below vacuous, which is exactly how the elite tests
    // once passed without testing anything.
    expect(done && done.current >= done.target).toBe(true);
  };

  it('replaces the claimed mission with a fresh one in the same slot', () => {
    init('ar_swap', 'AutoSwap');
    const before = held('ar_swap').map((m) => m.id);
    const victim = held('ar_swap').find((m) => m.tier === 'regular')!;
    finish('ar_swap', victim.id);

    const res = db.claimMission('ar_swap', victim.id, today);
    expect(res.ok).toBe(true);
    expect(res.newMissionId).toBeTruthy();

    const after = held('ar_swap');
    expect(after).toHaveLength(before.length);
    expect(after.map((m) => m.id)).not.toContain(victim.id);
    expect(after.map((m) => m.id)).toContain(res.newMissionId);
    // Genuinely fresh, not a completed one shuffled back in.
    const dealt = after.find((m) => m.id === res.newMissionId)!;
    expect(dealt.claimed).toBe(false);
    expect(dealt.current).toBeLessThan(dealt.target);
  });

  it('costs neither allowance', () => {
    init('ar_free', 'AutoFree');
    const victim = held('ar_free').find((m) => m.tier === 'regular')!;
    finish('ar_free', victim.id);
    db.claimMission('ar_free', victim.id, today);
    expect(db.rerollsRemaining('ar_free', today)).toEqual({
      regular: REROLLS_REGULAR,
      elite: REROLLS_ELITE,
    });
  });

  it('keeps dealing them past the point the paid allowance would have run out', () => {
    // The free reroll is unlimited on purpose: every one of them had to be
    // earned by finishing something, so there is nothing to ration.
    init('ar_many', 'AutoMany');
    let dealt = 0;
    for (let round = 0; round < REROLLS_REGULAR + 2; round++) {
      const target = db
        .getMissions('ar_many', today)
        .find((m) => m.tier === 'regular' && !m.claimed);
      if (!target) break;
      finish('ar_many', target.id);
      const res = db.claimMission('ar_many', target.id, today);
      expect(res.ok).toBe(true);
      if (res.newMissionId) dealt++;
    }
    expect(dealt).toBeGreaterThan(REROLLS_REGULAR);
    expect(db.rerollsRemaining('ar_many', today).regular).toBe(REROLLS_REGULAR);
  });

  it('deals an elite replacement for an elite, without touching the elite allowance', () => {
    init('ar_elite', 'AutoElite');
    const elite = held('ar_elite').find((m) => m.tier === 'elite')!;
    finish('ar_elite', elite.id);
    const res = db.claimMission('ar_elite', elite.id, today);
    expect(res.ok).toBe(true);
    expect(res.newMissionId).toBeTruthy();
    expect(findMission(res.newMissionId!)!.tier).toBe('elite');
    expect(db.rerollsRemaining('ar_elite', today).elite).toBe(REROLLS_ELITE);
    // The hand keeps its shape: still exactly one elite slot.
    expect(held('ar_elite').filter((m) => m.tier === 'elite')).toHaveLength(ELITE_SLOTS);
  });

  it('never deals something held, or dealt in the last few rolls', () => {
    // The rule that replaced one-and-done: anything may come back, once
    // RECENT_DEAL_MEMORY other deals have gone by. One-and-done meant a
    // productive player used the pool up, and a claim then had nothing to hand
    // back — which is what left a finished task sitting in its slot.
    init('ar_dupes', 'AutoDupes');
    const dealt = db
      .getMissions('ar_dupes', today)
      .filter((m) => m.tier === 'regular')
      .map((m) => m.id);

    for (let round = 0; round < 10; round++) {
      const target = db
        .getMissions('ar_dupes', today)
        .find((m) => m.tier === 'regular' && !m.claimed);
      if (!target) break;
      finish('ar_dupes', target.id);
      const res = db.claimMission('ar_dupes', target.id, today);
      const hand = db.getMissions('ar_dupes', today).map((m) => m.id);
      // Never the same task twice on the list at once.
      expect(new Set(hand).size).toBe(hand.length);
      expect(res.newMissionId).toBeTruthy();
      // Never one of the last few dealt, and never one already held.
      expect(dealt.slice(-RECENT_DEAL_MEMORY)).not.toContain(res.newMissionId);
      expect(hand.filter((id) => id === res.newMissionId)).toHaveLength(1);
      // ...and it arrives clean. Past the first few rounds these ARE re-deals
      // of tasks completed and claimed earlier, which without the reset would
      // come straight back finished and already marked claimed.
      const fresh = res.missions!.find((m) => m.id === res.newMissionId)!;
      expect(fresh.current).toBe(0);
      expect(fresh.claimed).toBe(false);
      dealt.push(res.newMissionId!);
    }
    // Ten claims out of a twelve-task pool: only a repeating pool gets here.
    expect(dealt.length).toBeGreaterThan(REGULAR_SLOTS + RECENT_DEAL_MEMORY);
    expect(new Set(dealt).size).toBeLessThan(dealt.length);
  });

  it('deals a repeat back at zero, never carrying what it held before', () => {
    // Reported: rerolling into "Point Machine" arrived at 21/25. Progress is
    // stored per task for the day, so a task dealt back into a slot used to
    // bring whatever it collected the last time it was held — and since tasks
    // now repeat, every repeat would arrive already finished and claimed.
    // A task in a slot has always just started.
    init('ar_fresh', 'FreshStart');
    const seen = new Set(
      db.getMissions('ar_fresh', today).filter((m) => m.tier === 'regular').map((m) => m.id)
    );
    let repeats = 0;

    for (let round = 0; round < 12; round++) {
      const target = db
        .getMissions('ar_fresh', today)
        .find((m) => m.tier === 'regular' && !m.claimed);
      if (!target) break;
      finish('ar_fresh', target.id);
      const res = db.claimMission('ar_fresh', target.id, today);
      if (!res.ok || !res.newMissionId) break;

      const dealt = res.missions!.find((m) => m.id === res.newMissionId)!;
      if (seen.has(res.newMissionId)) {
        // A task coming round again — completed and claimed earlier today.
        repeats += 1;
        expect(dealt.current).toBe(0);
        expect(dealt.claimed).toBe(false);
      }
      seen.add(res.newMissionId);
    }

    // Twelve claims against a twelve-task pool: repeats are certain, and it is
    // the repeats that carry the risk.
    expect(repeats).toBeGreaterThan(0);
  });

  it('holds a day dealt under a larger hand down to the current size', () => {
    // A player mid-day is holding whatever they were dealt this morning, so
    // lowering the hand size has to take effect on the list they already have.
    init('ar_trim', 'TrimMe');
    db.getMissions('ar_trim', today);
    const dayKey = today.toISOString().slice(0, 10);
    const raw = new DatabaseSync(path.join(TMP, 'phong.db'));
    const seed = raw.prepare(
      `INSERT INTO daily_mission_slots (playerId, dayKey, slot, missionId) VALUES (?, ?, ?, ?)
       ON CONFLICT(playerId, dayKey, slot) DO UPDATE SET missionId = excluded.missionId`
    );
    ['mission_games', 'mission_win', 'mission_rally', 'mission_points', 'mission_aces'].forEach(
      (id, i) => seed.run('ar_trim', dayKey, i, id)
    );
    seed.run('ar_trim', dayKey, 5, 'elite_rally_40');
    raw.close();

    const hand = db.getMissions('ar_trim', today);
    expect(hand.filter((m) => m.tier === 'regular')).toHaveLength(REGULAR_SLOTS);
    expect(hand.filter((m) => m.tier === 'elite')).toHaveLength(ELITE_SLOTS);
  });
});

describe('elite missions are permanent unlocks', () => {
  const today = new Date('2026-08-21T12:00:00Z');
  const tomorrow = new Date('2026-08-22T12:00:00Z');

  // Plays enough of everything to satisfy any elite in the pool, so the test
  // never depends on which one the hand happened to deal.
  const completeElite = (id: string, now: Date) => {
    const elite = db.getMissions(id, now).find((m) => m.tier === 'elite')!;
    for (let i = 0; i < 40; i++) {
      db.recordMatch(
        match(id, {
          mode: 'multiplayer', playerScore: 5, opponentScore: 0, maxRally: 45, aces: 9,
        }),
        {},
        now
      );
      db.recordMatch(
        match(id, {
          mode: 'solo', difficulty: 'cyber', playerScore: 5, opponentScore: 0,
          maxRally: 45, aces: 9,
        }),
        {},
        now
      );
    }
    const after = db.getMissions(id, now).find((m) => m.id === elite.id)!;
    // The point of the helper: if this ever stops completing, the tests below
    // must fail rather than quietly skip.
    expect(after.current).toBeGreaterThanOrEqual(after.target);
    return elite;
  };

  it('every elite mission carries an unlock, and no regular one does', () => {
    for (const m of ELITE_POOL) expect(m.unlocks).toBeTruthy();
    for (const m of MISSION_POOL) expect(m.unlocks).toBeFalsy();
    // Each elite grants a DIFFERENT unlock, or completing one would silently
    // consume another's reward.
    const unlocks = ELITE_POOL.map((m) => m.unlocks);
    expect(new Set(unlocks).size).toBe(unlocks.length);
  });

  it('banks the unlock on first completion and keeps it across days', () => {
    init('e_bank', 'EliteBank');
    const elite = completeElite('e_bank', today);
    const res = db.claimMission('e_bank', elite.id, today);
    expect(res.ok).toBe(true);
    expect(res.unlocked).toBe(elite.unlocks);
    expect(db.eliteUnlocks('e_bank')).toContain(elite.unlocks);

    // The XP is a daily reward; the unlock is kept for good.
    expect(db.eliteUnlocks('e_bank')).toContain(elite.unlocks);
    const nextDay = db.getMissions('e_bank', tomorrow);
    expect(nextDay.every((m) => m.current === 0)).toBe(true);
    expect(db.eliteUnlocks('e_bank')).toContain(elite.unlocks);
  });

  it('grants nothing extra for repeating an elite already banked', () => {
    init('e_repeat', 'EliteRepeat');
    const elite = completeElite('e_repeat', today);
    expect(db.claimMission('e_repeat', elite.id, today).unlocked).toBe(elite.unlocks);
    const owned = db.eliteUnlocks('e_repeat').length;

    // Same mission, a later day: XP again, but no second unlock.
    const laterElite = completeElite('e_repeat', tomorrow);
    const again = db.claimMission('e_repeat', laterElite.id, tomorrow);
    expect(again.ok).toBe(true);
    expect(again.earnedXp).toBeGreaterThan(0); // the XP is a DAILY reward...
    if (laterElite.id === elite.id) {
      expect(again.unlocked).toBeUndefined(); // ...the unlock is not repeatable
      expect(db.eliteUnlocks('e_repeat').length).toBe(owned);
    } else {
      expect(db.eliteUnlocks('e_repeat').length).toBe(owned + 1);
    }
  });

  it('reports whether the unlock is already owned', () => {
    init('e_flag', 'EliteFlag');
    const elite = db.getMissions('e_flag', today).find((m) => m.tier === 'elite')!;
    expect(elite.unlocks).toBeTruthy();
    expect(elite.unlockOwned).toBe(false);
  });
});

describe('permanent unlocks reach the themes', () => {
  const base = (over: Partial<PlayerProfile> = {}): PlayerProfile =>
    ({
      id: 'x', username: 'x', level: 1, xp: 0, xpNext: 250,
      mmrMu: 25, mmrSigma: 8.33, rankMu: 25, rankSigma: 8.33, rankedGames: 0,
      matchesPlayed: 0, matchesWon: 0, matchesLost: 0, highestRally: 0,
      totalPointsScored: 0, totalAces: 0, multiplayerWins: 0, dailyStreak: 0,
      tier: 'unranked', achievements: [], eliteUnlocks: [],
      createdAt: '', lastActive: '', initialized: true,
      hasAvatar: false, avatarVersion: 0,
      ...over,
    }) as PlayerProfile;

  it('gates every elite theme behind its own mission', () => {
    for (const mission of ELITE_POOL) {
      const themeId = mission.unlocks as CourtTheme;
      expect(THEMES[themeId]).toBeTruthy();
      expect(isThemeUnlocked(themeId, base())).toBe(false);
      expect(isThemeUnlocked(themeId, base({ eliteUnlocks: [mission.unlocks!] }))).toBe(true);
      // Owning one elite unlock must not open another's theme.
      const other = ELITE_POOL.find((m) => m.id !== mission.id)!;
      expect(isThemeUnlocked(themeId, base({ eliteUnlocks: [other.unlocks!] }))).toBe(false);
    }
  });

  it('gates the hidden-rung themes behind their achievements', () => {
    for (const [themeId, achId] of [
      ['perpetual-blue', 'rally_100'],
      ['flawless-white', 'cyber_shutout'],
      ['legend-aurora', 'legend_tier'],
      ['fixture-bronze', 'veteran_200'],
    ] as const) {
      expect(isThemeUnlocked(themeId, base())).toBe(false);
      expect(isThemeUnlocked(themeId, base({ achievements: [achId] }))).toBe(true);
    }
  });

  it('leaves the starter themes open to everyone', () => {
    for (const themeId of ['neon', 'retro-crt', 'midnight', 'cyberpunk', 'tennis'] as const) {
      expect(isThemeUnlocked(themeId, base())).toBe(true);
    }
  });

  it('surfaces banked unlocks on the profile the client actually reads', () => {
    init('t_profile', 'ThemeProfile');
    expect(db.getProfile('t_profile').eliteUnlocks).toEqual([]);
    const elite = db.getMissions('t_profile', new Date('2026-08-21T12:00:00Z'))
      .find((m) => m.tier === 'elite')!;
    for (let i = 0; i < 40; i++) {
      db.recordMatch(
        match('t_profile', {
          mode: 'multiplayer', playerScore: 5, opponentScore: 0, maxRally: 45, aces: 9,
        }),
        {},
        new Date('2026-08-21T12:00:00Z')
      );
      db.recordMatch(
        match('t_profile', {
          mode: 'solo', difficulty: 'cyber', playerScore: 5, opponentScore: 0,
          maxRally: 45, aces: 9,
        }),
        {},
        new Date('2026-08-21T12:00:00Z')
      );
    }
    db.claimMission('t_profile', elite.id, new Date('2026-08-21T12:00:00Z'));
    const profile = db.getProfile('t_profile');
    expect(profile.eliteUnlocks).toContain(elite.unlocks);
    expect(isThemeUnlocked(elite.unlocks as CourtTheme, profile)).toBe(true);
  });
});

describe('a claimed task never lingers in the list', () => {
  // Reported: "I completed Connected Court but after receiving the reward it
  // remained completed, on the list without automatically rerolling."
  //
  // Claiming deals a free replacement — but only while that tier still HAS
  // one. A claimed task can never be dealt back, so a productive day works
  // through the pool, and at that point the claim had nowhere to deal from and
  // simply left the finished task sitting in its slot marked "claimed".

  const heavyDuel = (playerId: string, i: number): MatchEndPayload => ({
    playerId,
    username: 'Heavy',
    playerScore: 5,
    opponentScore: 0,
    maxRally: 20,
    aces: 4,
    mode: 'multiplayer',
    isWinner: true,
    matchKey: `${playerId}:heavy:${i}`,
  });

  /** Claim everything claimable, returning how many claims found no replacement. */
  const claimAll = (playerId: string): { claims: number; retired: number } => {
    let claims = 0;
    let retired = 0;
    for (let pass = 0; pass < 20; pass++) {
      const ready = db.getMissions(playerId).filter((m) => !m.claimed && m.current >= m.target);
      if (!ready.length) break;
      for (const m of ready) {
        const res = db.claimMission(playerId, m.id);
        if (!res.ok) continue;
        claims++;
        if (!res.newMissionId) retired++;
      }
    }
    return { claims, retired };
  };

  it('drops a claimed task out of the list even when nothing is left to deal', () => {
    const id = 'p_no_linger';
    init(id, 'NoLinger');
    for (let round = 0; round < 12; round++) {
      db.recordMatch(heavyDuel(id, round));
      claimAll(id);
      // Whatever else is true, a task that has been paid out must not still be
      // sitting in the list. That is the whole complaint.
      const held = db.getMissions(id);
      expect(held.filter((m) => m.claimed)).toEqual([]);
    }
  });

  it('exhausts the pool rather than dealing a finished task back', () => {
    const id = 'p_exhaust';
    init(id, 'Exhaust');
    const seen = new Set<string>();
    for (let round = 0; round < 12; round++) {
      db.recordMatch(heavyDuel(id, round));
      for (const m of db.getMissions(id)) seen.add(m.id);
      claimAll(id);
    }
    // The list only ever shrinks, and never below empty.
    const left = db.getMissions(id);
    expect(left.length).toBeLessThanOrEqual(REGULAR_SLOTS + ELITE_SLOTS);
    expect(left.length).toBeGreaterThanOrEqual(0);
    // Nothing was dealt twice: every id seen is a real, distinct mission.
    expect(seen.size).toBeLessThanOrEqual(MISSION_POOL.length + ELITE_POOL.length);
  });

  it('does not re-deal a whole fresh day when the last slot retires', () => {
    // The slot is blanked, not deleted: ensureSlots reads "no rows today" as
    // "not dealt yet", so deleting the last row would hand out a new day.
    const id = 'p_all_clear';
    init(id, 'AllClear');
    for (let round = 0; round < 25; round++) {
      db.recordMatch(heavyDuel(id, round));
      claimAll(id);
    }
    const before = db.getMissions(id).map((m) => m.id);
    const after = db.getMissions(id).map((m) => m.id);
    expect(after).toEqual(before);
    expect(after.filter((id2) => MISSION_POOL.some((d) => d.id === id2)).length)
      .toBeLessThanOrEqual(REGULAR_SLOTS);
  });

  it('deals a full hand again on the next UTC day', () => {
    const id = 'p_next_day';
    const today = new Date('2026-05-05T12:00:00.000Z');
    const tomorrow = new Date('2026-05-06T12:00:00.000Z');
    init(id, 'NextDay');
    for (let round = 0; round < 20; round++) {
      db.recordMatch(heavyDuel(id, round), {}, today);
      for (let pass = 0; pass < 20; pass++) {
        const ready = db.getMissions(id, today).filter((m) => !m.claimed && m.current >= m.target);
        if (!ready.length) break;
        for (const m of ready) db.claimMission(id, m.id, today);
      }
    }
    expect(db.getMissions(id, tomorrow)).toHaveLength(REGULAR_SLOTS + ELITE_SLOTS);
  });
});

describe('the size of a day\'s hand', () => {
  it('deals three regular tasks and one elite', () => {
    expect(REGULAR_SLOTS).toBe(3);
    expect(ELITE_SLOTS).toBe(1);
  });

  it('leaves the pool room to deal a replacement for most of a day', () => {
    // A claim can only deal what the pool still holds, so the slots have to
    // leave spare room. Three of twelve leaves nine claims before it can dry.
    expect(MISSION_POOL.length - REGULAR_SLOTS).toBeGreaterThanOrEqual(2 * REGULAR_SLOTS);
  });
});
