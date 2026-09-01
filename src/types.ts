import type { Tier } from './rating';
// Type-only, so the cycle with venues.ts (which imports shapes from here) is
// erased at compile time and never exists at runtime.
import type { EntryVerdict } from './venues';

export type GameMode = 'solo' | 'multiplayer' | 'split' | 'practice';

// Five rungs, each simulating a band of the PvP ladder: Rookie plays like an
// Unranked/Contender human, Pro like Vanguard/Ace, Elite like Master/
// Grandmaster, Cyber like Grandmaster/Legend, and Chaos like a Legend+ player.
// 'chaos' is a REVIVED name: it once sat between Pro and Cyber (defined by
// volatility rather than strength) and was retired; legacy history rows were
// relabelled to 'cyber' by the chaos_relabel_v1 migration before the name was
// given its new meaning at the top of the ladder.
export type AIDifficulty = 'rookie' | 'pro' | 'elite' | 'cyber' | 'chaos';

export type CosmeticId =
  | 'neon'
  | 'retro-crt'
  | 'midnight'
  | 'cyberpunk'
  | 'arena-pro'
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
  // The two net indicators, both on by default. They are DEVICE preferences,
  // like showRadar — but unlike it they survive inside a ranked match, which
  // is the trade the opponent sonar now carries (see src/matchRules.ts): the
  // sonar draws the far half and costs the rating; these two name where the
  // opponent's paddle is and whether the ball is over there, and cost nothing.
  // A match played WITH the sonar suppresses both, so the two never stack.
  showOpponentIndicator: boolean;
  showBallIndicator: boolean;
  // Telemetry visibility is deliberately NOT a stored setting: the panel is
  // per-match, starting hidden and toggled from the court (see App.tsx).
  showTrails: boolean;
  // Paddle width and ball speed are not DEVICE settings: they are terms of
  // the MATCH, chosen pre-match in `rules` below and shared with the opponent
  // through `RoomMatchConfig`. This comment used to say they "must never be
  // player-editable", which `PHYSICS_RULES` contradicted thirty lines away —
  // what is actually true is that they are never a per-phone preference,
  // because the two halves of one rally have to obey one set of numbers.
  difficulty: AIDifficulty;
  winningScore: number;
  // Pre-match only, like difficulty and winningScore: chosen on the menu and
  // never editable once a match is running.
  rules: MatchRules;
  /**
   * The equipped cosmetic, cached on the device so the first paint does not
   * wait for the profile. The PROFILE is the source of truth — it is what other
   * players see — and this is overwritten by it whenever the two disagree.
   */
  cosmetic: CosmeticId;
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
  /**
   * The same run, counted from ZERO at the start of this match.
   *
   * `bestStreak` opens on whatever was carried in, which is the right number
   * for a career best and the wrong one for a reward: XP is paid per rally, so
   * a carried run would be paid for again in every match it spans, and a
   * player could open Practice and leave without touching the ball to collect
   * it. This is the work actually done here, and it is what gets paid.
   */
  earnedStreak: number;
  earnedBest: number;
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
  /** Matches won with the opponent on zero, at SHUTOUT_MIN_POINTS or longer. */
  shutoutsWon: number;
  /** Solo wins per difficulty — what the ladder branch is measured on. */
  rookieWins: number;
  proWins: number;
  eliteWins: number;
  cyberWins: number;
  chaosWins: number;
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
   * The cosmetic this player has equipped. Lives on the profile rather than the
   * device because it is not a preference about this phone: it is what everyone
   * else sees when they open this player's profile.
   */
  cosmetic?: CosmeticId;
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
  /**
   * Position on the ranked ladder, 1..LADDER_TOP_N, for the top rung ONLY.
   * Absent for everyone else — including an Overlord who has slipped outside
   * the top 100, who reads as "Cyber Overlord" again.
   *
   * A position is not a rating: it is the one rank number that is already
   * public, since the leaderboard shows it to everybody. It is derived
   * server-side against the same filters and the same order the board uses, so
   * the badge and the Ranks page cannot disagree.
   */
  ladderPosition?: number;

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
  /** Equipped cosmetic — a viewer renders this profile in the OWNER's look. */
  cosmetic?: CosmeticId;
  dailyStreak: number;
  // Tier only — a public profile never exposes raw mu/sigma numbers.
  tier: Tier;
  /**
   * Position on the ranked ladder, 1..LADDER_TOP_N, for the top rung ONLY.
   * Absent for everyone else — including an Overlord who has slipped outside
   * the top 100, who reads as "Cyber Overlord" again.
   *
   * A position is not a rating: it is the one rank number that is already
   * public, since the leaderboard shows it to everybody. It is derived
   * server-side against the same filters and the same order the board uses, so
   * the badge and the Ranks page cannot disagree.
   */
  ladderPosition?: number;

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
  // The confirmation typed at DELETE /api/profile/me was not this account's
  // username. Compared exactly — case included — so this is also what a
  // near-miss gets.
  | 'USERNAME_MISMATCH'
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
  /**
   * 1 = this match counted for the visible ladder (ranksThisMatch at record
   * time), 0 = it did not. null/undefined marks a row from before the column
   * existed — ranked-ness cannot be reconstructed for those, so they filter
   * and render as un-ranked.
   */
  ranked?: number | null;
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
   * How much of that was built HERE, counted from zero. A carried run is real
   * and belongs in the career best; it is not work done in this match, and
   * paying for it again every match it spans is a farm.
   */
  earnedStreak: number;
  /**
   * When this match ENDED, by the reporting device's clock.
   *
   * Everything else here is either additive (and so paid once, by matchKey) or
   * a maximum. `endStreak` is neither: it is assigned, so the last write wins
   * — and the last write is not the last match. A result can sit in the
   * on-device queue through a whole replay and land afterwards, restoring a
   * run the replay had already broken. This is what orders them.
   *
   * Never compared against the SERVER's clock: paired with `clientNow`, read
   * at send time, it gives an elapsed age instead — and an age from two
   * readings of one clock is free of whatever offset that clock carries. A
   * phone set a week slow would otherwise have every result it ever sent look
   * older than what is already stored, and be ignored forever.
   */
  endedAt?: number;
  /**
   * That same clock, read as this attempt goes out — see `endedAt`. Set by
   * the transport rather than the caller, so a retry or a queued replay says
   * how stale it actually is rather than repeating the first attempt's answer.
   */
  clientNow?: number;
  /**
   * This browser's position in ITS OWN run-write chain, assigned once per
   * event at the same moment as `endedAt` (see `src/net/runChain.ts`) and
   * PERSISTED, so a payload parked and replayed after a reload keeps the
   * number it was actually decided at.
   *
   * The age alone cannot order two writes from one browser: it never counts
   * a request's own time on the wire, so whichever of two writes happens to
   * have the faster round trip can reach the server "later" in stamped time
   * even though it was decided first. Comparing this instead — paired with
   * `chainId`, so it is only ever compared against another write from the
   * SAME browser — sidesteps network timing entirely: whichever carries the
   * higher number was decided later, however long either one took to arrive.
   *
   * Absent for a caller with no chain (an older bundle, or the relay's own
   * writes), which falls back to the age alone.
   */
  runSeq?: number;
  /**
   * Which browser's chain that seq belongs to. Purely a self-reported ordering
   * hint, like `runSeq` itself — not a credential, and not verified against
   * anything. A modified client could already misreport any field a match
   * payload carries (see the trust model in CLAUDE.md §5); this adds no reach
   * beyond that.
   */
  chainId?: string | null;
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

