import type { Tier } from './rating';

export type GameMode = 'solo' | 'multiplayer' | 'split' | 'practice';

// Three rungs: Rookie is the floor, Pro is the average-player baseline, Cyber
// is the ceiling. 'chaos' was retired — it sat between Pro and Cyber in rating
// but was defined by volatility rather than strength, which made the ladder
// read as four rungs with only three distinct difficulties.
export type AIDifficulty = 'rookie' | 'pro' | 'cyber';

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
  | 'quantum-gold'
  // Earned from the hidden rungs of the achievement tree.
  | 'perpetual-blue'
  | 'flawless-white'
  | 'legend-aurora'
  | 'fixture-bronze'
  // Banked permanently by completing an elite daily mission.
  | 'void-runner'
  | 'crimson-tide'
  | 'arctic-glass'
  | 'molten-core'
  | 'signal-lost'
  | 'gilded-age';

export type SoundscapeType = 'none' | 'stadium' | 'cyberpunk' | 'zen';

export type PlayerStatus = 'online' | 'idle' | 'offline';

export type LanguageCode = 'en' | 'es' | 'ja' | 'de' | 'fr' | 'pt' | 'zh';

export type MissionType =
  | 'games_played'
  | 'matches_won'
  | 'rally'
  | 'multiplayer'
  | 'points_scored'
  | 'aces'
  | 'shutouts';

export interface DailyMission {
  id: string;
  type: MissionType;
  tier: 'regular' | 'elite';
  /** Permanent unlock granted the first time this is ever completed. */
  unlocks?: string;
  /** True once the permanent unlock has already been banked on some day. */
  unlockOwned?: boolean;
  titleKey: string;
  descKey: string;
  target: number;
  current: number;
  xpReward: number;
  claimed: boolean;
}

/**
 * Rules locked in before a match starts. The six numeric fields are
 * multipliers on the engine constants — 1 means stock — and any non-stock
 * value makes the match unranked (see src/matchRules.ts). The four flags are
 * presentation and convenience only and never affect ranking.
 */
export interface MatchRules {
  paddleScale: number;
  ballScale: number;
  ballSpeedMin: number;
  ballSpeedMax: number;
  serveAngleMax: number;
  servePowerMax: number;
  opponentSonar: boolean;
  trackTelemetry: boolean;
  quickChat: boolean;
  /** 0 = off; otherwise seconds before a held serve fires by itself. */
  autoServeSeconds: number;
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
  // Telemetry visibility is deliberately NOT a stored setting: the panel is
  // per-match, starting hidden and toggled from the court (see App.tsx).
  showTrails: boolean;
  // Paddle width and ball speed are deliberately NOT settings — they are
  // fixed constants in game/physics.ts and must never be player-editable.
  difficulty: AIDifficulty;
  winningScore: number;
  // Pre-match only, like difficulty and winningScore: chosen on the menu and
  // never editable once a match is running.
  rules: MatchRules;
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
  /**
   * A rally streak belongs to ONE player: it counts their own consecutive
   * successful returns and it breaks only when THEY fail to return one. The
   * opponent missing — a point YOU just won — leaves it alone, so a streak
   * runs across points and ends only on your own miss. The serve is not a hit:
   * the receiver's return of it is the receiver's first, and the server's
   * streak resumes on their first return of that.
   *
   * What this replaced was a single shared counter that both players
   * incremented and that reset whenever either of them scored, so your "rally"
   * number was mostly a statement about your opponent.
   */
  streak: number;
  bestStreak: number;
  /** The same two, for the opponent. Tracked separately, never mixed in. */
  oppStreak: number;
  oppBestStreak: number;
  aces: number;
  matchesWon: number;
}

/**
 * One mode's own stats. The career totals on PlayerProfile pool solo and duel
 * into one number; these keep them apart. Practice has no opponent, so its
 * wins, losses and aces stay zero and only sessions and the streak move.
 * Split Screen is absent: two people share one phone and only one of them has
 * an account, so there is nobody to write the other side's numbers to.
 */
export interface ModeStats {
  matchesPlayed: number;
  matchesWon: number;
  matchesLost: number;
  pointsScored: number;
  aces: number;
  bestStreak: number;
  /**
   * The run still going in this mode. A streak carries across matches, so a
   * new match in this mode starts from here rather than from zero.
   */
  currentStreak: number;
  bestWinStreak: number;
}

