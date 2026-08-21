import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import {
  PlayerProfile,
  PublicProfile,
  ProfileApiErrorCode,
  Achievement,
  MatchRecord,
  LeaderboardEntry,
  MatchEndPayload,
  MatchEndResult,
  DailyMission,
} from '../src/types';
import { validateUsername, usernameLockExpiry } from '../src/profileRules';
import { isRankedRules } from '../src/matchRules';
import { ALL_ACHIEVEMENTS, achievementById, isUnlockable } from '../src/achievements';
import {
  Rating,
  Tier,
  AI_RATINGS,
  aiRating,
  newRating,
  winProbability,
  updateRating,
  tierFor,
  isPlaced,
  matchXp,
  levelFromXp,
  SOLO_UPDATE,
  PVP_UPDATE,
  PLACEMENT_GAMES,
  surpriseMultiplier,
  normalizeDifficulty,
  practiceXp,
  achievementXpCap,
  PRACTICE_XP_DAILY_CAP,
} from '../src/rating';
import {
  MISSION_DEFS,
  MissionDef,
  applyMatchToProgress,
  findMission,
  missionDayKey,
} from '../src/game/missions';

// Bots are hand-rated and never uncertain.
const BOT_SIGMA = 1.0;

// Extra context the server can supply for a PvP result it has verified
// against its own room state (TrueSkill-2 style signals). Solo never gets
// these — solo stats are self-reported and would be a free rating dial.
export interface RecordMatchContext {
  opponentRating?: Rating;
  /** 0.5..1.5 weight from margin of victory / rally quality. */
  performanceWeight?: number;
}

// Overridable so production can point at a persistent volume (e.g. /data on
// the KVM); the default cwd-relative path serves local development.
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'phong.db');

// One-shot destructive migrations, keyed in the meta table so each runs at
// most once per database. wipe_v1: the pre-launch player wipe — the game
// relaunched with 0 players, so the first boot on an old database drops all
// player data (including auth_secret, which retires every old device cookie).
const WIPE_V1_KEY = 'wipe_v1';
// A second one-shot reset, for the release that retires the Chaos difficulty
// and lowers the AI ceiling: every stored rating was earned against a ladder
// that no longer exists. Like wipe_v1 this also clears `meta`, which rotates
// auth_secret and therefore retires every existing device cookie — see the
// note on PROFILE_NOT_INITIALIZED in server.ts for how clients recover.
const WIPE_V2_KEY = 'wipe_v2';

// Result of any operation that (re)names a profile. Optional fields rather
// than a discriminated union — strictNullChecks is off in this repo, so
// union narrowing wouldn't apply at the call sites.
export interface UsernameResult {
  ok: boolean;
  profile?: PlayerProfile;
  code?: ProfileApiErrorCode;
  unlockAt?: string;
}

// The catalogue itself lives in src/achievements.ts so the client can draw
// the tree without asking the server what shape it is. Re-exported here
// because every consumer of the database already imports from this module.
export { ALL_ACHIEVEMENTS };

function calculateLevelFromXp(xp: number): { level: number; xpNext: number } {
  return levelFromXp(xp);
}