/** Where the ladder went: up, down, or nowhere. */
export type RankDirection = 'up' | 'down' | 'none';

/**
 * How FAR the ladder moved, bucketed server-side into the number of arrows the
 * winner overlay draws.
 *
 * Four values so it is total, with 'none' exactly when `rankDirection` is
 * 'none' — the two are derived from one delta sharing one epsilon, so they can
 * never disagree about whether anything happened. An arrow with no direction,
 * or a direction with no arrows, is the failure this shape rules out.
 */
export type RankMagnitude = 'none' | 'minor' | 'moderate' | 'large';

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
  /**
   * Whether the RULES were ranked-legal — false on non-stock physics or with
   * the sonar on, and then neither estimator moved.
   *
   * True is not the same as "the ladder moved", and the gap widened when
   * Casual stopped rating: a duel there is ranked-legal, so this is true and
   * hidden MMR does move, while the visible tier stands still. `rankDirection`
   * is the field that answers what the player is actually shown. Nothing in
   * `src/` reads this today; the persisted `matches.ranked` column is
   * `ranksThisMatch`, which is the stricter one.
   */
  ranked: boolean;
  /**
   * Which way the visible ranked rating moved, for the winner overlay's glyph.
   *
   * 'none' covers both "this match did not rate" (unranked rules, the sonar,
   * a solo match at an unearned difficulty) and "it rated and landed where it
   * started". Derived server-side from rankMu either side of the update — the
   * mu itself is never sent anywhere it could be rendered.
   */
  rankDirection: RankDirection;
  /**
   * How big that move was, drawn as 1, 2 or 3 arrows.
   *
   * A BUCKET, and never the mu behind it. RankBadge.tsx states the hard rule —
   * rankMu enters tierProgress() and reaches a CSS transform, never text and
   * never an aria-label — and a raw delta would walk past every guard that
   * enforces it: e2e-rating regexes the rendered body and checks the public
   * profile's field list, and a number on this object is in neither. A
   * difference of two ratings is itself a rating; watched over a few matches it
   * reconstructs the trajectory the tier exists to abstract.
   *
   * Bucketed HERE rather than on the client for two more reasons.
   * stampRecordedMatch persists this object whole, so a delta would sit in
   * recorded_matches for its fortnight; and two bundles bucketing for
   * themselves would draw a different number of arrows for the same match. The
   * count is a property of the result, not of whatever is looking at it.
   */
  rankMagnitude: RankMagnitude;
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
  /**
   * Whether this table opens its two watching seats.
   *
   * A term of the match beside the winning score, and deliberately NOT a
   * MatchRule: MatchRules feed isRankedRules and unrankedReasons, so a
   * seat-availability flag put there would show up in the "what unranks this
   * match" list as though it were physics. It is not — whether a rated match
   * may be watched at all is answered by the VENUE (src/venues.ts), which is
   * why the top three brackets simply have no spectator seats and everything
   * below them rates exactly as it always did.
   *
   * The venue DOES now reach `unrankedReasons`, on its own account: a Casual
   * table pays XP and moves no rank. That is a statement about the room, not
   * about who is watching in it, and this flag is still not one of them.
   *
   * Being a config field means it rides room_config and game_start for free
   * and is already locked during play by set_room_config's own guard.
   */
  spectators: boolean;
}

