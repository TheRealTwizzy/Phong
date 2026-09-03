import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { PlayerProfile, TitleId } from '../src/types';
import { TITLES, TITLE_IDS, isTitleUnlocked, normalizeTitleId, unlockNameKey } from '../src/game/titles';
import { COSMETICS, COSMETIC_IDS } from '../src/game/cosmetics';
import { ALL_MISSIONS, ELITE_POOL, findMission } from '../src/game/missions';
import { achievementById } from '../src/achievements';
import { Relay, startRelay } from './helpers/relay';

// Titles: the second permanent reward type, beside cosmetics.
//
// Ten more elite tasks would have meant ten more themes against a palette
// floor the closest existing pair clears by 0.003, so a title — seven strings
// and no palette — carries the rewards a theme cannot. Everything below is the
// cosmetic's contract restated for a title, plus the one place the two differ:
// an unknown title normalizes to NULL and never to a default, because wearing
// no title is the ordinary state and `normalizeCosmeticId` would answer 'neon'.
//
// What this suite exists to hold:
//   1. the catalogue is complete — every title names something real to earn;
//   2. the two catalogues share ONE id namespace and never collide, because an
//      elite task's `unlocks` is banked verbatim and a collision opens both;
//   3. every unlock arm, including the tier arm's `unranked` guard;
//   4. the server refuses a locked or unknown title exactly as it refuses a
//      locked cosmetic, on the same PUT, and null takes the title off.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-titles-test-'));
process.env.DATA_DIR = TMP;

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const base = (over: Partial<PlayerProfile> = {}): PlayerProfile =>
  ({
    id: 'x', username: 'x', level: 1, xp: 0, xpNext: 250,
    mmrMu: 25, mmrSigma: 8.33, rankMu: 25, rankSigma: 8.33, rankedGames: 0, rankedDuels: 0,
    matchesPlayed: 0, matchesWon: 0, matchesLost: 0, highestRally: 0,
    totalPointsScored: 0, totalAces: 0, multiplayerWins: 0, dailyStreak: 0,
    tier: 'unranked', achievements: [], eliteUnlocks: [],
    createdAt: '', lastActive: '', initialized: true,
    hasAvatar: false, avatarVersion: 0,
    ...over,
  }) as PlayerProfile;

describe('the title catalogue', () => {
  it('names something real to earn for every title', () => {
    for (const id of TITLE_IDS) {
      const def = TITLES[id];
      expect(def.id).toBe(id);
      expect(def.nameKey).toBe(`title_${id}`);
      const req = def.unlockRequirement;
      const arms = [req.achievementId, req.eliteMissionId, req.minLevel, req.minTier].filter((a) => a !== undefined);
      expect(arms.length, `${id} has no way to be earned`).toBeGreaterThan(0);
      if (req.achievementId) expect(achievementById(req.achievementId), `${id}: ${req.achievementId}`).toBeTruthy();
      if (req.eliteMissionId) {
        const mission = findMission(req.eliteMissionId);
        expect(mission?.tier, `${id}: ${req.eliteMissionId}`).toBe('elite');
        // The mission has to bank THIS title, or the arm can never be satisfied.
        expect(mission!.unlocks).toBe(id);
      }
    }
  });

  it('shares one id namespace with the cosmetics and never collides with it', () => {
    // `elite_completions.unlockId` is an opaque string compared against both
    // catalogues; one id in both would open a look and a title for one task.
    for (const id of TITLE_IDS) expect(id in COSMETICS, `${id} is also a cosmetic`).toBe(false);
    for (const id of COSMETIC_IDS) expect(id in TITLES, `${id} is also a title`).toBe(false);
    // And every elite task's reward is exactly one of the two.
    for (const m of ELITE_POOL) {
      const inCosmetics = m.unlocks! in COSMETICS;
      const inTitles = m.unlocks! in TITLES;
      expect(inCosmetics !== inTitles, `${m.id} unlocks '${m.unlocks}'`).toBe(true);
    }
    // No regular task banks anything.
    for (const m of ALL_MISSIONS.filter((x) => x.tier === 'regular')) expect(m.unlocks).toBeUndefined();
  });

  it('resolves a reward id to a display key from whichever catalogue holds it, or null', () => {
    expect(unlockNameKey('void-runner')).toBe('cosmetic_void-runner');
    expect(unlockNameKey('unbroken')).toBe('title_unbroken');
    expect(unlockNameKey('not-a-reward')).toBeNull();
  });
});