function updatePlayerStreak(profile: PlayerProfile): void {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

  if (!profile.lastDailyDate) {
    profile.dailyStreak = 1;
    profile.lastDailyDate = todayStr;
    return;
  }

  if (profile.lastDailyDate === todayStr) {
    // Already logged in today
    if (!profile.dailyStreak || profile.dailyStreak < 1) profile.dailyStreak = 1;
    return;
  }

  const lastDate = new Date(profile.lastDailyDate + 'T00:00:00Z');
  const todayDate = new Date(todayStr + 'T00:00:00Z');
  const diffDays = Math.round((todayDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 1) {
    // Consecutive day!
    profile.dailyStreak = (profile.dailyStreak || 0) + 1;
  } else if (diffDays > 1) {
    // Missed at least one day, reset to 1
    profile.dailyStreak = 1;
  }
  profile.lastDailyDate = todayStr;
}

interface PlayerRow {
  /** Added by migration, so an old row reads back null. */
  multiplayerWins: number | null;
  id: string;
  username: string;
  level: number;
  xp: number;
  xpNext: number;
  eloRating: number | null; // legacy column, no longer used
  mmrMu: number;
  mmrSigma: number;
  rankMu: number;
  rankSigma: number;
  rankedGames: number;
  matchesPlayed: number;
  matchesWon: number;
  matchesLost: number;
  highestRally: number;
  totalPointsScored: number;
  totalAces: number;
  dailyStreak: number;
  lastDailyDate: string;
  achievements: string;
  createdAt: string;
  lastActive: string;
  rankTitle: string | null; // legacy column, superseded by the derived tier
  recoveryCode: string | null;
  initializedAt: string | null;
  usernameChangedAt: string | null;
  // From the LEFT JOIN on avatars; NULL when the player has no avatar.
  avatarUpdatedAt?: string | null;
}

function rowToProfile(row: PlayerRow): PlayerProfile {
  // eloRating/rankTitle are dead columns kept for old databases; strip them so
  // no raw rating number can leak into a profile payload.
  const { avatarUpdatedAt, eloRating, rankTitle, ...rest } = row;
  return {
    ...rest,
    tier: tierFor(row.rankMu, row.rankedGames, row.rankSigma),
    // Defaulted rather than required: a row written before the column existed
    // reads back as null under the ALTER TABLE default.
    multiplayerWins: row.multiplayerWins || 0,
    achievements: JSON.parse(row.achievements || '[]'),
    recoveryCode: row.recoveryCode || undefined,
    initializedAt: row.initializedAt || undefined,
    usernameChangedAt: row.usernameChangedAt || undefined,
    initialized: Boolean(row.initializedAt),
    hasAvatar: Boolean(avatarUpdatedAt),
    avatarVersion: avatarUpdatedAt ? Date.parse(avatarUpdatedAt) : undefined,
  };
}

class GameDatabase {
  private sql: DatabaseSync;

  constructor() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    this.sql = new DatabaseSync(DB_FILE);
    this.sql.exec('PRAGMA journal_mode = WAL');
    this.ensureBaseSchema();
    this.applyWipeV1();
    this.migrateSchema();
  }

  // Full modern schema. IF NOT EXISTS everywhere so it is safe both on a
  // brand-new file and after the wipe drops the data tables.
  private ensureBaseSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        level INTEGER NOT NULL,
        xp INTEGER NOT NULL,
        xpNext INTEGER NOT NULL,
        eloRating INTEGER,
        mmrMu REAL NOT NULL DEFAULT 25,
        mmrSigma REAL NOT NULL DEFAULT 8.3333,
        rankMu REAL NOT NULL DEFAULT 25,
        rankSigma REAL NOT NULL DEFAULT 8.3333,
        rankedGames INTEGER NOT NULL DEFAULT 0,
        matchesPlayed INTEGER NOT NULL,
        matchesWon INTEGER NOT NULL,
        matchesLost INTEGER NOT NULL,
        highestRally INTEGER NOT NULL,
        totalPointsScored INTEGER NOT NULL,
        totalAces INTEGER NOT NULL,
        multiplayerWins INTEGER NOT NULL DEFAULT 0,
        dailyStreak INTEGER NOT NULL,
        lastDailyDate TEXT NOT NULL,
        achievements TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        lastActive TEXT NOT NULL,
        rankTitle TEXT,
        recoveryCode TEXT,
        initializedAt TEXT,
        usernameChangedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        player1Id TEXT NOT NULL,
        player1Name TEXT NOT NULL,
        player2Id TEXT NOT NULL,
        player2Name TEXT NOT NULL,
        winnerId TEXT NOT NULL,
        winnerName TEXT NOT NULL,
        scoreP1 INTEGER NOT NULL,
        scoreP2 INTEGER NOT NULL,
        maxRally INTEGER NOT NULL,
        mode TEXT NOT NULL,
        difficulty TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_matches_p1 ON matches(player1Id);
      CREATE INDEX IF NOT EXISTS idx_matches_p2 ON matches(player2Id);
      CREATE TABLE IF NOT EXISTS avatars (
        playerId TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      -- Daily mission progress, one row per player/day/mission. Server-owned:
      -- progress only ever advances from a recorded match, and the PRIMARY KEY
      -- is what makes a claim idempotent.
      CREATE TABLE IF NOT EXISTS daily_missions (
        playerId TEXT NOT NULL,
        dayKey TEXT NOT NULL,
        missionId TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        claimedAt TEXT,
        PRIMARY KEY (playerId, dayKey, missionId)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_missions_player
        ON daily_missions (playerId, dayKey);
      -- Practice Wall XP paid per UTC day, so the daily cap survives restarts.
      CREATE TABLE IF NOT EXISTS daily_practice (
        playerId TEXT NOT NULL,
        dayKey TEXT NOT NULL,
        xpAwarded INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (playerId, dayKey)
      );
    `);
  }

  // The one-time pre-launch player wipe. Runs exactly once per database
  // (guarded by the wipe_v1 meta flag): drops every player, match, and
  // avatar, and clears meta — including auth_secret, so every previously
  // issued device cookie fails verification and each device re-onboards as
  // a brand-new player. New databases just get the flag stamped.
  private applyWipeV1(): void {
    this.applyWipe(WIPE_V1_KEY, 'wipe_v1: cleared all player data for the fresh launch (0 players)');
    this.applyWipe(WIPE_V2_KEY, 'wipe_v2: cleared all player data for the rebalanced AI ladder (0 players)');
  }

  private applyWipe(key: string, message: string): void {
    if (this.getMeta(key)) return;
    const hadPlayers = this.playerCount() > 0;
    this.sql.exec('BEGIN');
    try {
      this.sql.exec('DROP TABLE IF EXISTS players');
      this.sql.exec('DROP TABLE IF EXISTS matches');
      this.sql.exec('DROP TABLE IF EXISTS avatars');
      this.sql.exec('DROP TABLE IF EXISTS daily_missions');
      this.sql.exec('DROP TABLE IF EXISTS daily_practice');
      this.sql.exec('DELETE FROM meta');
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
    this.ensureBaseSchema();
    // Every wipe flag is re-stamped: a later one must not re-run an earlier.
    this.setMeta(WIPE_V1_KEY, new Date().toISOString());
    this.setMeta(key, new Date().toISOString());
    if (hadPlayers) console.log(message);
  }

  // Additive schema changes for databases created by earlier builds. After
  // wipe_v1 these are no-ops on the freshly recreated tables, but they keep
  // any straggler database shape-compatible before indexes are created.
  private migrateSchema(): void {
    const cols = this.sql.prepare('PRAGMA table_info(players)').all() as unknown as Array<{ name: string }>;
    const addColumn = (name: string, ddl: string) => {
      if (!cols.some((c) => c.name === name)) {
        this.sql.exec(`ALTER TABLE players ADD COLUMN ${ddl}`);
      }
    };
    addColumn('recoveryCode', 'recoveryCode TEXT');
    // TrueSkill-style ratings replaced the old fixed-delta ELO.
    addColumn('mmrMu', 'mmrMu REAL NOT NULL DEFAULT 25');
    addColumn('mmrSigma', 'mmrSigma REAL NOT NULL DEFAULT 8.3333');
    addColumn('rankMu', 'rankMu REAL NOT NULL DEFAULT 25');
    addColumn('rankSigma', 'rankSigma REAL NOT NULL DEFAULT 8.3333');
    addColumn('rankedGames', 'rankedGames INTEGER NOT NULL DEFAULT 0');
    addColumn('initializedAt', 'initializedAt TEXT');
    addColumn('usernameChangedAt', 'usernameChangedAt TEXT');
    // The duel branch counts PvP wins on their own; matchesWon mixes in solo.
    addColumn('multiplayerWins', 'multiplayerWins INTEGER NOT NULL DEFAULT 0');
    this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_players_recovery ON players(recoveryCode)');
    // Uniqueness is case-insensitive and applies to chosen names only:
    // uninitialized rows keep their Paddle-XXXX placeholders outside the
    // index, and a released name frees its slot the moment the row updates.
    this.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_players_username
         ON players(username COLLATE NOCASE) WHERE initializedAt IS NOT NULL`
    );
    // Achievement ids are persisted in each player's JSON array, so renaming
    // one silently un-awards it — and re-awards it later, paying its XP twice.
    // 'rating_1400' was named for the ELO threshold it used to key on; it has
    // keyed on the Master tier since ELO was replaced.
    this.renameAchievement('rating_1400', 'master_tier');

    // Backfill codes for rows created before recovery codes existed
    const missing = this.sql
      .prepare('SELECT id FROM players WHERE recoveryCode IS NULL')
      .all() as unknown as Array<{ id: string }>;
    for (const row of missing) {
      this.sql
        .prepare('UPDATE players SET recoveryCode = ? WHERE id = ?')
        .run(this.newRecoveryCode(), row.id);
    }
  }

  /** Rewrite a stored achievement id across every profile that holds it. */
  private renameAchievement(from: string, to: string): void {
    const rows = this.sql
      .prepare(`SELECT id, achievements FROM players WHERE achievements LIKE ?`)
      .all(`%"${from}"%`) as unknown as Array<{ id: string; achievements: string }>;
    for (const row of rows) {
      let list: string[];
      try {
        list = JSON.parse(row.achievements || '[]');
      } catch {
        continue;
      }
      if (!Array.isArray(list) || !list.includes(from)) continue;
      // Map then de-duplicate, in case both ids somehow ended up stored.
      const renamed = Array.from(new Set(list.map((a) => (a === from ? to : a))));
      this.sql
        .prepare('UPDATE players SET achievements = ? WHERE id = ?')
        .run(JSON.stringify(renamed), row.id);
    }
  }

  public getMeta(key: string): string | null {
    const row = this.sql.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  public setMeta(key: string, value: string): void {
    this.sql
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // Human-friendly code (no 0/O/1/I), e.g. "K3TF-9WQZ". Unique via index +
  // retry; the space is ~1.1e12 so collisions are effectively theoretical.
  private newRecoveryCode(): string {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    for (;;) {
      let code = '';
      for (let i = 0; i < 8; i++) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
        if (i === 3) code += '-';
      }
      const clash = this.sql.prepare('SELECT 1 FROM players WHERE recoveryCode = ?').get(code);
      if (!clash) return code;
    }
  }

  private playerCount(): number {
    const row = this.sql.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number };
    return row.n;
  }

  private upsertProfile(p: PlayerProfile): void {
    this.sql
      .prepare(
        `INSERT INTO players (id, username, level, xp, xpNext, mmrMu, mmrSigma, rankMu, rankSigma, rankedGames, matchesPlayed, matchesWon,
           matchesLost, highestRally, totalPointsScored, totalAces, multiplayerWins, dailyStreak, lastDailyDate,
           achievements, createdAt, lastActive, recoveryCode, initializedAt, usernameChangedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           username=excluded.username, level=excluded.level, xp=excluded.xp, xpNext=excluded.xpNext,
           mmrMu=excluded.mmrMu, mmrSigma=excluded.mmrSigma, rankMu=excluded.rankMu,
           rankSigma=excluded.rankSigma, rankedGames=excluded.rankedGames,
           matchesPlayed=excluded.matchesPlayed,
           matchesWon=excluded.matchesWon, matchesLost=excluded.matchesLost,
           highestRally=excluded.highestRally, totalPointsScored=excluded.totalPointsScored,
           totalAces=excluded.totalAces, multiplayerWins=excluded.multiplayerWins,
           dailyStreak=excluded.dailyStreak,
           lastDailyDate=excluded.lastDailyDate, achievements=excluded.achievements,
           createdAt=excluded.createdAt, lastActive=excluded.lastActive,
           recoveryCode=excluded.recoveryCode, initializedAt=excluded.initializedAt,
           usernameChangedAt=excluded.usernameChangedAt`
      )
      .run(
        p.id,
        p.username,
        p.level,
        p.xp,
        p.xpNext,
        p.mmrMu,
        p.mmrSigma,
        p.rankMu,
        p.rankSigma,
        p.rankedGames,
        p.matchesPlayed,
        p.matchesWon,
        p.matchesLost,
        p.highestRally,
        p.totalPointsScored,
        p.totalAces,
        p.multiplayerWins || 0,
        p.dailyStreak,
        p.lastDailyDate,
        JSON.stringify(p.achievements),
        p.createdAt,
        p.lastActive,
        p.recoveryCode ?? null,
        p.initializedAt ?? null,
        p.usernameChangedAt ?? null
      );
  }

  private insertMatch(m: MatchRecord): void {
    this.sql
      .prepare(
        `INSERT INTO matches (id, player1Id, player1Name, player2Id, player2Name, winnerId, winnerName,
           scoreP1, scoreP2, maxRally, mode, difficulty, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.id,
        m.player1Id,
        m.player1Name,
        m.player2Id,
        m.player2Name,
        m.winnerId,
        m.winnerName,
        m.scoreP1,
        m.scoreP2,
        m.maxRally,
        m.mode,
        m.difficulty ?? null,
        m.timestamp
      );
  }

  private readProfile(id: string): PlayerProfile | null {
    const row = this.sql
      .prepare(
        `SELECT p.*, a.updatedAt AS avatarUpdatedAt
           FROM players p LEFT JOIN avatars a ON a.playerId = p.id
          WHERE p.id = ?`
      )
      .get(id) as unknown as PlayerRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  public getProfile(id: string): PlayerProfile {
    const existing = this.readProfile(id);
    if (!existing) {
      const now = new Date().toISOString();
      const todayStr = now.slice(0, 10);
      // Placeholder name until onboarding locks in a real one. Use the END of
      // the id: device ids share a dev_ prefix, so the head would name every
      // new player identically.
      const username = `Paddle-${id.slice(-4).toUpperCase()}`;
      const newPlayer: PlayerProfile = {
        id,
        username,
        level: 1,
        xp: 0,
        xpNext: 250,
        mmrMu: newRating().mu,
        mmrSigma: newRating().sigma,
        rankMu: newRating().mu,
        rankSigma: newRating().sigma,
        rankedGames: 0,
        matchesPlayed: 0,
        matchesWon: 0,
        matchesLost: 0,
        highestRally: 0,
        totalPointsScored: 0,
        totalAces: 0,
        multiplayerWins: 0,
        dailyStreak: 1,
        lastDailyDate: todayStr,
        achievements: [],
        createdAt: now,
        lastActive: now,
        tier: 'unranked',
        recoveryCode: this.newRecoveryCode(),
        initialized: false,
        hasAvatar: false,
      };
      this.upsertProfile(newPlayer);
      return newPlayer;
    }

    const prevStreak = existing.dailyStreak;
    const prevDate = existing.lastDailyDate;
    updatePlayerStreak(existing);
    if (existing.dailyStreak !== prevStreak || existing.lastDailyDate !== prevDate) {
      this.upsertProfile(existing);
    }
    return existing;
  }

  // True when no INITIALIZED profile other than `forId` holds `username`
  // (case-insensitive). Placeholder names on uninitialized rows don't count.
  public isUsernameAvailable(username: string, forId?: string): boolean {
    const row = this.sql
      .prepare(
        'SELECT id FROM players WHERE username = ? COLLATE NOCASE AND initializedAt IS NOT NULL'
      )
      .get(username) as unknown as { id: string } | undefined;
    return !row || row.id === forId;
  }

  /**
   * First-arrival onboarding: locks in the player's chosen unique username
   * and stamps initializedAt / usernameChangedAt (the 365-day lock starts
   * now). One-shot — an initialized profile can't initialize again.
   */
  public initializeProfile(id: string, username: string, nowIso?: string): UsernameResult {
    const now = nowIso || new Date().toISOString();
    const check = validateUsername(username);
    if (!check.ok) return { ok: false, code: 'USERNAME_INVALID' };
    const profile = this.getProfile(id);
    if (profile.initializedAt) return { ok: false, code: 'ALREADY_INITIALIZED' };
    if (!this.isUsernameAvailable(username, id)) return { ok: false, code: 'USERNAME_TAKEN' };

    profile.username = username;
    profile.initializedAt = now;
    profile.usernameChangedAt = now;
    profile.lastActive = now;
    try {
      this.upsertProfile(profile);
    } catch {
      // Unique-index race: someone claimed the name between check and write.
      return { ok: false, code: 'USERNAME_TAKEN' };
    }
    return { ok: true, profile: this.readProfile(id)! };
  }

  /**
   * Rename an initialized profile. Enforces the 365-day lock from the last
   * change (== initialization for first-timers); the old name is released
   * for anyone else the moment the row updates. `nowIso` is injectable so
   * tests can travel through time.
   */
  public changeUsername(id: string, username: string, nowIso?: string): UsernameResult {
    const now = nowIso || new Date().toISOString();
    const profile = this.getProfile(id);
    if (!profile.initializedAt) return { ok: false, code: 'PROFILE_NOT_INITIALIZED' };
    if (username === profile.username) return { ok: true, profile }; // no-op

    const check = validateUsername(username);
    if (!check.ok) return { ok: false, code: 'USERNAME_INVALID' };

    const lockBasis = profile.usernameChangedAt || profile.initializedAt;
    const unlockAt = usernameLockExpiry(lockBasis);
    if (Date.parse(now) < unlockAt.getTime()) {
      return { ok: false, code: 'USERNAME_LOCKED', unlockAt: unlockAt.toISOString() };
    }
    if (!this.isUsernameAvailable(username, id)) return { ok: false, code: 'USERNAME_TAKEN' };

    profile.username = username;
    profile.usernameChangedAt = now;
    profile.lastActive = now;
    try {
      this.upsertProfile(profile);
    } catch {
      return { ok: false, code: 'USERNAME_TAKEN' };
    }
    return { ok: true, profile: this.readProfile(id)! };
  }

  // Client-trusted XP grant (daily mission rewards). Clamped small so the
  // endpoint can't be used to speed-level; level/rank re-derive from XP.
  /**
   * Award XP for a Practice Wall session. The client reports the streak it
   * reached; the server decides what that is worth and how much of the daily
   * allowance is left, so nothing here takes an XP amount from the caller.
   * Practice records no match, moves no rating, and feeds no missions.
   */
  public recordPractice(
    playerId: string,
    bestStreak: number,
    now: Date = new Date()
  ): {
    earnedXp: number;
    dailyRemaining: number;
    newAchievements: Achievement[];
    profile: PlayerProfile;
  } {
    const profile = this.getProfile(playerId);
    if (!profile.initializedAt) throw new Error('PROFILE_NOT_INITIALIZED');

    const dayKey = missionDayKey(now);
    const row = this.sql
      .prepare(`SELECT xpAwarded FROM daily_practice WHERE playerId = ? AND dayKey = ?`)
      .get(playerId, dayKey) as { xpAwarded: number } | undefined;
    const alreadyPaid = row?.xpAwarded ?? 0;

    const earnedXp = Math.max(
      0,
      Math.min(practiceXp(bestStreak), PRACTICE_XP_DAILY_CAP - alreadyPaid)
    );

    // The rally branch's wall rungs are the only achievements a player who
    // never records a match can reach, so they are checked here as well.
    const streak = Math.max(0, Math.floor(bestStreak || 0));
    const newAchievements: Achievement[] = [];
    let budget = achievementXpCap(profile.level);
    const grantWall = (achId: string) => {
      if (!isUnlockable(achId, profile.achievements)) return;
      if (profile.achievements.includes(achId)) return;
      const meta = achievementById(achId);
      if (!meta) return;
      profile.achievements.push(achId);
      const awardedXp = Math.max(0, Math.min(meta.xpReward, budget));
      budget -= awardedXp;
      profile.xp += awardedXp;
      newAchievements.push({ ...meta, unlockedAt: now.toISOString(), awardedXp });
    };
    if (streak >= 30) grantWall('wall_30');
    if (streak >= 90) grantWall('wall_90');

    if (earnedXp > 0 || newAchievements.length > 0) {
      if (earnedXp > 0) {
        this.sql
          .prepare(
            `INSERT INTO daily_practice (playerId, dayKey, xpAwarded) VALUES (?, ?, ?)
             ON CONFLICT(playerId, dayKey) DO UPDATE SET xpAwarded = xpAwarded + excluded.xpAwarded`
          )
          .run(playerId, dayKey, earnedXp);
      }

      profile.xp += earnedXp;
      const { level, xpNext } = calculateLevelFromXp(profile.xp);
      profile.level = level;
      profile.xpNext = xpNext;
      profile.lastActive = now.toISOString();
      this.upsertProfile(profile);
    }

    return {
      earnedXp,
      dailyRemaining: Math.max(0, PRACTICE_XP_DAILY_CAP - alreadyPaid - earnedXp),
      newAchievements,
      profile: this.readProfile(playerId)!,
    };
  }

  // ---- Daily missions -----------------------------------------------------
  // Server-owned in full. Progress advances only from recordMatch, and a claim
  // is guarded by the (playerId, dayKey, missionId) primary key, so replaying
  // a claim — or clearing browser storage — grants nothing.

  private missionRows(playerId: string, dayKey: string): Map<string, { progress: number; claimedAt: string | null }> {
    const rows = this.sql
      .prepare(`SELECT missionId, progress, claimedAt FROM daily_missions WHERE playerId = ? AND dayKey = ?`)
      .all(playerId, dayKey) as { missionId: string; progress: number; claimedAt: string | null }[];
    return new Map(rows.map((r) => [r.missionId, { progress: r.progress, claimedAt: r.claimedAt }]));
  }

  /** Today's missions for a player, defaulting to zero progress. */
  public getMissions(playerId: string, now: Date = new Date()): DailyMission[] {
    const dayKey = missionDayKey(now);
    const rows = this.missionRows(playerId, dayKey);
    return MISSION_DEFS.map((def) => {
      const row = rows.get(def.id);
      return {
        id: def.id,
        type: def.type,
        titleKey: def.titleKey,
        descKey: def.descKey,
        target: def.target,
        xpReward: def.xpReward,
        current: Math.min(def.target, row?.progress ?? 0),
        claimed: !!row?.claimedAt,
      };
    });
  }

  /** Advance every mission this match touches. Called from recordMatch only. */
  private advanceMissions(playerId: string, payload: MatchEndPayload, now: Date): void {
    const dayKey = missionDayKey(now);
    const rows = this.missionRows(playerId, dayKey);
    const upsert = this.sql.prepare(
      `INSERT INTO daily_missions (playerId, dayKey, missionId, progress)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(playerId, dayKey, missionId) DO UPDATE SET progress = excluded.progress`
    );
    for (const def of MISSION_DEFS) {
      const current = rows.get(def.id)?.progress ?? 0;
      const next = applyMatchToProgress(def, current, payload);
      if (next !== current) upsert.run(playerId, dayKey, def.id, next);
    }
  }

  /**
   * Claim one mission's reward. The XP amount comes from the definition table,
   * never from the caller, and the row is stamped claimed in the same step.
   */
  public claimMission(
    playerId: string,
    missionId: string,
    now: Date = new Date()
  ): { ok: boolean; code?: 'MISSION_UNKNOWN' | 'MISSION_INCOMPLETE' | 'MISSION_CLAIMED'; profile?: PlayerProfile; missions?: DailyMission[]; earnedXp?: number } {
    const def: MissionDef | undefined = findMission(missionId);
    if (!def) return { ok: false, code: 'MISSION_UNKNOWN' };

    const dayKey = missionDayKey(now);
    const row = this.missionRows(playerId, dayKey).get(def.id);
    const progress = row?.progress ?? 0;
    if (row?.claimedAt) return { ok: false, code: 'MISSION_CLAIMED' };
    if (progress < def.target) return { ok: false, code: 'MISSION_INCOMPLETE' };

    // Stamp the claim FIRST and only pay out if this call is the one that
    // stamped it, so two concurrent claims cannot both award the reward.
    const stamped = this.sql
      .prepare(
        `UPDATE daily_missions SET claimedAt = ?
         WHERE playerId = ? AND dayKey = ? AND missionId = ? AND claimedAt IS NULL`
      )
      .run(now.toISOString(), playerId, dayKey, def.id);
    if (!stamped.changes) return { ok: false, code: 'MISSION_CLAIMED' };

    const profile = this.getProfile(playerId);
    profile.xp += def.xpReward;
    const { level, xpNext } = calculateLevelFromXp(profile.xp);
    profile.level = level;
    profile.xpNext = xpNext;
    profile.lastActive = now.toISOString();
    this.upsertProfile(profile);

    return {
      ok: true,
      profile: this.readProfile(playerId)!,
      missions: this.getMissions(playerId, now),
      earnedXp: def.xpReward,
    };
  }

  // ---- Avatars: exactly 256x256 PNGs, validated in server/image.ts before
  // they get here. Returns the new avatarVersion (epoch ms cache-buster).
  public setAvatar(playerId: string, data: Uint8Array): number {
    const now = new Date().toISOString();
    this.sql
      .prepare(
        `INSERT INTO avatars (playerId, data, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(playerId) DO UPDATE SET data=excluded.data, updatedAt=excluded.updatedAt`
      )
      .run(playerId, data, now);
    return Date.parse(now);
  }

  public getAvatar(playerId: string): { data: Uint8Array; updatedAt: string } | null {
    const row = this.sql
      .prepare('SELECT data, updatedAt FROM avatars WHERE playerId = ?')
      .get(playerId) as unknown as { data: Uint8Array; updatedAt: string } | undefined;
    return row || null;
  }

  public deleteAvatar(playerId: string): void {
    this.sql.prepare('DELETE FROM avatars WHERE playerId = ?').run(playerId);
  }

  // The world-readable view of a profile. Uninitialized profiles don't exist
  // publicly; recoveryCode / lastDailyDate / lastActive never leave the DB.
  public getPublicProfile(id: string): PublicProfile | null {
    const p = this.readProfile(id);
    if (!p || !p.initializedAt) return null;
    return {
      id: p.id,
      username: p.username,
      level: p.level,
      xp: p.xp,
      xpNext: p.xpNext,
      matchesPlayed: p.matchesPlayed,
      matchesWon: p.matchesWon,
      matchesLost: p.matchesLost,
      highestRally: p.highestRally,
      totalPointsScored: p.totalPointsScored,
      totalAces: p.totalAces,
      multiplayerWins: p.multiplayerWins || 0,
      dailyStreak: p.dailyStreak,
      tier: p.tier,
      rankedGames: p.rankedGames,
      createdAt: p.createdAt,
      achievements: p.achievements,
      hasAvatar: p.hasAvatar,
      avatarVersion: p.avatarVersion,
      isBot: p.id.startsWith('bot-') || undefined,
    };
  }

  /**
   * Insert a bot profile (id must start with "bot-"). Bots are initialized
   * so they hold their usernames and appear on the leaderboard when
   * requested. This is the seam for the future bot roster — nothing seeds
   * automatically since the wipe_v1 fresh launch.
   */
  public insertBot(
    bot: Partial<PlayerProfile> & { id: string; username: string; mu?: number }
  ): PlayerProfile {
    if (!bot.id.startsWith('bot-')) {
      throw new Error('Bot ids must start with "bot-"');
    }
    const now = new Date().toISOString();
    const todayStr = now.slice(0, 10);
    const { level, xpNext } = calculateLevelFromXp(bot.xp || 0);
    const botMu = bot.mu ?? bot.rankMu ?? 25;
    const full: PlayerProfile = {
      id: bot.id,
      username: bot.username,
      level,
      xp: bot.xp || 0,
      xpNext,
      mmrMu: botMu,
      mmrSigma: BOT_SIGMA,
      rankMu: botMu,
      rankSigma: BOT_SIGMA,
      // Bots are pre-placed so they carry a real tier on the leaderboard.
      rankedGames: bot.rankedGames ?? PLACEMENT_GAMES,
      matchesPlayed: bot.matchesPlayed || 0,
      matchesWon: bot.matchesWon || 0,
      matchesLost: bot.matchesLost || 0,
      highestRally: bot.highestRally || 0,
      totalPointsScored: bot.totalPointsScored || 0,
      totalAces: bot.totalAces || 0,
      multiplayerWins: bot.multiplayerWins || 0,
      dailyStreak: bot.dailyStreak || 1,
      lastDailyDate: todayStr,
      achievements: bot.achievements || [],
      createdAt: now,
      lastActive: now,
      tier: tierFor(botMu, bot.rankedGames ?? PLACEMENT_GAMES, BOT_SIGMA),
      recoveryCode: this.newRecoveryCode(),
      initialized: true,
      initializedAt: now,
      usernameChangedAt: now,
      hasAvatar: false,
    };
    this.upsertProfile(full);
    return this.readProfile(bot.id)!;
  }

  public recordMatch(payload: MatchEndPayload, context: RecordMatchContext = {}): MatchEndResult {
    const opponentRating = context.opponentRating;
    const performance = context.performanceWeight ?? 1;
    const profile = this.getProfile(payload.playerId);
    // Names come from the profile, never the payload — backstop for the
    // route-level 403 so no code path records under an unclaimed identity.
    if (!profile.initializedAt) {
      throw new Error('PROFILE_NOT_INITIALIZED');
    }
    const prevLevel = profile.level;
    const isWin = payload.isWinner;

    // 1. Predict the matchup BEFORE scoring it. Hidden MMR vs the opponent's
    // rating decides both how much the rating moves and how much XP is paid,
    // so difficulty scaling is implicit — there is no per-difficulty table.
    const isPvp = payload.mode === 'multiplayer';
    // A client on an older bundle can still name a retired difficulty.
    const difficulty = normalizeDifficulty(payload.difficulty);
    const myMmr: Rating = { mu: profile.mmrMu, sigma: profile.mmrSigma };
    const oppRating: Rating = isPvp
      ? opponentRating || { mu: profile.mmrMu, sigma: profile.mmrSigma }
      // The AI slides part-way toward the player's own rating, so the anchor
      // to rate against is the strength they actually faced, not the label.
      : aiRating(difficulty, profile.mmrMu);
    const winProb = winProbability(myMmr, oppRating);

    // 2. Experience — always positive, never subtracted: levels can't regress.
    const earnedXp = matchXp({
      playerScore: payload.playerScore,
      maxRally: payload.maxRally,
      won: isWin,
      winProb,
      mode: payload.mode,
    });
    profile.xp += earnedXp;

    const { level, xpNext } = calculateLevelFromXp(profile.xp);
    const leveledUp = level > prevLevel;
    profile.level = level;
    profile.xpNext = xpNext;

    // 3. Skill rating. Hidden MMR moves on EVERY match; the ranked rating that
    // drives the visible tier moves on PvP ONLY, so solo results can never
    // change a player's rank.
    // A match played on non-stock physics (a wider paddle, a bigger ball, a
    // different speed band) still pays XP but must not move the rating: the
    // tier ladder only means something if every ranked match used one ruleset.
    // Re-derived from the rules themselves, never from a client-set flag.
    const ranked = isRankedRules(payload.rules);
    const previousTier = profile.tier;
    const soloOpts = {
      ...SOLO_UPDATE,
      // A solo win can't push mu past the anchor it beat: farming a weak
      // difficulty converges on that difficulty and stops. Deliberately the
      // BASE anchor, not the adapted one — capping at a target that rises with
      // the player would be circular and let solo lift mu without limit.
      cap: AI_RATINGS[difficulty].mu,
    };
    if (ranked) {
      const nextMmr = updateRating(
        myMmr,
        oppRating,
        isWin,
        isPvp ? { ...PVP_UPDATE, performance } : soloOpts
      );
      profile.mmrMu = nextMmr.mu;
      profile.mmrSigma = nextMmr.sigma;
    }

    if (isPvp && ranked) {
      const nextRank = updateRating(
        { mu: profile.rankMu, sigma: profile.rankSigma },
        oppRating,
        isWin,
        { ...PVP_UPDATE, performance }
      );
      profile.rankMu = nextRank.mu;
      profile.rankSigma = nextRank.sigma;
      profile.rankedGames += 1;
    }
    profile.tier = tierFor(profile.rankMu, profile.rankedGames, profile.rankSigma);

    // 3. Update Match Statistics
    profile.matchesPlayed += 1;
    if (isWin) {
      profile.matchesWon += 1;
    } else {
      profile.matchesLost += 1;
    }
    profile.totalPointsScored += payload.playerScore;
    // Aces were a stored column nothing ever incremented, so `ace_sniper` was
    // unobtainable. Self-reported like every other solo stat, and bounded by
    // the achievements being once-only.
    profile.totalAces += Math.max(0, Math.min(payload.playerScore, Math.round(payload.aces || 0)));
    if (isWin && payload.mode === 'multiplayer') profile.multiplayerWins += 1;
    if (payload.maxRally > profile.highestRally) {
      profile.highestRally = payload.maxRally;
    }
    profile.lastActive = new Date().toISOString();

    // 4. Check & Unlock Achievements
    const newAchievements: Achievement[] = [];
    // Achievements that mean "you beat something" are worth what that something
    // was actually worth. The AI adapts to the player, so a flat reward would
    // pay a mu-40 player the same for a Cyber win they take often as a mu-25
    // player for one they take rarely. Same multiplier the match XP uses, so
    // there is still no per-difficulty table anywhere.
    const achievementMultiplier = surpriseMultiplier(winProb, isWin);
    let achievementBudget = achievementXpCap(profile.level);
    // Tree rule, strictly: a child cannot be earned before its parent, and the
    // parent is never granted implicitly. Auto-granting ancestors seemed
    // helpful until the data showed it handing out `ai_rookie` for beating
    // Pro — a difficulty the player had never beaten. Where one result really
    // does satisfy a whole chain (a 50-hit rally is also a 25 and a 10), the
    // triggers below fire in order and each rung opens the next.
    const unlock = (achId: string) => {
      if (!isUnlockable(achId, profile.achievements)) return;
      grant(achId);
    };

    const grant = (achId: string) => {
      if (!profile.achievements.includes(achId)) {
        profile.achievements.push(achId);
        const meta = achievementById(achId);
        if (meta) {
          const scaled = meta.scaled
            ? Math.max(1, Math.round(meta.xpReward * achievementMultiplier))
            : meta.xpReward;
          // Never hand over most of a level — see the cap's note in rating.ts.
          // The budget is for everything this match unlocks, so several
          // achievements landing together cannot stack into a free level. It
          // is measured against the level the player is on as the batch lands,
          // which is after this match's own XP has been applied.
          const awardedXp = Math.max(0, Math.min(scaled, achievementBudget));
          achievementBudget -= awardedXp;
          newAchievements.push({ ...meta, unlockedAt: new Date().toISOString(), awardedXp });
          profile.xp += awardedXp;
        }
      }
    };

    // Achievement triggers
    const solo = payload.mode === 'solo';
    const pvp = payload.mode === 'multiplayer';
    const shutOut = isWin && payload.opponentScore === 0 && payload.playerScore >= 5;
    const placed = isPlaced(profile.rankedGames, profile.rankSigma);

    // Foundation
    if (payload.maxRally >= 1) unlock('first_serve');
    if (isWin) unlock('first_win');
    if (shutOut) unlock('shutout');
    if (profile.matchesPlayed >= 10) unlock('veteran_10');
    if (profile.matchesPlayed >= 50) unlock('veteran_50');
    if (profile.matchesPlayed >= 200) unlock('veteran_200');
    if (profile.level >= 5) unlock('level_5');
    if (profile.level >= 10) unlock('level_10');
    if (profile.level >= 25) unlock('level_25');
    if (profile.dailyStreak >= 7) unlock('streak_7');

    // Rally
    if (payload.maxRally >= 10) unlock('rally_10');
    if (payload.maxRally >= 25) unlock('rally_25');
    if (payload.maxRally >= 50) unlock('rally_50');
    if (payload.maxRally >= 100) unlock('rally_100');

    // Ladder
    if (isWin && solo && difficulty === 'rookie') unlock('ai_rookie');
    if (isWin && solo && difficulty === 'pro') unlock('ai_pro');
    if (isWin && solo && difficulty === 'cyber') unlock('cyber_slayer');
    if (shutOut && solo && difficulty === 'cyber') unlock('cyber_shutout');

    // Duel
    if (pvp) unlock('first_duel');
    if (isWin && pvp) unlock('multiplayer_champ');
    if (profile.multiplayerWins >= 10) unlock('duel_10');
    if (placed && profile.rankMu >= 28) unlock('master_tier');
    if (placed && profile.rankMu >= 34) unlock('legend_tier');

    // Craft
    if (profile.totalAces >= 1) unlock('first_ace');
    if (profile.totalAces >= 5) unlock('ace_sniper');
    if (profile.totalAces >= 25) unlock('ace_25');
    if (profile.totalPointsScored >= 100) unlock('points_100');
    if (profile.totalPointsScored >= 500) unlock('points_500');

    // Daily mission progress rides the same server-verified match record, so
    // it can never be reported independently of an actual game.
    this.advanceMissions(payload.playerId, payload, new Date());

    // Achievement XP can push the profile over a level threshold too
    const finalLevel = calculateLevelFromXp(profile.xp);
    profile.level = finalLevel.level;
    profile.xpNext = finalLevel.xpNext;

    // 5. Store match record
    const matchRecord: MatchRecord = {
      id: `match_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      player1Id: payload.playerId,
      player1Name: profile.username,
      player2Id: payload.opponentId || (payload.mode === 'solo' ? `AI-${difficulty}` : 'Player 2'),
      player2Name: payload.opponentName || (payload.mode === 'solo' ? `AI (${difficulty})` : 'Opponent'),
      winnerId: isWin ? payload.playerId : (payload.opponentId || 'opponent'),
      winnerName: isWin ? profile.username : (payload.opponentName || 'Opponent'),
      scoreP1: payload.playerScore,
      scoreP2: payload.opponentScore,
      maxRally: payload.maxRally,
      mode: payload.mode,
      difficulty: payload.mode === 'solo' ? difficulty : payload.difficulty,
      timestamp: new Date().toISOString(),
    };

    this.sql.exec('BEGIN');
    try {
      this.upsertProfile(profile);
      this.insertMatch(matchRecord);
      // Keep only the most recent 500 matches (parity with the JSON store)
      this.sql.exec(
        'DELETE FROM matches WHERE rowid NOT IN (SELECT rowid FROM matches ORDER BY rowid DESC LIMIT 500)'
      );
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }

    return {
      profile,
      earnedXp,
      leveledUp,
      winProbability: winProb,
      previousTier: isPvp && ranked ? previousTier : null,
      tier: isPvp && ranked ? profile.tier : null,
      tierChanged: isPvp && ranked && profile.tier !== previousTier,
      ranked,
      newAchievements,
      missions: this.getMissions(payload.playerId),
    };
  }

  /**
   * Transfer the profile owning `code` to `newDeviceId`. The recovery code
   * rotates on use, the old device id stops resolving to anything, and any
   * throwaway profile the claiming device already had is deleted. Returns
   * null when the code matches nothing.
   */
  public claimProfileByCode(code: string, newDeviceId: string): PlayerProfile | null {
    const canonical = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const formatted = canonical.length === 8 ? `${canonical.slice(0, 4)}-${canonical.slice(4)}` : code.trim().toUpperCase();
    const row = this.sql.prepare('SELECT * FROM players WHERE recoveryCode = ?').get(formatted) as unknown as
      | PlayerRow
      | undefined;
    if (!row) return null;
    if (row.id === newDeviceId) return this.readProfile(row.id);

    this.sql.exec('BEGIN');
    try {
      this.sql.prepare('DELETE FROM players WHERE id = ?').run(newDeviceId);
      this.sql
        .prepare('UPDATE players SET id = ?, recoveryCode = ?, lastActive = ? WHERE id = ?')
        .run(newDeviceId, this.newRecoveryCode(), new Date().toISOString(), row.id);
      this.sql.prepare('UPDATE matches SET player1Id = ? WHERE player1Id = ?').run(newDeviceId, row.id);
      this.sql.prepare('UPDATE matches SET player2Id = ? WHERE player2Id = ?').run(newDeviceId, row.id);
      this.sql.prepare('UPDATE matches SET winnerId = ? WHERE winnerId = ?').run(newDeviceId, row.id);
      // The avatar moves with the profile; whatever throwaway avatar the
      // claiming device had is replaced.
      this.sql.prepare('DELETE FROM avatars WHERE playerId = ?').run(newDeviceId);
      this.sql.prepare('UPDATE avatars SET playerId = ? WHERE playerId = ?').run(newDeviceId, row.id);
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
    return this.readProfile(newDeviceId);
  }

  public getLeaderboard(
    sortBy: 'elo' | 'level' | 'rally' | 'wins' = 'elo',
    limit = 50,
    includeBots = false
  ): LeaderboardEntry[] {
    const orderBy = {
      level: 'xp DESC',
      rally: 'highestRally DESC',
      wins: 'matchesWon DESC',
      elo: '(rankedGames >= 5 AND rankSigma <= 4.0) DESC, rankMu DESC',
    }[sortBy];

    // Only initialized profiles compete — players who never finished
    // onboarding hold placeholder names and stay invisible.
    const rows = this.sql
      .prepare(
        `SELECT p.*, a.updatedAt AS avatarUpdatedAt
           FROM players p LEFT JOIN avatars a ON a.playerId = p.id
          WHERE p.initializedAt IS NOT NULL
          ORDER BY ${orderBy}`
      )
      .all() as unknown as PlayerRow[];

    // Ranks count human players only, so a human's number is identical
    // whether bot rows are interleaved into the view or not.
    const out: LeaderboardEntry[] = [];
    let humanRank = 0;
    for (const row of rows) {
      if (out.length >= limit) break;
      const isBot = row.id.startsWith('bot-');
      if (isBot && !includeBots) continue;
      if (!isBot) humanRank++;
      const p = rowToProfile(row);
      const winRate = p.matchesPlayed > 0 ? Math.round((p.matchesWon / p.matchesPlayed) * 100) : 0;
      out.push({
        rank: isBot ? null : humanRank,
        isBot: isBot || undefined,
        id: p.id,
        username: p.username,
        tier: p.tier,
        rankedGames: p.rankedGames,
        level: p.level,
        xp: p.xp,
        matchesPlayed: p.matchesPlayed,
        matchesWon: p.matchesWon,
        winRate,
        highestRally: p.highestRally,
        avatarVersion: p.avatarVersion,
      });
    }
    return out;
  }

  public getAchievementsList(playerId?: string): Achievement[] {
    const player = playerId ? this.readProfile(playerId) : null;
    return ALL_ACHIEVEMENTS.map((ach) => {
      const isUnlocked = player?.achievements?.includes(ach.id) || false;
      return {
        ...ach,
        unlockedAt: isUnlocked ? (player?.lastActive || new Date().toISOString()) : undefined,
      };
    });
  }

  public getMatchHistory(playerId: string, limit = 15): MatchRecord[] {
    return this.sql
      .prepare(
        'SELECT * FROM matches WHERE player1Id = ? OR player2Id = ? ORDER BY rowid DESC LIMIT ?'
      )
      .all(playerId, playerId, limit) as unknown as MatchRecord[];
  }
}

export const db = new GameDatabase();
