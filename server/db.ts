import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import {
  PlayerProfile,
  Achievement,
  MatchRecord,
  LeaderboardEntry,
  MatchEndPayload,
  MatchEndResult,
} from '../src/types';

// Overridable so production can point at a persistent volume (e.g. /data on
// the KVM); the default cwd-relative path serves local development.
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'phong.db');
// Pre-SQLite installs stored everything in this JSON file; it is imported
// once into SQLite on first boot and then left untouched.
const LEGACY_JSON_FILE = path.join(DATA_DIR, 'game_database.json');

export const ALL_ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first_serve',
    title: 'First Impact',
    description: 'Complete your first cross-net volley.',
    category: 'beginner',
    xpReward: 50,
    icon: 'zap',
  },
  {
    id: 'rally_10',
    title: 'Rally Apprentice',
    description: 'Sustain a rally of 10 or more hits in a single point.',
    category: 'mastery',
    xpReward: 100,
    icon: 'activity',
  },
  {
    id: 'rally_25',
    title: 'Sonic Speed',
    description: 'Sustain a lightning-fast rally of 25 or more hits.',
    category: 'mastery',
    xpReward: 250,
    icon: 'flame',
  },
  {
    id: 'rally_50',
    title: 'Quantum Reflexes',
    description: 'Reach a legendary 50-hit rally without missing.',
    category: 'mastery',
    xpReward: 600,
    icon: 'shield',
  },
  {
    id: 'first_win',
    title: 'First Blood',
    description: 'Win your first full match in any mode.',
    category: 'beginner',
    xpReward: 80,
    icon: 'trophy',
  },
  {
    id: 'shutout',
    title: 'Clean Sheet',
    description: 'Win a match without conceding a single point (5-0 or better).',
    category: 'mastery',
    xpReward: 300,
    icon: 'star',
  },
  {
    id: 'cyber_slayer',
    title: 'Cyber Slayer',
    description: 'Defeat the Cyber or Chaos difficulty AI in Solo mode.',
    category: 'mastery',
    xpReward: 400,
    icon: 'cpu',
  },
  {
    id: 'multiplayer_champ',
    title: 'Twin Link Master',
    description: 'Win a 2-device online multiplayer match across the net.',
    category: 'online',
    xpReward: 350,
    icon: 'smartphone',
  },
  {
    id: 'ace_sniper',
    title: 'Ace Sniper',
    description: 'Score 5 or more career aces directly on serve.',
    category: 'special',
    xpReward: 200,
    icon: 'target',
  },
  {
    id: 'veteran_10',
    title: 'Paddle Veteran',
    description: 'Complete 10 total matches.',
    category: 'beginner',
    xpReward: 150,
    icon: 'award',
  },
  {
    id: 'level_5',
    title: 'Rising Star',
    description: 'Reach Player Level 5.',
    category: 'special',
    xpReward: 250,
    icon: 'sparkles',
  },
  {
    id: 'level_10',
    title: 'Grandmaster',
    description: 'Reach Player Level 10.',
    category: 'special',
    xpReward: 750,
    icon: 'crown',
  },
  {
    id: 'rating_1400',
    title: 'Elite Contender',
    description: 'Surpass an ELO rating of 1400.',
    category: 'special',
    xpReward: 500,
    icon: 'trending-up',
  },
];

function calculateRankTitle(level: number, elo: number): string {
  if (level >= 20 || elo >= 1800) return 'Cyber Overlord';
  if (level >= 15 || elo >= 1650) return 'Legend';
  if (level >= 10 || elo >= 1500) return 'Grandmaster';
  if (level >= 7 || elo >= 1400) return 'Master';
  if (level >= 5 || elo >= 1300) return 'Ace';
  if (level >= 3 || elo >= 1200) return 'Vanguard';
  if (level >= 2) return 'Contender';
  return 'Rookie';
}

function calculateLevelFromXp(xp: number): { level: number; xpNext: number } {
  // Level curve: Level L requires 120 * L^1.6 XP
  let level = 1;
  let xpForNext = 120;
  while (xp >= xpForNext) {
    level++;
    xpForNext = Math.round(120 * Math.pow(level, 1.6));
  }
  return { level, xpNext: xpForNext };
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
  id: string;
  username: string;
  level: number;
  xp: number;
  xpNext: number;
  eloRating: number;
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
  rankTitle: string;
  recoveryCode: string | null;
}

