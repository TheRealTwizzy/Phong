import fs from 'fs';
import path from 'path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  PlayerProfile,
  PublicProfile,
  ProfileApiErrorCode,
  Achievement,
  MatchRecord,
  LeaderboardEntry,
  MatchEndPayload,
  MatchEndResult,
  ModeStats,
  RankDirection,
  GameMode,
  DailyMission,
} from '../src/types';
import {
  validateUsername,
  usernameLockExpiry,
  DELETED_PLAYER_ID,
  DELETED_PLAYER_NAME,
} from '../src/profileRules';
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
  soloMuCap,
  PVP_UPDATE,
  PLACEMENT_UPDATE,
  PLACEMENT_SIGMA,
  soloCountsForRank,
  PLACEMENT_GAMES,
  surpriseMultiplier,
  normalizeDifficulty,
  practiceXp,
  achievementXpCap,
  PRACTICE_XP_DAILY_CAP,
  soloAdjustedXp,
} from '../src/rating';
import { BotSeed, botProfileFields } from './bots';
import {
  MISSION_POOL,
  RECENT_DEAL_MEMORY,
  pickHand,
  ELITE_POOL,
  REGULAR_SLOTS,
  ELITE_SLOTS,
  REROLLS_REGULAR,
  REROLLS_ELITE,
  MissionDef,
  applyMatchToProgress,
  dealOrder,
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
  /**
   * Record the match as un-ranked whatever its rules say: no MMR, no rank,
   * `ranked: 0` on the history row. The one caller is the relay recording a
   * FORGIVEN abandon's loss — the day's first disconnect spares the leaver's
   * ladder, never the loss itself.
   */
  forceUnranked?: boolean;
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
// A third one-shot reset, requested after the progression overhaul landed:
// ranked bands, the eight-branch achievement tree, the Cyber climb, abandon
// penalties. Everything stored was earned under rules that no longer exist.
const WIPE_V3_KEY = 'wipe_v3';
// A fourth, for the rally rework. A rally number used to be a single counter
// both players incremented, reset whenever either of them scored; it is now
// one player's own consecutive returns, broken only by their own miss. Every
// banked highestRally, every matches.maxRally and every rally mission's
// progress was measured on the old rule and is not comparable to the new one
// — and the thresholds moved under them in the same release. There is no
// conversion that would be honest, so the slate is cleared.
const WIPE_V4_KEY = 'wipe_v4';

/**
 * The oldest a reported result may claim to be, for ordering purposes.
 *
 * A nonsense age — a clock that jumped, a hand-written payload — should sort
 * as simply old rather than place a row before the epoch. Thirty days is well
 * past anything the on-device queue realistically holds.
 */
const MAX_RESULT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long before it was SENT a reported match ended, in ms.
 *
 * Both readings come from the reporting device's own clock — one at the
 * whistle, one as the attempt goes out — so the difference is an elapsed
 * duration and carries none of that clock's offset. Either missing means
 * "just now", which is what a first attempt that landed, or a payload the
 * relay built itself, actually is.
 */
const resultAgeMs = (payload: { endedAt?: number; clientNow?: number }): number | undefined => {
  const ended = Number(payload.endedAt);
  const sent = Number(payload.clientNow);
  if (!Number.isFinite(ended) || !Number.isFinite(sent)) return undefined;
  const age = sent - ended;
  // A NEGATIVE difference means the clock moved backwards between the two
  // readings — an NTP correction, or a hand-set clock — so the elapsed time
  // is not knowable from them. "Just now" is the reading that lets this
  // result overwrite whatever is stored, which makes it the wrong guess: a
  // match queued while the clock ran fast, replayed after the correction,
  // would land on top of a newer one. Read as old as we allow instead. It
  // costs at most the carry from a live report whose ordering the client's
  // own write chain already handles, and that is the side to be wrong on.
  if (age < 0) return MAX_RESULT_AGE_MS;
  return age > 0 ? age : undefined;
};
// Every key, oldest first. applyWipe re-stamps ALL of them after running:
// stamping only some would leave a hole that re-triggers an earlier wipe on
// the next boot — and since each wipe clears `meta`, two half-stamped keys
// would take turns wiping the database on every single start.
const WIPE_KEYS = [WIPE_V1_KEY, WIPE_V2_KEY, WIPE_V3_KEY, WIPE_V4_KEY];

/**
 * How long a recorded match stays deduplicable. Long enough to cover a match
 * parked on a device by an offline session and replayed on its next load;
 * short enough that the table stays small.
 */
const RECORDED_MATCH_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A daily-task slot whose tier has nothing fresh left to deal today. Matches
 * no mission id, so getMissions drops it and advanceMissions skips it, while
 * the row itself stays put so ensureSlots still knows the day was dealt.
 */
const RETIRED_SLOT = '';

/**
 * Every table whose rows belong to one account, keyed by a `playerId` column.
 *
 * deleteAccount walks this list, so a table added without being named here is
 * a table that survives its owner. That is not a tidiness problem: a row under
 * a deleted id is a pointer into nothing, and the last time this list was
 * incomplete — `player_mode_stats`, missed by moveAccount — an account arrived
 * on its new browser having played nothing and the next match recorded there
 * wrote that zero over the run the player actually had.
 *
 * `players` is absent because its key is `id`, not `playerId`, and `matches`
 * because its rows are not all one player's — see deleteAccount for both.
 * tests/identity.test.ts reads the schema and fails if a playerId-keyed table
 * exists that this list does not name.
 */
export const PLAYER_KEYED_TABLES = [
  'avatars',
  'player_mode_stats',
  'daily_missions',
  'daily_mission_slots',
  'daily_abandons',
  'daily_rerolls',
  'daily_practice',
  'daily_solo',
  'elite_completions',
  'recent_missions',
  'recorded_matches',
] as const;

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
  winStreak: number | null;
  bestWinStreak: number | null;
  shutoutsWon: number | null;
  rookieWins: number | null;
  proWins: number | null;
  eliteWins: number | null;
  cyberWins: number | null;
  chaosWins: number | null;
  abandons: number | null;
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
    winStreak: row.winStreak || 0,
    bestWinStreak: row.bestWinStreak || 0,
    shutoutsWon: row.shutoutsWon || 0,
    rookieWins: row.rookieWins || 0,
    proWins: row.proWins || 0,
    eliteWins: row.eliteWins || 0,
    cyberWins: row.cyberWins || 0,
    chaosWins: row.chaosWins || 0,
    abandons: row.abandons || 0,
    achievements: JSON.parse(row.achievements || '[]'),
    recoveryCode: row.recoveryCode || undefined,
    initializedAt: row.initializedAt || undefined,
    usernameChangedAt: row.usernameChangedAt || undefined,
    initialized: Boolean(row.initializedAt),
    hasAvatar: Boolean(avatarUpdatedAt),
    avatarVersion: avatarUpdatedAt ? Date.parse(avatarUpdatedAt) : undefined,
  };
}

// Mid-match abandons: the first of a UTC day is forgiven — forgiveness spares
// the RATING on the loss the relay records (the leaver's copy of the match
// goes down unranked), never the loss itself. Repeats pay the genuine
// TrueSkill loss, which replaced the flat mu penalty this constant's sibling
// used to size: one bad wifi evening still cannot cost a rank, while a
// session of rage-quits now costs exactly what losing those matches costs.
const ABANDONS_FORGIVEN_PER_DAY = 1;

class GameDatabase {
  private sql: DatabaseSync;
  /**
   * Compiled statements keyed by their SQL. Compiling is the expensive half of
   * a small query, and the write path repeats the same dozen statements on
   * every recorded match, so each one is compiled once and reused. SQLite
   * re-prepares a cached statement itself if the schema changes underneath it.
   */
  private statements = new Map<string, StatementSync>();

  private stmt(sql: string): StatementSync {
    let cached = this.statements.get(sql);
    if (!cached) {
      cached = this.sql.prepare(sql);
      this.statements.set(sql, cached);
    }
    return cached;
  }