/**
 * A seat at a table, on the wire: 0 and 1 play, 2 and 3 watch.
 *
 * One flat namespace for the client, because a client only ever asks for "a
 * seat". The relay maps it to (array, index) at its own boundary and keeps
 * `players` and `spectators` apart internally, which is what stops a watching
 * slot ever reaching something that indexes `streaks` or `ready`.
 */
export type TableSeat = 0 | 1 | 2 | 3;

/** One seat's occupant, as the table browser and the lobby draw it. */
export interface TableSeatInfo {
  seat: TableSeat;
  /** Null when nobody is in it. */
  playerId: string | null;
  playerName: string | null;
  /**
   * Whether this seat exists at this table at all. Always true for the two
   * playing seats; for a watching seat it is the room's `config.spectators`,
   * which the venue can force off however the host set it.
   */
  enabled: boolean;
}

/**
 * Where the match stands, for somebody who has just sat down to watch it.
 *
 * A spectator arriving at 3-2 has missed `game_start` and every
 * `score_update`, and the relay is the only party that knows — so without
 * this their court renders 0-0 until the next point. Sent on arrival, and
 * again whenever a watcher changes which side they are sitting beside.
 */
export interface SpectatorSnapshot {
  p1Score: number;
  p2Score: number;
  servingPlayer: 0 | 1;
  matchSeq: number;
  inPlay: boolean;
  matchOver: boolean;
  config: RoomMatchConfig;
  /** Both seats' live runs, for the telemetry overlay. Never counted here. */
  streaks: [number, number];
}

// WebSocket Messages
// Display names are NOT part of the protocol: the server resolves each
// player's name from the device-cookie profile, so clients can't spoof one.
export type WSClientMessage =
  | { type: 'join_room'; roomId: string; playerId: string }
  | { type: 'create_room'; playerId: string; config?: RoomMatchConfig; venueRoomId?: string; visibility?: 'public' | 'private' }
  | { type: 'set_room_config'; config: RoomMatchConfig }
  | { type: 'spectate_room'; roomId: string; seat?: number }
  | { type: 'swap_seat'; seat: number }
  // Host-only, pre-match: lock this table, or open it up. Turning the lock ON
  // mints a FRESH key every time, so a key already shared stops working.
  | { type: 'set_table_visibility'; private: boolean }
  // The ranked queue. `rttMs` is the client's own last round-trip reading —
  // a tiebreak hint and never a gate, so its being self-reported costs
  // nothing: forging it buys a marginally better-connected opponent.
  | { type: 'queue_join'; rttMs?: number }
  | { type: 'queue_cancel' }
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
  | { type: 'match_sync'; matchSeq: number; rev: number; p1Score: number; p2Score: number; bestStreaks: [number, number]; streaks: [number, number]; earnedBests: [number, number]; servingPlayer: 0 | 1; crossingsThisPoint: number }
  | { type: 'quick_chat'; text: string; senderName?: string }
  | { type: 'rematch_request' }
  | { type: 'rtc_signal'; payload: RTCSignalPayload }
  | { type: 'ping'; timestamp: number }
  | { type: 'leave_room' };