export interface PlayerProfile {
  id: string;
  username: string;
  level: number;
  xp: number;
  xpNext: number;
  // Hidden matchmaking rating (TrueSkill-style). Moved by EVERY match,
  // solo included; drives win prediction and the XP surprise multiplier.
  // Only ever serialized to the profile's own device.
  mmrMu: number;
  mmrSigma: number;
  // Ranked rating — moved by PvP ONLY; drives the visible tier badge.
  rankMu: number;
  rankSigma: number;
  rankedGames: number;
  matchesPlayed: number;
  matchesWon: number;
  matchesLost: number;
  highestRally: number;
  totalPointsScored: number;
  totalAces: number;
  /** PvP wins only — solo wins never count toward the duel branch. */
  multiplayerWins: number;
  // Every one of these is computed by the server inside recordMatch from the
  // match it just wrote. None is ever accepted as a total from a client.
  /** Consecutive wins right now, reset by any loss. */
  winStreak: number;
  bestWinStreak: number;
  /** Matches won without conceding a point. */
  shutoutsWon: number;
  /** Solo wins per difficulty — what the ladder branch is measured on. */
  rookieWins: number;
  proWins: number;
  cyberWins: number;
  /**
   * Career count of duels walked out on mid-match (disconnect or quit with a
   * live ball). Recorded by the relay, never reported by a client. The first
   * of a UTC day is forgiven; ranked repeats cost visible rating.
   */
  abandons: number;
  /**
   * Permanent unlocks banked by completing elite daily missions. Kept for
   * good: the mission's XP is a daily reward, this is not.
   */
  eliteUnlocks?: string[];
  /**
   * Stats kept per mode, keyed by GameMode. Only ever sent to the profile's
   * OWN device — PublicProfile is a separate, sanitized shape.
   */
  modeStats?: Record<string, ModeStats>;
  dailyStreak: number;
  lastDailyDate?: string;
  achievements: string[]; // achievement IDs
  createdAt: string;
  lastActive: string;
  // Visible skill tier, derived from rankMu once placed (see src/rating.ts).
  tier: Tier;
  // One-time code that reclaims this profile on a new device (rotates on use).
  // Only ever serialized to the profile's own device.
  recoveryCode?: string;
  // Identity lifecycle: profiles are minted lazily from the device cookie and
  // stay "uninitialized" (placeholder Paddle-XXXX name, hidden from the
  // leaderboard, can't record matches) until the player locks in a unique
  // username via onboarding. usernameChangedAt is the basis of the 365-day
  // rename lock (see src/profileRules.ts).
  initialized: boolean;
  initializedAt?: string;
  usernameChangedAt?: string;
  // Avatar presence + cache-buster (epoch ms of the last upload). The image
  // itself is served from GET /api/avatar/:playerId?v=<avatarVersion>.
  hasAvatar: boolean;
  avatarVersion?: number;
}

// The subset of a profile that anyone may view via GET /api/profile/:id —
// never includes recoveryCode, lastDailyDate, or lastActive.
export interface PublicProfile {
  id: string;
  username: string;
  level: number;
  xp: number;
  xpNext: number;
  matchesPlayed: number;
  matchesWon: number;
  matchesLost: number;
  highestRally: number;
  totalPointsScored: number;
  totalAces: number;
  /** PvP wins only — solo wins never count toward the duel branch. */
  multiplayerWins: number;
  /**
   * Permanent unlocks banked by completing elite daily missions. Kept for
   * good: the mission's XP is a daily reward, this is not.
   */
  eliteUnlocks?: string[];
  dailyStreak: number;
  // Tier only — a public profile never exposes raw mu/sigma numbers.
  tier: Tier;
  rankedGames: number;
  createdAt: string;
  achievements: string[];
  hasAvatar: boolean;
  avatarVersion?: number;
  isBot?: boolean;
}

// Typed error envelope for profile/avatar API failures:
// { error: ProfileApiErrorCode, message?, unlockAt? }
export type ProfileApiErrorCode =
  | 'USERNAME_INVALID'
  | 'USERNAME_TAKEN'
  | 'USERNAME_LOCKED'
  | 'ALREADY_INITIALIZED'
  | 'PROFILE_NOT_INITIALIZED'
  | 'AVATAR_INVALID'
  | 'AVATAR_TOO_LARGE'
  | 'NOT_FOUND'
  | 'BAD_REQUEST';

export interface UsernameCheckResponse {
  valid: boolean;
  available: boolean;
  reason?: string;
}

/**
 * Something an achievement opens up. The tree gates access to the game, so a
 * difficulty or a match length is earned rather than simply offered.
 */
export interface GameUnlock {
  kind: 'difficulty' | 'winningScore' | 'mode';
  value: string | number;
}

export type AchievementBranch =
  | 'foundation'
  | 'rally'
  | 'ladder'
  | 'duel'
  | 'craft'
  // Concealed branches — a whole tree the player discovers rather than reads
  // on day one. What opens each is in src/achievements.ts.
  | 'ascent'
  | 'dominion'
  | 'devotion';