describe('isTitleUnlocked', () => {
  it('is shut for a fresh profile and for no profile at all', () => {
    for (const id of TITLE_IDS) {
      expect(isTitleUnlocked(id, base())).toBe(false);
      expect(isTitleUnlocked(id, null)).toBe(false);
    }
  });

  it('opens on an elite unlock, and only on the mission that banks it', () => {
    expect(isTitleUnlocked('unbroken', base({ eliteUnlocks: ['unbroken'] }))).toBe(true);
    expect(isTitleUnlocked('unbroken', base({ eliteUnlocks: ['sniper'] }))).toBe(false);
    expect(isTitleUnlocked('sniper', base({ eliteUnlocks: ['sniper'] }))).toBe(true);
  });

  it('opens on the achievement, the level or the tier — each arm on its own', () => {
    expect(isTitleUnlocked('centurion', base({ achievements: ['level_100'] }))).toBe(true);
    expect(isTitleUnlocked('centurion', base({ level: 100 }))).toBe(true);
    expect(isTitleUnlocked('centurion', base({ level: 99 }))).toBe(false);
    expect(isTitleUnlocked('chaos-ender', base({ achievements: ['chaos_50'] }))).toBe(true);
    expect(isTitleUnlocked('chaos-ender', base({ achievements: ['chaos_25'] }))).toBe(false);
    expect(isTitleUnlocked('overlord', base({ tier: 'overlord' }))).toBe(true);
    expect(isTitleUnlocked('overlord', base({ tier: 'legend' }))).toBe(false);
    expect(isTitleUnlocked('overlord', base({ achievements: ['tier_overlord'] }))).toBe(true);
  });

  it('never opens the tier arm for an unranked profile', () => {
    // TIER_ORDER has no `unranked` entry, so indexOf is -1 on both sides and
    // `-1 >= -1` would pass without the guard — the same trap the cosmetic's
    // tier arm carries a check for.
    expect(isTitleUnlocked('overlord', base({ tier: 'unranked' }))).toBe(false);
  });

  it('normalizes an unknown title to null, never to a default', () => {
    expect(normalizeTitleId('unbroken')).toBe('unbroken');
    expect(normalizeTitleId('neon')).toBeNull(); // a cosmetic is not a title
    expect(normalizeTitleId('')).toBeNull();
    expect(normalizeTitleId(42)).toBeNull();
    expect(normalizeTitleId(undefined)).toBeNull();
  });
});

describe('equipping a title through the store', () => {
  const init = (id: string, username: string) => {
    db.getProfile(id);
    const r = db.initializeProfile(id, username);
    if (!r.ok) throw new Error(`init failed: ${r.code}`);
  };
  const bank = (playerId: string, missionId: string) => {
    const def = findMission(missionId)!;
    const raw = new DatabaseSync(path.join(TMP, 'phong.db'));
    try {
      raw
        .prepare(`INSERT INTO elite_completions (playerId, missionId, unlockId, completedAt) VALUES (?, ?, ?, ?)`)
        .run(playerId, def.id, def.unlocks!, new Date().toISOString());
    } finally {
      raw.close();
    }
  };

  it('refuses a locked title, an unknown one, and an uninitialized profile', () => {
    init('t_lock', 'TitleLock');
    expect(db.setTitle('t_lock', 'unbroken').code).toBe('TITLE_LOCKED');
    expect(db.setTitle('t_lock', 'no-such-title').code).toBe('TITLE_UNKNOWN');
    // A cosmetic id is not a title id, whatever the player owns.
    expect(db.setTitle('t_lock', 'neon').code).toBe('TITLE_UNKNOWN');
    db.getProfile('t_ghost');
    expect(db.setTitle('t_ghost', 'unbroken').code).toBe('PROFILE_NOT_INITIALIZED');
    expect(db.getProfile('t_lock').title).toBeUndefined();
  });

  it('equips an owned title, persists it, shows it publicly, and takes it off on null', () => {
    init('t_wear', 'TitleWear');
    bank('t_wear', 'elite_streak_10');
    expect(db.getProfile('t_wear').eliteUnlocks).toContain('unbroken');
    const res = db.setTitle('t_wear', 'unbroken');
    expect(res.ok).toBe(true);
    expect(res.profile!.title).toBe('unbroken');
    expect(db.getProfile('t_wear').title).toBe('unbroken');
    expect(db.getPublicProfile('t_wear')!.title).toBe('unbroken');
    // Still shut to a title from another mission.
    expect(db.setTitle('t_wear', 'sniper').code).toBe('TITLE_LOCKED');
    // Off again, and null is an answer rather than an error.
    const off = db.setTitle('t_wear', null);
    expect(off.ok).toBe(true);
    expect(db.getProfile('t_wear').title).toBeUndefined();
    expect(db.getPublicProfile('t_wear')!.title).toBeUndefined();
  });

  it('reads a stored title this build no longer ships as none', () => {
    init('t_stale', 'TitleStale');
    const raw = new DatabaseSync(path.join(TMP, 'phong.db'));
    try {
      raw.prepare(`UPDATE players SET title = 'retired-title' WHERE id = ?`).run('t_stale');
    } finally {
      raw.close();
    }
    expect(db.getProfile('t_stale').title).toBeUndefined();
  });
});