  constructor() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    this.sql = new DatabaseSync(DB_FILE);
    this.sql.exec('PRAGMA journal_mode = WAL');
    // The companion setting to WAL: commits stop fsync-ing the log every time,
    // which is most of the cost of recording a match. A crashed process still
    // recovers fully; only a power loss can drop the last few commits, which
    // for match history and XP is a trade worth making.
    this.sql.exec('PRAGMA synchronous = NORMAL');
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
        winStreak INTEGER NOT NULL DEFAULT 0,
        bestWinStreak INTEGER NOT NULL DEFAULT 0,
        shutoutsWon INTEGER NOT NULL DEFAULT 0,
        rookieWins INTEGER NOT NULL DEFAULT 0,
        proWins INTEGER NOT NULL DEFAULT 0,
        eliteWins INTEGER NOT NULL DEFAULT 0,
        cyberWins INTEGER NOT NULL DEFAULT 0,
        chaosWins INTEGER NOT NULL DEFAULT 0,
        abandons INTEGER NOT NULL DEFAULT 0,
        dailyStreak INTEGER NOT NULL,
        lastDailyDate TEXT NOT NULL,
        achievements TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        lastActive TEXT NOT NULL,
        rankTitle TEXT,
        recoveryCode TEXT,
        initializedAt TEXT,
        usernameChangedAt TEXT,
        activeSessionId TEXT,
        activeSessionAt TEXT
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
        timestamp TEXT NOT NULL,
        -- 1 = this match actually moved the visible ladder (ranksThisMatch at
        -- record time), 0 = it did not. Rows from before the column existed
        -- were classified once by ranked_backfill_v1 from mode + difficulty
        -- (rules assumed stock — see backfillMatchRanked); a NULL still reads
        -- as un-ranked everywhere, as the safety net for any straggler.
        ranked INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_matches_p1 ON matches(player1Id);
      CREATE INDEX IF NOT EXISTS idx_matches_p2 ON matches(player2Id);
      -- Per-mode stats. The career totals on the players table mix solo and
      -- duel into a single number, which answers "how much have you played"
      -- and nothing at all about how you play each mode. A separate table
      -- rather than four times the columns: upsertProfile is a hand-written
      -- INSERT whose column list, VALUES tuple, DO UPDATE SET and positional
      -- args all have to agree, and every column added there is four chances
      -- to get it wrong. Split Screen is absent by design — it is two people
      -- on one phone and only one of them has an account.
      CREATE TABLE IF NOT EXISTS player_mode_stats (
        playerId TEXT NOT NULL,
        mode TEXT NOT NULL,
        matchesPlayed INTEGER NOT NULL DEFAULT 0,
        matchesWon INTEGER NOT NULL DEFAULT 0,
        matchesLost INTEGER NOT NULL DEFAULT 0,
        pointsScored INTEGER NOT NULL DEFAULT 0,
        aces INTEGER NOT NULL DEFAULT 0,
        bestStreak INTEGER NOT NULL DEFAULT 0,
        -- The run still going. A rally streak carries across matches, not just
        -- across points, so it has to outlive the match it was built in — and
        -- across a reload and a different browser too, which means it lives
        -- here rather than in the client.
        currentStreak INTEGER NOT NULL DEFAULT 0,
        -- When the match that set currentStreak ended, by its own device's
        -- clock. Every other column here is additive (paid once per matchKey)
        -- or a maximum, so order cannot hurt them. currentStreak is assigned,
        -- and the last WRITE is not the last MATCH: a result can sit in the
        -- on-device queue through a whole replay and land after it, restoring
        -- a run the replay had already broken.
        streakAt INTEGER NOT NULL DEFAULT 0,
        streakChainId TEXT,
        streakSeq INTEGER NOT NULL DEFAULT 0,
        winStreak INTEGER NOT NULL DEFAULT 0,
        bestWinStreak INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (playerId, mode)
      );
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
      -- Which missions a player actually holds today. Rerolling swaps the
      -- mission in a slot; keyed by dayKey so the hand resets with the day.
      CREATE TABLE IF NOT EXISTS daily_mission_slots (
        playerId TEXT NOT NULL,
        dayKey TEXT NOT NULL,
        slot INTEGER NOT NULL,
        missionId TEXT NOT NULL,
        PRIMARY KEY (playerId, dayKey, slot)
      );
      -- Rerolls spent today. Also dayKey'd, which is the whole mechanism by
      -- which unused rerolls expire rather than banking up.
      CREATE TABLE IF NOT EXISTS daily_abandons (
        playerId TEXT NOT NULL,
        dayKey TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (playerId, dayKey)
      );
      CREATE TABLE IF NOT EXISTS daily_rerolls (
        playerId TEXT NOT NULL,
        dayKey TEXT NOT NULL,
        regularUsed INTEGER NOT NULL DEFAULT 0,
        eliteUsed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (playerId, dayKey)
      );
      -- PERMANENT, deliberately not dayKey'd: the first time an elite mission
      -- is ever completed it banks an unlock that is kept for good.
      CREATE TABLE IF NOT EXISTS elite_completions (
        playerId TEXT NOT NULL,
        missionId TEXT NOT NULL,
        unlockId TEXT NOT NULL,
        completedAt TEXT NOT NULL,
        PRIMARY KEY (playerId, missionId)
      );
      CREATE TABLE IF NOT EXISTS daily_practice (
        playerId TEXT NOT NULL,
        dayKey TEXT NOT NULL,
        xpAwarded INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (playerId, dayKey)
      );
      -- Solo matches recorded today, for the XP fatigue curve: same-day solo
      -- grinding decays the momentum multiplier toward a floor (rating.ts,
      -- soloFatigue). Day-keyed like daily_practice, and for the same reason:
      -- a new day is a new row, so nothing ever needs expiring.
      CREATE TABLE IF NOT EXISTS daily_solo (
        playerId TEXT NOT NULL,
        dayKey TEXT NOT NULL,
        gamesPlayed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (playerId, dayKey)
      );
      -- One row per match actually paid out, so recording the same match
      -- twice pays once. A duel is reported up to three times over — the
      -- relay records it for both seats the moment the score decides it, and
      -- each phone POSTs its own copy as the fallback for a relay that never
      -- saw the match — and a queued match replayed from a device can arrive
      -- days later. The PRIMARY KEY is the whole mechanism; the result column
      -- holds the MatchEndResult that first call produced, replayed verbatim
      -- to the ones that follow so every caller sees the same XP.
      -- The last few tasks dealt to a player, per tier. Tasks repeat now, so
      -- this is what stops one returning the moment it leaves: a task is
      -- eligible again once RECENT_DEAL_MEMORY other deals have gone by. Not
      -- day-keyed on purpose — a task finished last night should not be first
      -- in line this morning. At most one row per (player, tier, task), so it
      -- is bounded by the pool size and never needs pruning.
      CREATE TABLE IF NOT EXISTS recent_missions (
        playerId TEXT NOT NULL,
        tier TEXT NOT NULL,
        missionId TEXT NOT NULL,
        dealtAt TEXT NOT NULL,
        -- Counts deals, per player and tier. "The last three" has to be exact,
        -- and a timestamp cannot give that: a whole hand is dealt in one go
        -- and would share a stamp, leaving the window's edge to a tiebreak.
        seq INTEGER NOT NULL,
        PRIMARY KEY (playerId, tier, missionId)
      );
      CREATE INDEX IF NOT EXISTS idx_recent_missions_player
        ON recent_missions (playerId, tier, seq DESC);
      -- Devices that USED to hold a profile and no longer do, because the
      -- profile was claimed onto another device. Permanent and tiny: one row
      -- per transfer. It exists because without it a retired device id is
      -- indistinguishable from a browser the server has never met, and
      -- getProfile mints a fresh profile for exactly that case — so the
      -- device that had just handed its account away was quietly issued a
      -- new, empty one and allowed to play a full match under it.
      CREATE TABLE IF NOT EXISTS released_devices (
        deviceId TEXT PRIMARY KEY,
        movedToPlayerId TEXT NOT NULL,
        releasedAt TEXT NOT NULL
      );
      -- Every browser that has ever signed in to an account, including the one
      -- currently holding it.
      --
      -- A player's identity is their device cookie, and cookie jars do not
      -- cross browsers: an invitation tapped in Messenger opens a webview that
      -- is not the browser the account was made in, and the server cannot tell
      -- it from a stranger. There is no device identifier on the web to fix
      -- that with — so instead an account remembers the browsers it belongs
      -- to. Signing in with the account's code adds this browser to the set.
      --
      -- The account still LIVES on exactly one row at a time (players.id is a
      -- device id, and moves), and exactly one session may hold it — the
      -- concurrency rule is untouched. What changes is that a browser which is
      -- not currently holding it is a known browser of the account rather than
      -- a stranger, so it is offered the account back instead of a fresh empty
      -- profile or a one-way "start over" wall.
      CREATE TABLE IF NOT EXISTS device_links (
        deviceId TEXT PRIMARY KEY,
        playerId TEXT NOT NULL,
        linkedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_device_links_player ON device_links (playerId);
      CREATE TABLE IF NOT EXISTS recorded_matches (
        playerId TEXT NOT NULL,
        matchKey TEXT NOT NULL,
        recordedAt TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (playerId, matchKey)
      );
      -- Expiry runs on every recorded match, so it has to be a seek that finds
      -- nothing rather than a scan of the whole fortnight. Recording a match
      -- is the game's hot write; it was not going to pay for this.
      CREATE INDEX IF NOT EXISTS idx_recorded_matches_at
        ON recorded_matches (recordedAt);
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
    this.applyWipe(WIPE_V3_KEY, 'wipe_v3: cleared all player data for the progression overhaul (0 players)');
    this.applyWipe(WIPE_V4_KEY, 'wipe_v4: cleared all player data for the rally-streak rework (0 players)');
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
      this.sql.exec('DROP TABLE IF EXISTS daily_mission_slots');
      this.sql.exec('DROP TABLE IF EXISTS daily_rerolls');
      this.sql.exec('DROP TABLE IF EXISTS daily_abandons');
      this.sql.exec('DROP TABLE IF EXISTS elite_completions');
      this.sql.exec('DROP TABLE IF EXISTS daily_practice');
      this.sql.exec('DROP TABLE IF EXISTS daily_solo');
      this.sql.exec('DROP TABLE IF EXISTS recorded_matches');
      this.sql.exec('DROP TABLE IF EXISTS released_devices');
      // Added with the multi-browser rework and missed here at the time. A
      // surviving device_links row points at a playerId that no longer exists,
      // and resolveSession reads "linked but not holding" as `superseded` — so
      // a wipe would have left devices walled off from an account that had
      // been deleted out from under them.
      this.sql.exec('DROP TABLE IF EXISTS device_links');
      this.sql.exec('DROP TABLE IF EXISTS recent_missions');
      this.sql.exec('DROP TABLE IF EXISTS player_mode_stats');
      this.sql.exec('DELETE FROM meta');
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
    this.ensureBaseSchema();
    // EVERY wipe flag is re-stamped, earlier and later alike. Stamping only
    // the keys up to this one used to be enough with two of them, but each
    // wipe clears `meta`: with three keys, a wipe that forgot to re-stamp a
    // sibling would leave that sibling unstamped, it would fire on the next
    // boot, clear THIS stamp in turn, and the two would alternate — a full
    // player wipe and cookie rotation on every start, forever.
    const stamp = new Date().toISOString();
    for (const k of WIPE_KEYS) this.setMeta(k, stamp);
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
    // The same, for player_mode_stats — the only other table this project has
    // ever needed to widen after the fact.
    const modeCols = this.sql
      .prepare('PRAGMA table_info(player_mode_stats)')
      .all() as unknown as Array<{ name: string }>;
    if (modeCols.length && !modeCols.some((c) => c.name === 'streakAt')) {
      this.sql.exec('ALTER TABLE player_mode_stats ADD COLUMN streakAt INTEGER NOT NULL DEFAULT 0');
    }
    if (modeCols.length && !modeCols.some((c) => c.name === 'streakChainId')) {
      this.sql.exec('ALTER TABLE player_mode_stats ADD COLUMN streakChainId TEXT');
      this.sql.exec('ALTER TABLE player_mode_stats ADD COLUMN streakSeq INTEGER NOT NULL DEFAULT 0');
    }
    // And for matches: whether the match counted for the visible ladder,
    // recorded so history can filter Ranked from Un-Ranked. Nullable on
    // purpose — see the CREATE TABLE comment: a row from before the column
    // cannot be backfilled honestly and reads as un-ranked.
    const matchCols = this.sql
      .prepare('PRAGMA table_info(matches)')
      .all() as unknown as Array<{ name: string }>;
    if (matchCols.length && !matchCols.some((c) => c.name === 'ranked')) {
      this.sql.exec('ALTER TABLE matches ADD COLUMN ranked INTEGER');
    }

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
    // Counters the expanded achievement tree is measured on. All server-side.
    addColumn('winStreak', 'winStreak INTEGER NOT NULL DEFAULT 0');
    addColumn('bestWinStreak', 'bestWinStreak INTEGER NOT NULL DEFAULT 0');
    addColumn('shutoutsWon', 'shutoutsWon INTEGER NOT NULL DEFAULT 0');
    addColumn('rookieWins', 'rookieWins INTEGER NOT NULL DEFAULT 0');
    addColumn('proWins', 'proWins INTEGER NOT NULL DEFAULT 0');
    addColumn('eliteWins', 'eliteWins INTEGER NOT NULL DEFAULT 0');
    addColumn('cyberWins', 'cyberWins INTEGER NOT NULL DEFAULT 0');
    addColumn('chaosWins', 'chaosWins INTEGER NOT NULL DEFAULT 0');
    addColumn('abandons', 'abandons INTEGER NOT NULL DEFAULT 0');
    // One account, one live session. Which one is recorded here.
    addColumn('activeSessionId', 'activeSessionId TEXT');
    addColumn('activeSessionAt', 'activeSessionAt TEXT');
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

    this.releaseStrandedPlacements();
    this.resetActiveTasks();
    // Order matters between these two: the backfill classifies legacy rows
    // from mode + difficulty, and a legacy 'chaos' row (which meant the old
    // between-Pro-and-Cyber rung) must be judged and relabelled under its old
    // meaning before the name is revived at the top of the ladder.
    this.backfillMatchRanked();
    this.relabelChaosMatches();

    // Backfill codes for rows created before recovery codes existed
    const missing = this.stmt('SELECT id FROM players WHERE recoveryCode IS NULL')
      .all() as unknown as Array<{ id: string }>;
    for (const row of missing) {
      this.stmt('UPDATE players SET recoveryCode = ? WHERE id = ?')
        .run(this.newRecoveryCode(), row.id);
    }
  }

  /**
   * Place the players the old placement rule stranded.
   *
   * Placement needs BOTH enough ranked games AND sigma <= PLACEMENT_SIGMA, and
   * at the ordinary PvP shrink the sigma condition was not reachable until
   * roughly the sixteenth ranked game — while the profile screen counted to
   * five and stopped. Players finished the matches the game asked of them, saw
   * "5/5", and stayed UNRANKED with nothing to tell them what was still
   * missing. Placement matches now shed uncertainty faster, but that only
   * helps people placing from here on: anyone already past their placement
   * games carries a sigma earned under the old rule and would go on waiting.
   *
   * Their uncertainty is brought to exactly the placement threshold — the most
   * uncertain a placed player may be, so nobody is credited with more
   * confidence than they played for. The tier itself is derived on read
   * (rowToProfile), so the badge follows immediately.
   */
  private releaseStrandedPlacements(): void {
    const KEY = 'placement_sigma_v1';
    if (this.getMeta(KEY)) return;
    const stranded = this.stmt(
        `UPDATE players SET rankSigma = ?
          WHERE rankedGames >= ? AND rankSigma > ?`
      )
      .run(PLACEMENT_SIGMA, PLACEMENT_GAMES, PLACEMENT_SIGMA);
    this.setMeta(KEY, new Date().toISOString());
    if (stranded.changes) {
      console.log(`placement_sigma_v1: placed ${stranded.changes} player(s) stranded by the old placement rule`);
    }
  }

  /**
   * Classify the match rows recorded before the `ranked` column existed.
   *
   * Shipping the column with no backfill read as correct caution and was a
   * bug in practice: on a live database the ENTIRE history predated it, so
   * every match rendered Un-Ranked and both Ranked sub-tabs were empty. The
   * per-match rules and sonar flag were discarded at record time, but the two
   * inputs that dominate the verdict — mode and difficulty — survive in every
   * row, and rules are stock in the overwhelming case. So: a duel counted for
   * the ladder, a solo at an earned difficulty (pro/cyber) counted, and
   * everything else did not. Post-wipe_v4 databases hold only
   * rookie/pro/cyber difficulties, so the IN list is complete.
   *
   * One-shot and heuristic, deliberately: rows written after the column
   * always carry the exact verdict, and NULL still reads as un-ranked
   * everywhere as the safety net for any straggler.
   */
  private backfillMatchRanked(): void {
    const KEY = 'ranked_backfill_v1';
    if (this.getMeta(KEY)) return;
    const rankedRows = this.stmt(
        `UPDATE matches SET ranked = 1 WHERE ranked IS NULL
          AND (mode = 'multiplayer' OR (mode = 'solo' AND difficulty IN ('pro','cyber')))`
      ).run();
    const unrankedRows = this.stmt('UPDATE matches SET ranked = 0 WHERE ranked IS NULL').run();
    this.setMeta(KEY, new Date().toISOString());
    if (rankedRows.changes || unrankedRows.changes) {
      console.log(
        `ranked_backfill_v1: classified ${rankedRows.changes} ranked and ${unrankedRows.changes} un-ranked legacy match row(s)`
      );
    }
  }

  /**
   * Solo matches recorded for `playerId` so far this UTC day — the fatigue
   * input, read BEFORE this match's own bump so the first game of a day
   * counts as zero played.
   */
  /**
   * The solo win streak this player carries INTO a match — the momentum
   * input. Read straight from the row rather than through getModeStats, whose
   * public shape deliberately omits the live per-mode win streak; and read
   * BEFORE bumpModeStats applies this match's own result.
   */
  private soloWinStreak(playerId: string): number {
    const row = this.stmt(
        `SELECT winStreak FROM player_mode_stats WHERE playerId = ? AND mode = 'solo'`
      )
      .get(playerId) as { winStreak: number } | undefined;
    return row?.winStreak ?? 0;
  }

  private soloGamesToday(playerId: string, now: Date): number {
    const row = this.stmt('SELECT gamesPlayed FROM daily_solo WHERE playerId = ? AND dayKey = ?')
      .get(playerId, missionDayKey(now)) as { gamesPlayed: number } | undefined;
    return row?.gamesPlayed ?? 0;
  }