/**
 * A rung that needs more than its parent: a minimum profile level, a minimum
 * visible tier, or both. Deep rungs are held behind real progression so the
 * far end of a branch cannot be reached in a first session.
 */
export interface AchievementGate {
  level?: number;
  tier?: Tier;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  /** Which tree this belongs to. */
  branch: AchievementBranch;
  /** The achievement that must be earned first; absent on a branch root. */
  parent?: string;
  category: 'beginner' | 'mastery' | 'online' | 'special';
  // Base reward. Achievements flagged `scaled` pay this multiplied by the
  // match's surprise multiplier, so a moving-target difficulty (the AI adapts
  // to the player) cannot be worth a fixed amount — see server/db.ts.
  xpReward: number;
  scaled?: boolean;
  /**
   * Concealed until its parent is earned: the catalogue shows a silhouette
   * rather than the name, so the deep rungs of a branch are something to
   * discover instead of a list of chores read on day one.
   */
  hidden?: boolean;
  /** Extra requirements beyond the parent — see AchievementGate. */
  gate?: AchievementGate;
  icon: string;
  unlockedAt?: string;
  // XP actually granted when this achievement was unlocked. Only set on the
  // achievements returned from a match; absent on the static catalogue.
  awardedXp?: number;
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
  // Rank among HUMAN players only — bots never shift a human's number.
  // Bot rows (isBot) carry rank: null.
  rank: number | null;
  isBot?: boolean;
  id: string;
  username: string;
  tier: Tier;
  rankedGames: number;
  level: number;
  xp: number;
  matchesPlayed: number;
  matchesWon: number;
  winRate: number;
  highestRally: number;
  avatarVersion?: number;
}

export interface MatchEndPayload {
  playerId: string;
  username: string;
  opponentId?: string;
  opponentName?: string;
  playerScore: number;
  opponentScore: number;
  /** THIS player's longest rally streak in this match — see PlayerStats. */
  bestStreak: number;
  /**
   * The streak this player finished the match ON. Zero if the last thing they
   * did was miss. A streak carries into the next match, so this is what the
   * next one starts from — and it is a different number from the peak above,
   * which is what the match is rated and paid on.
   */
  endStreak: number;
  mode: GameMode;
  difficulty?: AIDifficulty;
  isWinner: boolean;
  /** Points won directly off this player's own serve, this match. */
  aces?: number;
  // Rules the match was played under. Non-stock physics means XP but no
  // rating movement — the server re-derives this, never trusting a flag.
  rules?: Partial<MatchRules>;
  // PvP only: lets the server cross-check the reported result against the
  // room state it owns, so scores/rallies can't be forged.
  roomId?: string;
  /**
   * Which match inside that room this result belongs to. The room is reused
   * across rematches, so a roomId alone does not identify a match: without
   * this, a replayed or slow POST was cross-checked against whatever the room
   * held by then — a rematch already reset to 0-0 — and recorded as a 0-0
   * loss. See duelMatchKey() in src/matchRules.ts.
   */
  matchSeq?: number;
  /**
   * Idempotency key for this match, so recording it twice pays once. Derived
   * server-side for a duel (roomId + matchSeq) since both the relay and the
   * client must land on the same string; minted by the client for a solo
   * match, where only that device can report it.
   */
  matchKey?: string;
}

export interface MatchEndResult {
  profile: PlayerProfile;
  earnedXp: number;
  leveledUp: boolean;
  // Pre-match predicted win chance the XP multiplier was derived from.
  winProbability: number;
  // Tier movement (ranked/PvP matches only; both null for solo).
  previousTier: Tier | null;
  tier: Tier | null;
  tierChanged: boolean;
  /** False when the match ran on non-stock physics: XP paid, rating untouched. */
  ranked: boolean;
  newAchievements: Achievement[];
  // Today's missions after this match advanced them — server-owned, so the
  // client never computes mission progress itself.
  missions: DailyMission[];
  /**
   * True when this match had already been recorded under the same matchKey —
   * a retry, a replayed queue entry, or the client's POST arriving after the
   * relay recorded the duel for both players. The stored result is returned
   * verbatim rather than paid a second time.
   */
  alreadyRecorded?: boolean;
}

// WebRTC signaling payload relayed verbatim between the two peers in a room.
// kind 'offer'/'answer' carry SDP; 'ice' carries an ICE candidate.
export interface RTCSignalPayload {
  kind: 'offer' | 'answer' | 'ice';
  sdp?: string;
  candidate?: RTCIceCandidateInit | null;
}

/**
 * The terms of a duel. Owned by the ROOM, not by either phone: the host picks
 * them in the lobby, the server normalizes and broadcasts them, and both sides
 * play the same match. Before this existed each phone applied its own winning
 * score and its own physics rules, so a room could be two different matches.
 */
