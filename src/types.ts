export type GameMode = 'solo' | 'multiplayer' | 'split' | 'practice';

export type AIDifficulty = 'rookie' | 'pro' | 'cyber' | 'chaos';

export type CourtTheme =
  | 'neon'
  | 'retro-crt'
  | 'midnight'
  | 'cyberpunk'
  | 'tennis'
  | 'emerald-matrix'
  | 'solar-flare'
  | 'hyper-violet'
  | 'monochrome-noir'
  | 'quantum-gold';

export type SoundscapeType = 'none' | 'stadium' | 'cyberpunk' | 'zen';

export type PlayerStatus = 'online' | 'idle' | 'offline';

export type LanguageCode = 'en' | 'es' | 'ja' | 'de' | 'fr' | 'pt' | 'zh';

export interface DailyMission {
  id: string;
  type: 'games_played' | 'matches_won' | 'rally' | 'multiplayer' | 'points_scored';
  titleKey: string;
  descKey: string;
  target: number;
  current: number;
  xpReward: number;
  claimed: boolean;
}

export interface GameSettings {
  soundEnabled: boolean;
  sfxVolume: number; // 0 to 100
  bgmVolume: number; // 0 to 100
  soundscape: SoundscapeType;
  soundscapeVolume: number; // 0 to 100
  screenShakeIntensity: number; // 0 to 100
  hapticsEnabled: boolean;
  hapticIntensity: number; // 10 to 100
  tiltEnabled: boolean;
  showRadar: boolean;
  showStatsOverlay: boolean;
  showTrails: boolean;
  ballSpeedFactor: number; // 0.8 to 1.6
  paddleWidthRatio: number; // 0.15 to 0.35
  difficulty: AIDifficulty;
  winningScore: number;
  theme: CourtTheme;
  language: LanguageCode;
}

export interface BallState {
  x: number; // 0 (left) to 1 (right)
  y: number; // 0 (net) to 1 (baseline/paddle)
  vx: number; // velocity per second in normalized court units
  vy: number;
  radius: number; // normalized radius
  active: boolean; // whether ball is currently in THIS player's half
  color?: string;
  spin?: number;
  speedMultiplier?: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

export interface Ripple {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  opacity: number;
  color: string;
}

export interface PlayerStats {
  score: number;
  opponentScore: number;
  rallyCount: number;
  maxRally: number;
  aces: number;
  matchesWon: number;
}

export interface PlayerProfile {
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
  lastDailyDate?: string;
  achievements: string[]; // achievement IDs
  createdAt: string;
  lastActive: string;
  rankTitle: string;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  category: 'beginner' | 'mastery' | 'online' | 'special';
  xpReward: number;
  icon: string;
  unlockedAt?: string;
}

export interface MatchRecord {
  id: string;
  player1Id: string;
  player1Name: string;
  player2Id: string;
  player2Name: string;
  winnerId: string;
  winnerName: string;
  scoreP1: number;
  scoreP2: number;
  maxRally: number;
  mode: GameMode;
  difficulty?: AIDifficulty;
  timestamp: string;
}

export interface LeaderboardEntry {
  rank: number;
  id: string;
  username: string;
  eloRating: number;
  level: number;
  xp: number;
  matchesPlayed: number;
  matchesWon: number;
  winRate: number;
  highestRally: number;
}

export interface MatchEndPayload {
  playerId: string;
  username: string;
  opponentId?: string;
  opponentName?: string;
  playerScore: number;
  opponentScore: number;
  maxRally: number;
  mode: GameMode;
  difficulty?: AIDifficulty;
  isWinner: boolean;
}

export interface MatchEndResult {
  profile: PlayerProfile;
  earnedXp: number;
  leveledUp: boolean;
  eloDelta: number;
  newAchievements: Achievement[];
}

// WebSocket Messages
export type WSClientMessage =
  | { type: 'join_room'; roomId: string; playerId: string; playerName?: string }
  | { type: 'create_room'; playerId: string; playerName?: string }
  | { type: 'paddle_move'; x: number }
  | { type: 'ball_cross_net'; ball: { x: number; vx: number; vy: number; spin: number; speedMultiplier: number } }
  | { type: 'point_scored'; scorer: 'p1' | 'p2' }
  | { type: 'quick_chat'; text: string; senderName?: string }
  | { type: 'rematch_request' }
  | { type: 'ping'; timestamp: number }
  | { type: 'leave_room' };

export type WSServerMessage =
  | { type: 'room_created'; roomId: string; playerIndex: 0 | 1 }
  | { type: 'room_joined'; roomId: string; playerIndex: 0 | 1; opponentName: string; opponentId: string }
  | { type: 'opponent_joined'; opponentName: string; opponentId: string }
  | { type: 'opponent_paddle'; x: number }
  | { type: 'ball_incoming'; ball: { x: number; vx: number; vy: number; spin: number; speedMultiplier: number } }
  | { type: 'quick_chat'; text: string; senderName: string; senderIdx: number }
  | { type: 'game_start'; servingPlayer: 0 | 1 }
  | { type: 'score_update'; p1Score: number; p2Score: number; reason: string; nextServer: 0 | 1 }
  | { type: 'rematch_state'; votes: [boolean, boolean] }
  | { type: 'opponent_left' }
  | { type: 'pong'; timestamp: number }
  | { type: 'error'; message: string };