describe('the PUT that equips a look equips a title too', () => {
  let relay: Relay;
  const cookies = new Map<string, string>();
  let playerId = '';

  const call = async (p: string, init: RequestInit = {}) => {
    const res = await fetch(`${relay.base}${p}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        cookie: [...cookies.values()].join('; '),
        ...(init.headers || {}),
      },
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';')[0];
      cookies.set(pair.slice(0, pair.indexOf('=')), pair);
    }
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, body };
  };

  beforeAll(async () => {
    relay = await startRelay('titles-test');
    await call('/api/session', { method: 'POST' });
    const onboarded = await call('/api/profile/initialize', {
      method: 'POST',
      body: JSON.stringify({ username: 'TitleRoute' }),
    });
    if (!onboarded.body?.id) throw new Error(`onboarding failed: ${JSON.stringify(onboarded.body)}`);
    playerId = onboarded.body.id;
  }, 40000);

  afterAll(async () => {
    await relay?.stop();
  });

  it('refuses a locked title with 403, an unknown one with 400, and junk with 400', async () => {
    expect((await call('/api/profile/me', { method: 'PUT', body: JSON.stringify({ title: 'unbroken' }) })).status).toBe(403);
    const unknown = await call('/api/profile/me', { method: 'PUT', body: JSON.stringify({ title: 'nope' }) });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('TITLE_UNKNOWN');
    const junk = await call('/api/profile/me', { method: 'PUT', body: JSON.stringify({ title: 42 }) });
    expect(junk.status).toBe(400);
    expect(junk.body.error).toBe('TITLE_INVALID');
  });

  it('equips an owned title, carries it on the public profile, and takes it off on null', async () => {
    const def = findMission('elite_streak_10')!;
    const sql = new DatabaseSync(path.join(relay.dataDir, 'phong.db'));
    try {
      sql
        .prepare(`INSERT INTO elite_completions (playerId, missionId, unlockId, completedAt) VALUES (?, ?, ?, ?)`)
        .run(playerId, def.id, def.unlocks!, new Date().toISOString());
    } finally {
      sql.close();
    }
    const on = await call('/api/profile/me', { method: 'PUT', body: JSON.stringify({ title: 'unbroken' }) });
    expect(on.status).toBe(200);
    expect(on.body.title).toBe('unbroken');
    const pub = await call(`/api/profile/${playerId}`);
    expect(pub.status).toBe(200);
    expect(pub.body.profile.title).toBe('unbroken');
    // The cosmetic half of the same PUT is untouched by any of this.
    const look = await call('/api/profile/me', { method: 'PUT', body: JSON.stringify({ cosmetic: 'retro-crt' }) });
    expect(look.status).toBe(200);
    expect(look.body.cosmetic).toBe('retro-crt');
    expect(look.body.title).toBe('unbroken');
    const off = await call('/api/profile/me', { method: 'PUT', body: JSON.stringify({ title: null }) });
    expect(off.status).toBe(200);
    expect(off.body.title).toBeUndefined();
  });

  it('exposes the ranked-duel count on the public profile as a count, not a rating', async () => {
    const pub = await call(`/api/profile/${playerId}`);
    expect(pub.body.profile.rankedDuels).toBe(0);
    for (const key of ['rankMu', 'rankSigma', 'mmrMu', 'mmrSigma']) expect(pub.body.profile[key]).toBeUndefined();
  });
});

// The type is load-bearing for the id namespace above.
const _typeCheck: TitleId = 'unbroken';
void _typeCheck;