export interface RoomMatchConfig {
  winningScore: number;
  rules: MatchRules;
}

// WebSocket Messages
// Display names are NOT part of the protocol: the server resolves each
// player's name from the device-cookie profile, so clients can't spoof one.
export type WSClientMessage =
  | { type: 'join_room'; roomId: string; playerId: string }
  | { type: 'create_room'; playerId: string; config?: RoomMatchConfig }
  | { type: 'set_room_config'; config: RoomMatchConfig }
  | { type: 'player_ready'; ready: boolean }
  | { type: 'start_match' }
  | { type: 'paddle_move'; x: number }
  | { type: 'ball_pos'; x: number; y: number }
  | { type: 'ball_cross_net'; ball: { x: number; vx: number; vy: number; spin: number; speedMultiplier: number } }
  | { type: 'point_scored'; scorer: 'p1' | 'p2' }
  // A P2P duel scores over the DataChannel, so the relay never sees a point.
  // This tells it where the match got to — absolute values, not a delta, so a
  // dropped one heals itself and a duplicate is a no-op. Without it the relay
  // believed every P2P match was still 0-0 and had never started.
  // `bestStreaks` is per SEAT, [p1, p2]. One number for the whole match was
  // fine when the counter was shared and is not now: the relay writes each
  // seat its own result, and rating it on the other player's streak would be
  // rating it on the wrong thing. NOTE this member stays on ONE line —
  // tests/protocolParity.test.ts reads this union to the first line-ending
  // semicolon, and a multi-line member truncates the whole parse.
  | { type: 'match_sync'; matchSeq: number; p1Score: number; p2Score: number; bestStreaks: [number, number] }
  | { type: 'quick_chat'; text: string; senderName?: string }
  | { type: 'rematch_request' }
  | { type: 'rtc_signal'; payload: RTCSignalPayload }
  | { type: 'ping'; timestamp: number }
  | { type: 'leave_room' };

export type WSServerMessage =
  | { type: 'room_created'; roomId: string; playerIndex: 0 | 1 }
  | { type: 'room_joined'; roomId: string; playerIndex: 0 | 1; opponentName: string; opponentId: string }
  | { type: 'opponent_joined'; opponentName: string; opponentId: string }
  | { type: 'opponent_paddle'; x: number }
  | { type: 'opponent_ball'; x: number; y: number }
  | { type: 'ball_incoming'; ball: { x: number; vx: number; vy: number; spin: number; speedMultiplier: number } }
  | { type: 'quick_chat'; text: string; senderName: string; senderIdx: number }
  | { type: 'room_config'; config: RoomMatchConfig }
  | { type: 'ready_state'; ready: [boolean, boolean] }
  | { type: 'game_start'; servingPlayer: 0 | 1; config: RoomMatchConfig; matchSeq: number }
  | { type: 'match_prediction'; winProbability: number }
  | { type: 'score_update'; p1Score: number; p2Score: number; reason: string; nextServer: 0 | 1 }
  | { type: 'rematch_state'; votes: [boolean, boolean] }
  | { type: 'rtc_signal'; payload: RTCSignalPayload; fromIdx: 0 | 1 }
  // The relay recorded a finished duel for this player. It records for BOTH
  // seats from the score it owns, so a result lands on both profiles even if
  // one phone never manages to POST it.
  | { type: 'match_recorded'; matchKey: string; result: MatchEndResult }
  | { type: 'opponent_left' }
  // The relay refused this socket because the account is not held by this
  // session any more (transferred to another device, displaced by a newer
  // load, or minted under a previous deployment). Sent immediately before the
  // close, so the client can act on the reason rather than on a bare 1006.
  | { type: 'session_invalid'; status: SessionStatus; build: string }
  | { type: 'pong'; timestamp: number }
  | { type: 'error'; message: string };

/**
 * Which device is holding an account right now. One account has exactly one
 * live session; every other device that presents its cookie is told which of
 * these it is instead of being quietly allowed to keep playing.
 *
 *  - `active`      this session owns the account
 *  - `none`        no session yet on this device; mint one
 *  - `released`    this device transferred its account away and holds nothing
 *  - `superseded`  a newer load elsewhere took the account over
 *  - `stale_build` minted by an earlier deployment; refresh onto the new one
 */
export type SessionStatus = 'active' | 'none' | 'released' | 'superseded' | 'stale_build';

/** What GET /api/session answers. The client polls it while it plays. */
export interface SessionState {
  status: SessionStatus;
  build: string;
  deviceId?: string;
  /**
   * The session currently holding the account. Cookies are origin-scoped, so
   * two tabs on one device share one and the server sees a single caller;
   * comparing this against the id a page was handed is how that page tells it
   * has been displaced by a later load beside it.
   */
  sessionId?: string | null;
  released?: boolean;
}