  private bumpSoloGames(playerId: string, now: Date): void {
    this.stmt(
        `INSERT INTO daily_solo (playerId, dayKey, gamesPlayed) VALUES (?, ?, 1)
         ON CONFLICT(playerId, dayKey) DO UPDATE SET gamesPlayed = gamesPlayed + 1`
      )
      .run(playerId, missionDayKey(now));
  }

  /**
   * Relabel legacy 'chaos' match rows to 'cyber' — ONCE, before the name
   * changes hands.
   *
   * 'chaos' was a retired difficulty that sat BETWEEN Pro and Cyber, and
   * normalizeDifficulty mapped it to 'cyber' ("a stored chaos still means the
   * hard one"). The five-rung ladder revives the name as the NEW TOP RUNG, so
   * a legacy history row left saying 'chaos' would silently start rendering
   * as the hardest opponent in the game — a match the player never played.
   * Rewriting the rows to what the retirement map already said they meant,
   * one time, is what lets the map itself be deleted.
   */
  private relabelChaosMatches(): void {
    const KEY = 'chaos_relabel_v1';
    if (this.getMeta(KEY)) return;
    const rows = this.stmt(`UPDATE matches SET difficulty = 'cyber' WHERE difficulty = 'chaos'`).run();
    this.setMeta(KEY, new Date().toISOString());
    if (rows.changes) {
      console.log(`chaos_relabel_v1: relabelled ${rows.changes} legacy chaos match row(s) to cyber`);
    }
  }

  /**
   * Clear everybody's active tasks once, so the day is dealt afresh.
   *
   * Hands dealt under the old rules carry state the new ones cannot repair on
   * their own: five slots where there should be three, tasks marked claimed
   * that the claim path will never revisit, and progress banked against tasks
   * that were meant to start from zero. sweepClaimed and trimSlots heal most
   * of that on read, but a half-finished five-task hand is still not a hand
   * anyone was meant to be holding.
   *
   * Nothing permanent is touched. XP already paid stays on the profile and
   * elite unlocks live in their own table; these three are day-keyed working
   * state, and every player simply gets dealt a fresh set on their next read.
   * The reroll allowances go back too — they were spent on a hand that is
   * being taken away, and letting that stand would be charging for nothing.
   */
  private resetActiveTasks(): void {
    const KEY = 'tasks_reset_v1';
    if (this.getMeta(KEY)) return;
    const held = this.stmt('SELECT COUNT(*) AS n FROM daily_mission_slots').get() as { n: number };
    this.sql.exec('BEGIN');
    try {
      this.sql.exec('DELETE FROM daily_mission_slots');
      this.sql.exec('DELETE FROM daily_missions');
      this.sql.exec('DELETE FROM daily_rerolls');
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
    this.setMeta(KEY, new Date().toISOString());
    if (held.n > 0) {
      console.log(`tasks_reset_v1: cleared ${held.n} active task slot(s); every player is dealt a fresh set`);
    }
  }

  /** Rewrite a stored achievement id across every profile that holds it. */
  private renameAchievement(from: string, to: string): void {
    const rows = this.stmt(`SELECT id, achievements FROM players WHERE achievements LIKE ?`)
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
      this.stmt('UPDATE players SET achievements = ? WHERE id = ?')
        .run(JSON.stringify(renamed), row.id);
    }
  }

  public getMeta(key: string): string | null {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  public setMeta(key: string, value: string): void {
    this.stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
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
      const clash = this.stmt('SELECT 1 FROM players WHERE recoveryCode = ?').get(code);
      if (!clash) return code;
    }
  }

  private playerCount(): number {
    const row = this.stmt('SELECT COUNT(*) AS n FROM players').get() as { n: number };
    return row.n;
  }

