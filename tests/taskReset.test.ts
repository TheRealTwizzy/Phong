import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { REGULAR_SLOTS, ELITE_SLOTS, REROLLS_REGULAR, REROLLS_ELITE } from '../src/game/missions';

// The one-shot tasks_reset_v1 migration. Hands dealt under the old rules carry
// state the new ones cannot repair on their own — five slots where there
// should be three, and progress banked against tasks meant to start at zero —
// so every player is dealt a fresh set once. Nothing permanent is touched.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-task-reset-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let mod: typeof import('../server/db');

const PLAYER = 'dev_reset_aaaaaaaaaaaaaaa';

beforeAll(async () => {
  mod = await import('../server/db');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('resetting everybody active tasks, once', () => {
  it('deals a fresh set, restores rerolls, and keeps everything earned', async () => {
    mod.db.getProfile(PLAYER);
    mod.db.initializeProfile(PLAYER, 'ResetMe');

    // Play, finish something, claim it: real XP on the profile and real
    // progress in the day-keyed tables.
    for (let i = 0; i < 4; i++) {
      mod.db.recordMatch({
        playerId: PLAYER, username: 'R', playerScore: 7, opponentScore: 0,
        bestStreak: 20, endStreak: 0, earnedStreak: 20, aces: 4, mode: 'multiplayer', isWinner: true, matchKey: `reset:${i}`,
      });
    }
    for (const m of mod.db.getMissions(PLAYER)) {
      if (!m.claimed && m.current >= m.target) mod.db.claimMission(PLAYER, m.id);
    }
    const earnedXp = mod.db.getProfile(PLAYER).xp;
    const matchesPlayed = mod.db.getProfile(PLAYER).matchesPlayed;
    expect(earnedXp).toBeGreaterThan(0);

    // Spend a reroll, so the restore is observable.
    const spendable = mod.db.getMissions(PLAYER).find((m) => m.tier === 'regular' && !m.claimed && m.current < m.target);
    if (spendable) mod.db.rerollMission(PLAYER, spendable.id);

    // Re-arm the migration and boot again.
    const raw = new DatabaseSync(DB_FILE);
    raw.prepare('DELETE FROM meta WHERE key = ?').run('tasks_reset_v1');
    const before = raw.prepare('SELECT COUNT(*) AS n FROM daily_mission_slots').get() as { n: number };
    raw.close();
    expect(before.n).toBeGreaterThan(0);

    vi.resetModules();
    mod = await import('../server/db');

    // A fresh hand, at the current size, all at zero.
    const hand = mod.db.getMissions(PLAYER);
    expect(hand.filter((m) => m.tier === 'regular')).toHaveLength(REGULAR_SLOTS);
    expect(hand.filter((m) => m.tier === 'elite')).toHaveLength(ELITE_SLOTS);
    for (const m of hand) {
      expect(m.current).toBe(0);
      expect(m.claimed).toBe(false);
    }

    // Allowances back — they were spent on a hand that has been taken away.
    expect(mod.db.rerollsRemaining(PLAYER)).toEqual({ regular: REROLLS_REGULAR, elite: REROLLS_ELITE });

    // Nothing permanent lost: the XP those claims paid, and the match record.
    const profile = mod.db.getProfile(PLAYER);
    expect(profile.xp).toBe(earnedXp);
    expect(profile.matchesPlayed).toBe(matchesPlayed);
  });

  it('runs exactly once, so a later hand is never wiped again', async () => {
    const hand = mod.db.getMissions(PLAYER).map((m) => m.id);
    expect(mod.db.getMeta('tasks_reset_v1')).toBeTruthy();

    vi.resetModules();
    mod = await import('../server/db');
    expect(mod.db.getMissions(PLAYER).map((m) => m.id)).toEqual(hand);
  });
});