/**
 * Why the relay refused something, as a stable token rather than English prose.
 *
 * The `error` frame used to carry a server-authored English literal and the
 * client put it straight into `alert()` — so six of seven locales read English,
 * and the most common refusal in the product (mistyping a 4-character join key)
 * was a blocking OS dialog over a live court. These are the client's key into
 * its own dictionary; the literal rides along as the fallback.
 */
export type RelayErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ALREADY_AT_TABLE'
  | 'SEAT_TAKEN'
  | 'SEATS_LOCKED'
  | 'NEEDS_A_PLAYER'
  | 'NO_WATCH_SEATS'
  | 'WATCH_SEATS_FULL'
  | 'NOT_A_SEAT'
  | 'NEEDS_USERNAME'
  | 'LEAVE_TABLE_FIRST'
  | 'VENUE_LOCKED';

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
  | { type: 'game_start'; servingPlayer: 0 | 1; config: RoomMatchConfig; matchSeq: number; streaks: [number, number] }
  | { type: 'match_prediction'; winProbability: number }
  | { type: 'score_update'; p1Score: number; p2Score: number; reason: string; nextServer: 0 | 1 }
  | { type: 'rematch_state'; votes: [boolean, boolean] }
  | { type: 'rtc_signal'; payload: RTCSignalPayload; fromIdx: 0 | 1 }
  // The relay recorded a finished duel for this player. It records for BOTH
  // seats from the score it owns, so a result lands on both profiles even if
  // one phone never manages to POST it.
  | { type: 'match_recorded'; matchKey: string; result: MatchEndResult }
  | { type: 'opponent_left' }
  // Who is sitting where at this table, and which seat the recipient holds.
  // Sent per-socket rather than broadcast, since `yourSeat` differs by
  // recipient. A spectator is told about a seat change the way a player is
  // told about `opponent_joined` — never with `opponent_left`, which would
  // report a departure to somebody who lost nobody.
  | { type: 'table_state'; roomId: string; seats: TableSeatInfo[]; yourSeat: TableSeat | null; spectatorsEnabled: boolean; isPrivate: boolean; joinKey: string | null; venueRoomId: string }
  // Where the match already stands, for a watcher who has just sat down.
  | { type: 'spectator_sync'; snapshot: SpectatorSnapshot }
  // Where the search stands. `found` is followed immediately by the ordinary
  // room_created/room_joined/room_config and then game_start: the relay seats
  // the pair and starts the match itself, with no lobby and no ready tap.
  | { type: 'queue_state'; status: 'searching' | 'found' | 'cancelled'; opponent?: PublicProfile }
  // The three frames only a WATCHER receives, all about the court of the
  // player they are sitting beside — which that player never needs, because
  // they are simulating it. RAW, in that player's own coordinates: no mirror
  // and no transform, unlike opponent_paddle/opponent_ball/ball_incoming,
  // which a watcher receives byte-identically to the player beside them.
  | { type: 'watched_paddle'; x: number }
  | { type: 'watched_ball'; x: number; y: number }
  | { type: 'watched_ball_left' }
  // The relay refused this socket because the account is not held by this
  // session any more (transferred to another device, displaced by a newer
  // load, or minted under a previous deployment). Sent immediately before the
  // close, so the client can act on the reason rather than on a bare 1006.
  | { type: 'session_invalid'; status: SessionStatus; build: string }
  // The relay has started counting this match's gameplay itself, so both
  // phones must come off their DataChannel and play through it. A link does
  // not die for both peers at the same instant: the one that notices falls
  // back on its own, and without this the other keeps playing P2P against an
  // opponent who is no longer there — and keeps reporting a replica the relay
  // has already overtaken. One transport, one authority.
  | { type: 'p2p_fallback' }
  | { type: 'pong'; timestamp: number }
  | {
      type: 'error';
      /**
       * English, and the fallback. Kept so an older bundle — and anything
       * reading the wire directly — still shows something sensible.
       */
      message: string;
      /**
       * What went wrong, for a client that wants to say it in the player's own
       * language. Optional: a relay that has not been taught a code for some
       * refusal still sends `message`, and the client falls back to it.
       */
      code?: RelayErrorCode;
      /**
       * For `VENUE_LOCKED` only: the bracket verdict itself, so the client can
       * render it with the same localized sentence the room list already
       * shows. Sending the verdict rather than a formatted string is what
       * keeps one copy of that wording instead of two.
       */
      verdict?: EntryVerdict;
    };

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