  private upsertProfile(p: PlayerProfile): void {
    this.stmt(
        `INSERT INTO players (id, username, level, xp, xpNext, mmrMu, mmrSigma, rankMu, rankSigma, rankedGames, matchesPlayed, matchesWon,
           matchesLost, highestRally, totalPointsScored, totalAces, multiplayerWins,
           winStreak, bestWinStreak, shutoutsWon, rookieWins, proWins, eliteWins, cyberWins, chaosWins, abandons, dailyStreak, lastDailyDate,
           achievements, createdAt, lastActive, recoveryCode, initializedAt, usernameChangedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           username=excluded.username, level=excluded.level, xp=excluded.xp, xpNext=excluded.xpNext,
           mmrMu=excluded.mmrMu, mmrSigma=excluded.mmrSigma, rankMu=excluded.rankMu,
           rankSigma=excluded.rankSigma, rankedGames=excluded.rankedGames,
           matchesPlayed=excluded.matchesPlayed,
           matchesWon=excluded.matchesWon, matchesLost=excluded.matchesLost,
           highestRally=excluded.highestRally, totalPointsScored=excluded.totalPointsScored,
           totalAces=excluded.totalAces, multiplayerWins=excluded.multiplayerWins,
           winStreak=excluded.winStreak, bestWinStreak=excluded.bestWinStreak,
           shutoutsWon=excluded.shutoutsWon, rookieWins=excluded.rookieWins,
           proWins=excluded.proWins, eliteWins=excluded.eliteWins,
           cyberWins=excluded.cyberWins, chaosWins=excluded.chaosWins,
           abandons=excluded.abandons,
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
        p.winStreak || 0,
        p.bestWinStreak || 0,
        p.shutoutsWon || 0,
        p.rookieWins || 0,
        p.proWins || 0,
        p.eliteWins || 0,
        p.cyberWins || 0,
        p.chaosWins || 0,
        p.abandons || 0,
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
    this.stmt(
        `INSERT INTO matches (id, player1Id, player1Name, player2Id, player2Name, winnerId, winnerName,
           scoreP1, scoreP2, maxRally, mode, difficulty, timestamp, ranked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        m.timestamp,
        m.ranked ?? null
      );
    // Keep the newest 500 rows PER PLAYER — history is "an accurate timeline
    // of every match played on this profile", and the global cap this
    // replaced meant one busy server's players silently trimmed each other's
    // histories. Per filer, here in the one insert path, so every writer
    // (recordMatch and the practice session row alike) pays for its own
    // retention. Cheap via idx_matches_p1.
    this.stmt(
        `DELETE FROM matches WHERE player1Id = ? AND rowid NOT IN
           (SELECT rowid FROM matches WHERE player1Id = ? ORDER BY rowid DESC LIMIT 500)`
      )
      .run(m.player1Id, m.player1Id);
  }

  private readProfile(id: string): PlayerProfile | null {
    const row = this.stmt(
        `SELECT p.*, a.updatedAt AS avatarUpdatedAt
           FROM players p LEFT JOIN avatars a ON a.playerId = p.id
          WHERE p.id = ?`
      )
      .get(id) as unknown as PlayerRow | undefined;
    if (!row) return null;
    // Elite unlocks live in their own permanent table; the client checks them
    // when deciding which themes are available, so they ride the profile.
    return {
      ...rowToProfile(row),
      eliteUnlocks: this.eliteUnlocks(id),
      modeStats: this.getModeStats(id),
    };
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
        winStreak: 0,
        bestWinStreak: 0,
        shutoutsWon: 0,
        rookieWins: 0,
        proWins: 0,
        eliteWins: 0,
        cyberWins: 0,
        chaosWins: 0,
        abandons: 0,
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
    const row = this.stmt(
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
  /**
   * A duel walked out on mid-match — socket died or the player quit with a
   * live ball. Recorded by the relay from its own room state; a client can
   * never report one.
   *
   * This is the abandon's BOOKKEEPING half: the day-keyed count and the
   * career counter, plus the verdict on whether today's forgiveness covers
   * it. The match itself is recorded separately by the relay as a real LOSS
   * for the leaver and a real WIN for the survivor (recordRoomMatch with the
   * leaver named), because the old shape — a flat rating penalty and no match
   * anywhere — meant a player could quit every losing duel and keep a 100%
   * win rate while their opponents' wins evaporated with them.
   *
   * The FIRST abandon of a UTC day is forgiven: connections drop, phones
   * ring, life happens. Forgiveness spares only the RATING — the leaver's
   * copy of the match records unranked — never the facts: the loss, the win
   * and both history rows land either way. There is no flat mu penalty any
   * more; the unforgiven cost is the genuine TrueSkill loss.
   */
  public recordAbandon(
    playerId: string,
    now: Date = new Date()
  ): { counted: boolean; forgiven: boolean; abandonsToday: number } {
    const profile = this.readProfile(playerId);
    if (!profile || !profile.initialized) {
      return { counted: false, forgiven: false, abandonsToday: 0 };
    }
    const dayKey = missionDayKey(now);
    this.stmt(
        `INSERT INTO daily_abandons (playerId, dayKey, count) VALUES (?, ?, 1)
         ON CONFLICT(playerId, dayKey) DO UPDATE SET count = count + 1`
      )
      .run(playerId, dayKey);
    const row = this.stmt(`SELECT count FROM daily_abandons WHERE playerId = ? AND dayKey = ?`)
      .get(playerId, dayKey) as { count: number };

    profile.abandons += 1;
    profile.lastActive = now.toISOString();
    this.upsertProfile(profile);
    return {
      counted: true,
      forgiven: row.count <= ABANDONS_FORGIVEN_PER_DAY,
      abandonsToday: row.count,
    };
  }

  /**
   * Fold one result into a mode's own row.
   *
   * The career totals on `players` mix solo and duel into a single number,
   * which answers "how much have you played" and nothing at all about how you
   * play each mode. These are the same measures kept apart, per mode.
   *
   * Additive and derived here, like every other counter: a client reports a
   * match, never a total. Split Screen never reaches this — it is two people
   * on one phone and only one of them has an account to write to.
   */
  private bumpModeStats(
    playerId: string,
    mode: GameMode,
    d: {
      played?: number;
      won?: boolean;
      pointsScored?: number;
      aces?: number;
      bestStreak?: number;
      /**
       * The run still going when the match ended — zero if it ended on a miss.
       * Absent means "leave it alone", which is what a write that is not about
       * a finished match wants.
       */
      endStreak?: number;
      /**
       * How long before it was SENT the match ended, in ms — see the note on
       * `stamp` below. Absent means "just now", which is what a write
       * happening as it happens wants: the relay's own record of a duel, a
       * practice session, or a first attempt that landed.
       */
      ageMs?: number;
      /**
       * This browser's own position in its run-write chain (see
       * `src/net/runChain.ts`), assigned once per event and PERSISTED — so it
       * survives a reload and orders a replayed write against whatever this
       * same browser assigns after it, with no regard to how long either
       * request's own round trip takes. Absent for anything with no chain —
       * an older bundle, or the relay's own writes.
       */
      chainId?: string | null;
      runSeq?: number;
    }
  ): void {
    const row = this.stmt(
        `SELECT winStreak, currentStreak, streakAt, streakChainId, streakSeq
           FROM player_mode_stats WHERE playerId = ? AND mode = ?`
      )
      .get(playerId, mode) as
      | {
          winStreak: number;
          currentStreak: number;
          streakAt: number;
          streakChainId: string | null;
          streakSeq: number;
        }
      | undefined;
    // Two of these columns describe THE RUN AS IT STANDS rather than a total,
    // and a run is a statement about a sequence — so they are the two that
    // need the results in order, and the additive ones do not. Idempotency
    // tells two matches apart; it does not put them in sequence. A result that
    // failed to POST sits in the on-device queue while the player replays and
    // lands afterwards.
    //
    // Ordered on the SERVER's clock, from how stale the caller says it is.
    //
    // A device's absolute clock cannot be used for this in either direction. A
    // phone running fast parks the stored stamp ahead of real time and freezes
    // the column until reality catches up; a phone running slow has every
    // result it ever sends look older than what is stored and be ignored the
    // same way. Both are one bug — comparing two clocks — and clamping only
    // the upper end fixes only half of it.
    //
    // An AGE has neither problem: it is the difference between two readings of
    // one clock, so whatever offset that clock carries cancels. The caller
    // measures how long ago the match ended and the server places it on its
    // own timeline. Bounded, because a nonsense age is still possible and a
    // result from "sixty years ago" should just sort as old, not underflow.
    const now = Date.now();
    const age = Math.min(MAX_RESULT_AGE_MS, Math.max(0, Math.round(Number(d.ageMs) || 0)));
    const stamp = now - age;
    const prevStamp = row?.streakAt ?? 0;
    // A stamp is `event + time on the wire`, and the wire is not constant, so
    // two writes from the SAME browser can still invert: whichever of them
    // happens to have the faster round trip can reach the server "later" in
    // stamped time even though it was decided first — a stall does this to a
    // serialized chain, and an ordinary difference in per-request latency does
    // it even without one, which the chain alone cannot fix once a queued
    // write is replayed from a page that no longer exists.
    //
    // A `runSeq` sidesteps network timing rather than reasoning about it: it
    // is assigned once, at the moment the event happens, before any request is
    // sent, and PERSISTED on the browser — so it means the same thing whether
    // this write lands in a second or resurfaces from the on-device queue
    // after a reload. `chainId` says which browser assigned it, so two numbers
    // are only ever compared when they came from the same one. Same chain,
    // higher seq — later, however long either request's own trip took. A
    // different chain, or no seq at all, has nothing in common to compare and
    // falls back to the age.
    const seq = Number.isFinite(Number(d.runSeq)) ? Math.floor(Number(d.runSeq)) : null;
    const sameChain =
      seq !== null && !!d.chainId && !!row?.streakChainId && d.chainId === row.streakChainId;
    const prevSeq = row?.streakSeq ?? 0;
    // A HIGHER seq is unambiguously later. An EQUAL one is not necessarily a
    // duplicate: `nextRunSeq()` reads its counter, increments, and writes it
    // back in three separate steps, none of them atomic across TABS — two
    // tabs on the same device can both read the same starting value before
    // either write lands, and both then report the same chainId and the same
    // next seq for two genuinely different events. Falling back to the age
    // here is not claiming to resolve that race correctly — two truly
    // simultaneous events have no meaningful "first" — only to stop always
    // resolving it the SAME wrong way, which was "whichever request's own
    // network trip happens to arrive at this server second always loses,"
    // with no regard to which one actually happened later.
    const isNewer = sameChain
      ? seq > prevSeq || (seq === prevSeq && stamp > prevStamp)
      : stamp >= prevStamp;
    const describesRun = d.endStreak !== undefined || d.won !== undefined;

    // A win streak IN THIS MODE: unlike the profile-wide one, a duel loss does
    // not end a solo streak and vice versa. Undefined `won` (a practice
    // session) leaves both alone rather than counting as a loss.
    //
    // An out-of-order result does not move it. Applied on arrival, an older
    // win landing after a newer loss extends the run THAT LOSS ENDED, and
    // bestWinStreak is a maximum so the inflation is permanent. The cost is
    // the mirror case — an older win that belonged to an unbroken run is not
    // added — and that is the side to be wrong on: a run not credited is
    // recoverable, a best that was never played is not.
    const nextWinStreak =
      d.won === undefined || !isNewer
        ? (row?.winStreak ?? 0)
        : d.won
          ? (row?.winStreak ?? 0) + 1
          : 0;
    // The run that carries. Assigned, not accumulated and not maxed: it can
    // legitimately go DOWN to zero, because ending a match on a miss is
    // exactly what ends a streak — which is why assigning it blindly is wrong.
    // Match A's run of 10 comes back over replay B's 0, and the next reload
    // starts on a run that was already broken. An older result is still kept
    // for its additive part: it happened, and it is owed the match, the points
    // and its share of the peak.
    const nextCurrent =
      d.endStreak === undefined || !isNewer
        ? (row?.currentStreak ?? 0)
        : Math.max(0, Math.round(d.endStreak));
    const nextStamp = describesRun && isNewer ? stamp : prevStamp;
    // The chain this run was last assigned by, so the next write from the same
    // browser can be ordered against it without the wire getting a vote.
    const nextChainId = describesRun && isNewer ? (d.chainId ?? null) : (row?.streakChainId ?? null);
    const nextSeq = describesRun && isNewer ? (seq ?? 0) : (row?.streakSeq ?? 0);
    this.stmt(
        `INSERT INTO player_mode_stats
           (playerId, mode, matchesPlayed, matchesWon, matchesLost,
            pointsScored, aces, bestStreak, currentStreak, streakAt, streakChainId,
            streakSeq, winStreak, bestWinStreak)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(playerId, mode) DO UPDATE SET
           matchesPlayed = matchesPlayed + excluded.matchesPlayed,
           matchesWon    = matchesWon    + excluded.matchesWon,
           matchesLost   = matchesLost   + excluded.matchesLost,
           pointsScored  = pointsScored  + excluded.pointsScored,
           aces          = aces          + excluded.aces,
           bestStreak    = MAX(bestStreak, excluded.bestStreak),
           currentStreak = excluded.currentStreak,
           streakAt      = excluded.streakAt,
           streakChainId = excluded.streakChainId,
           streakSeq     = excluded.streakSeq,
           winStreak     = excluded.winStreak,
           bestWinStreak = MAX(bestWinStreak, excluded.winStreak)`
      )
      .run(
        playerId,
        mode,
        d.played ?? 0,
        d.won === true ? 1 : 0,
        d.won === false ? 1 : 0,
        Math.max(0, Math.round(d.pointsScored ?? 0)),
        Math.max(0, Math.round(d.aces ?? 0)),
        Math.max(0, Math.round(d.bestStreak ?? 0)),
        nextCurrent,
        nextStamp,
        nextChainId,
        nextSeq,
        nextWinStreak,
        nextWinStreak
      );
  }

  /**
   * Where a run stands, reported outside a match.
   *
   * Only a FINISHED match reports itself, and a run does not only change when
   * one finishes: a player can carry a run in, miss, and walk out. Without
   * this the stored run is whatever the last completed match left, so the miss
   * survives a reload and every return after it extends a run that was over.
   *
   * Deliberately narrow. It counts no match, pays nothing, and moves no
   * rating — it writes one number. `multiplayer` is refused because the relay
   * owns a duel's runs and writes them itself from state no client can touch;
   * `split` banks nothing at all. What is left is solo and practice, both of
   * which are already client-authoritative (see the trust model in CLAUDE.md
   * §5) and already report this exact number through their own routes, so
   * this adds no reach a modified client did not have.
   */
  public reportStreak(
    playerId: string,
    mode: GameMode,
    endStreak: number,
    /**
     * How long before it was SENT the run reached this value. Not optional in
     * spirit: a report that stalls on a slow connection is stamped by ARRIVAL
     * without it, which makes it newer than the match result that overtook it.
     */
    ageMs?: number,
    /** This report's position in the browser's run-write chain; see bumpModeStats. */
    chain?: { chainId?: string | null; runSeq?: number }
  ): { ok: boolean; modeStats: Record<string, ModeStats> } {
    if (mode !== 'solo' && mode !== 'practice') return { ok: false, modeStats: {} };
    const profile = this.getProfile(playerId);
    if (!profile.initializedAt) throw new Error('PROFILE_NOT_INITIALIZED');
    const n = Math.floor(Number(endStreak));
    if (!Number.isFinite(n) || n < 0) return { ok: false, modeStats: this.getModeStats(playerId) };
    // No `played`, no `won`: nothing here says a match happened.
    this.bumpModeStats(playerId, mode, {
      endStreak: Math.min(100000, n),
      ageMs: Number(ageMs) || undefined,
      chainId: chain?.chainId,
      runSeq: chain?.runSeq,
    });
    return { ok: true, modeStats: this.getModeStats(playerId) };
  }

  /**
   * A duel seat's run, written by the RELAY.
   *
   * `reportStreak` refuses `multiplayer` on purpose — a duel's runs belong to
   * the room, not to either phone. This is the room's own way to say the same
   * thing, and it exists because a duel does not only end by being decided: a
   * player walks out and it is abandoned. `recordRoomMatch` writes the runs
   * when the score decides it; without this, an abandoned duel left both seats
   * on whatever the last COMPLETED match stored, so a miss during it was
   * undone and a run built during it was thrown away.
   *
   * Counts no match and pays nothing — the abandon itself is recorded
   * separately, and it is the only thing an abandoned duel costs.
   */
  public recordDuelStreak(playerId: string, endStreak: number): void {
    const n = Math.floor(Number(endStreak));
    if (!Number.isFinite(n) || n < 0) return;
    if (!this.readProfile(playerId)?.initializedAt) return;
    this.bumpModeStats(playerId, 'multiplayer', { endStreak: Math.min(100000, n) });
  }

  /** Every mode this player has a row for, keyed by mode. */
  public getModeStats(playerId: string): Record<string, ModeStats> {
    const rows = this.stmt(
        `SELECT mode, matchesPlayed, matchesWon, matchesLost, pointsScored,
                aces, bestStreak, currentStreak, bestWinStreak
           FROM player_mode_stats WHERE playerId = ?`
      )
      .all(playerId) as unknown as (ModeStats & { mode: string })[];
    const out: Record<string, ModeStats> = {};
    for (const r of rows) {
      const { mode, ...rest } = r;
      out[mode] = rest;
    }
    return out;
  }

  /**
   * A Practice Wall session.
   *
   * Three numbers, because they answer three different questions. `bestStreak`
   * is the run's peak, carried run included — that is a real run and it is what
   * the wall achievements and the mode's best are about. `earnedStreak` is how
   * much of it was built HERE, and it is the only one XP is paid on: paying on
   * the peak let a player carry a run in, open the wall, leave without touching
   * the ball, and collect for it again, up to the daily cap, every day.
   * `endStreak` is where the run stands, so the next session continues it.
   */
  public recordPractice(
    playerId: string,
    session: {
      bestStreak: number;
      earnedStreak?: number;
      endStreak?: number;
      ageMs?: number;
      chainId?: string | null;
      runSeq?: number;
    },
    now: Date = new Date()
  ): {
    earnedXp: number;
    dailyRemaining: number;
    newAchievements: Achievement[];
    profile: PlayerProfile;
  } {
    const profile = this.getProfile(playerId);
    if (!profile.initializedAt) throw new Error('PROFILE_NOT_INITIALIZED');

    const whole = (v: unknown): number => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) ? Math.max(0, n) : 0;
    };
    const peak = whole(session.bestStreak);
    // Neither of these can stand higher than the run ever reached.
    const earned = Math.min(peak, whole(session.earnedStreak));
    const ended = Math.min(peak, whole(session.endStreak));

    // Practice has no opponent, so it has no wins, losses or aces — a session
    // and a streak are all there is to keep. Banked whatever the daily XP cap
    // says, because the cap is about XP, not about what happened.
    this.bumpModeStats(playerId, 'practice', {
      played: 1,
      bestStreak: peak,
      endStreak: ended,
      // Ordered like every other write to the run. Two sessions can be left
      // seconds apart and their reports can land in either order — an older
      // one ending at 8 landing after a newer one that broke to 0 would put
      // the broken run back for anyone who reloads.
      ageMs: session.ageMs,
      chainId: session.chainId,
      runSeq: session.runSeq,
    });

    // A history-only session row, so the Practice Wall has a timeline like
    // every other mode. Deliberately NOT recordMatch — that path pays XP,
    // missions and rating, and practice pays through the capped math below
    // and moves neither. 'wall' is a synthetic opponent id in the mould of
    // AI-<difficulty>: it fails isLinkableId so it is never a tap target,
    // and the client renders practice rows from the mode, not these names.
    // winnerId is NOT NULL filler — a wall session has no winner and the UI
    // never renders W/L for practice. Sessions where no ball was returned
    // (earned 0 — including one that only broke a carried run) record
    // nothing: there is no session to remember.
    if (earned >= 1) {
      this.insertMatch({
        id: `match_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        player1Id: playerId,
        player1Name: profile.username,
        player2Id: 'wall',
        player2Name: 'Practice Wall',
        winnerId: playerId,
        winnerName: profile.username,
        scoreP1: 0,
        scoreP2: 0,
        maxRally: peak,
        mode: 'practice',
        timestamp: now.toISOString(),
        ranked: 0,
      });
    }

    const dayKey = missionDayKey(now);
    const row = this.stmt(`SELECT xpAwarded FROM daily_practice WHERE playerId = ? AND dayKey = ?`)
      .get(playerId, dayKey) as { xpAwarded: number } | undefined;
    const alreadyPaid = row?.xpAwarded ?? 0;

    const earnedXp = Math.max(
      0,
      Math.min(practiceXp(earned), PRACTICE_XP_DAILY_CAP - alreadyPaid)
    );

    // The rally branch's wall rungs are the only achievements a player who
    // never records a match can reach, so they are checked here as well.
    // The rungs are about the run, so they read the peak — a carried run is a
    // real run of returns, however many sessions it took.
    const streak = peak;
    const newAchievements: Achievement[] = [];
    let budget = achievementXpCap(profile.level);
    const wallProgress = { level: profile.level, tier: profile.tier };
    const grantWall = (achId: string) => {
      if (!isUnlockable(achId, profile.achievements, wallProgress)) return;
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
    if (streak >= 200) grantWall('wall_200');

    if (earnedXp > 0 || newAchievements.length > 0) {
      if (earnedXp > 0) {
        this.stmt(
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
    const rows = this.stmt(`SELECT missionId, progress, claimedAt FROM daily_missions WHERE playerId = ? AND dayKey = ?`)
      .all(playerId, dayKey) as { missionId: string; progress: number; claimedAt: string | null }[];
    return new Map(rows.map((r) => [r.missionId, { progress: r.progress, claimedAt: r.claimedAt }]));
  }

  /**
   * The missions a player holds today, dealing the hand on first sight of a
   * new day. Slots are stored rather than derived on every read so a reroll
   * has somewhere to live; the initial deal is deterministic from the player
   * and the day, so two devices agree without coordinating.
   */
  private ensureSlots(
    playerId: string,
    dayKey: string,
    now: Date = new Date()
  ): { slot: number; missionId: string }[] {
    const existing = this.stmt(`SELECT slot, missionId FROM daily_mission_slots WHERE playerId = ? AND dayKey = ? ORDER BY slot`)
      .all(playerId, dayKey) as { slot: number; missionId: string }[];
    if (existing.length) {
      return this.sweepClaimed(playerId, dayKey, this.trimSlots(playerId, dayKey, existing), now);
    }

    const regular = pickHand(
      dealOrder(MISSION_POOL, playerId, dayKey, 'regular'),
      this.recentlyDealt(playerId, 'regular'),
      REGULAR_SLOTS
    );
    const elite = pickHand(
      dealOrder(ELITE_POOL, playerId, dayKey, 'elite'),
      this.recentlyDealt(playerId, 'elite'),
      ELITE_SLOTS
    );
    const dealt = [...regular, ...elite];

    const insert = this.stmt(
      `INSERT INTO daily_mission_slots (playerId, dayKey, slot, missionId) VALUES (?, ?, ?, ?)
       ON CONFLICT(playerId, dayKey, slot) DO NOTHING`
    );
    dealt.forEach((missionId, slot) => insert.run(playerId, dayKey, slot, missionId));
    for (const missionId of regular) this.dealMission(playerId, dayKey, 'regular', missionId, now);
    for (const missionId of elite) this.dealMission(playerId, dayKey, 'elite', missionId, now);
    return dealt.map((missionId, slot) => ({ slot, missionId }));
  }

  /**
   * Hold a day already dealt to the CURRENT slot counts.
   *
   * The hand size is a constant, but a player mid-day is holding whatever they
   * were dealt this morning — so lowering it left them with five active tasks
   * until the UTC reset. The surplus is retired (blanked, never deleted; see
   * RETIRED_SLOT) rather than reshuffled, so nothing in progress is disturbed
   * beyond what has to be.
   */
  private trimSlots(
    playerId: string,
    dayKey: string,
    slots: { slot: number; missionId: string }[]
  ): { slot: number; missionId: string }[] {
    const limits: Record<'regular' | 'elite', number> = { regular: REGULAR_SLOTS, elite: ELITE_SLOTS };
    const kept: Record<'regular' | 'elite', number> = { regular: 0, elite: 0 };
    const retire = this.stmt(
      `UPDATE daily_mission_slots SET missionId = ? WHERE playerId = ? AND dayKey = ? AND slot = ?`
    );

    return slots.map((sl) => {
      const def = findMission(sl.missionId);
      if (!def) return sl; // already retired
      kept[def.tier] += 1;
      if (kept[def.tier] <= limits[def.tier]) return sl;
      retire.run(RETIRED_SLOT, playerId, dayKey, sl.slot);
      return { slot: sl.slot, missionId: RETIRED_SLOT };
    });
  }

  /**
   * Refill any slot still holding a task that has already been PAID.
   *
   * The auto-reroll fires at claim time, which handles every claim made under
   * these rules — but a slot can hold a claimed task for reasons the claim
   * path will never revisit: a task claimed before the repeating pool existed,
   * when a dry pool left it sitting there, is stuck for the rest of the UTC
   * day. The player cannot shift it either; a claimed task refuses both a
   * reroll (MISSION_COMPLETE) and a second claim (MISSION_CLAIMED). Sweeping
   * on read makes "a paid task is not an active task" true however the slot
   * got that way, rather than only on the path that happens to create it.
   *
   * Only CLAIMED tasks go. One that is finished but unclaimed stays exactly
   * where it is — that is the player's reward waiting to be collected, and
   * clearing it would quietly take the XP away.
   */
  private sweepClaimed(
    playerId: string,
    dayKey: string,
    slots: { slot: number; missionId: string }[],
    now: Date
  ): { slot: number; missionId: string }[] {
    const rows = this.missionRows(playerId, dayKey);
    let current = slots;
    for (const sl of slots) {
      const def = findMission(sl.missionId);
      if (!def || !rows.get(def.id)?.claimedAt) continue;
      const replacement = this.fillSlot(playerId, dayKey, sl.slot, def.tier, current, now);
      current = current.map((entry) =>
        entry.slot === sl.slot
          ? { slot: entry.slot, missionId: replacement ?? RETIRED_SLOT }
          : entry
      );
    }
    return current;
  }

  /** The tasks this player was dealt most recently, per tier. */
  private recentlyDealt(playerId: string, tier: 'regular' | 'elite'): Set<string> {
    const rows = this.stmt(
        `SELECT missionId FROM recent_missions WHERE playerId = ? AND tier = ?
         ORDER BY seq DESC LIMIT ?`
      )
      .all(playerId, tier, RECENT_DEAL_MEMORY) as { missionId: string }[];
    return new Set(rows.map((r) => r.missionId));
  }

  /**
   * Put a task into play: wipe whatever it held before, and remember that it
   * was dealt.
   *
   * The reset is the point. Progress is stored per (player, day, task), so a
   * task dealt back into a slot used to arrive carrying whatever it had
   * collected the last time it was held — a rerolled "Point Machine" turning
   * up at 21/25, which is a reward for nothing. A task in a slot has always
   * just started.
   */
  private dealMission(
    playerId: string,
    dayKey: string,
    tier: 'regular' | 'elite',
    missionId: string,
    now: Date
  ): void {
    this.stmt('DELETE FROM daily_missions WHERE playerId = ? AND dayKey = ? AND missionId = ?')
      .run(playerId, dayKey, missionId);
    this.stmt(
        `INSERT INTO recent_missions (playerId, tier, missionId, dealtAt, seq)
         VALUES (?, ?, ?, ?,
           (SELECT COALESCE(MAX(seq), 0) + 1 FROM recent_missions WHERE playerId = ? AND tier = ?))
         ON CONFLICT(playerId, tier, missionId)
           DO UPDATE SET dealtAt = excluded.dealtAt, seq = excluded.seq`
      )
      .run(playerId, tier, missionId, now.toISOString(), playerId, tier);
  }

  /** Rerolls already spent today, per tier. */
  private rerollsUsed(playerId: string, dayKey: string): { regular: number; elite: number } {
    const row = this.stmt(`SELECT regularUsed, eliteUsed FROM daily_rerolls WHERE playerId = ? AND dayKey = ?`)
      .get(playerId, dayKey) as { regularUsed: number; eliteUsed: number } | undefined;
    return { regular: row?.regularUsed ?? 0, elite: row?.eliteUsed ?? 0 };
  }

  /** Elite missions this player has EVER completed, with what they unlocked. */
  public eliteUnlocks(playerId: string): string[] {
    const rows = this.stmt(`SELECT unlockId FROM elite_completions WHERE playerId = ?`)
      .all(playerId) as { unlockId: string }[];
    return rows.map((r) => r.unlockId);
  }

  /** Today's missions for a player, defaulting to zero progress. */
  public getMissions(playerId: string, now: Date = new Date()): DailyMission[] {
    const dayKey = missionDayKey(now);
    const slots = this.ensureSlots(playerId, dayKey);
    const rows = this.missionRows(playerId, dayKey);
    const owned = new Set(this.eliteUnlocks(playerId));

    return slots
      .map(({ missionId }) => {
        const def = findMission(missionId);
        if (!def) return null;
        const row = rows.get(def.id);
        return {
          id: def.id,
          type: def.type,
          tier: def.tier,
          titleKey: def.titleKey,
          descKey: def.descKey,
          target: def.target,
          xpReward: def.xpReward,
          unlocks: def.unlocks,
          unlockOwned: def.unlocks ? owned.has(def.unlocks) : undefined,
          current: Math.min(def.target, row?.progress ?? 0),
          claimed: !!row?.claimedAt,
        } as DailyMission;
      })
      .filter(Boolean) as DailyMission[];
  }

  /** Rerolls left today, per tier. */
  public rerollsRemaining(playerId: string, now: Date = new Date()): { regular: number; elite: number } {
    const used = this.rerollsUsed(playerId, missionDayKey(now));
    return {
      regular: Math.max(0, REROLLS_REGULAR - used.regular),
      elite: Math.max(0, REROLLS_ELITE - used.elite),
    };
  }

  /**
   * Put the next mission along in this player's deal order into one slot.
   * Skips anything they already hold, and anything they have already finished
   * today — a slot filled with a mission that is complete before it arrives
   * would be dead weight. Returns the new mission id, or null when that pool
   * has nothing left to give.
   */
  private fillSlot(
    playerId: string,
    dayKey: string,
    slot: number,
    tier: 'regular' | 'elite',
    slots: { slot: number; missionId: string }[],
    now: Date = new Date()
  ): string | null {
    const isElite = tier === 'elite';
    const pool = isElite ? ELITE_POOL : MISSION_POOL;
    const order = dealOrder(pool, playerId, dayKey, isElite ? 'elite' : 'regular');
    // Anything may be dealt except what is already on the list and what was
    // dealt in the last few rolls. Finishing a task no longer retires it for
    // the day: one-and-done meant a productive player worked through the pool
    // and a claim then had nothing to hand back, leaving the finished task
    // sitting in its slot. A repeating pool cannot run out.
    const held = new Set(slots.map((sl) => sl.missionId));
    const recent = this.recentlyDealt(playerId, tier);
    const replacement = order.find((id) => !held.has(id) && !recent.has(id));
    // Nothing left to deal: the player has finished everything this tier had
    // for them today. RETIRE the slot rather than leaving what was in it —
    // a task that has been completed and paid is not an active task, and
    // leaving it sitting there marked "claimed" reads as the reroll being
    // broken. getMissions drops a slot it cannot resolve, so the list simply
    // gets shorter and fills up again at the UTC reset.
    //
    // Deliberately blanked rather than DELETEd: ensureSlots treats "no rows
    // for today" as "not dealt yet", so removing the last row outright would
    // deal the player a whole fresh day's tasks.
    this.stmt(`UPDATE daily_mission_slots SET missionId = ? WHERE playerId = ? AND dayKey = ? AND slot = ?`)
      .run(replacement ?? RETIRED_SLOT, playerId, dayKey, slot);
    // A task arriving in a slot starts from zero, whatever it collected the
    // last time it was held.
    if (replacement) this.dealMission(playerId, dayKey, tier, replacement, now);
    return replacement ?? null;
  }

  /**
   * Swap one mission for the next unused one from its own pool, spending a
   * reroll of that tier. A completed mission cannot be rerolled — there is
   * nothing to gain and a reward to lose.
   */
  public rerollMission(
    playerId: string,
    missionId: string,
    now: Date = new Date()
  ): {
    ok: boolean;
    code?: 'MISSION_UNKNOWN' | 'MISSION_NOT_ACTIVE' | 'MISSION_COMPLETE' | 'NO_REROLLS' | 'POOL_EXHAUSTED';
    missions?: DailyMission[];
    rerolls?: { regular: number; elite: number };
    newMissionId?: string;
  } {
    const def = findMission(missionId);
    if (!def) return { ok: false, code: 'MISSION_UNKNOWN' };

    const dayKey = missionDayKey(now);
    const slots = this.ensureSlots(playerId, dayKey);
    const target = slots.find((s) => s.missionId === missionId);
    if (!target) return { ok: false, code: 'MISSION_NOT_ACTIVE' };

    const rows = this.missionRows(playerId, dayKey);
    const row = rows.get(missionId);
    if (row?.claimedAt || (row?.progress ?? 0) >= def.target) {
      return { ok: false, code: 'MISSION_COMPLETE' };
    }

    const used = this.rerollsUsed(playerId, dayKey);
    const isElite = def.tier === 'elite';
    const allowance = isElite ? REROLLS_ELITE : REROLLS_REGULAR;
    if ((isElite ? used.elite : used.regular) >= allowance) return { ok: false, code: 'NO_REROLLS' };

    // The next mission along in this player's deal order — so a reroll always
    // produces something new. Only charged if one was actually found.
    const replacement = this.fillSlot(playerId, dayKey, target.slot, def.tier, slots, now);
    if (!replacement) return { ok: false, code: 'POOL_EXHAUSTED' };

    this.stmt(
        `INSERT INTO daily_rerolls (playerId, dayKey, regularUsed, eliteUsed) VALUES (?, ?, ?, ?)
         ON CONFLICT(playerId, dayKey) DO UPDATE SET
           regularUsed = regularUsed + excluded.regularUsed,
           eliteUsed = eliteUsed + excluded.eliteUsed`
      )
      .run(playerId, dayKey, isElite ? 0 : 1, isElite ? 1 : 0);

    return {
      ok: true,
      missions: this.getMissions(playerId, now),
      rerolls: this.rerollsRemaining(playerId, now),
      newMissionId: replacement,
    };
  }

  /** Advance every mission this match touches. Called from recordMatch only. */
  private advanceMissions(playerId: string, payload: MatchEndPayload, now: Date): void {
    const dayKey = missionDayKey(now);
    const rows = this.missionRows(playerId, dayKey);
    const upsert = this.stmt(
      `INSERT INTO daily_missions (playerId, dayKey, missionId, progress)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(playerId, dayKey, missionId) DO UPDATE SET progress = excluded.progress`
    );
    // Only the missions actually held today advance. Progressing the whole
    // pool would let a rerolled-away mission arrive back half-done.
    for (const { missionId } of this.ensureSlots(playerId, dayKey)) {
      const def = findMission(missionId);
      if (!def) continue;
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
  ): {
    ok: boolean;
    code?: 'MISSION_UNKNOWN' | 'MISSION_INCOMPLETE' | 'MISSION_CLAIMED';
    profile?: PlayerProfile;
    missions?: DailyMission[];
    earnedXp?: number;
    /** Permanent unlock banked by this claim, if it was a first-ever elite. */
    unlocked?: string;
    /** The free replacement dealt into the slot this claim emptied. */
    newMissionId?: string;
  } {
    const def: MissionDef | undefined = findMission(missionId);
    if (!def) return { ok: false, code: 'MISSION_UNKNOWN' };

    const dayKey = missionDayKey(now);
    const row = this.missionRows(playerId, dayKey).get(def.id);
    const progress = row?.progress ?? 0;
    if (row?.claimedAt) return { ok: false, code: 'MISSION_CLAIMED' };
    if (progress < def.target) return { ok: false, code: 'MISSION_INCOMPLETE' };

    // Which slot this task sits in, resolved BEFORE it is stamped claimed:
    // once it is, sweepClaimed would refill the slot on the next read and this
    // claim would have no replacement of its own to report.
    const slots = this.ensureSlots(playerId, dayKey, now);
    const mine = slots.find((sl) => sl.missionId === def.id);

    // Stamp the claim FIRST and only pay out if this call is the one that
    // stamped it, so two concurrent claims cannot both award the reward.
    const stamped = this.stmt(
        `UPDATE daily_missions SET claimedAt = ?
         WHERE playerId = ? AND dayKey = ? AND missionId = ? AND claimedAt IS NULL`
      )
      .run(now.toISOString(), playerId, dayKey, def.id);
    if (!stamped.changes) return { ok: false, code: 'MISSION_CLAIMED' };

    // An elite mission's XP is a daily reward; its unlock is kept for good.
    // Recorded on first completion only, so repeating it later pays the XP
    // again but cannot re-grant something already owned.
    let unlocked: string | undefined;
    if (def.tier === 'elite' && def.unlocks) {
      const banked = this.stmt(
          `INSERT INTO elite_completions (playerId, missionId, unlockId, completedAt)
           VALUES (?, ?, ?, ?) ON CONFLICT(playerId, missionId) DO NOTHING`
        )
        .run(playerId, def.id, def.unlocks, now.toISOString());
      if (banked.changes) unlocked = def.unlocks;
    }

    const profile = this.getProfile(playerId);
    profile.xp += def.xpReward;
    const { level, xpNext } = calculateLevelFromXp(profile.xp);
    profile.level = level;
    profile.xpNext = xpNext;
    profile.lastActive = now.toISOString();
    this.upsertProfile(profile);

    // Finishing a mission hands you another one, free and without limit. The
    // daily allowances exist for missions you did NOT want; completing one is
    // the opposite of that, so it must not cost an allowance — nor is it
    // capped, since every free reroll had to be earned by finishing something.
    // The pool is finite, so an unusually productive day can run it dry; the
    // claimed mission then simply stays in its slot.
    const newMissionId = mine
      ? this.fillSlot(playerId, dayKey, mine.slot, def.tier, slots, now) ?? undefined
      : undefined;

    return {
      ok: true,
      profile: this.readProfile(playerId)!,
      missions: this.getMissions(playerId, now),
      earnedXp: def.xpReward,
      unlocked,
      newMissionId,
    };
  }

  // ---- Avatars: exactly 256x256 PNGs, validated in server/image.ts before
  // they get here. Returns the new avatarVersion (epoch ms cache-buster).
  public setAvatar(playerId: string, data: Uint8Array): number {
    const now = new Date().toISOString();
    this.stmt(
        `INSERT INTO avatars (playerId, data, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(playerId) DO UPDATE SET data=excluded.data, updatedAt=excluded.updatedAt`
      )
      .run(playerId, data, now);
    return Date.parse(now);
  }

  public getAvatar(playerId: string): { data: Uint8Array; updatedAt: string } | null {
    const row = this.stmt('SELECT data, updatedAt FROM avatars WHERE playerId = ?')
      .get(playerId) as unknown as { data: Uint8Array; updatedAt: string } | undefined;
    return row || null;
  }

  public deleteAvatar(playerId: string): void {
    this.stmt('DELETE FROM avatars WHERE playerId = ?').run(playerId);
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
      eliteUnlocks: this.eliteUnlocks(p.id),
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
      winStreak: 0,
      bestWinStreak: 0,
      shutoutsWon: 0,
      rookieWins: 0,
      proWins: 0,
      eliteWins: 0,
      cyberWins: 0,
      chaosWins: 0,
      abandons: 0,
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

  /**
   * Seed the curated bot roster, once per database.
   *
   * A launched deployment has no players and the boards refuse rows of zeros,
   * so the leaderboard opened empty — and stayed close to empty long enough
   * for the ladder to be invisible to exactly the players deciding whether to
   * climb it. Bot rows carry `rank: null` and never shift a human's number,
   * which is what makes them safe to show at all.
   *
   * One-shot and flagged, like every other migration here: re-running is a
   * no-op, so a restart cannot resurrect a bot an operator deleted on purpose.
   *
   * A roster name may already be held by a human on an existing deployment —
   * the username index is unique and case-insensitive, so inserting would
   * throw. That is per-bot recoverable and must never take the boot down with
   * it: the collision is skipped and named in the log, the rest of the roster
   * still lands, and the flag is still stamped so this does not retry forever.
   */
  public seedBotRoster(roster: BotSeed[]): { inserted: number; skipped: string[] } {
    const KEY = 'bot_roster_v1';
    if (this.getMeta(KEY)) return { inserted: 0, skipped: [] };
    let inserted = 0;
    const skipped: string[] = [];
    for (const bot of roster) {
      try {
        this.insertBot(botProfileFields(bot));
        inserted++;
      } catch (e: any) {
        skipped.push(`${bot.username} (${e?.message || 'insert failed'})`);
      }
    }
    this.setMeta(KEY, new Date().toISOString());
    if (inserted) console.log(`bot_roster_v1: seeded ${inserted} bot(s) onto the leaderboard`);
    if (skipped.length) console.log(`bot_roster_v1: skipped ${skipped.length} — ${skipped.join(', ')}`);
    return { inserted, skipped };
  }

  public recordMatch(
    payload: MatchEndPayload,
    context: RecordMatchContext = {},
    now: Date = new Date()
  ): MatchEndResult {
    const opponentRating = context.opponentRating;
    const performance = context.performanceWeight ?? 1;
    const profile = this.getProfile(payload.playerId);
    // Names come from the profile, never the payload — backstop for the
    // route-level 403 so no code path records under an unclaimed identity.
    if (!profile.initializedAt) {
      throw new Error('PROFILE_NOT_INITIALIZED');
    }
    // A match carries an identity now, and the same match can legitimately be
    // reported more than once: the relay records a finished duel for both
    // seats, each phone POSTs its own copy, a failed POST is retried, and a
    // queued one is replayed on the next load. Paying only the first is what
    // lets every one of those paths run without anybody being paid twice.
    const matchKey = payload.matchKey ? String(payload.matchKey).slice(0, 120) : '';
    if (matchKey) {
      const seen = this.replayRecordedMatch(payload.playerId, matchKey, now);
      if (seen) return seen;
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
    // Coerced, not trusted. A client that omits the field — an older bundle
    // mid-deploy, or a malformed POST — used to reach matchXp with undefined,
    // which multiplies to NaN, lands NaN in profile.xp and only surfaces as
    // "NOT NULL constraint failed: players.xp" from a write three functions
    // later. Everything else read off the payload is bounded; this is too.
    const bound = (v: unknown): number => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) ? Math.max(0, Math.min(100000, n)) : 0;
    };
    const bestStreak = bound(payload.bestStreak);
    payload.bestStreak = bestStreak;
    // The run cannot end higher than it ever reached.
    const endStreak = Math.min(bound(payload.endStreak), bestStreak);
    payload.endStreak = endStreak;
    // Nor can a match have EARNED more than it reached. This is the number XP
    // is paid on: bestStreak opens on whatever was carried in, so paying on
    // that would pay for the same run again in every match it spans.
    const earnedStreak = Math.min(bound(payload.earnedStreak), bestStreak);
    payload.earnedStreak = earnedStreak;

    let earnedXp = matchXp({
      playerScore: payload.playerScore,
      bestStreak: earnedStreak,
      won: isWin,
      winProb,
      mode: payload.mode,
    });
    // Solo only: consecutive-win momentum ramps the payout toward a hard
    // per-match cap, and same-day solo volume decays it toward a floor — see
    // the design note beside soloAdjustedXp in rating.ts. Both inputs are the
    // state BEFORE this match: the win streak the player walked in on (the
    // same convention the rally carry uses, and what makes a loss ending a
    // long run pay more than an early one) and the solo games already
    // recorded today. PvP is deliberately untouched.
    if (payload.mode === 'solo') {
      earnedXp = soloAdjustedXp(
        earnedXp,
        this.soloWinStreak(payload.playerId),
        this.soloGamesToday(payload.playerId, now)
      );
    }
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
    // `forceUnranked` is the relay's own override for a forgiven abandon's
    // loss — trusted because it comes from server code, never a request.
    const ranked = !context.forceUnranked && isRankedRules(payload.rules);
    const previousTier = profile.tier;
    const soloOpts = {
      ...SOLO_UPDATE,
      // A solo win can't push mu past the hardest that difficulty ever plays:
      // farming one rung converges on it and stops. A constant per difficulty,
      // never anything derived from the player's own mu — a cap that rose with
      // the player would chase them upward without bound.
      cap: soloMuCap(difficulty),
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

    // The visible ladder moves on a duel, and on a solo match at a difficulty
    // the player had to EARN. Rookie is the tutorial rung — placing against it
    // would be a formality — so it feeds hidden MMR only.
    const ranksThisMatch = ranked && (isPvp || soloCountsForRank(difficulty));
    // Sampled before the update so the overlay can say which way the ladder
    // went. Only the DIRECTION ever leaves the server — the mu itself is not
    // something the client renders (see src/components/ui/RankBadge.tsx).
    const rankMuBefore = profile.rankMu;
    if (ranksThisMatch) {
      // While still unplaced, a ranked match sheds uncertainty faster — the
      // whole point of placement matches, and what makes the profile screen's
      // "N/PLACEMENT_GAMES" the truth rather than the first of two conditions.
      const placing = profile.rankedGames < PLACEMENT_GAMES;
      const placementOpts = placing ? PLACEMENT_UPDATE : PVP_UPDATE;
      const rankOpts = isPvp
        ? { ...placementOpts, performance }
        : {
            // Lighter on mu than a duel — beating an AI says less than beating
            // a person — and held under the same ceiling every solo result is,
            // so farming a rung converges on it and stops.
            k: SOLO_UPDATE.k,
            cap: soloMuCap(difficulty),
            // Sigma converges at the SAME rate as a duel's, deliberately:
            // placement counts observations, not opponents. Shrinking it
            // slower would land a solo player on "5/5" and still unranked —
            // the exact trap placement was just fixed for.
            sigmaScale: placementOpts.sigmaScale,
          };
      const nextRank = updateRating(
        { mu: profile.rankMu, sigma: profile.rankSigma },
        oppRating,
        isWin,
        rankOpts
      );
      profile.rankMu = nextRank.mu;
      profile.rankSigma = nextRank.sigma;
      profile.rankedGames += 1;
    }
    profile.tier = tierFor(profile.rankMu, profile.rankedGames, profile.rankSigma);
    // 'none' is both "did not rate" and "rated and did not move" — from the
    // player's side those are the same fact, and the overlay says so with one
    // glyph rather than distinguishing a difference nobody can act on.
    const rankDirection: RankDirection = !ranksThisMatch
      ? 'none'
      : profile.rankMu > rankMuBefore + 1e-9
        ? 'up'
        : profile.rankMu < rankMuBefore - 1e-9
          ? 'down'
          : 'none';

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
    // The same result, kept per mode as well as pooled — written down in the
    // transaction below rather than here. It is the one write in this function
    // with no ceiling of its own: mission progress caps at its target and the
    // profile is upserted whole, but matchesPlayed and the rest only ever add,
    // so a bump that landed while the match went unstamped would be counted
    // again by the retry, and again by the one after that.
    const modeDelta = {
      played: 1,
      won: isWin,
      pointsScored: payload.playerScore,
      aces: Math.max(0, Math.min(payload.playerScore, Math.round(payload.aces || 0))),
      bestStreak: payload.bestStreak,
      endStreak,
      // How long ago this match ended, by the reporting device's own clock —
      // the gap between the whistle and the moment this attempt went out. A
      // result that queued through a replay therefore says so and does not
      // land back on top of a newer one. Absent (an older client, or a payload
      // the relay built itself) means "just now".
      ageMs: resultAgeMs(payload),
      // This browser's own chain position, for the writes the age cannot
      // order — see the note beside `stamp` in bumpModeStats.
      chainId: payload.chainId,
      runSeq: payload.runSeq,
    };
    // Streaks, shutouts and per-difficulty wins are derived here and only
    // here, from the result the server just accepted — a client can report a
    // match, never a total.
    profile.winStreak = isWin ? profile.winStreak + 1 : 0;
    if (profile.winStreak > profile.bestWinStreak) profile.bestWinStreak = profile.winStreak;
    const cleanSheet = isWin && payload.opponentScore === 0 && payload.playerScore >= 5;
    if (cleanSheet) profile.shutoutsWon += 1;
    if (isWin && payload.mode === 'solo') {
      if (difficulty === 'rookie') profile.rookieWins += 1;
      else if (difficulty === 'pro') profile.proWins += 1;
      else if (difficulty === 'elite') profile.eliteWins += 1;
      else if (difficulty === 'cyber') profile.cyberWins += 1;
      else if (difficulty === 'chaos') profile.chaosWins += 1;
    }
    // The career best rally STREAK — this player's own consecutive returns,
    // never the opponent's, and never a whole point's worth of both.
    if (payload.bestStreak > profile.highestRally) {
      profile.highestRally = payload.bestStreak;
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
    // Gates are measured against the profile as it stands when the batch
    // lands — after this match's own XP and tier update, the same instant the
    // achievement budget is measured at.
    const progress = { level: profile.level, tier: profile.tier };
    const unlock = (achId: string) => {
      if (!isUnlockable(achId, profile.achievements, progress)) return;
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
    // Finishing a match at all. This used to read `payload.maxRally >= 1`,
    // which under the shared counter was true of anyone who had touched the
    // ball once. A streak is one player's own returns now, so a player who
    // never returns a single ball has a best streak of zero — and first_serve
    // is what opens `mode:multiplayer`, so keying it on that would have left
    // them unable to reach a duel at all.
    unlock('first_serve');
    if (isWin) unlock('first_win');
    if (shutOut) unlock('shutout');
    if (profile.matchesPlayed >= 10) unlock('veteran_10');
    if (profile.matchesPlayed >= 50) unlock('veteran_50');
    if (profile.matchesPlayed >= 200) unlock('veteran_200');
    if (profile.level >= 5) unlock('level_5');

    // Rally. Measured on the profile's banked best, not this match's rally,
    // so a feat performed before a gate opened is not lost — the rung lands
    // on the first match after the gate is met.
    // Rescaled by 0.72 with the counting change: a rally number is one
    // player's own consecutive returns now rather than a whole point's worth
    // of both players', which measures about 0.72x the old figure across the
    // ladder and both winning scores. These rungs are therefore as far away as
    // they always were.
    if (profile.highestRally >= 7) unlock('rally_10');
    if (profile.highestRally >= 18) unlock('rally_25');
    if (profile.highestRally >= 36) unlock('rally_50');
    if (profile.highestRally >= 72) unlock('rally_100');
    if (profile.highestRally >= 108) unlock('rally_150');

    // Ladder. The rungs fire in order so a single result can climb a chain
    // it genuinely satisfies, and each one opens the next.
    if (isWin && solo && difficulty === 'rookie') unlock('ai_rookie');
    if (profile.rookieWins >= 10) unlock('ai_rookie_10');
    if (isWin && solo && difficulty === 'pro') unlock('ai_pro');
    if (profile.proWins >= 10) unlock('ai_pro_10');
    if (isWin && solo && difficulty === 'elite') unlock('ai_elite');
    if (profile.eliteWins >= 10) unlock('ai_elite_10');
    if (isWin && solo && difficulty === 'cyber') unlock('cyber_slayer');
    if (shutOut && solo && difficulty === 'cyber') unlock('cyber_shutout');
    if (profile.cyberWins >= 10) unlock('cyber_10');
    if (isWin && solo && difficulty === 'chaos') unlock('ai_chaos');
    if (profile.chaosWins >= 10) unlock('chaos_10');

    // Duel
    if (pvp) unlock('first_duel');
    if (isWin && pvp) unlock('multiplayer_champ');
    if (shutOut && pvp) unlock('duel_shutout');
    if (profile.multiplayerWins >= 10) unlock('duel_10');
    if (profile.multiplayerWins >= 50) unlock('duel_50');

    // Craft
    if (profile.totalAces >= 1) unlock('first_ace');
    if (profile.totalAces >= 5) unlock('ace_sniper');
    if (profile.totalAces >= 25) unlock('ace_25');
    if (profile.totalAces >= 100) unlock('ace_100');
    if (profile.totalPointsScored >= 100) unlock('points_100');
    if (profile.totalPointsScored >= 500) unlock('points_500');
    if (profile.totalPointsScored >= 2000) unlock('points_2000');

    // Ascent — the ranked ladder, concealed until a first duel has happened.
    if (placed) unlock('placed');
    if (placed && profile.rankMu >= 22) unlock('tier_vanguard');
    if (placed && profile.rankMu >= 25) unlock('tier_ace');
    if (placed && profile.rankMu >= 28) unlock('master_tier');
    if (placed && profile.rankMu >= 31) unlock('tier_grandmaster');
    if (placed && profile.rankMu >= 34) unlock('legend_tier');
    if (placed && profile.rankMu >= 37) unlock('tier_overlord');

    // Dominion — winning, and winning without giving anything back.
    if (profile.bestWinStreak >= 3) unlock('streak_3');
    if (profile.bestWinStreak >= 5) unlock('streak_5');
    if (profile.bestWinStreak >= 10) unlock('streak_10');
    if (profile.shutoutsWon >= 5) unlock('shutout_5');
    if (profile.shutoutsWon >= 15) unlock('shutout_15');

    // Devotion — the long haul, concealed until level 5.
    if (profile.level >= 10) unlock('level_10');
    if (profile.level >= 25) unlock('level_25');
    if (profile.level >= 50) unlock('level_50');
    if (profile.dailyStreak >= 3) unlock('daily_3');
    if (profile.dailyStreak >= 7) unlock('streak_7');
    if (profile.dailyStreak >= 30) unlock('daily_30');

    // Daily mission progress rides the same server-verified match record, so
    // it can never be reported independently of an actual game.
    this.advanceMissions(payload.playerId, payload, now);

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
      maxRally: payload.bestStreak,
      mode: payload.mode,
      difficulty: payload.mode === 'solo' ? difficulty : payload.difficulty,
      timestamp: new Date().toISOString(),
      // Persisted so history can tell Ranked from Un-Ranked later: this is
      // ranksThisMatch — the match actually moved the visible ladder — not
      // merely "the rules sat in the ranked bands". A stock-rules Rookie solo
      // stores 0, because it rated nothing, whatever its rules were.
      ranked: ranksThisMatch ? 1 : 0,
    };

    const result: MatchEndResult = {
      profile,
      earnedXp,
      leveledUp,
      winProbability: winProb,
      previousTier: ranksThisMatch ? previousTier : null,
      tier: ranksThisMatch ? profile.tier : null,
      tierChanged: ranksThisMatch && profile.tier !== previousTier,
      ranked,
      rankDirection,
      newAchievements,
      missions: this.getMissions(payload.playerId, now),
    };

    this.sql.exec('BEGIN');
    try {
      this.bumpModeStats(profile.id, payload.mode, modeDelta);
      // The fatigue tally rides the same transaction and the same idempotency
      // as everything else here: this line is only reached when the matchKey
      // is unstamped, so a replayed match no more double-counts a day's games
      // than it double-pays.
      if (payload.mode === 'solo') this.bumpSoloGames(payload.playerId, now);
      // Read back what that just wrote, from inside the transaction that wrote
      // it. `profile` was loaded before the bump, so its per-mode snapshot is
      // the one from BEFORE this match — and it is the object handed to the
      // client in MatchEndResult, which installs it whole. Left stale, the
      // first match's row was missing entirely and every later one was a match
      // behind for the rest of the page session. `result` holds this same
      // object, so the stamp below records the fresh rows too.
      profile.modeStats = this.getModeStats(profile.id);
      this.upsertProfile(profile);
      this.insertMatch(matchRecord); // carries its own per-player retention trim
      // Same transaction as the payout: a match is either paid and marked, or
      // neither. Marked outside it, a crash between the two would leave the
      // key claimed and the XP never awarded.
      if (matchKey) this.stampRecordedMatch(payload.playerId, matchKey, result, now);
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }

    return result;
  }

  /**
   * The stored outcome of a match already recorded under `matchKey`, or null.
   *
   * The profile and today's missions are re-read live rather than replayed
   * from the stored blob: the caller is showing the player where they stand
   * NOW, and matches recorded since would make a frozen snapshot a lie. What
   * IS replayed is what this particular match did — its XP, its level-up, its
   * achievements — so a retry and the original agree.
   */
  private replayRecordedMatch(playerId: string, matchKey: string, now: Date): MatchEndResult | null {
    const row = this.stmt('SELECT result FROM recorded_matches WHERE playerId = ? AND matchKey = ?')
      .get(playerId, matchKey) as unknown as { result: string } | undefined;
    if (!row) return null;
    let stored: Partial<MatchEndResult>;
    try {
      stored = JSON.parse(row.result);
    } catch {
      stored = {};
    }
    return {
      earnedXp: 0,
      leveledUp: false,
      winProbability: 0.5,
      previousTier: null,
      tier: null,
      tierChanged: false,
      ranked: false,
      rankDirection: 'none',
      newAchievements: [],
      ...stored,
      profile: this.readProfile(playerId)!,
      missions: this.getMissions(playerId, now),
      alreadyRecorded: true,
    };
  }

  /** Mark `matchKey` paid, keeping what it paid so a replay can be answered. */
  private stampRecordedMatch(
    playerId: string,
    matchKey: string,
    result: MatchEndResult,
    now: Date
  ): void {
    // profile and missions are deliberately dropped: they are snapshots of the
    // whole account, not of this match, and replayRecordedMatch re-reads them.
    const { profile: _p, missions: _m, ...match } = result;
    this.stmt(
        `INSERT INTO recorded_matches (playerId, matchKey, recordedAt, result)
         VALUES (?, ?, ?, ?) ON CONFLICT(playerId, matchKey) DO NOTHING`
      )
      .run(playerId, matchKey, now.toISOString(), JSON.stringify(match));
    // Dedupe only has to outlive the paths that can replay a match: a retry,
    // a relay record racing a client POST, and a queue parked on a device
    // until its next load. A fortnight covers all three without the table
    // growing for the life of the database.
    const cutoff = new Date(now.getTime() - RECORDED_MATCH_TTL_MS).toISOString();
    this.stmt('DELETE FROM recorded_matches WHERE recordedAt < ?').run(cutoff);
  }

  // ---- Device sessions ---------------------------------------------------
  //
  // An account is held by exactly one session at a time. Anything else was
  // the exploit: two devices, one account, two matches at once, and whichever
  // of them was no longer the owner finding out only when its finished match
  // was refused.

  /** The session id that currently owns `playerId`, or null if none does. */
  public activeSessionId(playerId: string): string | null {
    const row = this.stmt('SELECT activeSessionId FROM players WHERE id = ?').get(playerId) as
      | { activeSessionId: string | null }
      | undefined;
    return row?.activeSessionId || null;
  }

  /**
   * Hand `playerId` to `sessionId`, displacing whoever held it. The newest
   * load wins deliberately: the player is at the device they just opened, so
   * that is the one that should keep playing, and the other learns it has been
   * displaced at its next heartbeat rather than at the end of its match.
   */
  public adoptSession(playerId: string, sessionId: string, now: Date = new Date()): void {
    this.stmt('UPDATE players SET activeSessionId = ?, activeSessionAt = ? WHERE id = ?')
      .run(sessionId, now.toISOString(), playerId);
  }

  /** Give up ownership, if this session is the one holding it. */
  public endSession(playerId: string, sessionId: string): void {
    this.stmt('UPDATE players SET activeSessionId = NULL WHERE id = ? AND activeSessionId = ?')
      .run(playerId, sessionId);
  }

  /**
   * What happened to a device that no longer resolves to a profile: null if
   * the server has simply never seen it, or the transfer that retired it.
   * The difference matters — the first is a new player, the second is a
   * player whose account is alive and well on another device, and telling
   * them apart is what lets the second be told so instead of silently
   * re-minted as a stranger.
   */
  public releasedDevice(deviceId: string): { movedToPlayerId: string; releasedAt: string } | null {
    const row = this.stmt('SELECT movedToPlayerId, releasedAt FROM released_devices WHERE deviceId = ?')
      .get(deviceId) as { movedToPlayerId: string; releasedAt: string } | undefined;
    return row || null;
  }

  /** Forget a release, because this device holds a live account again. */
  public clearDeviceRelease(deviceId: string): void {
    this.stmt('DELETE FROM released_devices WHERE deviceId = ?').run(deviceId);
  }

  /**
   * The account this browser belongs to, and where that account currently
   * lives — or null if this browser has never signed in to one.
   *
   * `holdsIt` is the whole point: a linked browser that is NOT holding the
   * account is a known browser of it, not a stranger. It gets offered the
   * account back rather than a fresh empty profile.
   */
  public linkedAccount(deviceId: string): { playerId: string; holdsIt: boolean } | null {
    const row = this.stmt('SELECT playerId FROM device_links WHERE deviceId = ?').get(deviceId) as
      | { playerId: string }
      | undefined;
    if (!row) return null;
    return { playerId: row.playerId, holdsIt: row.playerId === deviceId };
  }

  /** Add a browser to an account's set. Idempotent. */
  public linkDevice(deviceId: string, playerId: string, now: Date = new Date()): void {
    this.stmt(
      'INSERT OR REPLACE INTO device_links (deviceId, playerId, linkedAt) VALUES (?, ?, ?)'
    ).run(deviceId, playerId, now.toISOString());
  }

  /** Every browser signed in to this account, newest link first. */
  public linkedDevices(playerId: string): Array<{ deviceId: string; linkedAt: string }> {
    return this.stmt(
      'SELECT deviceId, linkedAt FROM device_links WHERE playerId = ? ORDER BY linkedAt DESC'
    ).all(playerId) as unknown as Array<{ deviceId: string; linkedAt: string }>;
  }

  /**
   * Bring an account back to a browser that is already signed in to it.
   *
   * No code is asked for, and deliberately: presenting the device cookie of a
   * linked browser IS the credential, exactly as it is for the browser
   * currently holding the account. The code is what gets a browser INTO the
   * set; membership is what lets it take its turn afterwards. Returns null if
   * this device is not linked, or the account has since gone.
   */
  public reclaimLinkedAccount(deviceId: string, sessionId: string | null): PlayerProfile | null {
    const link = this.linkedAccount(deviceId);
    if (!link) return null;
    if (link.holdsIt) return this.readProfile(deviceId);
    const row = this.stmt('SELECT id FROM players WHERE id = ?').get(link.playerId) as
      | { id: string }
      | undefined;
    if (!row) return null;
    return this.moveAccount(link.playerId, deviceId, sessionId);
  }

  /**
   * Move an account's row onto `newDeviceId`, carrying everything that keys
   * off the id with it, and record both browsers as belonging to it.
   *
   * Extracted from claimProfileByCode so the code path and the no-code
   * reclaim below cannot drift: a move that updated matches but forgot the
   * links, or tombstoned a browser that is a member of the account, is the
   * class of bug this whole area keeps producing.
   */
  private moveAccount(
    fromId: string,
    newDeviceId: string,
    sessionId: string | null
  ): PlayerProfile | null {
    const now = new Date().toISOString();
    this.sql.exec('BEGIN');
    try {
      // A placeholder row on the claiming device is in the way and carries
      // nothing; server.ts refuses the sign-in outright if it is initialized,
      // so nothing with a username or progress is ever dropped here.
      this.stmt('DELETE FROM players WHERE id = ?').run(newDeviceId);
      this.stmt(
          `UPDATE players
              SET id = ?, lastActive = ?, activeSessionId = ?, activeSessionAt = ?
            WHERE id = ?`
        )
        .run(newDeviceId, now, sessionId, now, fromId);
      this.stmt('UPDATE matches SET player1Id = ? WHERE player1Id = ?').run(newDeviceId, fromId);
      this.stmt('UPDATE matches SET player2Id = ? WHERE player2Id = ?').run(newDeviceId, fromId);
      this.stmt('UPDATE matches SET winnerId = ? WHERE winnerId = ?').run(newDeviceId, fromId);
      // Every playerId-keyed table follows the account — the same list
      // deleteAccount walks, for the same reason: a rename is a statement
      // about every table that keys off the id, and each one left behind is
      // its own bug. This used to move only avatars and player_mode_stats,
      // and the orphans were not litter: `recorded_matches` left behind meant
      // every idempotency stamp was lost on a sign-in, so a queued, retried
      // or relay-vs-POST duplicate of a match the account already played was
      // paid a SECOND time — XP, matchesPlayed, wins and rankedGames all
      // double-counted. `elite_completions` left behind silently took back
      // permanent theme unlocks; the daily tables reset mission progress,
      // reroll spend, the abandon forgiveness and the practice XP cap.
      // The DELETE is load-bearing, not tidiness: several of these have
      // composite primary keys on playerId, so rows a placeholder profile
      // wrote on this browser would collide with the rows moving in.
      // (Identifiers come from the exported `as const` list, not from input.)
      for (const table of PLAYER_KEYED_TABLES) {
        this.stmt(`DELETE FROM ${table} WHERE playerId = ?`).run(newDeviceId);
        this.stmt(`UPDATE ${table} SET playerId = ? WHERE playerId = ?`).run(newDeviceId, fromId);
      }
      // Everything already pointed at the account follows it, and both ends of
      // the move are members from here on.
      this.stmt('UPDATE device_links SET playerId = ? WHERE playerId = ?').run(newDeviceId, fromId);
      for (const id of [fromId, newDeviceId]) {
        this.stmt('INSERT OR REPLACE INTO device_links (deviceId, playerId, linkedAt) VALUES (?, ?, ?)')
          .run(id, newDeviceId, now);
      }
      // The browser handing the account over is a MEMBER now, not a stranger,
      // so it must not be tombstoned: `released` is the state whose only exit
      // used to be destroying the account. A linked browser resolves as
      // `superseded` instead, which has always had a way back.
      this.stmt('DELETE FROM released_devices WHERE deviceId = ?').run(fromId);
      this.stmt('DELETE FROM released_devices WHERE deviceId = ?').run(newDeviceId);
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
    return this.readProfile(newDeviceId);
  }

  /**
   * Erase an account and everything keyed on it. Permanent, deliberately.
   *
   * This is the one destructive thing a player can do to themselves, so it has
   * to be the complete one. `moveAccount` above is the same rule with a softer
   * edge — a rename is a statement about every table that keys off the id, and
   * a delete is that statement with nowhere for a missed row to go. Two of
   * them bite rather than merely litter:
   *
   *  - `device_links`. A surviving row reads as "linked, not holding" in
   *    resolveSession, which is `superseded` — so another of this player's
   *    browsers would meet a full-screen wall saying the account is live
   *    somewhere else, about an account that no longer exists anywhere. wipe_v1
   *    shipped without dropping this table and learned it the same way.
   *  - `released_devices`, for the same reason one step removed: a tombstone
   *    pointing at a deleted account leaves a browser walled off with a
   *    recovery code that can no longer match anything.
   *
   * `matches` is handled apart from the list because those rows are not all
   * this player's. Every seat files its OWN row (recordMatch writes the
   * reporter as player1), so a duel produces two and the second one is the
   * opponent's record of a game they played. Deleting it would take that game
   * out of their history while their career counters — which are not derived
   * from this table — went on counting it. Their rows stay; only the pointers
   * into this account are scrubbed.
   *
   * The username goes back into the pool as a side effect of the row going:
   * the unique index covers initialized rows only.
   *
   * Returns the browsers that belonged to the account so the caller can shut
   * their sockets. The relay records duels itself, and a phone must not be
   * left playing on an account that is no longer there.
   */
  public deleteAccount(playerId: string): { deleted: boolean; username: string | null; devices: string[] } {
    const row = this.stmt('SELECT id, username FROM players WHERE id = ?').get(playerId) as
      | { id: string; username: string }
      | undefined;
    if (!row) return { deleted: false, username: null, devices: [] };
    // The holder's own id IS the account id, and it may or may not have a
    // link row of its own (an account that never signed in anywhere has none).
    const devices = new Set<string>([playerId, ...this.linkedDevices(playerId).map((d) => d.deviceId)]);

    this.sql.exec('BEGIN');
    try {
      for (const table of PLAYER_KEYED_TABLES) {
        this.stmt(`DELETE FROM ${table} WHERE playerId = ?`).run(playerId);
      }
      this.stmt('DELETE FROM players WHERE id = ?').run(playerId);
      // Both directions, and every browser: the rows naming this account, and
      // any naming one of the browsers that belonged to it.
      this.stmt('DELETE FROM device_links WHERE playerId = ?').run(playerId);
      this.stmt('DELETE FROM released_devices WHERE movedToPlayerId = ?').run(playerId);
      for (const id of devices) {
        this.stmt('DELETE FROM device_links WHERE deviceId = ?').run(id);
        this.stmt('DELETE FROM released_devices WHERE deviceId = ?').run(id);
      }
      // This account's own history goes first, so the scrub below cannot spend
      // itself on rows that are already on their way out.
      this.stmt('DELETE FROM matches WHERE player1Id = ?').run(playerId);
      this.stmt('UPDATE matches SET player2Id = ?, player2Name = ? WHERE player2Id = ?')
        .run(DELETED_PLAYER_ID, DELETED_PLAYER_NAME, playerId);
      this.stmt('UPDATE matches SET winnerId = ?, winnerName = ? WHERE winnerId = ?')
        .run(DELETED_PLAYER_ID, DELETED_PLAYER_NAME, playerId);
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
    return { deleted: true, username: row.username, devices: [...devices] };
  }

  /** Mint a new sign-in code for an account, retiring the old one. */
  public rotateRecoveryCode(playerId: string): string | null {
    const code = this.newRecoveryCode();
    const res = this.stmt('UPDATE players SET recoveryCode = ? WHERE id = ?').run(code, playerId);
    return res.changes ? code : null;
  }

  /**
   * Sign in to the account owning `code` on this browser.
   *
   * This used to be a one-way TRANSFER: the row moved, the losing browser was
   * tombstoned as `released`, and the code rotated so it could never be used
   * again. Every part of that fought the thing players actually need. An
   * invitation tapped in Messenger opens a webview that is not the browser
   * the account was made in, so "sign in over there" is the normal case, not
   * an emergency — and under the old rules doing it cost the player their real
   * browser and burned the only credential that could undo it.
   *
   * So: the row still moves (players.id IS a device id), but both browsers are
   * recorded as belonging to the account, nothing is tombstoned, and the code
   * is NOT spent. It is a sign-in credential the player keeps, and any browser
   * that has used it can take the account back with no code at all.
   *
   * Returns null when the code matches nothing.
   */
  /** The account a sign-in code belongs to, without moving anything. */
  public profileByRecoveryCode(code: string): { id: string } | null {
    const canonical = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const formatted =
      canonical.length === 8 ? `${canonical.slice(0, 4)}-${canonical.slice(4)}` : code.trim().toUpperCase();
    const row = this.stmt('SELECT id FROM players WHERE recoveryCode = ?').get(formatted) as
      | { id: string }
      | undefined;
    return row || null;
  }

  public signInWithCode(
    code: string,
    newDeviceId: string,
    claimingSessionId: string | null = null
  ): PlayerProfile | null {
    const canonical = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const formatted =
      canonical.length === 8 ? `${canonical.slice(0, 4)}-${canonical.slice(4)}` : code.trim().toUpperCase();
    const row = this.stmt('SELECT id FROM players WHERE recoveryCode = ?').get(formatted) as
      | { id: string }
      | undefined;
    if (!row) return null;
    if (row.id === newDeviceId) {
      // Already here. Make sure the membership is recorded even so — an
      // account created before device_links existed has no row for the very
      // browser holding it, and would otherwise be a stranger to itself the
      // first time it signed in somewhere else.
      this.linkDevice(newDeviceId, newDeviceId);
      return this.readProfile(newDeviceId);
    }
    return this.moveAccount(row.id, newDeviceId, claimingSessionId);
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
      // Placed players first, then by visible rating. The placement test is
      // the same pair of conditions tierFor applies — from the constants, so
      // a rebalance of either cannot leave this ORDER BY sorting stale rules.
      elo: `(rankedGames >= ${PLACEMENT_GAMES} AND rankSigma <= ${PLACEMENT_SIGMA}) DESC, rankMu DESC`,
    }[sortBy];

    // A board only lists players with progress on the thing IT measures.
    // Rows of zeros are noise: a freshly onboarded profile is not "last
    // place", it simply is not on the board yet — and the skill board is a
    // PvP ladder, so a solo-only career belongs on the level, wins and rally
    // boards instead. Bots are exempt: they are a curated roster, inserted
    // deliberately, not idle players.
    const progress = {
      level: 'p.xp > 0',
      rally: 'p.highestRally > 0',
      wins: 'p.matchesWon > 0',
      elo: 'p.rankedGames > 0',
    }[sortBy];

    // Only initialized profiles compete — players who never finished
    // onboarding hold placeholder names and stay invisible.
    const rows = this.stmt(
        `SELECT p.*, a.updatedAt AS avatarUpdatedAt
           FROM players p LEFT JOIN avatars a ON a.playerId = p.id
          WHERE p.initializedAt IS NOT NULL
            AND (${progress} OR p.id LIKE 'bot-%')
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
    // player1 only, deliberately. Every seat of a duel files its OWN row with
    // itself as player1 (see recordMatch), so the player's own filed row is
    // the complete, correctly-oriented record of that match — reading the
    // player2 column as well matched the OPPONENT's copy too, and every duel
    // showed up twice: two WIN cards for the winner, two LOSS cards for the
    // loser. player2Id still matters to deleteAccount's pointer scrub and
    // moveAccount's re-key; it just isn't a history membership test.
    return this.stmt(
        'SELECT * FROM matches WHERE player1Id = ? ORDER BY rowid DESC LIMIT ?'
      )
      .all(playerId, limit) as unknown as MatchRecord[];
  }

  /**
   * One page of a player's history, filtered the way the history UI filters:
   * by mode, and inside a mode by whether the match counted for rank.
   *
   * Same ownership rule as getMatchHistory — player1 only, the rows this
   * player filed themselves. `total` counts the SAME filter, so the caller
   * can page without a second query shape to keep in agreement. A NULL
   * `ranked` (a row from before the column existed) is deliberately folded
   * into 'unranked': ranked-ness cannot be reconstructed for those rows, and
   * a filter that hid them from both sub-tabs would make matches vanish the
   * moment a filter is touched.
   */
  public getMatchHistoryPage(
    playerId: string,
    opts: {
      mode?: 'multiplayer' | 'solo' | 'practice';
      ranked?: 'ranked' | 'unranked';
      limit?: number;
      offset?: number;
    } = {}
  ): { matches: MatchRecord[]; total: number } {
    const where: string[] = ['player1Id = ?'];
    const binds: Array<string | number> = [playerId];
    if (opts.mode) {
      where.push('mode = ?');
      binds.push(opts.mode);
    }
    if (opts.ranked === 'ranked') where.push('ranked = 1');
    else if (opts.ranked === 'unranked') where.push('(ranked IS NULL OR ranked = 0)');
    const cond = where.join(' AND ');

    const total = (
      this.stmt(`SELECT COUNT(*) AS n FROM matches WHERE ${cond}`).get(...binds) as { n: number }
    ).n;
    const limit = Math.max(1, Math.min(50, Math.floor(opts.limit ?? 10)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const matches = this.stmt(
        `SELECT * FROM matches WHERE ${cond} ORDER BY rowid DESC LIMIT ? OFFSET ?`
      )
      .all(...binds, limit, offset) as unknown as MatchRecord[];
    return { matches, total };
  }
}

export const db = new GameDatabase();