function rowToProfile(row: PlayerRow): PlayerProfile {
  return {
    ...row,
    achievements: JSON.parse(row.achievements || '[]'),
    recoveryCode: row.recoveryCode || undefined,
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
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        level INTEGER NOT NULL,
        xp INTEGER NOT NULL,
        xpNext INTEGER NOT NULL,
        eloRating INTEGER NOT NULL,
        matchesPlayed INTEGER NOT NULL,
        matchesWon INTEGER NOT NULL,
        matchesLost INTEGER NOT NULL,
        highestRally INTEGER NOT NULL,
        totalPointsScored INTEGER NOT NULL,
        totalAces INTEGER NOT NULL,
        dailyStreak INTEGER NOT NULL,
        lastDailyDate TEXT NOT NULL,
        achievements TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        lastActive TEXT NOT NULL,
        rankTitle TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.migrateSchema();
    this.importLegacyJsonIfPresent();
    this.seedBotsIfEmpty();
  }

  // Additive schema changes for databases created by earlier builds.
  private migrateSchema(): void {
    const cols = this.sql.prepare('PRAGMA table_info(players)').all() as unknown as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'recoveryCode')) {
      this.sql.exec('ALTER TABLE players ADD COLUMN recoveryCode TEXT');
    }
    this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_players_recovery ON players(recoveryCode)');
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
        `INSERT INTO players (id, username, level, xp, xpNext, eloRating, matchesPlayed, matchesWon,
           matchesLost, highestRally, totalPointsScored, totalAces, dailyStreak, lastDailyDate,
           achievements, createdAt, lastActive, rankTitle, recoveryCode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           username=excluded.username, level=excluded.level, xp=excluded.xp, xpNext=excluded.xpNext,
           eloRating=excluded.eloRating, matchesPlayed=excluded.matchesPlayed,
           matchesWon=excluded.matchesWon, matchesLost=excluded.matchesLost,
           highestRally=excluded.highestRally, totalPointsScored=excluded.totalPointsScored,
           totalAces=excluded.totalAces, dailyStreak=excluded.dailyStreak,
           lastDailyDate=excluded.lastDailyDate, achievements=excluded.achievements,
           createdAt=excluded.createdAt, lastActive=excluded.lastActive, rankTitle=excluded.rankTitle,
           recoveryCode=excluded.recoveryCode`
      )
      .run(
        p.id,
        p.username,
        p.level,
        p.xp,
        p.xpNext,
        p.eloRating,
        p.matchesPlayed,
        p.matchesWon,
        p.matchesLost,
        p.highestRally,
        p.totalPointsScored,
        p.totalAces,
        p.dailyStreak,
        p.lastDailyDate,
        JSON.stringify(p.achievements),
        p.createdAt,
        p.lastActive,
        p.rankTitle,
        p.recoveryCode ?? null
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

  private importLegacyJsonIfPresent(): void {
    if (this.playerCount() > 0 || !fs.existsSync(LEGACY_JSON_FILE)) return;
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_JSON_FILE, 'utf-8')) as {
        players?: Record<string, PlayerProfile>;
        matches?: MatchRecord[];
      };
      this.sql.exec('BEGIN');
      try {
        Object.values(legacy.players || {}).forEach((p) =>
          this.upsertProfile({ ...p, recoveryCode: p.recoveryCode || this.newRecoveryCode() })
        );
        // Legacy matches array is newest-first; insert reversed so rowid order
        // (our sort key) stays oldest-to-newest.
        [...(legacy.matches || [])].reverse().forEach((m) => this.insertMatch(m));
        this.sql.exec('COMMIT');
        console.log(
          `Imported legacy JSON database (${Object.keys(legacy.players || {}).length} players, ${(legacy.matches || []).length} matches) into SQLite`
        );
      } catch (e) {
        this.sql.exec('ROLLBACK');
        throw e;
      }
    } catch (e) {
      console.error('Failed to import legacy game_database.json, starting fresh:', e);
    }
  }

  private seedBotsIfEmpty() {
    if (this.playerCount() > 0) return;
    const bots: Partial<PlayerProfile>[] = [
      {
        id: 'bot-pro-01',
        username: 'NeonViper',
        level: 12,
        xp: 6200,
        eloRating: 1540,
        matchesPlayed: 48,
        matchesWon: 39,
        matchesLost: 9,
        highestRally: 34,
        totalPointsScored: 240,
        totalAces: 22,
        dailyStreak: 5,
        achievements: ['first_serve', 'rally_10', 'rally_25', 'first_win', 'level_5', 'level_10', 'rating_1400'],
      },
      {
        id: 'bot-pro-02',
        username: 'PulseEcho',
        level: 9,
        xp: 4100,
        eloRating: 1420,
        matchesPlayed: 32,
        matchesWon: 24,
        matchesLost: 8,
        highestRally: 28,
        totalPointsScored: 165,
        totalAces: 14,
        dailyStreak: 3,
        achievements: ['first_serve', 'rally_10', 'rally_25', 'first_win', 'level_5', 'rating_1400'],
      },
      {
        id: 'bot-pro-03',
        username: 'AeroZen',
        level: 6,
        xp: 2300,
        eloRating: 1310,
        matchesPlayed: 20,
        matchesWon: 13,
        matchesLost: 7,
        highestRally: 21,
        totalPointsScored: 98,
        totalAces: 8,
        dailyStreak: 2,
        achievements: ['first_serve', 'rally_10', 'first_win', 'level_5'],
      },
      {
        id: 'bot-pro-04',
        username: 'CyberStriker',
        level: 15,
        xp: 9800,
        eloRating: 1680,
        matchesPlayed: 75,
        matchesWon: 62,
        matchesLost: 13,
        highestRally: 46,
        totalPointsScored: 380,
        totalAces: 35,
        dailyStreak: 12,
        achievements: ['first_serve', 'rally_10', 'rally_25', 'first_win', 'shutout', 'cyber_slayer', 'level_5', 'level_10', 'rating_1400'],
      },
    ];

    const now = new Date().toISOString();
    const todayStr = now.slice(0, 10);
    this.sql.exec('BEGIN');
    try {
      bots.forEach((b) => {
        const { level, xpNext } = calculateLevelFromXp(b.xp || 0);
        const full: PlayerProfile = {
          id: b.id!,
          username: b.username!,
          level,
          xp: b.xp || 0,
          xpNext,
          eloRating: b.eloRating || 1200,
          matchesPlayed: b.matchesPlayed || 0,
          matchesWon: b.matchesWon || 0,
          matchesLost: b.matchesLost || 0,
          highestRally: b.highestRally || 0,
          totalPointsScored: b.totalPointsScored || 0,
          totalAces: b.totalAces || 0,
          dailyStreak: b.dailyStreak || 1,
          lastDailyDate: todayStr,
          achievements: b.achievements || [],
          createdAt: now,
          lastActive: now,
          rankTitle: calculateRankTitle(level, b.eloRating || 1200),
          recoveryCode: this.newRecoveryCode(),
        };
        this.upsertProfile(full);
      });
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  private readProfile(id: string): PlayerProfile | null {
    const row = this.sql.prepare('SELECT * FROM players WHERE id = ?').get(id) as unknown as
      | PlayerRow
      | undefined;
    return row ? rowToProfile(row) : null;
  }

  public getProfile(id: string, defaultUsername?: string): PlayerProfile {
    const existing = this.readProfile(id);
    if (!existing) {
      const now = new Date().toISOString();
      const todayStr = now.slice(0, 10);
      // Use the END of the id: device ids share a dev_ prefix, so the head
      // would name every new player identically.
      const username = defaultUsername || `Paddle-${id.slice(-4).toUpperCase()}`;
      const newPlayer: PlayerProfile = {
        id,
        username,
        level: 1,
        xp: 0,
        xpNext: 120,
        eloRating: 1200,
        matchesPlayed: 0,
        matchesWon: 0,
        matchesLost: 0,
        highestRally: 0,
        totalPointsScored: 0,
        totalAces: 0,
        dailyStreak: 1,
        lastDailyDate: todayStr,
        achievements: [],
        createdAt: now,
        lastActive: now,
        rankTitle: 'Rookie',
        recoveryCode: this.newRecoveryCode(),
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

  public updateUsername(id: string, username: string): PlayerProfile {
    const profile = this.getProfile(id);
    profile.username = username.trim().slice(0, 18) || profile.username;
    profile.lastActive = new Date().toISOString();
    this.upsertProfile(profile);
    return profile;
  }

  public recordMatch(payload: MatchEndPayload): MatchEndResult {
    const profile = this.getProfile(payload.playerId, payload.username);
    const prevLevel = profile.level;
    const isWin = payload.isWinner;

    // 1. Calculate XP Earned
    let xpBase = payload.playerScore * 15;
    xpBase += payload.maxRally * 6;
    if (isWin) xpBase += 60;
    if (payload.difficulty === 'cyber') xpBase = Math.round(xpBase * 1.35);
    if (payload.difficulty === 'chaos') xpBase = Math.round(xpBase * 1.5);
    if (payload.mode === 'multiplayer') xpBase = Math.round(xpBase * 1.4);

    const earnedXp = Math.max(20, xpBase);
    profile.xp += earnedXp;

    // Recalculate Level & Next XP threshold
    const { level, xpNext } = calculateLevelFromXp(profile.xp);
    const leveledUp = level > prevLevel;
    profile.level = level;
    profile.xpNext = xpNext;

    // 2. Calculate ELO Rating Change
    let eloDelta = 0;
    if (payload.mode === 'multiplayer') {
      eloDelta = isWin ? 24 : -16;
    } else {
      const difficultyMultiplier = { rookie: 8, pro: 16, cyber: 24, chaos: 32 }[payload.difficulty || 'pro'] || 16;
      eloDelta = isWin ? difficultyMultiplier : -Math.round(difficultyMultiplier / 2);
    }
    profile.eloRating = Math.max(800, profile.eloRating + eloDelta);
    profile.rankTitle = calculateRankTitle(profile.level, profile.eloRating);

    // 3. Update Match Statistics
    profile.matchesPlayed += 1;
    if (isWin) {
      profile.matchesWon += 1;
    } else {
      profile.matchesLost += 1;
    }
    profile.totalPointsScored += payload.playerScore;
    if (payload.maxRally > profile.highestRally) {
      profile.highestRally = payload.maxRally;
    }
    profile.lastActive = new Date().toISOString();

    // 4. Check & Unlock Achievements
    const newAchievements: Achievement[] = [];
    const unlock = (achId: string) => {
      if (!profile.achievements.includes(achId)) {
        profile.achievements.push(achId);
        const meta = ALL_ACHIEVEMENTS.find((a) => a.id === achId);
        if (meta) {
          newAchievements.push({ ...meta, unlockedAt: new Date().toISOString() });
          profile.xp += meta.xpReward;
        }
      }
    };

    // Achievement triggers
    if (payload.maxRally >= 1) unlock('first_serve');
    if (payload.maxRally >= 10) unlock('rally_10');
    if (payload.maxRally >= 25) unlock('rally_25');
    if (payload.maxRally >= 50) unlock('rally_50');
    if (isWin) unlock('first_win');
    if (isWin && payload.opponentScore === 0 && payload.playerScore >= 5) unlock('shutout');
    if (isWin && (payload.difficulty === 'cyber' || payload.difficulty === 'chaos')) unlock('cyber_slayer');
    if (isWin && payload.mode === 'multiplayer') unlock('multiplayer_champ');
    if (profile.matchesPlayed >= 10) unlock('veteran_10');
    if (profile.level >= 5) unlock('level_5');
    if (profile.level >= 10) unlock('level_10');
    if (profile.eloRating >= 1400) unlock('rating_1400');

    // Achievement XP can push the profile over a level threshold too
    const finalLevel = calculateLevelFromXp(profile.xp);
    profile.level = finalLevel.level;
    profile.xpNext = finalLevel.xpNext;
    profile.rankTitle = calculateRankTitle(profile.level, profile.eloRating);

    // 5. Store match record
    const matchRecord: MatchRecord = {
      id: `match_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      player1Id: payload.playerId,
      player1Name: payload.username,
      player2Id: payload.opponentId || (payload.mode === 'solo' ? `AI-${payload.difficulty || 'Pro'}` : 'Player 2'),
      player2Name: payload.opponentName || (payload.mode === 'solo' ? `AI (${payload.difficulty || 'Pro'})` : 'Opponent'),
      winnerId: isWin ? payload.playerId : (payload.opponentId || 'opponent'),
      winnerName: isWin ? payload.username : (payload.opponentName || 'Opponent'),
      scoreP1: payload.playerScore,
      scoreP2: payload.opponentScore,
      maxRally: payload.maxRally,
      mode: payload.mode,
      difficulty: payload.difficulty,
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
      eloDelta,
      newAchievements,
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
    if (row.id === newDeviceId) return rowToProfile(row);

    this.sql.exec('BEGIN');
    try {
      this.sql.prepare('DELETE FROM players WHERE id = ?').run(newDeviceId);
      this.sql
        .prepare('UPDATE players SET id = ?, recoveryCode = ?, lastActive = ? WHERE id = ?')
        .run(newDeviceId, this.newRecoveryCode(), new Date().toISOString(), row.id);
      this.sql.prepare('UPDATE matches SET player1Id = ? WHERE player1Id = ?').run(newDeviceId, row.id);
      this.sql.prepare('UPDATE matches SET player2Id = ? WHERE player2Id = ?').run(newDeviceId, row.id);
      this.sql.prepare('UPDATE matches SET winnerId = ? WHERE winnerId = ?').run(newDeviceId, row.id);
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
      elo: 'eloRating DESC',
    }[sortBy];

    const rows = this.sql
      .prepare(`SELECT * FROM players ORDER BY ${orderBy}`)
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
        eloRating: p.eloRating,
        level: p.level,
        xp: p.xp,
        matchesPlayed: p.matchesPlayed,
        matchesWon: p.matchesWon,
        winRate,
        highestRally: p.highestRally,
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
