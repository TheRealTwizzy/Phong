import fs from 'fs';
import path from 'path';
import {
  PlayerProfile,
  Achievement,
  MatchRecord,
  LeaderboardEntry,
  MatchEndPayload,
  MatchEndResult,
} from '../src/types';

// Overridable so production can point at a persistent volume (e.g. /data on
// Render); the default cwd-relative path serves local development.
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'game_database.json');

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

interface DatabaseSchema {
  players: Record<string, PlayerProfile>;
  matches: MatchRecord[];
  achievementLog: Record<string, Record<string, string>>; // playerId -> { achievementId: timestamp }
}

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

class GameDatabase {
  private data: DatabaseSchema = {
    players: {},
    matches: [],
    achievementLog: {},
  };

  constructor() {
    this.ensureDataDir();
    this.load();
    this.seedBotsIfEmpty();
  }

  private ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        this.data = JSON.parse(raw);
      }
    } catch (e) {
      console.error('Error loading database, initializing fresh state:', e);
    }
  }

  private save() {
    try {
      this.ensureDataDir();
      const tmpFile = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmpFile, DB_FILE);
    } catch (e) {
      console.error('Failed to save game database:', e);
    }
  }

  private seedBotsIfEmpty() {
    if (Object.keys(this.data.players).length === 0) {
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
        };
        this.data.players[full.id] = full;
      });
      this.save();
    }
  }

  public getProfile(id: string, defaultUsername?: string): PlayerProfile {
    if (!this.data.players[id]) {
      const now = new Date().toISOString();
      const todayStr = now.slice(0, 10);
      const username = defaultUsername || `Paddle-${id.slice(0, 4).toUpperCase()}`;
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
      };
      this.data.players[id] = newPlayer;
      this.save();
    } else {
      const p = this.data.players[id];
      const prevStreak = p.dailyStreak;
      const prevDate = p.lastDailyDate;
      updatePlayerStreak(p);
      if (p.dailyStreak !== prevStreak || p.lastDailyDate !== prevDate) {
        this.save();
      }
    }
    return this.data.players[id];
  }

  public updateUsername(id: string, username: string): PlayerProfile {
    const profile = this.getProfile(id);
    profile.username = username.trim().slice(0, 18) || profile.username;
    profile.lastActive = new Date().toISOString();
    this.save();
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

    this.data.matches.unshift(matchRecord);
    if (this.data.matches.length > 500) {
      this.data.matches = this.data.matches.slice(0, 500);
    }

    this.save();

    return {
      profile,
      earnedXp,
      leveledUp,
      eloDelta,
      newAchievements,
    };
  }

  public getLeaderboard(sortBy: 'elo' | 'level' | 'rally' | 'wins' = 'elo', limit = 50): LeaderboardEntry[] {
    const list = Object.values(this.data.players);

    list.sort((a, b) => {
      if (sortBy === 'level') {
        return b.xp - a.xp;
      }
      if (sortBy === 'rally') {
        return b.highestRally - a.highestRally;
      }
      if (sortBy === 'wins') {
        return b.matchesWon - a.matchesWon;
      }
      return b.eloRating - a.eloRating;
    });

    return list.slice(0, limit).map((p, idx) => {
      const winRate = p.matchesPlayed > 0 ? Math.round((p.matchesWon / p.matchesPlayed) * 100) : 0;
      return {
        rank: idx + 1,
        id: p.id,
        username: p.username,
        eloRating: p.eloRating,
        level: p.level,
        xp: p.xp,
        matchesPlayed: p.matchesPlayed,
        matchesWon: p.matchesWon,
        winRate,
        highestRally: p.highestRally,
      };
    });
  }

  public getAchievementsList(playerId?: string): Achievement[] {
    const player = playerId ? this.data.players[playerId] : null;
    return ALL_ACHIEVEMENTS.map((ach) => {
      const isUnlocked = player?.achievements?.includes(ach.id) || false;
      return {
        ...ach,
        unlockedAt: isUnlocked ? (player?.lastActive || new Date().toISOString()) : undefined,
      };
    });
  }

  public getMatchHistory(playerId: string, limit = 15): MatchRecord[] {
    return this.data.matches
      .filter((m) => m.player1Id === playerId || m.player2Id === playerId)
      .slice(0, limit);
  }
}

export const db = new GameDatabase();
