import { AnimatePresence, motion } from 'motion/react';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  BallState,
  AIDifficulty,
  GameMode,
  GameSettings,
  PlayerStats,
  WSClientMessage,
  WSServerMessage,
  PlayerProfile,
  Achievement,
  MatchEndResult,
  MatchEndPayload,
  RankDirection,
  RankMagnitude,
  PlayerStatus,
  DailyMission,
  LanguageCode,
  MatchRules,
  CosmeticId,
  RoomMatchConfig,
  TableSeat,
  TableSeatInfo,
} from './types';
import { P2PGameLink, P2PStatus } from './net/p2p';
import { QuickMatch, useQuickMatch } from './net/useQuickMatch';
import { postMatchRecord, flushPendingMatches, clearPendingMatches } from './net/matchRecord';
import { nextRunSeq } from './net/runChain';
import { relayErrorText } from './net/relayErrors';
import {
  COSMETICS,
  COSMETIC_IDS,
  Cosmetic,
  DEFAULT_COSMETIC_ID,
  cosmeticVars,
  isCosmeticUnlocked,
  normalizeCosmeticId,
} from './game/cosmetics';
import {
  PADDLE_Y,
  SERVE_BALL_Y,
  PADDLE_HEIGHT,
  PADDLE_WIDTH_RATIO,
  BALL_BASE_RADIUS,
  BASE_BALL_SPEED,
  physicsSubsteps,
  bounceOffReturnLine,
  checkPaddleCollision,
  OpponentAI,
  ServeAim,
  serveVelocity,
  paddleWidthFor,
  ballRadiusFor,
  clampBallSpeed,
  SERVE_MAX_ANGLE_DEG,
  aiServeAim,
  aiServeDelay,
  playerPressure,
  bounceOffWall,
} from './game/physics';
import { START_MU, normalizeDifficulty, xpForLevel } from './rating';
import {
  DEFAULT_MATCH_RULES,
  DEFAULT_ROOM_CONFIG,
  DEFAULT_WINNING_SCORE,
  MATCH_START_COUNTDOWN_SECONDS,
  duelMatchKey,
  normalizeRoomConfig,
  normalizeRules,
  isRankedRules,
  unrankedReasons,
} from './matchRules';
import { DEFAULT_VENUE_ROOM } from './venues';
import type { TableSummary } from './components/MultiplayerLobby';
import { sound } from './audio/soundEffects';
import { t } from './i18n/translations';
import {
  getMissionsStatusSummary,
  msUntilMissionReset,
} from './game/missions';
import { CourtCanvas } from './components/CourtCanvas';
import { ScoreBoard } from './components/ScoreBoard';
import { RadarPreview } from './components/RadarPreview';
import { SettingsModal } from './components/SettingsModal';
import { SettingsPanel } from './components/SettingsPanel';
import { MultiplayerLobby } from './components/MultiplayerLobby';
import { MainMenu } from './components/MainMenu';
import { SplitScreenMatch } from './components/SplitScreenMatch';
import { ProfileModal } from './components/ProfileModal';
import { RanksPage } from './components/RanksPage';
import { AchievementsTree } from './components/AchievementsTree';
import { AchievementCard, LevelUpCard } from './components/AchievementCard';
import { HistoryPage } from './components/HistoryPage';
import { StatsOverlay } from './components/StatsOverlay';
import { MissionsModal } from './components/MissionsModal';
import { QuickChat, ChatMessage } from './components/QuickChat';
import { MobileGatekeeper } from './components/MobileGatekeeper';
import { SessionGuard } from './components/SessionGuard';
import {
  CarryStore,
  carriedStreak as carried,
  opponentMiss,
  opponentReturn,
  ownMiss,
  ownReturn,
  rememberCarry,
  startMatchStreaks,
} from './game/streaks';
import { OnboardingModal } from './components/OnboardingModal';
import { PublicProfileModal } from './components/PublicProfileModal';
import {
  Sheet,
  Button,
  ProgressBar,
  StatTile,
  ToastHost,
  TOAST_TTL,
  resetMeterMemory,
  useMotion,
  type ToastSpec,
} from './components/ui';
import { isLinkableId } from './profileRules';
import {
  ClientSessionStatus,
  deleteAccount,
  endSession,
  openSession,
  probeSession,
  refreshForBuild,
  resetDevice,
  watchSession,
} from './net/session';
import { DIFFICULTY_ORDER, playableDifficulty, playableWinningScore } from './achievements';
import { TierBadge } from './components/TierBadge';
import rawConfetti from 'canvas-confetti';

/**
 * Confetti, unless the player has asked for less motion.
 *
 * `useMotion()` governs every DOM animation in the app; confetti is drawn to
 * its own canvas and was outside it, so a celebration fired a few hundred
 * moving objects across the screen for somebody who had explicitly asked not
 * to have that. Read at call time rather than once at module load, because
 * the preference can change while the app is open.
 */
const confetti: typeof rawConfetti = ((opts?: Parameters<typeof rawConfetti>[0]) => {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return undefined;
  }
  return rawConfetti(opts);
}) as typeof rawConfetti;
import { Trophy, RefreshCw, Home, ArrowUp, ArrowDown, Circle } from 'lucide-react';

/** How many times a lost invitation socket is retried before giving up. */
const MAX_INVITE_RETRIES = 2;
// A relay that refuses the socket for want of a live session is a different
// failure from a relay that cannot be reached, and it recovers on its own
// within a round trip, so it gets its own (larger) allowance.
const MAX_INVITE_SESSION_REJOINS = 5;

const DEFAULT_SETTINGS: GameSettings = {
  soundEnabled: true,
  sfxVolume: 80,
  bgmVolume: 50,
  soundscape: 'none',
  soundscapeVolume: 40,
  hapticsEnabled: true,
  hapticIntensity: 75,
  screenShakeIntensity: 60,
  tiltEnabled: false,
  showRadar: true,
  // Both on by default. They are the ranked-legal way to know where the other
  // player is: the sonar draws their whole half and costs the match its
  // rating, these two do not.
  showOpponentIndicator: true,
  showBallIndicator: true,
  showTrails: true,
  // Taken from the ladder rather than written out, so the shipped default is
  // the easiest rung by construction and cannot drift into being a LOCKED one.
  // It shipped as 'pro', which stays locked until Rookie has been beaten — so
  // every solo match a new player played came back 403 DIFFICULTY_LOCKED and
  // was thrown away, paying no XP, no missions and no history.
  difficulty: DIFFICULTY_ORDER[0],
  winningScore: DEFAULT_WINNING_SCORE,
  rules: DEFAULT_MATCH_RULES,
  cosmetic: DEFAULT_COSMETIC_ID,
  language: 'en',
};

/**
 * The identity of one solo match, minted here because only this device can
 * report it. It rides on the payload, so a retry and a replay from the
 * on-device queue carry the key the first attempt used and the server can see
 * they are the same match rather than three.
 */
/**
 * How many arrows a rank move draws, and what it is called.
 *
 * The overlay drew ONE arrow at any magnitude, so a first placement game that
 * moved 4.2 mu and a converged player's expected win that moved 0.05 looked
 * identical — the direction was the whole message. The server buckets the
 * delta (rankMoveSize in src/rating.ts); this only counts glyphs.
 *
 * Flat literal records rather than a key built from the two fields:
 * tests/i18n.test.ts finds a key by scanning the source for it in quotes, so a
 * template-literal `t(`rank_${dir}_${size}`)` is invisible to both halves of
 * that check — every key it names reads as dead weight, and a typo in it reads
 * as nothing at all.
 */
/**
 * How long the winner overlay will hold Rematch back for a pending result.
 *
 * Long enough that the ordinary case — the relay's own match_recorded, or this
 * phone's POST — always lands first, and short enough that a player is never
 * left prodding a dead button. It is a backstop, not the mechanism: the two
 * real doors are the result arriving and the record failing.
 */
const RESULT_WAIT_MS = 4000;

const RANK_ARROWS: Record<RankMagnitude, number> = { none: 0, minor: 1, moderate: 2, large: 3 };
const RANK_UP_KEY: Record<RankMagnitude, string> = {
  none: 'rank_steady',
  minor: 'rank_up_minor',
  moderate: 'rank_up_moderate',
  large: 'rank_up_large',
};
const RANK_DOWN_KEY: Record<RankMagnitude, string> = {
  none: 'rank_steady',
  minor: 'rank_down_minor',
  moderate: 'rank_down_moderate',
  large: 'rank_down_large',
};
const rankMoveKey = (direction: RankDirection, size: RankMagnitude): string =>
  direction === 'up' ? RANK_UP_KEY[size] : direction === 'down' ? RANK_DOWN_KEY[size] : 'rank_steady';

const newSoloMatchKey = (): string =>
  `solo:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;

/**
 * How long a multiplayer court may sit with no ball, nobody serving and no
 * countdown before it is treated as stalled rather than as a transient. Long
 * enough that an ordinary crossing (one relay hop, or one DataChannel hop) is
 * nowhere near it, short enough that a player is not left staring at a dead
 * court wondering.
 */
const BALL_STALL_MS = 6000;

/**
 * How old a ping reading may be before it stops being reported as one. The
 * probe runs every 5s, so anything past this has missed at least one round
 * trip and the number on screen is describing a connection that no longer
 * exists.
 */
const PING_STALE_MS = 8000;

export default function App() {
  const [settings, setSettings] = useState<GameSettings>(() => {
    const saved = localStorage.getItem('half_pong_settings');
    if (!saved) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(saved);
    // Legacy loose settings from before match rules were a single object.
    delete parsed.ballSpeedFactor;
    delete parsed.paddleWidthRatio;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      // 'chaos' was retired; a device that had it selected would otherwise
      // start a match against a difficulty that no longer has an anchor.
      difficulty: normalizeDifficulty(parsed.difficulty),
      rules: normalizeRules(parsed.rules),
      // Reads `parsed.theme` as well, because that is what this field was
      // called before a court theme became a whole-app cosmetic. Without the
      // fallback every existing player silently reverts to the default on the
      // deploy that renames it — no error, they just find their cosmetic gone.
      cosmetic: normalizeCosmeticId(parsed.cosmetic ?? parsed.theme),
    };
  });

  // Player identity is server-issued (signed device cookie); the id arrives
  // with the profile fetch and is display/labelling only — the server never
  // trusts a client-sent id.
  const [playerId, setPlayerId] = useState<string>('');

  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [lastMatchResult, setLastMatchResult] = useState<MatchEndResult | null>(null);

  // Daily Missions State
  // Missions are server state: progress advances only from a recorded match,
  // and rewards are claimed by id. Nothing about them lives in this browser.
  const [missions, setMissions] = useState<DailyMission[]>([]);
  // Rerolls left today, per tier. Server-owned and day-keyed, so they expire
  // with the missions rather than banking up.
  const [rerolls, setRerolls] = useState<{ regular: number; elite: number }>({
    regular: 0,
    elite: 0,
  });
  const [isMissionsOpen, setIsMissionsOpen] = useState<boolean>(false);

  // Modals state
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isMultiplayerOpen, setIsMultiplayerOpen] = useState<boolean>(false);
  const [isProfileOpen, setIsProfileOpen] = useState<boolean>(false);
  const [shakeTrigger, setShakeTrigger] = useState<number>(0);
  // Any tapped username opens this player's public profile — last in
  // `sheetStack` below, so it draws above whatever spawned it. null = closed.
  const [publicProfileId, setPublicProfileId] = useState<string | null>(null);

  /**
   * The open sheets App owns, bottom to top.
   *
   * Derived rather than pushed and popped, because `isMultiplayerOpen` is
   * driven by relay messages — `room_joined` and `room_created` reopen it, and
   * CLAUDE.md §1 records why that is load-bearing — so turning it into a stack
   * entry would mean rewiring those handlers in a change about the menu.
   *
   * The cost is that the order is fixed by declaration rather than by the order
   * the player opened them. For every pair that actually occurs — a public
   * profile over the leaderboard page, over the lobby, over a profile; a
   * profile over the in-match settings — the declared order IS the order they
   * can be opened in, so the two agree.
   *
   * It also ends a live undefined behaviour: `isSettingsOpen` and
   * `isProfileOpen` are independent, both openable from the in-match HUD, and
   * both were `z-50`. Two open at once resolved by DOM order, which nobody had
   * chosen.
   */
  const sheetStack = useMemo(
    () =>
      [
        isMissionsOpen && 'missions',
        isMultiplayerOpen && 'lobby',
        isSettingsOpen && 'settings',
        isProfileOpen && 'profile',
        publicProfileId && 'public-profile',
      ].filter(Boolean) as string[],
    [isMissionsOpen, isMultiplayerOpen, isSettingsOpen, isProfileOpen, publicProfileId]
  );
  const stackOf = (key: string) => {
    const index = sheetStack.indexOf(key);
    return index < 0 ? undefined : { index, count: sheetStack.length };
  };
  // Server-computed odds for the current PvP match (never exposes the
  // opponent's hidden rating to this client).
  const [matchPrediction, setMatchPrediction] = useState<number | null>(null);

  // Quick Chat State
  const [activeChatMessages, setActiveChatMessages] = useState<ChatMessage[]>([]);

  // Player Activity & Status Tracking
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus>('online');

  // Real-time Match Telemetry
  const [totalTouches, setTotalTouches] = useState<number>(0);
  const [matchStartTime, setMatchStartTime] = useState<number | null>(() => Date.now());

  // Toast notifications. A match can unlock several achievements at once —
  // a first-ever match grants first_serve, ai_rookie and first_win together —
  // so they stack rather than one of them standing for all of them.
  const [toastAchievements, setToastAchievements] = useState<Achievement[]>([]);
  const [toastLevelUp, setToastLevelUp] = useState<number | null>(null);
  // A match that failed to reach the server is parked on the device; the
  // player is told rather than left looking at an untracked result.
  const [toastRecordFailed, setToastRecordFailed] = useState<boolean>(false);
  /**
   * Whether the finished match's result has stopped being pending.
   *
   * Three doors, and it needs all three: the result landing, the record having
   * failed outright, and a hard timeout for the case where neither happens —
   * a request still hanging when the socket has gone quiet. Only the Rematch
   * button waits on it, and only so the ladder movement is on screen before
   * the match it describes can be replaced. Main Menu never waits: no state
   * this app can reach may have its only exit blocked on a network call.
   */
  const [recordTimedOut, setRecordTimedOut] = useState<boolean>(false);
  const [toastPracticeXp, setToastPracticeXp] = useState<number | null>(null);
  // A permanent unlock banked from an elite mission — worth announcing.
  /**
   * Cosmetics unlocked just now, waiting to be announced.
   *
   * A list rather than one slot because two can land together — an achievement
   * and the raw-stat fallback beside it both opening on the same match — and
   * the single slot this replaced silently dropped whichever arrived second.
   */
  const [toastUnlocks, setToastUnlocks] = useState<CosmeticId[]>([]);
  // 'won' when the relay recorded the abandoned match as this player's win,
  // 'plain' when there was no match to win (a stranded guest in a lobby).
  const [toastOpponentLeft, setToastOpponentLeft] = useState<'won' | 'plain' | null>(null);
  // Telemetry is per-match and starts HIDDEN: enabling the rule makes the
  // panel available, and the player opens it from the court when they want
  // it. Resets with every match so it never lingers from the last one.
  const [telemetryOpen, setTelemetryOpen] = useState<boolean>(false);

  // Whether THIS device still holds the account. One account has exactly one
  // live session; anything but 'active' means we must stop playing, because
  // nothing played from here would be recorded.
  const [sessionStatus, setSessionStatus] = useState<ClientSessionStatus>('connecting');
  const [sessionBusy, setSessionBusy] = useState<boolean>(false);

  // 'menu' = out-of-match navigation hub; 'game' = a match is on court.
  const [screen, setScreen] = useState<'menu' | 'game'>('menu');
  const [mode, setMode] = useState<GameMode>('solo');
  const [stats, setStats] = useState<PlayerStats>({
    score: 0,
    opponentScore: 0,
    streak: 0,
    bestStreak: 0,
    earnedStreak: 0,
    earnedBest: 0,
    oppStreak: 0,
    oppBestStreak: 0,
    aces: 0,
    matchesWon: 0,
  });

  // Active Player Half Court Ball State
  // A match opens on a serve, so the ball opens in the player's hand: held at
  // the paddle, still, and inactive. It used to start active at mid-court with
  // a velocity, which only the serve-gated physics loop stopped from being a
  // ball loose on the court — and which drew a second, stray ball beside the
  // one waiting on the paddle.
  const [ball, setBall] = useState<BallState>({
    x: 0.5,
    y: SERVE_BALL_Y,
    vx: 0,
    vy: 0,
    radius: BALL_BASE_RADIUS,
    active: false,
  });

  // Simulated Opponent Court Ball State (for AI solo mode & radar preview)
  const [oppBall, setOppBall] = useState<BallState | null>(null);
  const [paddleX, setPaddleX] = useState<number>(0.5);
  const [oppPaddleX, setOppPaddleX] = useState<number>(0.5);

  const [isServing, setIsServing] = useState<boolean>(true);
  const [isPlayerServer, setIsPlayerServer] = useState<boolean>(true);
  const [winner, setWinner] = useState<'player' | 'opponent' | null>(null);

  // Multiplayer State
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [playerIndex, setPlayerIndex] = useState<0 | 1 | null>(null);
  const [opponentName, setOpponentName] = useState<string | null>(null);
  const [opponentId, setOpponentId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [pingMs, setPingMs] = useState<number>(0);
  // When that reading was taken. The number only moves on a `pong`, so a
  // connection that has stopped answering went on showing its last good ping,
  // unchanged and reassuring, for as long as the stall lasted.
  const [pingAt, setPingAt] = useState<number>(0);
  const [rematchVotes, setRematchVotes] = useState<[boolean, boolean]>([false, false]);
  /**
   * Which side of a table this page is WATCHING, or null when it is playing.
   *
   * Mutually exclusive with holding a playing seat — the relay refuses a
   * second seat outright, so these cannot both be true. `side` is the player
   * being watched, and `playerIndex` is deliberately set to it as well: the
   * whole fan-out is built so a spectator looks, on the wire, exactly like
   * the player beside them, which is what lets score_update, game_start and
   * ball_incoming work here with no spectating branch at all.
   */
  const [spectating, setSpectating] = useState<{ roomId: string; side: 0 | 1 } | null>(null);
  /** Who is sitting where at the table, as the relay last described it. */
  const [tableState, setTableState] = useState<{
    seats: TableSeatInfo[];
    yourSeat: TableSeat | null;
    spectatorsEnabled: boolean;
    /** Whether this table is locked, and the key that opens it if it is. */
    isPrivate: boolean;
    joinKey: string | null;
    /**
     * The venue this TABLE is in — not the room the player was browsing.
     *
     * They differ for anybody who arrived on a join key rather than by tapping
     * a listed table, and Casual does not move the ladder, so a lobby reading
     * the browse venue would tell a guest the opposite of the truth about the
     * match they are about to play.
     */
    venueRoomId: string;
  } | null>(null);
  // The room's terms, as the server last broadcast them. Null until a room
  // exists. In a duel this — never the local menu — decides how long the match
  // is and how the ball behaves, so both phones play the same match.
  const [roomConfig, setRoomConfig] = useState<RoomMatchConfig | null>(null);
  // Ticks 3-2-1 on BOTH phones at every duel (re)start. The match does not
  // initialize until it hits zero: no serve — tapped or automatic — can fire
  // under it, so neither player is ambushed by a ball they weren't watching
  // for. Null outside a duel.
  //
  // ARMED by game_start but STARTED only when this player actually reaches
  // the court: game_start arrives while both phones still show the lobby, and
  // a countdown ticking behind a modal would burn away unseen — the player
  // pressed Play Match and got a match already in progress.
  const [matchCountdown, setMatchCountdown] = useState<number | null>(null);
  const [countdownArmed, setCountdownArmed] = useState<boolean>(false);
  // The lobby handshake, as the server last broadcast it: [host, guest].
  const [lobbyReady, setLobbyReady] = useState<[boolean, boolean]>([false, false]);
  // "Are you sure?" gate for quitting a live duel — walking out mid-match is
  // an abandon, so it should never happen off a single mis-tap.
  /**
   * The match-exit confirmation, and which exit raised it.
   *
   * Every route out of a LIVE match goes through this, because every one of
   * them now costs the match: 'duel' hands the win to the opponent, and both
   * solo routes record the loss (quitting to the menu, and Reset, which ends
   * this match just as surely as walking out of it). The routes that cost
   * nothing never raise it — a finished match's Main Menu, the Practice Wall,
   * a lobby with no match in it, and a solo match still at 0-0.
   */
  const [exitConfirm, setExitConfirm] = useState<'duel' | 'solo-quit' | 'solo-reset' | null>(null);
  // The same gate for walking out of a LOBBY. Dismissing that sheet used to
  // only hide it, which left the player alone on the live court underneath —
  // paddle working, serve refused, and the relay's room still open behind
  // them. Leaving a room is now a decision, and taking it actually leaves.
  const [leaveLobbyConfirmOpen, setLeaveLobbyConfirmOpen] = useState<boolean>(false);
  const [toastEjected, setToastEjected] = useState<boolean>(false);
  const [toastRelayError, setToastRelayError] = useState<string | null>(null);
  // A mission claim or reroll that never reached the server. The non-network
  // failures already resync the list, which is its own answer; a dropped
  // request left the button doing nothing at all, with no way to tell that
  // from a mission that was not finished.
  const [toastActionFailed, setToastActionFailed] = useState<boolean>(false);
  const [toastRallyStalled, setToastRallyStalled] = useState<boolean>(false);
  const [toastRoomExpired, setToastRoomExpired] = useState<boolean>(false);
  /** The table this page was WATCHING has gone — never an abandon notice. */
  const [toastTableEnded, setToastTableEnded] = useState<boolean>(false);
  // An invitation link that never got its holder a seat. Silence here reads as
  // "the link is broken" — which it may well be (a dead room code), but the
  // player deserves to be told rather than left on a menu that swallowed it.
  const [toastInviteFailed, setToastInviteFailed] = useState<boolean>(false);
  // 'relay' = via server; 'connecting' = P2P handshake running; 'p2p' = direct
  const [linkStatus, setLinkStatus] = useState<'relay' | 'connecting' | 'p2p'>('relay');
  const [p2pEnabled, setP2pEnabled] = useState<boolean>(true);

  // The terms the CURRENT match is played on. A duel takes them from the room
  // so both sides agree; every other mode takes them from the menu.
  const activeConfig: RoomMatchConfig =
    // `spectators: false` in the non-duel arm: a watching seat is a seat at a
    // relay TABLE, and a solo, practice or split match has no room to sit in.
    mode === 'multiplayer' && roomConfig
      ? spectating
        ? // A watcher sees the whole table, sonar and all — that is what
          // watching IS, and it is why the rooms where rating is on the line
          // have no watching seats at all. Applied HERE, to this page's own
          // view, and never written back to room.config: that field unranks
          // the match for the PLAYERS, so writing it would let a losing player
          // unrank a match on demand by asking a friend to sit down.
          { ...roomConfig, rules: { ...roomConfig.rules, opponentSonar: true } }
        : roomConfig
      : { winningScore: settings.winningScore, rules: settings.rules, spectators: false };
  const activeDifficulty: AIDifficulty = settings.difficulty;

  /**
   * The two net indicators are suppressed for any match played WITH the
   * opponent sonar. The sonar already draws the whole far half — stacking a
   * paddle marker and a ball marker on top of it would be pointing at things
   * the player can see in full a few pixels away — and it is the version that
   * costs the match its rating, so the cheap ones do not ride along with it.
   *
   * Derived per match, never written back: the player's stored preferences are
   * still on, and come back by themselves the next time the sonar is off.
   */
  const indicatorsAllowed = !activeConfig.rules.opponentSonar;

  // Refs for high-speed 60fps physics loop without stale closures
  const ballRef = useRef<BallState>(ball);
  const oppBallRef = useRef<BallState | null>(oppBall);
  const paddleXRef = useRef<number>(paddleX);
  const prevPaddleXRef = useRef<number>(paddleX);
  const paddleVxRef = useRef<number>(0);
  // When this court last had a rally on it, and whether the stall it is in has
  // already been reported. See the watchdog in the game loop.
  const rallyAliveRef = useRef<number>(0);
  const stallHandledRef = useRef<boolean>(false);
  const aiRef = useRef<OpponentAI>(new OpponentAI(settings.difficulty));
  // Match rules are locked in on the menu; these refs give the game loop the
  // live values without re-creating it every render.
  const rulesRef = useRef<MatchRules>(activeConfig.rules);
  rulesRef.current = activeConfig.rules;
  const paddleWidthRef = useRef<number>(paddleWidthFor(activeConfig.rules));
  paddleWidthRef.current = paddleWidthFor(activeConfig.rules);
  const ballRadiusRef = useRef<number>(ballRadiusFor(activeConfig.rules));
  ballRadiusRef.current = ballRadiusFor(activeConfig.rules);
  const configRef = useRef<RoomMatchConfig>(activeConfig);
  configRef.current = activeConfig;
  const modeRef = useRef<GameMode>(mode);
  const screenRef = useRef<'menu' | 'game'>(screen);
  const wsRef = useRef<WebSocket | null>(ws);
  const isServingRef = useRef<boolean>(isServing);
  const statsRef = useRef<PlayerStats>(stats);
  // Who served the point currently in play — an ace is a point won directly
  // off your own serve, so the winner alone doesn't identify one.
  const servedThisPointRef = useRef<boolean>(true);
  const isPlayerServerRef = useRef<boolean>(true);
  /**
   * Whether the opponent has put the ball over yet THIS point.
   *
   * Both of these answer the same question in the two shapes it arrives in: a
   * serve is not a return, so the opponent's first ball of a point is theirs
   * only when they are not the one serving. In a duel the opponent's returns
   * are only ever observed as balls arriving, so the count is what tells the
   * serve from a rally; in solo they are observed directly as a paddle hit,
   * and the flag is what tells an ace from a point won off a rally.
   */
  const oppCrossingsThisPointRef = useRef<number>(0);
  const oppReturnedThisPointRef = useRef<boolean>(false);
  const settingsRef = useRef<GameSettings>(settings);
  const profileRef = useRef<PlayerProfile | null>(profile);
  // Which match of the room is being played, from the relay's game_start (or
  // the P2P replica's, for a rematch the peers agreed between themselves).
  // Half of the key this match is recorded under, so a result reported late
  // is filed against the match it came from and not the one after it.
  const matchSeqRef = useRef<number>(0);
  // The key the CURRENT match will be recorded under. A duel derives it, so
  // the relay's own record of the same match and this phone's POST land on
  // the same row; a solo match mints one, so a retry or a queued replay of it
  // is recognised as the same match rather than paid twice.
  const matchKeyRef = useRef<string>('');
  // The last match key whose result has been shown. A duel's result can
  // arrive twice — pushed by the relay and returned by our own POST — and the
  // player should not be congratulated twice for one match.
  const shownMatchKeyRef = useRef<string>('');
  /**
   * Where this page's own run stands, per mode — what the next match in that
   * mode opens on, and why the profile alone is not enough to answer that.
   * The rule, and the reasoning, are in src/game/streaks.ts.
   */
  const carryRef = useRef<CarryStore>({});

  // P2P link plumbing. dispatchRef always points at the CURRENT render's
  // message handler, so both the WebSocket and the P2P link dispatch into
  // fresh state (the old direct socket.onmessage closure captured a stale
  // playerIndex from before the room existed, deadlocking the first serve).
  const p2pRef = useRef<P2PGameLink | null>(null);
  const rtcConfigRef = useRef<RTCIceServer[] | undefined>(undefined);
  const dispatchRef = useRef<(msg: WSServerMessage) => void>(() => {});
  const sendNetRef = useRef<(msg: WSClientMessage) => void>(() => {});
  const playerIndexRef = useRef<0 | 1 | null>(playerIndex);
  const opponentIdRef = useRef<string | null>(opponentId);
  // Frame-accurate opponent paddle for the sonar: the loop writes it directly
  // so the radar never waits on a React render to learn where the paddle is.
  const oppPaddleXRef = useRef<number>(0.5);
  // PvP sonar stream bookkeeping. In a duel the opponent's half is not
  // simulated here — the opponent's phone streams its live ball position
  // (ball_pos → opponent_ball) the same way paddles already stream. One ref
  // throttles our outgoing stream; the other timestamps the last incoming
  // sample so a ball whose stream has stopped can be swept away (the fast
  // channel is unordered and unreliable, so a stale sample can slip in after
  // the reliable clear that follows a net cross or a point).
  const lastBallPosSentRef = useRef<number>(0);
  const oppBallSeenRef = useRef<number>(0);
  const matchCountdownRef = useRef<number | null>(matchCountdown);
  const intentionalCloseRef = useRef<boolean>(false);
  /**
   * The room this page currently holds a seat in, for the socket handlers,
   * which are built once and cannot see state. Cleared by handleLeaveRoom, so
   * it answers "do we hold a seat right now" — which playerIndex does not: it
   * keeps its last value after a leave, and is only ever overwritten by the
   * next room_created/room_joined.
   */
  const roomIdRef = useRef<string | null>(null);
  /** Read by the game loop and the senders, which must not run for a watcher. */
  const spectatingRef = useRef<{ roomId: string; side: 0 | 1 } | null>(null);
  /** The last watched_ball sample, so the next one can be given a velocity. */
  const watchedBallRef = useRef<{ x: number; y: number; t: number } | null>(null);
  /**
   * The queue, reachable from the dispatch above where it is declared.
   *
   * And `queueSeating`, which suppresses one lobby flash: the relay seats a
   * found pair with the ordinary room_created/room_joined, and those reopen
   * the lobby by design — for a queue match that sheet would appear for the
   * single round trip before `game_start` closes everything anyway.
   */
  const quickMatchRef = useRef<QuickMatch | null>(null);
  const queueSeatingRef = useRef<boolean>(false);
  const countdownArmedRef = useRef<boolean>(countdownArmed);

  ballRef.current = ball;
  oppBallRef.current = oppBall;
  paddleXRef.current = paddleX;
  modeRef.current = mode;
  screenRef.current = screen;
  wsRef.current = ws;
  isServingRef.current = isServing;
  isPlayerServerRef.current = isPlayerServer;
  statsRef.current = stats;
  settingsRef.current = settings;
  profileRef.current = profile;
  playerIndexRef.current = playerIndex;
  roomIdRef.current = roomId;
  spectatingRef.current = spectating;
  opponentIdRef.current = opponentId;
  oppPaddleXRef.current = oppPaddleX;
  matchCountdownRef.current = matchCountdown;
  countdownArmedRef.current = countdownArmed;

  // Route a gameplay message over the P2P link when it is open, otherwise
  // over the WebSocket relay. Reassigned every render so it sees fresh refs.
  sendNetRef.current = (msg: WSClientMessage) => {
    if (p2pRef.current?.sendGame(msg)) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  };

  const currentLanguage: LanguageCode = settings.language || 'en';

  // Fetch Player Profile from Server. Usernames are server-owned now: the
  // profile arrives uninitialized on first contact and the OnboardingModal
  // gates the app until the player locks one in.
  const fetchProfile = useCallback(() => {
    fetch('/api/profile/me')
      .then((res) => res.json())
      .then((data) => {
        if (data && data.id) {
          setProfile(data);
          setPlayerId(data.id);
        }
      })
      .catch((e) => console.error('Profile fetch error:', e));
  }, []);

  // Today's missions come from the server, which also owns their progress.
  const refreshMissions = useCallback(async () => {
    try {
      const res = await fetch('/api/missions');
      const data = await res.json();
      if (data && Array.isArray(data.missions)) setMissions(data.missions);
      if (data?.rerolls) setRerolls(data.rerolls);
    } catch (e) {
      console.error('Mission fetch error:', e);
    }
  }, []);

  // Claim the account for this device before anything is allowed to act on
  // it. Every write is gated on holding a live session, so this has to land
  // first — and it returns the profile, which is why no separate fetch runs
  // here any more.
  // `force` is the session wall's "play here instead": a deliberate take-back
  // from another device. Boot passes nothing, so it will not mint a second
  // session over one this page already holds.
  const adoptSession = useCallback(async (force = false) => {
    setSessionBusy(true);
    const res = await openSession({ force });
    setSessionBusy(false);
    setSessionStatus(res.status);
    if (res.profile) {
      setProfile(res.profile);
      setPlayerId(res.profile.id);
    }
    return res.status;
  }, []);

  useEffect(() => {
    void adoptSession();
  }, [adoptSession]);

  // Hand the account back when the tab is genuinely going away, so the next
  // device to open it is not told the account is "playing elsewhere" by a
  // session nobody is sitting at. `persisted` filters out the bfcache case —
  // on a phone, switching apps fires pagehide too, and that player is coming
  // back to their match.
  useEffect(() => {
    const onPageHide = (e: PageTransitionEvent) => {
      if (!e.persisted) endSession();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // The one way off a released device: this browser gives up the identity it
  // used to hold and starts over. Handing the old profile back instead would
  // recreate the very two-devices-one-account state that let a whole match be
  // played for nothing.
  const startFreshIdentity = useCallback(async () => {
    setSessionBusy(true);
    const res = await resetDevice();
    setSessionBusy(false);
    setSessionStatus(res.status);
    if (res.profile) {
      // The fresh profile is swapped in WITHOUT a reload, unlike every other
      // way this page changes identity (a recovery-code restore reloads the
      // whole page instead). carryRef survives that swap, and it is read in
      // PREFERENCE to the profile's own stored value ("what this page last
      // saw for itself wins" — see streaks.ts) — so left alone, the brand new
      // account's first Solo or Practice session opens on the RELEASED
      // account's last run, and bestStreak opening on it is what the career
      // best, the mode best and rally achievements are keyed on: a theme
      // unlock or an achievement for returns this player never made.
      carryRef.current = {};
      // Same reasoning, a second piece of stale per-browser state: a match
      // that failed to record before this device was released is still
      // sitting in the on-device queue (net/matchRecord.ts), which is a flat
      // localStorage key with no idea which account was active when an entry
      // was parked. Left alone, the profile?.id effect below flushes it the
      // moment this fresh account is initialized and credits the RELEASED
      // account's match — XP, rating, achievements, streaks — to a player
      // who never played it.
      clearPendingMatches();
      // And a third, which is the cheap one and on the list for a structural
      // reason rather than for its stake: the meter origins (components/ui/
      // meterMemory.ts) are module scope too, so they outlive an identity swap
      // exactly as the two above do. Nothing is paid or rated on them — a bar
      // animates from the wrong place, and that is the whole cost. But a fresh
      // account is level 1 and unplaced, which is the ORDINARY case rather than
      // an exotic one, so it would inherit `menu-xp:1` and `rank:placement`
      // from the account just given up and watch its placement meter slide
      // DOWN from the previous player's 4/5 on the first paint.
      resetMeterMemory();
      setProfile(res.profile);
      setPlayerId(res.profile.id);
    }
  }, []);

  /**
   * Delete this account, permanently, from the bottom of Settings.
   *
   * The username has already been typed exactly and the permanence confirmed
   * by the time this runs; the server checks the name again, because the two
   * steps in front of it live in a client.
   *
   * The three pieces of stale per-browser state startFreshIdentity has to clear
   * apply here for the same reasons, and only one of them is handled here.
   * The on-device match queue (net/matchRecord.ts) is a flat localStorage key
   * with no idea which account was active when an entry was parked, so a match
   * that failed to record before the deletion would be flushed onto the fresh
   * profile this browser is about to be given — XP, rating and achievements
   * paid to an account that never played it. That is cleared here. `carryRef`
   * and the meter origins need no such call only because this path RELOADS:
   * the whole page goes, and with it every ref and every module-scope store,
   * which is also what puts the player on the onboarding modal a brand-new
   * device sees.
   */
  const handleDeleteAccount = useCallback(
    async (username: string): Promise<{ ok: boolean; error?: string }> => {
      const result = await deleteAccount(username);
      if (!result.ok) return result;
      clearPendingMatches();
      // Deliberately a full reload rather than a state swap: the account this
      // page was built around no longer exists, and there is no piece of it
      // worth carrying across.
      window.location.reload();
      return result;
    },
    []
  );

  // Refetch once the profile exists (the device cookie is set by then) and
  // again whenever the UTC day rolls over while the tab stays open.
  useEffect(() => {
    if (!profile?.id) return;
    // Replay anything an earlier session couldn't deliver, then refresh.
    // A replay keeps the chain position (see src/net/runChain.ts) it was
    // assigned when the match originally ended, so it is already ordered
    // against whatever this browser assigns after this reload — it does not
    // need to run through queueRunWrite as well.
    void flushPendingMatches().then((recovered) => {
      if (recovered > 0) fetchProfile();
    });
    void refreshMissions();
    const timer = setTimeout(() => void refreshMissions(), msUntilMissionReset() + 1000);
    return () => clearTimeout(timer);
  }, [profile?.id, refreshMissions]);

  /**
   * Equip a cosmetic.
   *
   * Written to the device FIRST so the repaint is instant — the whole shell
   * changes colour, and waiting a round trip for that reads as a broken tap —
   * then to the profile, which is the copy other players see. A refusal rolls
   * the device back rather than leaving the two disagreeing, because
   * `equippedCosmeticId` prefers the profile and the player would otherwise be
   * looking at a cosmetic that reverts on their next reload with no explanation.
   *
   * An uninitialized profile has nothing to write to and is left on the device
   * copy alone. That costs nothing: every cosmetic such a player can reach is a
   * free one.
   */
  const handleEquipCosmetic = async (id: CosmeticId): Promise<void> => {
    const previous = settings.cosmetic;
    setSettings((s) => ({ ...s, cosmetic: id }));
    if (!profile?.initialized) return;
    try {
      const res = await fetch('/api/profile/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cosmetic: id }),
      });
      const data = await res.json();
      if (res.ok && data && data.id) {
        setProfile(data);
        return;
      }
      setSettings((s) => ({ ...s, cosmetic: previous }));
    } catch {
      setSettings((s) => ({ ...s, cosmetic: previous }));
    }
  };

  /**
   * Announce a cosmetic the moment it opens.
   *
   * Load-bearing rather than decorative: locked cosmetics are absent from the
   * picker entirely, so this is the ONLY moment a player learns one exists.
   * Before cosmetics were hidden only the six elite missions raised this, and
   * the nine earned by achievements or raw stats arrived in silence — which was
   * survivable when the picker listed them greyed-out, and is not now.
   *
   * The diff is against the previous profile rather than against a stored list,
   * so it needs no new persistence: the unlock predicate is pure and the profile
   * already carries everything it reads. The first profile of the session only
   * establishes the baseline — without that guard, every load would announce all
   * five free cosmetics.
   */
  const knownCosmeticsRef = useRef<Set<CosmeticId> | null>(null);
  useEffect(() => {
    if (!profile) return;
    const owned = new Set(COSMETIC_IDS.filter((id) => isCosmeticUnlocked(id, profile)));
    const previous = knownCosmeticsRef.current;
    knownCosmeticsRef.current = owned;
    if (!previous) return;
    const fresh = [...owned].filter((id) => !previous.has(id));
    if (fresh.length) setToastUnlocks((prev) => [...prev, ...fresh.filter((id) => !prev.includes(id))]);
  }, [profile]);

  /**
   * Keep the device copy in step with the profile.
   *
   * The profile is the truth, and this is only about the NEXT boot: the first
   * paint happens before any fetch returns, so without this a player who
   * equipped something on another browser gets one frame of the old cosmetic
   * before the profile lands and corrects it.
   */
  useEffect(() => {
    const equipped = profile?.cosmetic;
    if (equipped && equipped !== settings.cosmetic) {
      setSettings((s) => ({ ...s, cosmetic: equipped }));
    }
  }, [profile?.cosmetic, settings.cosmetic]);

  // Rename (365-day lock). Returns the typed failure so the Profile modal
  // can tell the player WHY: taken, invalid, or locked until a date.
  const handleUpdateUsername = async (
    newName: string
  ): Promise<{ ok: boolean; error?: string; unlockAt?: string }> => {
    try {
      const res = await fetch('/api/profile/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newName }),
      });
      const data = await res.json();
      if (res.ok && data && data.id) {
        setProfile(data);
        return { ok: true };
      }
      return { ok: false, error: data?.error || 'USERNAME_INVALID', unlockAt: data?.unlockAt };
    } catch (e) {
      console.error('Failed to update username:', e);
      return { ok: false, error: 'NETWORK' };
    }
  };

  const openPublicProfile = (id: string | null | undefined) => {
    if (isLinkableId(id)) setPublicProfileId(id as string);
  };

  /**
   * Show what a finished match paid. Called from two places that can both
   * describe the SAME match — the result our own POST returned, and the one
   * the relay pushes after recording a duel for both players — so the match
   * key decides which of them gets to speak. Whichever lands first wins; the
   * other is dropped, rather than firing a second round of confetti for a
   * level the player already saw themselves reach.
   */
  const applyMatchResult = useCallback((matchKey: string, result: MatchEndResult, source: 'post' | 'relay') => {
    if (!result) return;
    if (matchKey && shownMatchKeyRef.current === matchKey) {
      // The toasts are done — but the PROFILE may not be. Anything derived from
      // the whole player table can only be right once every seat of this match
      // has been written, and the relay's copy is read after both are; our own
      // POST records one seat and cannot be. So a duplicate FROM THE RELAY
      // still installs its profile, silently, and a duplicate from our own POST
      // is dropped exactly as before.
      //
      // Authority by SOURCE, never by arrival order: "later wins" reads well
      // and is wrong in the mirror case, where the relay lands first and our
      // own POST is the duplicate that would reinstall the stale number.
      if (source === 'relay' && result.profile) setProfile(result.profile);
      return;
    }
    if (matchKey) shownMatchKeyRef.current = matchKey;

    setLastMatchResult(result);
    setToastRecordFailed(false);
    if (result.profile) setProfile(result.profile);
    // The server advanced today's missions as part of recording the match.
    if (result.missions) setMissions(result.missions);

    // Both, not one or the other: levelling up and unlocking something are
    // separate things to be told, and the `else if` this replaced meant a
    // match that did both announced only the level.
    const unlocked = result.newAchievements ?? [];
    if (result.leveledUp) setToastLevelUp(result.profile.level);
    if (unlocked.length > 0) setToastAchievements(unlocked);
    // One burst for the moment, sized by the bigger of the two things in it.
    if (result.leveledUp) confetti({ particleCount: 150, spread: 90, origin: { y: 0.5 } });
    else if (unlocked.length > 0) confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
  }, []);

  /**
   * Every client write that ASSIGNS the carried run, in the order it was made.
   *
   * The age each write carries orders it against writes from OTHER moments —
   * a match replayed off the on-device queue days later says so and loses to
   * what overtook it. It cannot order two writes made at nearly the same
   * moment, because their ages are both ~0 and what separates them is time
   * spent IN FLIGHT, which no stamp taken before sending can see. Reset
   * reporting a run of 8, then a miss and a walk-out reporting 0, then the
   * first request arriving last: both say "just now", and the server takes the
   * later arrival.
   *
   * So the two mechanisms answer different questions and the writes need both.
   * I removed this chain once on the grounds that the age superseded it; it
   * does not, and that was the wrong call.
   *
   * The price is that a stuck write delays the ones behind it. They are
   * corrections and results whose order matters more than their latency, and a
   * write that never lands leaves the server where it already was.
   */
  const runWriteChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const queueRunWrite = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const next = runWriteChainRef.current.then(work, work);
    runWriteChainRef.current = next.catch(() => undefined);
    return next;
  }, []);

  // Record Match Result to Server Database and Track Daily Missions
  const recordMatchCompletion = useCallback(
    async (isWinner: boolean) => {
      // Practice Wall and Split Screen are unranked: no winner is ever set
      // for them, and even if one were, nothing gets recorded.
      if (modeRef.current === 'practice' || modeRef.current === 'split') return;
      // Where this player's run stands now, before anything is awaited. Play
      // Again is a synchronous button and the POST below is not, so a replay
      // that read the profile would open on the run from before this match.
      rememberCarry(carryRef.current, modeRef.current, statsRef.current.streak);

      // A duel's key is derived so the relay lands on the same one; a solo
      // match has only this device to report it, so it mints its own. The
      // duel key was already minted at game_start (the moment the room is
      // certainly known) and cached — preferred here over a re-derivation
      // from live state, because `roomId` can be nulled by a leave racing
      // the final point, and a whistle-time mint then produced a solo-shaped
      // key the server could not match to the relay's record.
      const matchKey =
        modeRef.current === 'multiplayer'
          ? matchKeyRef.current ||
            (roomId ? duelMatchKey(roomId, matchSeqRef.current) : newSoloMatchKey())
          : matchKeyRef.current || newSoloMatchKey();
      matchKeyRef.current = matchKey;

      // The relay may already have recorded this duel for both players and
      // handed us the result. Recording it again would be answered with the
      // same result anyway, so this just saves a request the server would
      // recognise and refuse to pay.
      if (shownMatchKeyRef.current === matchKey) return;

      try {
        const payload: MatchEndPayload = {
          playerId,
          username: profileRef.current?.username || 'Player',
          opponentId: opponentId || undefined,
          opponentName:
            modeRef.current === 'multiplayer'
              ? opponentName || 'Opponent'
              : `AI (${settingsRef.current.difficulty})`,
          playerScore: statsRef.current.score,
          opponentScore: statsRef.current.opponentScore,
          bestStreak: statsRef.current.bestStreak,
          endStreak: statsRef.current.streak,
          earnedStreak: statsRef.current.earnedBest,
          // Stamped here, at the whistle — not when this eventually POSTs.
          // The queue can hold this through a whole replay, and the run it
          // reports must not land back on top of a newer one.
          endedAt: Date.now(),
          // This browser's own ordering, assigned at the same moment as
          // endedAt rather than at send time — see src/net/runChain.ts. A
          // parked-and-replayed copy of this exact payload keeps the number
          // assigned right here, so it stays correctly ordered against
          // whatever this browser assigns after a reload, regardless of how
          // long either request's own round trip takes.
          ...nextRunSeq(),
          aces: statsRef.current.aces,
          mode: modeRef.current,
          difficulty: settingsRef.current.difficulty,
          isWinner,
          // The rules the match was actually played under — the room's in a
          // duel, the menu's otherwise. The server re-derives whether they sit
          // inside the ranked bands; it never takes a "ranked" flag on trust.
          rules: configRef.current.rules,
          // Lets the server cross-check this PvP result against the room
          // state it owns instead of trusting the numbers above — against the
          // right match in that room, which is what matchSeq names.
          roomId: modeRef.current === 'multiplayer' ? roomId || undefined : undefined,
          // Only when the room actually told us (game_start always does). A
          // duel that somehow never learned its number says nothing rather
          // than claiming match 0, and the server falls back to the match the
          // room is on — which still deduplicates against the relay's record.
          matchSeq:
            modeRef.current === 'multiplayer' && matchSeqRef.current > 0
              ? matchSeqRef.current
              : undefined,
          // What makes recording this match idempotent. It travels with the
          // payload, so a retry and a replay from the on-device queue carry
          // the same key the first attempt did.
          matchKey,
        };

        const outcome = await queueRunWrite(() => postMatchRecord(payload));
        if (!outcome.ok) {
          if (outcome.reason === 'stale_build') {
            // A newer deployment is live and the page is already reloading.
            // The match is queued and replays under the new build, so a
            // "couldn't save" toast would be false as well as pointless.
            return;
          }
          if (outcome.reason === 'evicted') {
            // The account moved to another device while this match was being
            // played. Nothing was saved and nothing can be — the guard says
            // so in full, so a "couldn't save, we'll retry" toast would only
            // promise something that is never going to happen.
            const probe = await probeSession();
            setSessionStatus(probe.status);
            return;
          }
          if (outcome.reason === 'unidentified') {
            // The server no longer recognises this device (its signing secret
            // was rotated by a reset or a deploy that lost the data volume).
            // Re-syncing surfaces the uninitialized profile, which re-opens
            // onboarding instead of leaving the player silently unrecorded.
            fetchProfile();
          }
          // Queued for replay; tell the player rather than silently losing it
          // — unless the relay's own record of this duel reached us while the
          // POST was in flight, in which case the match IS saved and saying
          // otherwise would be the lie.
          if (shownMatchKeyRef.current !== matchKey) setToastRecordFailed(true);
          return;
        }
        applyMatchResult(matchKey, outcome.result!, 'post');
      } catch (e) {
        console.error('Failed to record match on server:', e);
        if (shownMatchKeyRef.current !== matchKey) setToastRecordFailed(true);
      }
    },
    [playerId, opponentId, opponentName, roomId, applyMatchResult, queueRunWrite]
  );

  // Trigger match completion on winner change. Guarded by a ref because the
  // effect also re-runs whenever recordMatchCompletion's identity changes
  // (playerId/opponent/room), which happens while `winner` is still set — that
  // recorded the same match twice.
  const recordedWinnerRef = useRef<'player' | 'opponent' | null>(null);
  useEffect(() => {
    if (!winner) {
      recordedWinnerRef.current = null;
      return;
    }
    // A watcher's `winner` is somebody else's result. It is set because the
    // whole fan-out makes a spectator look like the player they are sitting
    // beside — score_update reaches them byte-identically — and that is what
    // draws the overlay. Recording it would file another player's match onto
    // this account: XP, rating, achievements and streaks for a match this
    // device never played. The relay refuses it, but a POST that has to be
    // refused is a POST that should not have been sent.
    if (spectating) return;
    if (recordedWinnerRef.current === winner) return;
    recordedWinnerRef.current = winner;
    recordMatchCompletion(winner === 'player');
  }, [winner, spectating, recordMatchCompletion]);

  /**
   * The last door out of a pending result, so Rematch cannot be waiting on a
   * request that is never going to answer.
   *
   * Keyed on `winner` ALONE and on nothing rebuilt per render. App re-renders
   * once per animation frame while a ball is in play, so an effect depending
   * on a callback tears its timer down and re-arms it sixty times a second and
   * never fires — which is how the achievement toast once outlived its match,
   * the overlay and the menu after it (convention §14).
   */
  useEffect(() => {
    if (!winner) {
      setRecordTimedOut(false);
      return;
    }
    const id = window.setTimeout(() => setRecordTimedOut(true), RESULT_WAIT_MS);
    return () => window.clearTimeout(id);
  }, [winner]);

  /**
   * Whether the overlay has something to say about this match yet.
   *
   * A watcher settles immediately: they record nothing, so there is no result
   * coming and nothing for their Rematch — which they do not have — to wait on.
   */
  const resultSettled = !!lastMatchResult || toastRecordFailed || recordTimedOut || !!spectating;

  // Daily Mission Claim Handler
  const handleClaimMissionReward = async (missionId: string) => {
    try {
      const res = await fetch('/api/missions/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missionId }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Already claimed or not finished — refresh so the UI matches truth.
        void refreshMissions();
        return;
      }
      if (data.profile) setProfile(data.profile);
      if (data.missions) setMissions(data.missions);
      if (data.rerolls) setRerolls(data.rerolls);
      if (data.unlocked) setToastUnlocks((prev) => [...prev, normalizeCosmeticId(data.unlocked)]);
    } catch (e) {
      console.error('Failed to claim mission reward', e);
      setToastActionFailed(true);
    }
  };

  // Swap one mission for another from its pool, spending a reroll of its tier.
  const handleRerollMission = async (missionId: string) => {
    try {
      const res = await fetch('/api/missions/reroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missionId }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Out of rerolls, or the mission finished under us — resync either way.
        if (data?.rerolls) setRerolls(data.rerolls);
        void refreshMissions();
        return;
      }
      if (data.missions) setMissions(data.missions);
      if (data.rerolls) setRerolls(data.rerolls);
    } catch (e) {
      console.error('Failed to reroll mission', e);
      setToastActionFailed(true);
    }
  };

  // Quick Chat Send Handler
  const handleSendQuickChat = (text: string) => {
    const msgId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const myName = profile?.username || t('you', currentLanguage);

    const newMsg: ChatMessage = {
      id: msgId,
      text,
      senderName: myName,
      isSelf: true,
      timestamp: Date.now(),
    };

    setActiveChatMessages((prev) => [...prev.slice(-3), newMsg]);

    // Send to the opponent (P2P when linked, relay otherwise) in multiplayer
    if (mode === 'multiplayer') {
      sendNetRef.current({
        type: 'quick_chat',
        text,
        senderName: myName,
      });
    } else if (mode === 'solo') {
      // Simulate friendly AI response in solo mode after a small delay
      setTimeout(() => {
        const aiReplies = [
          'Nice shot! 👏',
          'Good game! 🤝',
          'What a save! 🛡️',
          'Close one! ⚡',
          "Let's go! 🔥",
        ];
        const randomReply = aiReplies[Math.floor(Math.random() * aiReplies.length)];
        const aiMsg: ChatMessage = {
          id: `ai_chat_${Date.now()}`,
          text: randomReply,
          senderName: `AI (${activeDifficulty})`,
          isSelf: false,
          timestamp: Date.now(),
        };
        setActiveChatMessages((prev) => [...prev.slice(-3), aiMsg]);
        sound.playBallIncoming();
      }, 1000);
    }
  };

  // Auto remove expired chat messages after 3.5s
  useEffect(() => {
    if (activeChatMessages.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setActiveChatMessages((prev) => prev.filter((m) => now - m.timestamp < 3500));
    }, 500);
    return () => clearInterval(timer);
  }, [activeChatMessages]);

  // Hold the match settings to what this profile has actually earned.
  //
  // Settings live on the device and the achievements that unlock them live on
  // the server, so the two drift: a wipe clears the achievements while
  // localStorage keeps the difficulty they opened, and the shipped default was
  // itself a locked one. Either way the menu drew the option as locked and
  // played it regardless, and every resulting solo match came back 403
  // DIFFICULTY_LOCKED and was thrown away. Correcting the SETTING is what
  // fixes it — refusing to record is the server being right.
  useEffect(() => {
    if (!profile) return;
    const earned = profile.achievements || [];
    setSettings((s) => {
      const difficulty = playableDifficulty(earned, s.difficulty);
      const winningScore = playableWinningScore(earned, s.winningScore);
      if (difficulty === s.difficulty && winningScore === s.winningScore) return s;
      return { ...s, difficulty, winningScore };
    });
  }, [profile?.achievements, profile?.id]);

  // Persist settings & sync audio volume engine
  useEffect(() => {
    localStorage.setItem('half_pong_settings', JSON.stringify(settings));
    sound.setEnabled(settings.soundEnabled);
    sound.setSfxVolume((settings.sfxVolume ?? 80) / 100);
    sound.setBgmVolume((settings.bgmVolume ?? 50) / 100);
    aiRef.current.setDifficulty(activeDifficulty);
  }, [settings, activeDifficulty]);

  // Feed the AI the player's hidden rating so each difficulty slides part-way
  // toward them — Pro stays a real contest at any skill instead of a wall.
  useEffect(() => {
    aiRef.current.setPlayerSkill(profile?.mmrMu ?? START_MU);
  }, [profile?.mmrMu]);

  // Track Player Status (Online / Idle / Offline)
  useEffect(() => {
    let idleTimer: number;

    const markActive = () => {
      if (!navigator.onLine) {
        setPlayerStatus('offline');
        return;
      }
      setPlayerStatus('online');
      clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        setPlayerStatus('idle');
      }, 30000); // 30s of inactivity triggers idle
    };

    const handleOnline = () => setPlayerStatus('online');
    const handleOffline = () => setPlayerStatus('offline');
    const handleVisibility = () => {
      if (document.hidden) {
        setPlayerStatus('idle');
      } else {
        markActive();
      }
    };

    markActive();
    window.addEventListener('mousemove', markActive);
    window.addEventListener('keydown', markActive);
    window.addEventListener('touchstart', markActive);
    window.addEventListener('pointerdown', markActive);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearTimeout(idleTimer);
      window.removeEventListener('mousemove', markActive);
      window.removeEventListener('keydown', markActive);
      window.removeEventListener('touchstart', markActive);
      window.removeEventListener('pointerdown', markActive);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  // An invitation link or QR (?room=CODE). Held here rather than acted on
  // immediately: a player arriving on one may have no identity yet, and the
  // relay stamps a seat's display name at join time — so joining first and
  // onboarding second seats them under their Paddle-XXXX placeholder for the
  // life of the room, which is what the host then sees instead of their name.
  // The auto-join effect below waits for the profile and then joins for them.
  const pendingRoomRef = useRef<string | null>(null);
  const autoJoinedRef = useRef<boolean>(false);
  // A join is now dispatched by the auto-join as well as by the lobby button,
  // and the lobby still renders that button for the moment before room_joined
  // lands. A second join_room on the same socket is answered "Room is already
  // full" — about the room this player is in the middle of joining — so the
  // first attempt holds the door until the server has answered either way.
  const joinInFlightRef = useRef<boolean>(false);
  /**
   * A seat has been ASKED FOR and the relay has not answered yet.
   *
   * Distinct from roomId, which is only set once the answer lands, and from
   * joinInFlightRef, which is about not sending a second join. This one exists
   * because that window looks exactly like being on the menu — the lobby can
   * be dismissed in it without a confirmation, and nothing else on screen says
   * a request is outstanding. The tour used to be startable from inside it,
   * and the seat then arrived underneath a running tour that walks away from
   * it (see startTour and room_created).
   */
  const roomRequestRef = useRef<boolean>(false);
  // An invitation that loses its socket before the server has answered is not
  // a refusal — it is an unanswered question, and latching autoJoinedRef on
  // the ATTEMPT turned every such blip into "the link is broken". Bounded, so
  // a genuinely unreachable relay stops rather than spinning.
  const inviteRetriesRef = useRef<number>(0);
  // Sockets the relay refused because this page held no live session. Bounded
  // separately from the retries above: those are for a flaky relay, these are
  // for a session that is one round trip from being fixed, and charging one to
  // the other is what turned a recoverable blip into a dead invitation.
  const sessionRefusedJoinRef = useRef<boolean>(false);
  const sessionRejoinsRef = useRef<number>(0);
  const [inviteRetry, setInviteRetry] = useState<number>(0);
  useEffect(() => {
    const roomCode = new URLSearchParams(window.location.search).get('room');
    if (roomCode) pendingRoomRef.current = roomCode.trim().toUpperCase();
  }, []);

  // Handle paddle movement. The paddle's VELOCITY is not computed here: a
  // pointermove is delivered once per animation frame, so a per-event delta
  // reads half the true speed on a 120Hz phone and a stale saturated value
  // forever once the finger stops moving. It is sampled per frame in the game
  // loop instead, the same way the AI does it (`physics.ts`).
  const handlePaddleMove = useCallback((newX: number) => {
    setPaddleX(newX);

    // Send position to multiplayer opponent
    if (modeRef.current === 'multiplayer') {
      sendNetRef.current({ type: 'paddle_move', x: newX });
    }
  }, []);

  // Serve the ball
  const handleServe = useCallback(
    (aim?: ServeAim) => {
      if (!isServingRef.current) return;
      // A watcher has no ball. Their isServing mirrors the player beside them,
      // which is what makes the fan-out work and would otherwise let the
      // space bar or the auto-serve timer spawn a phantom on somebody else's
      // court. The last line of three: the canvas is readOnly, so its pointer
      // and keyboard handlers are gone, and the timer above is gated too.
      if (spectatingRef.current) return;
      // A duel's serve needs someone on the other end. Nobody reaches the
      // court without a match now, so this is defence rather than the thing
      // doing the work — but it is cheap, and it is what stops a serve firing
      // into a room whose opponent left between the whistle and the tap.
      if (modeRef.current === 'multiplayer' && !opponentIdRef.current) return;
      // And no serve of any kind before or under the start countdown.
      if (
        modeRef.current === 'multiplayer' &&
        (countdownArmedRef.current || (matchCountdownRef.current ?? 0) > 0)
      ) {
        return;
      }
      setIsServing(false);
      isServingRef.current = false;
      setWinner(null);
      setLastMatchResult(null);

      const rules = rulesRef.current;
      // A plain tap keeps the old feel: a little random drift, medium power.
      const launch = serveVelocity(
        aim ?? { angle: (Math.random() - 0.5) * 0.5, power: 0.5 },
        rules
      );

      servedThisPointRef.current = isPlayerServer;
      if (isPlayerServer) {
        // Serve starts from player's paddle heading UP towards net
        setBall({
          x: paddleXRef.current,
          y: SERVE_BALL_Y,
          vx: launch.vx,
          vy: launch.vy,
          radius: ballRadiusRef.current,
          active: true,
        });
        setOppBall(null);
      } else {
        // Opponent is serving: Ball starts in opponent's half
        setBall((b) => ({ ...b, active: false }));
        if (modeRef.current === 'solo') {
          // The AI serves the way it plays: away from where the player is
          // standing, harder and more committed the better it is.
          const aiLaunch = serveVelocity(
            aiServeAim(aiRef.current.competence(), paddleXRef.current),
            rules
          );
          setOppBall({
            // Out of the middle of its OWN paddle, the same rule the player's
            // serve obeys — it used to launch from a hardcoded centre no
            // matter where the AI was actually standing.
            x: aiRef.current.paddleX,
            y: SERVE_BALL_Y,
            vx: aiLaunch.vx,
            vy: aiLaunch.vy,
            radius: ballRadiusRef.current,
            active: true,
          });
        }
      }
    },
    [isPlayerServer]
  );

  // An armed countdown starts the moment this player is on the court with the
  // lobby out of the way — which `game_start` now does in one step, and which
  // is the moment they can first see it. Kept as a guarded effect rather than
  // folded into that handler because a rematch and a P2P-agreed restart reach
  // it by their own paths.
  useEffect(() => {
    if (!countdownArmed) return;
    if (mode !== 'multiplayer' || screen !== 'game' || isMultiplayerOpen) return;
    setCountdownArmed(false);
    setMatchCountdown(MATCH_START_COUNTDOWN_SECONDS);
  }, [countdownArmed, mode, screen, isMultiplayerOpen]);

  // The start countdown's clock. game_start arms it; it walks itself to zero.
  useEffect(() => {
    if (matchCountdown === null) return;
    if (matchCountdown <= 0) {
      setMatchCountdown(null);
      return;
    }
    const t = setTimeout(() => setMatchCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [matchCountdown]);

  // Auto-serve: when the rules set a timer, a serve the player is sitting on
  // fires by itself so a PvP match can't stall on someone who put their phone
  // down. The countdown is surfaced on the court so it never feels arbitrary.
  const [serveCountdown, setServeCountdown] = useState<number | null>(null);
  useEffect(() => {
    const seconds = activeConfig.rules.autoServeSeconds;
    // In a duel the timer must not tick before there is a match to serve
    // INTO: an opponent in the room, and this player out of the lobby.
    // Hosting used to arm it the moment the room existed, so a host who set
    // auto-serve while waiting had the game "begin" against nobody.
    const duelReady =
      mode !== 'multiplayer' ||
      (opponentId !== null &&
        !isMultiplayerOpen &&
        !countdownArmed &&
        (matchCountdown ?? 0) <= 0);
    // Never for a watcher. Their `isServing`/`isPlayerServer` mirror the
    // player they are sitting beside — that is what makes the whole fan-out
    // work — so without this the timer would fire a serve on a court they do
    // not own, spawning a phantom ball the relay then refuses.
    const active =
      !spectating &&
      isServing && isPlayerServer && screen === 'game' && !winner && duelReady;
    if (!active || seconds <= 0) {
      setServeCountdown(null);
      return;
    }
    setServeCountdown(seconds);
    let left = seconds;
    const tick = setInterval(() => {
      left -= 1;
      setServeCountdown(left);
      if (left <= 0) {
        clearInterval(tick);
        handleServe();
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [
    isServing,
    isPlayerServer,
    screen,
    winner,
    mode,
    opponentId,
    isMultiplayerOpen,
    countdownArmed,
    matchCountdown,
    activeConfig.rules.autoServeSeconds,
    spectating,
    handleServe,
  ]);

  // Solo only: the AI has no finger to tap with. When the rules hand it the
  // serve (the AI missed the last point), serve on its behalf after a short
  // beat — otherwise the match waits forever on a prompt nobody sees.
  // (Practice Wall has no opponent at all: the player always serves.)
  useEffect(() => {
    if (mode !== 'solo' || screen !== 'game') return;
    if (!isServing || isPlayerServer || winner) return;
    const delayMs =
      aiServeDelay(
        aiRef.current.competence(),
        playerPressure({
          playerScore: statsRef.current.score,
          opponentScore: statsRef.current.opponentScore,
          maxRally: statsRef.current.bestStreak,
        })
      ) * 1000;
    const timer = setTimeout(() => handleServe(), delayMs);
    return () => clearTimeout(timer);
  }, [mode, screen, isServing, isPlayerServer, winner, handleServe]);

  // Build (or rebuild) the P2P link for the current room. The host creates
  // the offer; the guest side is created lazily when the first offer arrives.
  const createP2PLink = (asHost: boolean): P2PGameLink => {
    p2pRef.current?.close();
    const myIdx = (playerIndexRef.current ?? (asHost ? 0 : 1)) as 0 | 1;
    const myName = profileRef.current?.username || `Player ${myIdx + 1}`;
    const theirName = opponentName || `Player ${myIdx === 0 ? 2 : 1}`;
    const playerNames: [string, string] = myIdx === 0 ? [myName, theirName] : [theirName, myName];

    const link = new P2PGameLink({
      myIndex: myIdx,
      playerNames,
      iceServers: rtcConfigRef.current,
      config: configRef.current,
      sendSignal: (payload) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'rtc_signal', payload }));
        }
      },
      onMessage: (m) => dispatchRef.current(m),
      // The relay sees nothing of a P2P match otherwise. This is what keeps
      // its room state — and so the recorded result, the abandon check and the
      // settings lock — in step with what the two phones actually played.
      onMatchSync: (sync) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'match_sync', ...sync }));
        }
      },
      onStatus: (s: P2PStatus) => {
        if (s === 'p2p') {
          setLinkStatus('p2p');
        } else if (s === 'closed') {
          if (p2pRef.current === link) p2pRef.current = null;
          setLinkStatus('relay');
        }
      },
    });
    p2pRef.current = link;
    setLinkStatus('connecting');
    return link;
  };

  // All server-shaped messages (from the WebSocket relay AND synthesized by
  // the P2P link) land here. Defined fresh each render and published through
  // dispatchRef so handlers never see stale state.
  const handleServerMessage = (msg: WSServerMessage) => {
    switch (msg.type) {
      case 'room_created':
        roomRequestRef.current = false;
        // Same rule as room_joined below, and it was missing here: asking for
        // a room and being given one are separate moments, and the lobby can
        // be dismissed in between — before roomId is set, so that dismissal is
        // a plain one and asks nothing, which is what leaves the host with no
        // way back to a room the relay is still holding.
        // ...unless the relay seated this player out of the QUEUE, where the
        // sheet would flash for the one round trip before game_start replaces
        // it anyway.
        setIsMultiplayerOpen(!queueSeatingRef.current);
        setRoomId(msg.roomId);
        setPlayerIndex(msg.playerIndex);
        playerIndexRef.current = msg.playerIndex;
        setMode('multiplayer');
        // Deliberately NOT setScreen('game'). Holding a seat is not playing a
        // match: the court belongs to the match, and until one starts there is
        // nothing on it — no serve to take (handleServe needs an opponent), no
        // physics to run, and nothing for the player to do but watch a ball
        // that is not there. `game_start` is what walks both phones onto it.
        p2pRef.current?.close();
        p2pRef.current = null;
        setLinkStatus('relay');
        break;

      case 'room_joined':
        // Answered. Stop treating a later disconnect as an unfulfilled invite.
        pendingRoomRef.current = null;
        joinInFlightRef.current = false;
        roomRequestRef.current = false;
        // Holding a seat means the lobby is the right surface until the match
        // starts, so a seat granted while the lobby is shut reopens it. The
        // player can dismiss the lobby in the moment between asking for a seat
        // and being given one, and this case then put them on a live court
        // with no Ready control — holding the room while the host waited for a
        // readiness they had no way to signal.
        setIsMultiplayerOpen(!queueSeatingRef.current); // see room_created
        setRoomId(msg.roomId);
        setPlayerIndex(msg.playerIndex);
        playerIndexRef.current = msg.playerIndex;
        setOpponentName(msg.opponentName);
        setOpponentId(msg.opponentId);
        setMode('multiplayer');
        // Not onto the court — see room_created.
        p2pRef.current?.close();
        p2pRef.current = null;
        setLinkStatus('relay');
        break;

      case 'opponent_joined':
        setOpponentName(msg.opponentName);
        setOpponentId(msg.opponentId);
        sound.playScore();
        // Host offers a direct connection; gameplay stays on the relay until
        // (unless) the DataChannels open.
        //
        // Not at a table with watching seats open: a P2P match never reaches
        // the relay — paddles, balls and points all travel the DataChannel —
        // so there would be nothing for a watcher to be shown. This is a
        // hint, not the boundary: the relay refuses rtc_signal for such a
        // table, which is what a modified client cannot get past.
        if (p2pEnabled && !roomConfig?.spectators) {
          createP2PLink(true)
            .startAsHost()
            .catch((e) => console.warn('P2P offer failed, staying on relay:', e));
        }
        break;

      case 'rtc_signal':
        if (!p2pRef.current && msg.payload.kind === 'offer') {
          createP2PLink(false);
        }
        p2pRef.current?.handleSignal(msg.payload);
        break;

      case 'room_config':
        setRoomConfig(msg.config);
        p2pRef.current?.setConfig(msg.config);
        break;

      case 'ready_state':
        setLobbyReady(msg.ready);
        break;

      case 'game_start':
        // The terms ride along with every start, so a phone can never begin a
        // match on a ruleset it was not told about. So does the room's match
        // number: it is how the result this match produces is filed against
        // THIS match and not the rematch that follows it.
        matchSeqRef.current = msg.matchSeq ?? matchSeqRef.current + 1;
        // Mint the duel's matchKey HERE, while the room is certainly known,
        // rather than at the whistle: a leave or ejection racing the final
        // point can null `roomId` before the recording effect runs, and a
        // whistle-time mint then produced a solo-shaped key the server could
        // not re-derive — a second record of the same seat, paid twice. The
        // P2P replica synthesizes this same message for a peer-agreed
        // rematch, so its locally counted matchSeq lands here too.
        matchKeyRef.current = roomId ? duelMatchKey(roomId, matchSeqRef.current) : '';
        shownMatchKeyRef.current = '';
        setRoomConfig(msg.config);
        p2pRef.current?.setConfig(msg.config);
        setStats((s) =>
          startMatchStreaks(
            { ...s, score: 0, opponentScore: 0, aces: 0, matchesWon: 0 },
            // The relay's number, not the profile's: it seeded the seat from
            // the store and it is what this match will be recorded on, so a
            // phone that disagrees is a phone showing something else.
            (playerIndexRef.current !== null ? msg.streaks?.[playerIndexRef.current] : undefined) ??
              carriedStreak('multiplayer'),
            // The other seat's, for the telemetry overlay. Shown, never
            // counted: what the opponent is paid and rated on is their own
            // phone's business and the relay's.
            msg.streaks?.[playerIndexRef.current === 0 ? 1 : 0] ?? 0
          )
        );
        setTotalTouches(0);
        setMatchStartTime(Date.now());
        setIsPlayerServer(msg.servingPlayer === playerIndexRef.current);
        setIsServing(true);
        setWinner(null);
        setOppBall(null);
        setLastMatchResult(null);
        setRematchVotes([false, false]);
        setMatchCountdown(null);
        setCountdownArmed(true);
        setLobbyReady([false, false]);
        setTelemetryOpen(false);
        // The one way onto the court, and the only one. The host starting the
        // match is what closes BOTH lobbies AND puts both phones on it: a
        // player setting up a match is not playing one, and used to be stood
        // on a live court behind the lobby sheet — a ball waiting on them
        // while they picked a winning score. For a queue match the relay is
        // the host, and this is where the search ends.
        setMode('multiplayer');
        setScreen('game');
        setIsMultiplayerOpen(false);
        queueSeatingRef.current = false;
        quickMatchRef.current?.reset();
        setIsServing(true);
        p2pRef.current?.resetMatchState(msg.servingPlayer, matchSeqRef.current, msg.streaks);
        break;

      case 'opponent_paddle':
        // Arrives pre-mirrored (1 − x) from the relay/P2P link. The radar
        // applies the head-to-head mirror itself — the same one it applies to
        // the solo AI's paddle — so what it needs stored is the SENDER-frame
        // position. Storing the pre-mirrored value double-mirrored the paddle
        // onto the wrong side of the sonar.
        oppPaddleXRef.current = 1 - msg.x;
        setOppPaddleX(1 - msg.x);
        break;

      case 'opponent_ball':
        // The opponent's phone streaming its live ball for the sonar, in the
        // sender's frame — the radar mirrors, exactly as it does in solo.
        // Our own ball being live proves the sample stale (the stream rides
        // the unordered fast channel, so one can trail the ball_incoming that
        // handed the ball to us), and it is dropped rather than shown.
        // Must go through state, not the ref: the per-render ref sync would
        // clobber a direct ref write with the older state on the next render.
        if (ballRef.current.active) break;
        oppBallSeenRef.current = performance.now();
        setOppBall({
          x: msg.x,
          y: msg.y,
          vx: 0,
          vy: 0,
          radius: ballRadiusRef.current,
          active: true,
        });
        break;

      case 'ball_incoming': {
        // Ball crossed the net on opponent's phone and arrived here!
        // A ball arriving IS the signal that play is live: after every
        // score_update both phones sit in "serving" state (which gates the
        // physics loop), and only the serving player's tap clears it locally.
        // Without clearing it here, the receiver's loop stays gated and the
        // incoming serve freezes at the net.
        setIsServing(false);
        isServingRef.current = false;
        // The ball is on OUR half now — the sonar shows the half we can't
        // see, so whatever the opponent's stream last drew is over.
        setOppBall(null);
        const inc = msg.ball;
        setBall({
          x: inc.x,
          y: 0.02,
          vx: inc.vx,
          vy: inc.vy,
          radius: ballRadiusRef.current,
          active: true,
          // The server mirrors spin across the net (server/transform.ts), so a
          // ball that was curving right on their screen curves right on ours.
          spin: inc.spin || 0,
          speedMultiplier: inc.speedMultiplier,
        });
        // The opponent put this ball over, so it is THEIR return and their
        // streak — except when it is their serve, which opens the point
        // rather than continuing one. Same rule the relay applies to a
        // ball_cross_net; the client tracks it too so the HUD can show both
        // streaks without waiting to be told.
        {
          const isOppServe = oppCrossingsThisPointRef.current === 0 && !isPlayerServerRef.current;
          oppCrossingsThisPointRef.current += 1;
          if (!isOppServe) setStats(opponentReturn);
        }
        break;
      }

      case 'score_update': {
        // Between points the ball is nowhere, so the sonar goes dark on both
        // phones — the same thing the solo sim does when a point ends.
        setOppBall(null);
        const myIdx = playerIndexRef.current;
        if (myIdx === 0) {
          setStats((s) => applyDuelPoint(s, msg.p1Score, msg.p2Score));
          if (msg.p1Score >= configRef.current.winningScore) {
            setWinner('player');
            confetti({ particleCount: 100, spread: 80, origin: { y: 0.6 } });
          } else if (msg.p2Score >= configRef.current.winningScore) {
            setWinner('opponent');
          } else {
            setIsPlayerServer(msg.nextServer === 0);
            setIsServing(true);
          }
        } else {
          setStats((s) => applyDuelPoint(s, msg.p2Score, msg.p1Score));
          if (msg.p2Score >= configRef.current.winningScore) {
            setWinner('player');
            confetti({ particleCount: 100, spread: 80, origin: { y: 0.6 } });
          } else if (msg.p1Score >= configRef.current.winningScore) {
            setWinner('opponent');
          } else {
            setIsPlayerServer(msg.nextServer === 1);
            setIsServing(true);
          }
        }
        break;
      }

      case 'quick_chat': {
        // Display opponent's speech bubble!
        const chatItem: ChatMessage = {
          id: `opp_chat_${Date.now()}`,
          text: msg.text,
          senderName: msg.senderName || opponentName || 'Opponent',
          isSelf: false,
          timestamp: Date.now(),
        };
        setActiveChatMessages((prev) => [...prev.slice(-3), chatItem]);
        sound.playBallIncoming();
        break;
      }

      case 'queue_state':
        // The relay seats a found pair itself, so `found` is a beat rather
        // than a prompt: the room messages are already on their way behind it.
        if (msg.status === 'found') queueSeatingRef.current = true;
        quickMatchRef.current?.apply(msg);
        break;

      case 'table_state': {
        setTableState({
          seats: msg.seats,
          yourSeat: msg.yourSeat,
          spectatorsEnabled: msg.spectatorsEnabled,
          isPrivate: msg.isPrivate,
          joinKey: msg.joinKey,
          venueRoomId: msg.venueRoomId,
        });
        const watchingSeat = msg.yourSeat !== null && msg.yourSeat >= 2;
        if (watchingSeat) {
          const side: 0 | 1 = msg.yourSeat === 3 ? 1 : 0;
          // A watcher never receives room_created or room_joined, so this is
          // where they learn which table they are at — and where they become,
          // for every handler below, the player they are sitting beside.
          setSpectating({ roomId: msg.roomId, side });
          setRoomId(msg.roomId);
          setPlayerIndex(side);
          playerIndexRef.current = side;
          setOpponentName(msg.seats[side === 0 ? 1 : 0]?.playerName ?? null);
          setOpponentId(msg.seats[side === 0 ? 1 : 0]?.playerId ?? null);
          setMode('multiplayer');
          // Not onto the court, for the same reason a player is not: a table
          // with no match on it has nothing to watch, and the seat map is the
          // useful surface until it does. `game_start` walks everyone at the
          // table on at once; `spectator_sync` below does it for somebody who
          // sat down at a match already in progress.
          //
          // Nothing peer-to-peer for a watcher: the relay is the only thing
          // that can see this table at all.
          p2pRef.current?.close();
          p2pRef.current = null;
          setLinkStatus('relay');
        } else if (msg.yourSeat !== null) {
          // Playing. Kept in step because a seat can change hands.
          setSpectating(null);
        }
        break;
      }

      case 'spectator_sync': {
        // Sitting down mid-match: the relay is the only party that knows where
        // it got to, so without this the court would render 0-0 until the next
        // point happened to arrive.
        const snap = msg.snapshot;
        const side = spectatingRef.current?.side ?? playerIndexRef.current ?? 0;
        const mine = side === 0 ? snap.p1Score : snap.p2Score;
        const theirs = side === 0 ? snap.p2Score : snap.p1Score;
        setRoomConfig(snap.config);
        matchSeqRef.current = snap.matchSeq;
        setStats((s) => ({ ...s, score: mine, opponentScore: theirs }));
        setIsPlayerServer(snap.servingPlayer === side);
        setWinner(null);
        // Sitting down at a table with a match already ON it: there is
        // something to watch, so the court is the surface. A table between
        // matches keeps its lobby, which is where the seats are — and the
        // next `game_start` walks this watcher on with everybody else.
        if (snap.matchSeq > 0 && !snap.matchOver) {
          setIsMultiplayerOpen(false);
          setScreen('game');
        }
        break;
      }

      case 'watched_paddle':
        // RAW — no mirror. This is the watched player's OWN paddle on the
        // watched player's OWN court, which is the court being drawn. The
        // `1 - x` that belongs on `opponent_paddle` would put it on the wrong
        // side here, and against a paddle at 0.5 that mistake is invisible.
        setPaddleX(msg.x);
        break;

      case 'watched_ball': {
        // Twenty samples a second, deliberately not more: raising the rate for
        // a watched table would spend the PLAYERS' bandwidth on somebody
        // else's view. The velocity is derived from the last two samples
        // rather than assumed, so a wall bounce or a paddle hit is followed
        // without the watcher knowing any physics; the loop dead-reckons
        // between them so the ball glides rather than steps.
        const now = performance.now();
        const prev = watchedBallRef.current;
        const dt = prev ? Math.max(0.016, (now - prev.t) / 1000) : 0;
        const vx = prev && dt < 0.5 ? (msg.x - prev.x) / dt : 0;
        const vy = prev && dt < 0.5 ? (msg.y - prev.y) / dt : 0;
        watchedBallRef.current = { x: msg.x, y: msg.y, t: now };
        setOppBall(null);
        setBall({
          x: msg.x,
          y: msg.y,
          vx,
          vy,
          radius: ballRadiusRef.current,
          active: true,
          spin: 0,
          speedMultiplier: 1,
        });
        break;
      }

      case 'watched_ball_left':
        // The ball has left this half. A watcher has no physics to run it out
        // with, so it is told outright rather than left drawing a ball that is
        // no longer there.
        watchedBallRef.current = null;
        setBall((b) => ({ ...b, active: false }));
        break;

      case 'match_prediction':
        setMatchPrediction(msg.winProbability);
        break;

      case 'rematch_state':
        setRematchVotes(msg.votes);
        break;

      case 'match_recorded':
        // The relay recorded this duel onto BOTH players' profiles from the
        // score it owns, and this is our copy of it. It arrives whether or not
        // our own POST ever lands — which is the point: a phone that dies on
        // the final point no longer loses the match it just played.
        applyMatchResult(msg.matchKey, msg.result, 'relay');
        break;

      case 'session_invalid':
        // The relay refused this socket: the account is held by another
        // device now. The heartbeat would reach the same conclusion within
        // seconds, but the relay already knows, so act on it immediately —
        // this is the duel half of the same eviction the REST routes enforce.
        setSessionStatus(msg.status);
        // `none` is the one refusal that says nothing about the account: this
        // page simply had no live session at the moment it asked (a sibling
        // tab handed it back, or it had not landed yet). It is recoverable in
        // place, and the close that follows must NOT spend one of the
        // invitation's two retries on it — three refusals arrive inside a few
        // milliseconds, so a blink of session churn ate the whole budget and
        // the link died in silence. Re-mint, then ask for the seat again.
        if (msg.status === 'none') {
          sessionRefusedJoinRef.current = true;
          void adoptSessionRef.current();
        }
        break;

      case 'p2p_fallback':
        // The relay has started counting this match itself, which means the
        // other phone's DataChannel is gone. Ours may still look open — a link
        // does not die for both peers at the same instant — and playing on
        // over it means playing against somebody who is no longer receiving
        // us, while reporting a replica the relay has already overtaken. Drop
        // to the relay; gameplay continues there, which is what the fallback
        // has always been for.
        p2pRef.current?.close();
        p2pRef.current = null;
        setLinkStatus('relay');
        break;

      case 'opponent_left': {
        setMatchPrediction(null);
        setOpponentName(null);
        setOpponentId(null);
        setRematchVotes([false, false]);
        p2pRef.current?.close();
        p2pRef.current = null;
        setLinkStatus('relay');
        // A disconnect mid-match leaves this player alone on a court where no
        // point can ever be scored again — so they are returned to the menu
        // with a notice, instead of a blocking alert() over a dead court.
        // Two cases deliberately do NOT bounce: the winner overlay is up (the
        // match finished; let them read it — the rematch button disables
        // itself), and the lobby is still open (a host goes back to waiting
        // for the next opponent, which is what the lobby is for).
        //
        // That second case is about a HOST. For a guest it is the opposite:
        // seat 0 is only ever filled by create_room, so a room whose host has
        // gone can never have one again — join_room fills seat 1 and
        // start_match is refused to anyone but seat 0. Left in the lobby, the
        // guest waits on a room that cannot start, with nothing on screen to
        // say so. They are sent back with the same notice a mid-match
        // departure gets, which also empties the room behind them.
        const strandedGuest = isMultiplayerOpen && playerIndexRef.current === 1;
        const midMatch = !winner && !isMultiplayerOpen && screenRef.current === 'game';
        if (midMatch || strandedGuest) {
          // The relay records an abandoned duel as this player's WIN and
          // pushes it just before this message, so say so rather than
          // reporting only the disconnection: the match they were in the
          // middle of is on their record, not lost with the opponent.
          const wonByAbandon =
            midMatch && !!matchKeyRef.current && shownMatchKeyRef.current === matchKeyRef.current;
          setToastOpponentLeft(wonByAbandon ? 'won' : 'plain');
          handleLeaveRoom();
        }
        break;
      }

      case 'pong':
        setPingMs(Date.now() - msg.timestamp);
        setPingAt(Date.now());
        break;

      case 'error':
        // The server answered — a dead or full room is a verdict, not a blip.
        pendingRoomRef.current = null;
        joinInFlightRef.current = false;
        roomRequestRef.current = false;
        // A toast, in the player's own language, rather than `alert()`. The
        // dialog was blocking — it halts the animation loop until it is
        // dismissed, over a full-screen game — and it carried the relay's own
        // English literal, so six of seven locales read English on what is the
        // most common error path in the product: mistyping a join key. Notices
        // that arrive and leave by themselves go through ToastHost, which owns
        // the timer and the tap target (CLAUDE.md §14).
        setToastRelayError(relayErrorText(msg, settingsRef.current.language || 'en'));
        break;
    }
  };
  dispatchRef.current = handleServerMessage;

  // WebSocket Connection Lifecycle
  const connectWebSocket = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const socket = new WebSocket(wsUrl);

    // Prefetch ICE servers so the P2P link can be created synchronously later
    if (!rtcConfigRef.current) {
      fetch('/api/rtc-config')
        .then((r) => r.json())
        .then((cfg) => {
          if (Array.isArray(cfg?.iceServers)) rtcConfigRef.current = cfg.iceServers;
        })
        .catch(() => {});
    }

    socket.onopen = () => {
      setIsConnected(true);
      // Periodic ping
      const pingInterval = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }
      }, 5000);
      socket.addEventListener('close', () => clearInterval(pingInterval));
    };

    socket.onmessage = (event) => {
      try {
        const msg: WSServerMessage = JSON.parse(event.data);
        dispatchRef.current(msg);
      } catch (err) {
        console.error('WS parse error:', err);
      }
    };

    socket.onclose = () => {
      setIsConnected(false);
      // A queue place is held by the socket, so a socket that dies has given
      // it up — the relay's own close handler calls `leaveQueue`. Without
      // this the search UI kept counting against a queue this player was no
      // longer in.
      if (quickMatchRef.current?.state.status === 'searching') {
        quickMatchRef.current.reset();
        setToastActionFailed(true);
      }
      // A dead socket answers nothing, so any join waiting on one is over —
      // released here rather than in handleJoinRoom, which stops watching the
      // moment it sends. A socket that dies after `join_room` goes out but
      // before `room_joined` or `error` comes back would otherwise latch the
      // guard for good, and every later Join would return early without even
      // opening a replacement socket.
      joinInFlightRef.current = false;
      roomRequestRef.current = false;
      // The socket dying UNDER a live duel means this player was ejected —
      // the relay has already recorded the abandon and told the opponent.
      // A deliberate leave sets the flag first and lands here silently.
      if (intentionalCloseRef.current) {
        intentionalCloseRef.current = false;
        return;
      }
      // The invitation is still outstanding: this socket never produced a
      // room_joined or an error, so ask again on a fresh one.
      if (pendingRoomRef.current) {
        // Which budget this close comes out of depends on why the socket
        // died. A session refusal is charged to its own allowance, because
        // re-minting is already under way and the next attempt is very likely
        // to be seated; anything else is the relay being unreachable.
        const sessionRefusal = sessionRefusedJoinRef.current;
        sessionRefusedJoinRef.current = false;
        const budgetLeft = sessionRefusal
          ? sessionRejoinsRef.current < MAX_INVITE_SESSION_REJOINS
          : inviteRetriesRef.current < MAX_INVITE_RETRIES;
        if (budgetLeft) {
          if (sessionRefusal) sessionRejoinsRef.current += 1;
          else inviteRetriesRef.current += 1;
          autoJoinedRef.current = false;
          setInviteRetry((n) => n + 1);
        } else {
          // Out of attempts. The link is what the player was handed, so it
          // owes them an answer rather than a menu that quietly ate it.
          pendingRoomRef.current = null;
          setToastInviteFailed(true);
        }
      }
      // Anything the relay was holding a seat for. This used to require an
      // opponent AND a live court, which missed exactly the case the unpaired
      // TTL exists for: a host waiting alone, whose room the reaper deletes
      // and whose socket it closes. They were left sitting in a lobby showing
      // a room code that no longer resolved, so a friend typing it got "room
      // not found" while the host still believed they were hosting. A guest
      // who has joined but not yet started is the same shape — a seat, and no
      // court yet. A deliberate leave returned above; this is the rest.
      if (roomIdRef.current) {
        // Two different things to say. Mid-match the relay has recorded an
        // abandon and told the opponent, so "removed from the match" is the
        // truth. Alone in a lobby there was never a match to be removed from.
        // Three things to say, not two. Mid-match the relay has recorded an
        // abandon and told the opponent, so "removed from the match" is the
        // truth; alone in a lobby there was never a match to be removed from;
        // and a WATCHER was never in a match at all, so an abandon notice
        // would be about something that did not happen to them.
        const notice = spectatingRef.current
          ? setToastTableEnded
          : opponentIdRef.current
            ? setToastEjected
            : setToastRoomExpired;
        notice(true);
        handleLeaveRoomRef.current();
      }
    };

    setWs(socket);
    return socket;
  }, []);

  // Display names ride the device cookie server-side; the client never sends
  // one (usernames are unique identities, not free-text callsigns).
  /**
   * Send once the socket is up. The relay can now REFUSE a socket outright —
   * a device that no longer holds the account is closed at the upgrade — and
   * a closed socket never becomes OPEN, so a bare retry would tick every
   * 100ms for the life of the page against a door that is never opening. It
   * gives up when the socket is gone, and `onDead` hands back whatever the
   * caller was holding.
   */
  const sendWhenOpen = (socket: WebSocket | null, build: () => unknown, onDead?: () => void) => {
    const attempt = () => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(build()));
        return;
      }
      if (!socket || socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
        onDead?.();
        return;
      }
      setTimeout(attempt, 100);
    };
    attempt();
  };

  /**
   * The venue room a table is created in, and whether it is listed.
   *
   * Held in a ref rather than passed down through the lobby: the lobby is
   * `MultiplayerLobby`'s surface and knows nothing about buildings, while the
   * choice is made a level up, in the menu's room list. Defaults match a
   * `create_room` that names nothing — the ungated venue, private — so the
   * invitation flow is byte-identical to what it has always been.
   */
  const venueRef = useRef<{ roomId: string; visibility: 'public' | 'private' }>({
    roomId: DEFAULT_VENUE_ROOM,
    visibility: 'private',
  });

  // The tables open in the venue the lobby was reached from. Polled rather
  // than pushed: browsing is a read, and a WS message for it would have to be
  // handled in both the relay and the P2P replica (protocolParity) for no
  // gain over an unauthenticated GET the relay already answers.
  const [venueTables, setVenueTables] = useState<TableSummary[]>([]);
  const [tablesLoading, setTablesLoading] = useState<boolean>(false);
  const [lobbyVenue, setLobbyVenue] = useState<string | null>(null);

  const refreshTables = useCallback(async (venue: string | null) => {
    if (!venue) return;
    setTablesLoading(true);
    try {
      const res = await fetch(`/api/rooms/${venue}/tables`);
      if (!res.ok) {
        setVenueTables([]);
        return;
      }
      const body = await res.json();
      setVenueTables(Array.isArray(body?.tables) ? body.tables : []);
    } catch {
      // A failed poll leaves the last list standing rather than blanking the
      // browser: a dropped request is not evidence that the room emptied.
    } finally {
      setTablesLoading(false);
    }
  }, []);

  // Poll while the browser is actually on screen, and only then: a lobby with
  // a seat in it is showing the room, not the list.
  useEffect(() => {
    if (!isMultiplayerOpen || !lobbyVenue || roomId) return;
    refreshTables(lobbyVenue);
    const id = window.setInterval(() => refreshTables(lobbyVenue), 3000);
    return () => window.clearInterval(id);
  }, [isMultiplayerOpen, lobbyVenue, roomId, refreshTables]);

  const handleCreateRoom = (over?: { visibility?: 'public' | 'private' }) => {
    roomRequestRef.current = true;
    let socket = ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      socket = connectWebSocket();
    }
    // The host opens the room on their own menu choices; from then on the
    // room owns them and the lobby is where they change.
    const visibility = over?.visibility ?? venueRef.current.visibility;
    sendWhenOpen(socket, () => ({
      type: 'create_room',
      playerId,
      venueRoomId: venueRef.current.roomId,
      visibility,
      config: normalizeRoomConfig({
        winningScore: settingsRef.current.winningScore,
        rules: settingsRef.current.rules,
        // Watching seats start SHUT, and the host opens them in the lobby.
        //
        // They used to open by default on a public table, on the reasoning
        // that a table being advertised is one where watching is part of the
        // offer. That held while public was one of two choices. It stopped
        // holding the moment public became the ONLY kind of table the client
        // makes, because open seats force the match onto the relay —
        // `rtc_signal` is refused for a watched table, since a P2P match never
        // reaches the relay and a watcher would sit in front of a frozen
        // court. Defaulting them on would therefore have taken the direct
        // DataChannel away from every duel in the game to buy a feature
        // nobody had asked for yet.
        //
        // So the trade is made where the player can see it: P2P by default,
        // and one toggle in the lobby to open the table up — which ends the
        // DataChannel then and there, exactly as `set_room_config` already
        // handles.
        spectators: false,
      }),
    }));
  };

  /**
   * Move to another seat at the table already held.
   *
   * Every guard is the relay's: a seat taken, a table with no watching seats,
   * a court that would be left empty, and above all the match lock — a player
   * may not become a watcher mid-match, because "stand up, look at the hidden
   * half, sit back down" is a two-second cheat in a blind half-court game.
   * The lobby only draws what is free.
   */
  const handleSwapSeat = (seat: TableSeat) => {
    sendWhenOpen(ws, () => ({ type: 'swap_seat', seat }));
  };

  const handleJoinRoom = (code: string) => {
    if (joinInFlightRef.current) return;
    joinInFlightRef.current = true;
    roomRequestRef.current = true;
    let socket = ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      socket = connectWebSocket();
    }
    // onclose is what normally releases the guard; this declines to poll a
    // socket that is already gone, which the relay's own refusal can produce.
    sendWhenOpen(
      socket,
      () => ({ type: 'join_room', roomId: code, playerId }),
      () => {
        joinInFlightRef.current = false;
      }
    );
  };

  /**
   * Take a watching seat at a table rather than a playing one.
   *
   * Deliberately not routed through the join guard: `joinInFlightRef` exists
   * so a second `join_room` on one socket cannot be refused as "room is
   * already full" about the room being joined, and a watching seat is a
   * different seat with a different refusal. The relay refuses a second seat
   * of any kind on its own, which is where that rule belongs.
   *
   * No seat is named: which of the two watching seats you are in is a detail
   * a viewer does not care about, so the relay takes whichever is free and
   * refuses only when both are.
   */
  const handleWatchTable = (code: string, seat?: 2 | 3) => {
    roomRequestRef.current = true;
    let socket = ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      socket = connectWebSocket();
    }
    sendWhenOpen(socket, () => ({ type: 'spectate_room', roomId: code, seat, playerId }));
  };

  /**
   * The ranked queue.
   *
   * Placed here rather than in MainMenu because the state machine is driven by
   * relay messages and this is where the socket is — and because a player on
   * the menu may have no socket at all yet, so joining has to be able to open
   * one, exactly as creating a room does.
   *
   * Queue messages ride the RELAY, never `sendNetRef`: they are room
   * management, so a DataChannel must not carry them (and `sendGame` refuses
   * them anyway — see tests/protocolParity.test.ts).
   */
  const sendQueue = useCallback(
    (msg: WSClientMessage) => {
      let socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) socket = connectWebSocket();
      sendWhenOpen(
        socket,
        () => msg,
        () => {
          // The socket reached CLOSED without ever opening, so nothing was
          // sent. `join()` is optimistic — the spinner starts on the tap
          // rather than a round trip later — and with no `onDead` the state
          // was never reset, so the player watched the elapsed counter climb
          // indefinitely for a `queue_join` that never left the device.
          if (msg.type === 'queue_join') {
            quickMatchRef.current?.reset();
            setToastActionFailed(true);
          }
        }
      );
    },
    [connectWebSocket]
  );
  const quickMatch = useQuickMatch({ send: sendQueue, rttMs: pingMs || undefined });
  quickMatchRef.current = quickMatch;

  /**
   * A search is a seat on its way, so it counts as one for the tour.
   *
   * Being on the menu is not the same as having no room coming — the same
   * reason `startTour` already refuses while a create or join is outstanding.
   * A queue pairing lands as room_created/game_start, which under a running
   * tour would put the player on a court the tour then walks away from,
   * leaving the opponent alone on theirs.
   */
  useEffect(() => {
    if (quickMatch.state.status === 'idle') return;
    roomRequestRef.current = true;
    return () => {
      roomRequestRef.current = false;
    };
  }, [quickMatch.state.status]);

  /**
   * Follow an invitation link the moment the player has an identity to follow
   * it with.
   *
   * The lobby already prefilled the code from the URL, but prefilling is not
   * joining: someone who followed a link or scanned a QR expects to land in
   * the match, and instead sat on a lobby waiting for them to find the button
   * — which reads as the link simply not working. Gated on `initialized`
   * rather than on the profile existing, so a first-time player onboards and
   * is then taken into the room, rather than being seated under a placeholder
   * name before they have chosen one.
   *
   * The lobby is opened as well as joined, and deliberately in that order: it
   * is what renders the room once `room_joined` lands, and if the code turns
   * out to be dead or the room full, the player is left looking at the lobby
   * with their code still in the box rather than at a menu that ate the link.
   */
  useEffect(() => {
    if (!profile?.initialized || autoJoinedRef.current) return;
    const code = pendingRoomRef.current;
    if (!code) return;
    autoJoinedRef.current = true;
    setIsMultiplayerOpen(true);
    handleJoinRoom(code);
  }, [profile?.initialized, inviteRetry]);

  /**
   * Host-only: change the room's terms from the lobby. The server re-checks
   * both who sent it and whether a match is in progress, so this is a request,
   * not a command — the authoritative answer comes back as room_config.
   */
  const handleSetRoomConfig = (patch: Partial<RoomMatchConfig>) => {
    const next = normalizeRoomConfig({ ...(roomConfig || DEFAULT_ROOM_CONFIG), ...patch });
    setRoomConfig(next); // optimistic; a refused edit is corrected by the echo
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set_room_config', config: next }));
    }
  };

  /**
   * A point landed in a duel. Only the player who let the ball past loses
   * their streak, and this client already knows which that was: it sent the
   * point_scored itself when the ball crossed its own baseline, and cleared
   * its streak there. So what is left to do here is the OPPONENT's — their
   * streak ends exactly when my score goes up — and to open a fresh point.
   */
  const applyDuelPoint = (s: PlayerStats, mine: number, theirs: number): PlayerStats => {
    const iScored = mine > s.score;
    oppCrossingsThisPointRef.current = 0;
    oppReturnedThisPointRef.current = false;
    const next = { ...s, score: mine, opponentScore: theirs };
    // My own miss already ended my streak locally, a frame before the relay
    // said so. What is left is the opponent's, and only when I scored.
    return iScored ? opponentMiss(next) : next;
  };

  /** Guest: signal (or withdraw) readiness. Host starts via handleStartMatch. */
  const handleSendReady = (ready: boolean) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'player_ready', ready }));
    }
  };

  /** Host: start the match. The server re-checks the guest actually readied. */
  const handleStartMatch = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'start_match' }));
    }
  };

  const handleLeaveRoom = () => {
    p2pRef.current?.close();
    p2pRef.current = null;
    setLinkStatus('relay');
    if (ws && ws.readyState === WebSocket.OPEN) {
      // The flag labels a close WE cause, so it is set only when there is one
      // to cause. Set unconditionally it outlived its socket — this is also
      // reached FROM onclose, where the socket is already gone and no close
      // event is coming to consume it, and the flag then swallowed the next
      // socket's genuine ejection.
      intentionalCloseRef.current = true;
      ws.send(JSON.stringify({ type: 'leave_room' }));
      ws.close();
    }
    setWs(null);
    setRoomId(null);
    setOpponentName(null);
    setOpponentId(null);
    setRoomConfig(null);
    // Standing up. Cleared here rather than in a spectator-only exit, because
    // every way out of a table goes through this function — a leave, a reap,
    // the host closing the seats — and a stale `spectating` would leave the
    // next match with no physics and a read-only court.
    setSpectating(null);
    spectatingRef.current = null;
    setTableState(null);
    watchedBallRef.current = null;
    // A seating that never reached game_start would otherwise leave the lobby
    // suppressed for the NEXT room this page opens.
    queueSeatingRef.current = false;
    setMatchCountdown(null);
    setCountdownArmed(false);
    setLobbyReady([false, false]);
    setExitConfirm(null);
    setLeaveLobbyConfirmOpen(false);
    // The lobby is a sheet over the court, not a screen. Leaving without
    // closing it dropped the player back on the menu with it still floating.
    setIsMultiplayerOpen(false);
    setMode('solo');
    setScreen('menu');
    resetMatch();
  };

  /**
   * The lobby's X and its Leave button are the same intent, and both are a
   * request rather than an action: a seat in a room is something the relay is
   * holding, so walking away from it has to actually tell the relay. Before a
   * room exists there is nothing to leave, and dismissing is just dismissing —
   * which is also the window a join can still be in flight in, where
   * `room_joined` reopens the sheet rather than seating anyone behind it.
   */
  const requestLeaveLobby = () => {
    if (roomId) {
      setLeaveLobbyConfirmOpen(true);
      return;
    }
    setIsMultiplayerOpen(false);
  };

  // Main 60/120 FPS Physics Engine Loop
  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();

    const gameLoop = (time: number) => {
      const dt = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;

      // The paddle's own velocity is an input to the ball (`driveCoupling`),
      // so it has to be a speed rather than a per-event delta: measured here,
      // once a frame, against the same position the collision below reads.
      // Frame-rate independent by construction, and it returns to zero on its
      // own the moment the paddle stops — a flick followed by a held finger
      // fires no further pointermove at all, and the old per-event value
      // stayed latched at full swing for every remaining contact.
      paddleVxRef.current = (paddleXRef.current - prevPaddleXRef.current) / (dt || 0.016);
      prevPaddleXRef.current = paddleXRef.current;

      // A streamed opponent ball that has stopped being refreshed is stale —
      // its clear was reliable but the stream is not, so one late sample can
      // re-plant a dot after a net cross or a point. Swept here, BEFORE the
      // serving gate, because the between-points window is exactly when the
      // gate below is closed. Solo never sweeps: its opponent ball is
      // simulated locally and legitimately holds still during the AI's serve
      // wind-up.
      if (
        modeRef.current === 'multiplayer' &&
        oppBallRef.current?.active &&
        time - oppBallSeenRef.current > 400
      ) {
        setOppBall(null);
      }

      // Idle while on the menu; split mode runs its own self-contained loop.
      if (screenRef.current !== 'game' || modeRef.current === 'split') {
        animId = requestAnimationFrame(gameLoop);
        return;
      }

      // A watcher runs no physics at all: the court being drawn is somebody
      // else's, and every truth about it arrives over the wire. All this does
      // is carry the ball forward between the ~20Hz samples so it glides
      // rather than steps. Ahead of the serving/winner gate below, because a
      // watcher's `isServing` is set by score_update like a player's and would
      // otherwise freeze the ball for the whole of the next point.
      if (spectatingRef.current) {
        const watched = ballRef.current;
        if (watched.active) {
          setBall({ ...watched, x: watched.x + watched.vx * dt, y: watched.y + watched.vy * dt });
        }
        animId = requestAnimationFrame(gameLoop);
        return;
      }

      // A rally is ALIVE if a ball exists anywhere, if somebody is about to
      // serve one, if the countdown is still running, or if the match is over.
      // Anything else is a court with nothing on it, which is only ever a
      // transient in a healthy match.
      if (
        isServingRef.current ||
        winner ||
        ballRef.current.active ||
        oppBallRef.current?.active ||
        countdownArmedRef.current ||
        (matchCountdownRef.current ?? 0) > 0
      ) {
        rallyAliveRef.current = time;
        stallHandledRef.current = false;
      }

      if (isServingRef.current || winner) {
        animId = requestAnimationFrame(gameLoop);
        return;
      }

      // A DataChannel that dies without CLOSING takes the crossing with it.
      // `sendGame` reports success, `ball_cross_net` is never delivered, and
      // the ball has already left this half — so neither phone has a ball and
      // neither has `isServing`. Auto-serve cannot arm (it is gated on
      // serving), `p2p_fallback` cannot fire (the relay saw nothing), and the
      // reaper will not touch a room whose `lastActive` the survivor's own
      // paddle keeps fresh. The point never ends, and the only way out is
      // quitting — which is recorded as an abandon, a real ranked loss for a
      // player who did nothing.
      //
      // This does not resurrect the lost ball: doing that safely needs an
      // acknowledged crossing, which is a protocol change and not this. What
      // it does is stop the silence. The DataChannel is dropped, so every
      // later message goes back over the relay where it is at least reliable
      // and where the relay can judge it, and the player is TOLD, so leaving
      // is an informed decision rather than the only thing left to try.
      if (
        modeRef.current === 'multiplayer' &&
        !stallHandledRef.current &&
        time - rallyAliveRef.current > BALL_STALL_MS
      ) {
        stallHandledRef.current = true;
        // `close()` reports through `onStatus`, which is what puts the HUD
        // badge back to RELAY and clears the ref — so this does not set
        // either itself.
        p2pRef.current?.close();
        setToastRallyStalled(true);
      }

      const currentMode = modeRef.current;
      const currentSettings = settingsRef.current;

      // ==============================================================
      // 1. UPDATE BALL IN PLAYER'S VISIBLE HALF COURT
      // ==============================================================
      if (ballRef.current.active) {
        let b = { ...ballRef.current };

        // The flight is integrated in SUBSTEPS, not one jump. The paddle only
        // catches a ball inside a window `PADDLE_HEIGHT + 2r` tall — about
        // 0.068 at stock — while a ball at the 2.4 cap covers 0.12 in the
        // 0.05s the frame clamp allows, so a point-sampled test misses 43% of
        // sub-frame phases and the ball passes THROUGH the paddle. With a
        // legal `ballSpeedMax: 2` a wall rebound reaches 4.8 and tunnels 15%
        // of the time at a perfect 60fps. Stepping to the collision's own
        // scale is what makes the test reliable, and it holds the sidewalls
        // and the Practice Wall's return line to the same standard.
        const steps = physicsSubsteps(Math.hypot(b.vx, b.vy), dt, b.radius);
        const sdt = dt / steps;
        let contacted = false;

        for (let step = 0; step < steps; step++) {
          b.x += b.vx * sdt;
          b.y += b.vy * sdt;

          // Sidewall bounces. Spin never bends the flight — it spends itself
          // here, tilting the angle the ball leaves the wall at.
          if (b.x - b.radius <= 0 || b.x + b.radius >= 1) {
            const atLeft = b.x - b.radius <= 0;
            b.x = atLeft ? b.radius : 1 - b.radius;
            const bounced = bounceOffWall(b.vx, b.vy, b.spin, atLeft, rulesRef.current);
            b.vx = bounced.vx;
            b.vy = bounced.vy;
            b.spin = bounced.spin;
            sound.playWallBounce();
          }

          // Paddle Collision at bottom (y ~ 0.92)
          const hitResult = checkPaddleCollision(
            b,
            paddleXRef.current,
            paddleWidthRef.current,
            paddleVxRef.current,
            // The player's aggression is their own thumb; only the AI biases
            // its outgoing angle.
            0,
            rulesRef.current
          );

          if (hitResult.hit && hitResult.angle !== undefined && hitResult.speed !== undefined) {
            // Hold the rally inside the speed band this match is played under.
            const hitSpeed = clampBallSpeed(hitResult.speed, rulesRef.current);
            b.vy = -Math.abs(hitSpeed * Math.cos(hitResult.angle));
            b.vx = hitSpeed * Math.sin(hitResult.angle);
            // A fresh contact defines the spin: how fast the paddle was moving,
            // weighted by how far from centre the ball caught it.
            b.spin = hitResult.spin ?? 0;
            b.y = PADDLE_Y - PADDLE_HEIGHT / 2 - b.radius;

            sound.playPaddleHit(hitResult.speed / BASE_BALL_SPEED);
            contacted = true;
          }

          // The Practice Wall's return line is a surface like any other, so it
          // is swept here rather than tested once at the end of the frame.
          if (currentMode === 'practice') {
            if (b.y - b.radius <= 0) {
              b.y = b.radius;
              // The return line is a SURFACE, so it spends spin like every
              // other one: it used to be a bare `Math.abs(b.vy)`, and a spun
              // ball came off it exactly as it went in.
              const off = bounceOffReturnLine(b.vx, b.vy, b.spin, rulesRef.current);
              b.vx = off.vx;
              b.vy = Math.abs(off.vy);
              b.spin = off.spin;
              sound.playWallBounce();
            }
          } else if (b.y <= 0) {
            // Left this half. Stop the sweep HERE so the crossing is reported
            // from the point it actually happened at, rather than from
            // wherever the rest of the frame would have carried it.
            break;
          }
          if (b.y >= 1.05) break;
        }

        if (contacted) {
          setTotalTouches((t) => t + 1);
          // My own return, and my own streak. The serve never reaches here —
          // handleServe sets the ball's velocity directly and seeds it clear
          // of the paddle — so this site is already exactly "a return".
          setStats(ownReturn);
        }

        // How fast the rally is actually going, in units of the base serve.
        // It used to be read off THIS FRAME's paddle hit, which cannot be
        // truthy on the frame the ball crosses the net — a contact leaves the
        // ball at y≈0.9 and the net is a whole court away — so it was the
        // constant 1 on the wire and never set at all on the local ball. The
        // canvas's high-speed spark trail and its impact shake both key off
        // it, so neither had ever rendered.
        b.speedMultiplier = Math.hypot(b.vx, b.vy) / BASE_BALL_SPEED;

        // ==============================================================
        // 2. BALL REACHES TOP NET (Y <= 0)
        //    - Practice Wall: handled in the sweep above — the net is a
        //      RETURN LINE and the ball never leaves the player's screen.
        //    - Everything else: it disappears across the divide!
        // ==============================================================
        if (currentMode !== 'practice' && b.y <= 0) {
          // Ball disappears from player's screen!
          b.active = false;

          if (currentMode === 'multiplayer') {
            // Broadcast net crossing to remote player's phone
            sendNetRef.current({
              type: 'ball_cross_net',
              ball: {
                x: b.x,
                vx: b.vx,
                vy: b.vy,
                spin: b.spin || 0,
                speedMultiplier: b.speedMultiplier,
              },
            });
          } else if (currentMode === 'solo') {
            // Spawn ball on unseen Opponent AI's half court
            setOppBall({
              x: Math.max(0.02, Math.min(0.98, 1 - b.x)),
              y: 0.02,
              vx: -b.vx,
              vy: Math.abs(b.vy),
              radius: b.radius,
              // Same mirror the server applies for PvP, kept in step here so
              // solo and PvP agree on what crossing the net does to spin.
              spin: -(b.spin || 0),
              active: true,
            });
          }
        }

        // ==============================================================
        // 3. BALL MISSED BASELINE (Y >= 1.05)
        // ==============================================================
        if (b.y >= 1.05) {
          b.active = false;
          sound.playLose();
          // Whatever the mode, the ball got past ME — so mine is the streak
          // that ends, and only mine. In a duel the relay reaches the same
          // conclusion from the point_scored below; this is the local half of
          // the same rule, so the HUD does not wait for a round trip.
          setStats(ownMiss);
          oppReturnedThisPointRef.current = false;
          oppCrossingsThisPointRef.current = 0;

          if (currentMode === 'multiplayer') {
            sendNetRef.current({
              type: 'point_scored',
              scorer: playerIndexRef.current === 0 ? 'p2' : 'p1',
            });
          } else if (currentMode === 'practice') {
            // No opponent, no score — the streak just reset above and the
            // player serves again. Best streak stays on the board.
            setIsServing(true);
            setIsPlayerServer(true);
          } else {
            // Solo mode point for AI
            setStats((s) => {
              const nextOppScore = s.opponentScore + 1;
              if (nextOppScore >= configRef.current.winningScore) {
                setWinner('opponent');
              } else {
                setIsServing(true);
                setIsPlayerServer(true); // Player serves next
              }
              // I let it past, so mine is the streak that ends. The AI's is
              // untouched: a streak is never decided by the other player.
              return { ...s, opponentScore: nextOppScore, streak: 0 };
            });
          }
        }

        // Stream the live ball to the opponent's sonar (~20 Hz), in OUR
        // frame — their radar applies the head-to-head mirror, exactly as it
        // does for the solo AI's half. Only while the ball is on this half:
        // the silence after it leaves is what lets the far radar go dark.
        if (currentMode === 'multiplayer' && b.active && time - lastBallPosSentRef.current > 50) {
          lastBallPosSentRef.current = time;
          sendNetRef.current({ type: 'ball_pos', x: b.x, y: b.y });
        }

        setBall(b);
      }

      // ==============================================================
      // 4. SIMULATE OPPONENT'S UNSEEN COURT (SOLO AI MODE)
      // ==============================================================
      if (currentMode === 'solo' && oppBallRef.current?.active) {
        let ob = { ...oppBallRef.current };
        ob.x += ob.vx * dt;
        ob.y += ob.vy * dt;

        // Opponent side wall bounces, same spin rules as the player's half.
        if (ob.x - ob.radius <= 0 || ob.x + ob.radius >= 1) {
          const atLeft = ob.x - ob.radius <= 0;
          ob.x = atLeft ? ob.radius : 1 - ob.radius;
          const bounced = bounceOffWall(ob.vx, ob.vy, ob.spin, atLeft, rulesRef.current);
          ob.vx = bounced.vx;
          ob.vy = bounced.vy;
          ob.spin = bounced.spin;
          sound.playWallBounce();
        }

        // Update Opponent AI Paddle tracking
        aiRef.current.update(ob, dt, paddleWidthRef.current, rulesRef.current);
        oppPaddleXRef.current = aiRef.current.paddleX;
        setOppPaddleX(aiRef.current.paddleX);

        // Check Opponent Paddle Collision
        const oppHit = checkPaddleCollision(
          ob,
          aiRef.current.paddleX,
          paddleWidthRef.current,
          aiRef.current.paddleVx,
          // Aggression bends the ball on its way out, not the paddle on its
          // way to meet it — see OpponentAI.aimBias for why that swap matters
          // to the ladder's ordering. Passed INTO the contact rather than
          // applied to the angle it returns, because the contact derives its
          // own pace from the direction the ball leaves in: see the
          // angleBias parameter.
          aiRef.current.aimBias(),
          rulesRef.current
        );

        if (oppHit.hit && oppHit.angle !== undefined && oppHit.speed !== undefined) {
          // The AI's return went through no band clamp at all, where the
          // player's has had one since the rules shipped — so with a raised
          // `ballSpeedMin` the AI could hand back a ball slower than the match
          // permits, and the two halves of one rally obeyed different rules.
          const oppSpeed = clampBallSpeed(oppHit.speed, rulesRef.current);
          ob.vy = -Math.abs(oppSpeed * Math.cos(oppHit.angle));
          ob.vx = oppSpeed * Math.sin(oppHit.angle);
          // The spin the contact produced, which this line used to drop on the
          // floor: oppHit.spin was computed and never read, so the ball left
          // the AI's paddle still carrying the PLAYER's spin, un-reversed and
          // un-damped, and every wall it struck on the way back tilted the
          // wrong way.
          ob.spin = oppHit.spin ?? 0;
          ob.y = PADDLE_Y - PADDLE_HEIGHT / 2 - ob.radius;

          sound.playOpponentPaddleHit();
          setTotalTouches((t) => t + 1);
          oppReturnedThisPointRef.current = true;
          setStats(opponentReturn);
        }

        // Check Ball Crossing TOP Net BACK into Player's Court!
        if (ob.y <= 0) {
          ob.active = false;

          // Re-emerge onto player's half court at top net!
          setBall({
            x: Math.max(0.02, Math.min(0.98, 1 - ob.x)),
            y: 0.02,
            vx: -ob.vx,
            vy: Math.abs(ob.vy),
            // Mirrored, the same as every other crossing. This literal had no
            // `spin` key at all, and BallState.spin is optional, so the field
            // arrived undefined and every consumer read it as `spin || 0`:
            // the player was never served a spun ball in solo, ever. The comment
            // twenty lines above — "kept in step here so solo and PvP agree on
            // what crossing the net does to spin" — was true of one direction.
            spin: -(ob.spin || 0),
            radius: ob.radius,
            active: true,
          });
        }

        // Opponent AI Missed the Ball - PLAYER SCORES!
        if (ob.y >= 1.05) {
          ob.active = false;
          sound.playScore();
          // An ace: I served and the AI never got it back over, so the rally
          // never actually started. Read off whether they returned it rather
          // than off a counter — the counter is mine now, and mine does not
          // move when I serve.
          //
          // Latched BEFORE the point is opened, and read from the latch inside
          // the updater. setStats runs later, so clearing the ref first made
          // every point won on my own serve an ace.
          const wasAce = servedThisPointRef.current && !oppReturnedThisPointRef.current;
          oppReturnedThisPointRef.current = false;
          oppCrossingsThisPointRef.current = 0;

          setStats((s) => {
            const nextScore = s.score + 1;
            const ace = wasAce;
            if (nextScore >= configRef.current.winningScore) {
              setWinner('player');
              confetti({ particleCount: 120, spread: 80, origin: { y: 0.6 } });
            } else {
              setIsServing(true);
              setIsPlayerServer(false); // AI serves next
            }
            // The AI let it past, so theirs is the streak that ends — and
            // mine is untouched, which is the whole rule.
            return opponentMiss({
              ...s,
              score: nextScore,
              aces: s.aces + (ace ? 1 : 0),
              matchesWon: nextScore >= configRef.current.winningScore ? s.matchesWon + 1 : s.matchesWon,
            });
          });
        }

        setOppBall(ob);
      }

      animId = requestAnimationFrame(gameLoop);
    };

    animId = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(animId);
  }, [winner, playerIndex]);

  const resetMatchRef = useRef<() => void>(() => {});
  const adoptSessionRef = useRef<() => Promise<ClientSessionStatus>>(async () => 'connecting');
  adoptSessionRef.current = adoptSession;

  /**
   * The run this player already has going in a mode. A streak carries between
   * matches, so a new one opens on it — and it is read from the profile rather
   * than kept in memory, because it has to survive a reload and a different
   * browser too.
   */
  const carriedStreak = (m: GameMode): number =>
    carried(carryRef.current, m, profileRef.current?.modeStats?.[m]?.currentStreak ?? 0);

  /**
   * `carried` overrides where the run opens. Only the HUD's Reset passes it —
   * see handleResetMatch, which is also why it is a plain number here rather
   * than something the caller has to know how to look up.
   */
  const resetMatch = (forMode: GameMode = modeRef.current, carried?: number) => {
    setStats((s) =>
      startMatchStreaks(
        { ...s, score: 0, opponentScore: 0 },
        carried ?? carriedStreak(forMode)
      )
    );
    setTotalTouches(0);
    setMatchStartTime(Date.now());
    setWinner(null);
    setLastMatchResult(null);
    setTelemetryOpen(false);
    setIsServing(true);
    setIsPlayerServer(true);
    // A new match opens on a new POINT, and these three describe a point: who
    // served it, whether the opponent has returned anything, and how many
    // balls have crossed. Left alone across a reset they described the last
    // point of the abandoned match — so a reset taken after the AI had
    // returned a ball carried `oppReturned` into the next match and refused
    // the first genuine ace of it, which is a stat the player keeps.
    servedThisPointRef.current = true; // setIsPlayerServer(true), above
    oppReturnedThisPointRef.current = false;
    oppCrossingsThisPointRef.current = 0;
    // A new match is a new thing to record and a new result to show.
    matchKeyRef.current = '';
    shownMatchKeyRef.current = '';
    aiRef.current.reset();
    // Back into the server's hand, exactly as a fresh match opens.
    setBall({
      x: paddleXRef.current,
      y: SERVE_BALL_Y,
      vx: 0,
      vy: 0,
      radius: ballRadiusRef.current,
      active: false,
    });
    setOppBall(null);
  };

  // Menu → court. Match settings (difficulty, winning score) are already
  // locked in on the menu before this runs — nothing re-opens them mid-match.
  const startMatch = (newMode: GameMode) => {
    setMode(newMode);
    setScreen('game');
    // Named explicitly: modeRef still holds the mode being left.
    resetMatch(newMode);
  };

  // Court → menu, from the HUD home button or the winner overlay. Multiplayer
  // additionally tears the room down (handleLeaveRoom returns to menu itself).
  // Practice Wall banks its best return streak when the player leaves. No
  // match is recorded and no rating moves — the server decides what the streak
  // is worth and holds a daily cap, since a guaranteed-return drill would
  // otherwise be the fastest XP in the game.
  const submitPracticeSession = useCallback(
    async (bestStreak: number, earnedStreak: number, endStreak: number) => {
      // Where the run stood when the wall opened — read before the stamp
      // below replaces it, because it is what decides whether this session
      // has anything to say at all.
      const carriedIn = carriedStreak('practice');
      rememberCarry(carryRef.current, 'practice', endStreak);
      // A session worth nothing is still worth carrying: leaving the wall on
      // a run of two does not end it, so the report goes out either way. And
      // a run that BROKE here is news even though it earned nothing — without
      // that last clause the server keeps handing back, on the next load, the
      // very run the player just lost.
      if (earnedStreak < 3 && endStreak <= 0 && carriedIn <= 0) return;
    try {
      const endedAt = Date.now();
      // This browser's own ordering, assigned right alongside endedAt — see
      // src/net/runChain.ts. Two sessions can be left seconds apart, and an
      // older one ending at 8 must not land after a newer one that broke to 0,
      // however each request's own round trip turns out.
      const { chainId, runSeq } = nextRunSeq();
      const res = await queueRunWrite(() =>
        fetch('/api/practice/record', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bestStreak, earnedStreak, endStreak, endedAt, clientNow: Date.now(), chainId, runSeq,
          }),
        })
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data.profile) setProfile(data.profile);
      if (data.earnedXp > 0) setToastPracticeXp(data.earnedXp);
      // The wall grants achievements of its own (wall_30/90/200) and the
      // response has always carried them; nothing read them, so they were
      // banked in silence.
      if (data.newAchievements?.length) setToastAchievements(data.newAchievements);
    } catch (e) {
      console.error('Failed to bank practice session:', e);
    }
  }, [queueRunWrite]);

  /**
   * Tell the server where a run stands when no match is ending to say so.
   *
   * Fire-and-forget on purpose: this is a correction, not a result. Failing to
   * send it leaves the server on the old value, which is exactly where it was
   * without this — while blocking the walk back to the menu on a request would
   * make a network stall look like a frozen button.
   */
  /**
   * Tell the server where a run stands when no match is ending to say so.
   *
   * Stamped WHEN THE RUN REACHED THIS VALUE, and sent alongside the clock as
   * it goes out, exactly like a recorded match — the difference is the age,
   * and the age is how the server orders every write that assigns the run.
   *
   * That pairing is the whole point. These go out fire-and-forget from Reset
   * and from quitting, and they race each other and the match POST and the
   * practice POST, all of which write the same field. Ordered by arrival, a
   * report that stalled for a second outranks whatever overtook it in flight
   * and restores a run that had already ended, permanently, for anyone who
   * reloads. Ordered by age, a stalled report is simply old — which is the
   * truth about it, and the same rule every other writer already obeys.
   *
   * Fire-and-forget on purpose: this is a correction, not a result. A failed
   * send leaves the server where it was without it, while blocking the walk
   * back to the menu on a request would make a stall look like a frozen
   * button.
   */
  const reportStreak = useCallback(
    (m: GameMode, endStreak: number): Promise<void> => {
      if (m !== 'solo' && m !== 'practice') return Promise.resolve();
      const endedAt = Date.now();
      const { chainId, runSeq } = nextRunSeq();
      return queueRunWrite(async () => {
        try {
          await fetch('/api/profile/me/streak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Stamped when the call was MADE, sent with the clock as it goes
            // out. For a report those are close together and the age is
            // small — the age is not what orders these against each other,
            // this browser's chain position is (nextRunSeq, captured above
            // alongside endedAt, before anything is queued or sent).
            body: JSON.stringify({ mode: m, endStreak, endedAt, clientNow: Date.now(), chainId, runSeq }),
          });
        } catch {
          // A correction, not a result: the server keeps what it had.
        }
      });
    },
    [queueRunWrite]
  );

  /**
   * Whether leaving right now walks out of a solo match that is genuinely
   * under way — the case that has to be recorded as a loss.
   *
   * A duel's walkout is judged by the relay (see vacateSeat); this is the
   * solo half, and it is the client's to judge because a solo match exists
   * only here. Quitting a match a point has been scored in is losing it: a
   * player who quits every solo match they are behind in otherwise records
   * only their wins, which is half of the reported 100% win rate. At 0-0
   * nothing has happened yet — backing out of a match that never really
   * started costs nothing, and an already-decided one is not ours to record.
   */
  const abandoningLiveSoloMatch = (): boolean =>
    modeRef.current === 'solo' &&
    !winner &&
    statsRef.current.score + statsRef.current.opponentScore >= 1;

  /** Walk out of the current match. Past every confirmation by this point. */
  const commitQuitToMenu = () => {
    if (mode === 'practice') {
      void submitPracticeSession(
        statsRef.current.bestStreak,
        statsRef.current.earnedBest,
        statsRef.current.streak
      );
    } else {
      // Walking out of an UNFINISHED match still ends wherever the run ends.
      // Only a finished match reports itself, so without this a player who
      // carried a run in, missed, and quit was seeded from the stale carry on
      // their next match — the miss simply undone, and every return after it
      // extending a run that should have been over. Practice says the same
      // thing through its own report above.
      //
      // Told to the server as well as remembered here, or the miss survives a
      // reload: the stored run is what a fresh page reads, and it would still
      // hold whatever the last COMPLETED match left there.
      rememberCarry(carryRef.current, modeRef.current, statsRef.current.streak);
      if (abandoningLiveSoloMatch()) void recordMatchCompletion(false);
      else void reportStreak(modeRef.current, statsRef.current.streak);
    }
    setScreen('menu');
    resetMatch();
  };

  const quitToMenu = () => {
    // Standing up costs a watcher nothing — no match, no abandon, no run — so
    // the confirmation that guards a player's exit has nothing to warn about
    // here, and "you will lose the match" would simply be false.
    if (spectating) {
      handleLeaveRoom();
      // Back to the room they came from, not to the menu proper: standing up
      // is leaving a table, and the next thing a watcher wants is the other
      // tables. `lobbyVenue` still names the room, since it is set when they
      // walked into it and nothing since has changed it.
      if (lobbyVenue) setIsMultiplayerOpen(true);
      return;
    }
    if (mode === 'multiplayer') {
      // A live duel is worth a second look before walking out: leaving
      // mid-match is an abandon, and ranked repeats cost rating. A finished
      // match, or a lobby with no opponent, leaves without ceremony.
      const liveMatch = !winner && opponentId !== null && !isMultiplayerOpen;
      if (liveMatch) {
        setExitConfirm('duel');
        return;
      }
      handleLeaveRoom();
      return;
    }
    // A solo match with a point on the board is one that will be RECORDED as
    // a loss when it is left, so it is worth a second look — the same second
    // look a duel gets, for the same reason.
    if (abandoningLiveSoloMatch()) {
      setExitConfirm('solo-quit');
      return;
    }
    commitQuitToMenu();
  };

  /**
   * The HUD's Reset. Restarts the match; the run stands exactly where it
   * stands, which is what Play Again does too — a restart is not a miss, and
   * these are two buttons for the same intent. So a run broken by a miss
   * stays broken and an unbroken one is not confiscated for pressing a button.
   *
   * It takes no arguments ON PURPOSE. Wired straight to onClick, resetMatch
   * received the React event as its `forMode` — which happened to look up
   * nothing and seed zero, so Reset cleared the run by accident rather than
   * by decision, and tidying the wiring to `() => resetMatch()` would have
   * silently turned that into "reload the stored carry", resurrecting a run
   * the player had already missed away. Nothing in the component tree is
   * typechecked (no @types/react), so this is the guard.
   */
  const handleResetMatch = () => {
    // Restarting a match a point has been scored in ENDS that match as a
    // loss, so it asks first — the same confirmation walking out gets,
    // because it is the same consequence.
    if (abandoningLiveSoloMatch()) {
      setExitConfirm('solo-reset');
      return;
    }
    commitResetMatch();
  };

  /** Restart the current match. Past every confirmation by this point. */
  const commitResetMatch = () => {
    const run = statsRef.current.streak;
    // Carrying the run into the restarted match is only half of it. The other
    // half is saying so — a player who missed and then pressed Reset has a run
    // of zero, and neither this page's record nor the server's had heard: a
    // reload before the restarted match finished put the pre-miss run straight
    // back, ready for the next return to extend a streak that had ended. Same
    // pair as quitting, for the same reason.
    {
      rememberCarry(carryRef.current, modeRef.current, run);
      // Restarting a solo match a point has been scored in abandons it, the
      // same as walking out to the menu — so it is recorded the same way.
      // Without this Reset is simply the free version of the walkout: quit
      // the ones you are losing, press Reset instead of Home, and only your
      // wins are ever recorded. The run still carries (a restart is not a
      // miss); it is the MATCH that ends here, as a loss.
      if (abandoningLiveSoloMatch()) void recordMatchCompletion(false);
      // The Practice Wall banks through its own report, and Reset had it
      // reporting the STREAK alone — so the session's XP and its history row
      // were simply discarded, for work the player had already done. Restart
      // is the same ending as walking out as far as the wall is concerned: the
      // run carries either way (a restart is not a miss), and `resetMatch`
      // below opens the next session's earned counters at zero, so nothing is
      // banked twice.
      else if (modeRef.current === 'practice') {
        void submitPracticeSession(
          statsRef.current.bestStreak,
          statsRef.current.earnedBest,
          run
        );
      } else void reportStreak(modeRef.current, run);
    }
    resetMatch(modeRef.current, run);
  };

  resetMatchRef.current = resetMatch;

  const handleLeaveRoomRef = useRef<() => void>(() => {});
  handleLeaveRoomRef.current = handleLeaveRoom;

  // ---- Session ownership -------------------------------------------------
  //
  // One account, one live device. Losing the account mid-match used to be
  // undetectable until the final whistle: a phone whose profile had been
  // transferred to another device kept playing against a locally simulated
  // AI, and only when it POSTed the finished match did the server answer that
  // it had never heard of this player. A whole match, played for nothing, and
  // an onboarding modal for a prize. The heartbeat is what turns that into a
  // few seconds.
  const stopPlayOnEviction = useCallback(() => {
    if (modeRef.current === 'multiplayer') {
      handleLeaveRoomRef.current();
      return;
    }
    setScreen('menu');
    resetMatchRef.current();
  }, []);

  useEffect(
    () =>
      watchSession(({ status, build }) => {
        setSessionStatus(status);
        if (status === 'stale_build' && build) {
          // A new deployment is live. Reload onto it — the device cookie is
          // untouched, so we come back to the same account on the new build.
          // If we have already reloaded once for this build, re-minting the
          // session is what carries us the rest of the way.
          if (!refreshForBuild(build)) void adoptSessionRef.current();
          return;
        }
        if (status === 'released' || status === 'superseded') {
          stopPlayOnEviction();
          return;
        }
        // Nobody is holding the account (first contact, or a session we ended
        // ourselves). Take it back without troubling the player.
        if (status === 'none') void adoptSessionRef.current();
      }),
    [stopPlayOnEviction]
  );

  /**
   * The equipped cosmetic. The PROFILE wins over the device copy, which is the
   * opposite of the rule `carryRef` follows and for the opposite reason: a
   * carried rally run is about what this page just watched happen, while a
   * cosmetic is about what everybody ELSE sees on this player's profile. The
   * device copy exists only so the first paint does not wait for a round trip,
   * and it is reconciled below the moment the profile lands.
   */
  const equippedCosmeticId = normalizeCosmeticId(profile?.cosmetic ?? settings.cosmetic);
  const currentTheme: Cosmetic = COSMETICS[equippedCosmeticId];
  /**
   * The browser chrome is not reachable from CSS, so it is set from here.
   *
   * `<meta name="theme-color">` colours the address bar and, on iOS, the area
   * behind a `black-translucent` status bar. Left at the shipped dark value a
   * light cosmetic gets white text on a white status bar — invisible, and
   * invisible only on a real phone, which is the worst place to find out.
   */
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', currentTheme.shell.surface1);
    const bar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (bar) bar.setAttribute('content', currentTheme.mode === 'light' ? 'default' : 'black-translucent');
  }, [currentTheme]);

  const missionsSummary = getMissionsStatusSummary(missions);
  // One motion vocabulary for the whole app; it collapses to zero duration
  // under prefers-reduced-motion without this file knowing about it.
  const { screen: screenMotion } = useMotion();

  const inSplitMatch = screen === 'game' && mode === 'split';
  const inCourtMatch = screen === 'game' && mode !== 'split';

  return (
    <MobileGatekeeper language={currentLanguage}>
      <SessionGuard
        status={sessionStatus}
        busy={sessionBusy}
        language={currentLanguage}
        onAdopt={() => void adoptSession(true)}
        onStartFresh={() => void startFreshIdentity()}
      >
      {/* The equipped cosmetic is published ONCE, here, as the design tokens
          themselves — so every `bg-surface-2` and `text-ink` in the app follows
          it with no component knowing a cosmetic exists. The public-profile
          card makes the only other call, with somebody else's palette; see
          cosmeticVars for why this cannot be a var() pointing at a var(). */}
      <div
        id="app-root-container"
        data-cosmetic={equippedCosmeticId}
        data-mode={currentTheme.mode}
        className="relative w-full h-full overflow-hidden flex flex-col font-sans select-none bg-surface-1"
        style={cosmeticVars(currentTheme) as React.CSSProperties}
      >
        {/* Every temporary notice, celebrations included, lives in one stack:
            the host owns the timer and the tap target so neither can be
            forgotten here. */}
        <ToastHost
          toasts={[
            toastLevelUp !== null && {
              id: 'toast-level-up',
              chrome: 'card' as const,
              kind: 'level-up',
              ttlMs: TOAST_TTL.celebration,
              content: <LevelUpCard level={toastLevelUp} language={currentLanguage} />,
              onDismiss: () => setToastLevelUp(null),
            },
            // Each unlock is its own card with its own timer, and dismissing
            // one must not take its siblings with it — hence the functional
            // update rather than a straight set.
            ...toastAchievements.map((a) => ({
              id: `toast-achievement-${a.id}`,
              chrome: 'card' as const,
              kind: 'achievement',
              ttlMs: TOAST_TTL.celebration,
              content: <AchievementCard achievement={a} language={currentLanguage} />,
              onDismiss: () =>
                setToastAchievements((prev) => prev.filter((x) => x.id !== a.id)),
            })),
            ...toastUnlocks.map((id) => ({
              id: `toast-unlock-${id}`,
              tone: 'xp' as const,
              ttlMs: TOAST_TTL.reward,
              content: t('mission_unlock_earned', currentLanguage, {
                name: t(COSMETICS[id].nameKey, currentLanguage),
              }),
              onDismiss: () => setToastUnlocks((prev) => prev.filter((x) => x !== id)),
            })),
            toastPracticeXp !== null && {
              id: 'toast-practice-xp',
              tone: 'info' as const,
              ttlMs: TOAST_TTL.reward,
              content: t('practice_xp_earned', currentLanguage, { xp: toastPracticeXp }),
              onDismiss: () => setToastPracticeXp(null),
            },
            toastRallyStalled && {
              id: 'toast-rally-stalled',
              tone: 'warn' as const,
              ttlMs: TOAST_TTL.notice,
              content: t('rally_stalled_notice', currentLanguage),
              onDismiss: () => setToastRallyStalled(false),
            },
            toastActionFailed && {
              id: 'toast-action-failed',
              tone: 'warn' as const,
              ttlMs: TOAST_TTL.notice,
              content: t('load_failed', currentLanguage),
              onDismiss: () => setToastActionFailed(false),
            },
            toastRelayError && {
              id: 'toast-relay-error',
              tone: 'warn' as const,
              ttlMs: TOAST_TTL.notice,
              content: toastRelayError,
              onDismiss: () => setToastRelayError(null),
            },
            toastEjected && {
              id: 'toast-ejected',
              tone: 'loss' as const,
              ttlMs: TOAST_TTL.notice,
              content: t('connection_lost_notice', currentLanguage),
              onDismiss: () => setToastEjected(false),
            },
            toastRoomExpired && {
              id: 'toast-room-expired',
              tone: 'warn' as const,
              ttlMs: TOAST_TTL.notice,
              content: t('room_expired_notice', currentLanguage),
              onDismiss: () => setToastRoomExpired(false),
            },
            toastTableEnded && {
              id: 'toast-table-ended',
              tone: 'warn' as const,
              ttlMs: TOAST_TTL.notice,
              content: t('table_ended_notice', currentLanguage),
              onDismiss: () => setToastTableEnded(false),
            },
            toastOpponentLeft && {
              id: 'toast-opponent-left',
              tone: toastOpponentLeft === 'won' ? ('win' as const) : ('loss' as const),
              ttlMs: TOAST_TTL.reward,
              content: t(
                toastOpponentLeft === 'won' ? 'opponent_left_win_notice' : 'opponent_left_notice',
                currentLanguage
              ),
              onDismiss: () => setToastOpponentLeft(null),
            },
            // Deliberately no ttlMs: this one reports a state that is still
            // unresolved, and it is cleared by applyMatchResult the moment the
            // retry lands. A timer would hide an unsaved match.
            toastRecordFailed && {
              id: 'toast-record-failed',
              tone: 'warn' as const,
              content: t('match_not_saved', currentLanguage),
              onDismiss: () => setToastRecordFailed(false),
            },
            toastInviteFailed && {
              id: 'toast-invite-failed',
              tone: 'warn' as const,
              ttlMs: TOAST_TTL.notice,
              content: t('invite_join_failed', currentLanguage),
              onDismiss: () => setToastInviteFailed(false),
            },
          ].filter(Boolean) as ToastSpec[]}
        />

        {/* One confirmation for every route out of a live match, because they
            all cost the same thing: the match, recorded as a loss. It names
            that consequence and the ones that follow from it — the opponent's
            win in a duel, and whether the ladder is on the line — rather than
            asking "are you sure" and leaving the player to find out. */}
        <Sheet
          id="quit-confirm-modal"
          isOpen={exitConfirm !== null}
          onClose={() => setExitConfirm(null)}
          size="xs"
          layer="over"
          accent="loss"
          title={t(
            exitConfirm === 'solo-reset' ? 'reset_confirm_title' : 'quit_confirm_title',
            currentLanguage
          )}
          footer={
            <>
              <Button
                id="btn-quit-cancel"
                variant="secondary"
                block
                onClick={() => setExitConfirm(null)}
              >
                {t('quit_confirm_no', currentLanguage)}
              </Button>
              <Button
                id="btn-quit-confirm"
                variant="danger"
                block
                onClick={() => {
                  const intent = exitConfirm;
                  setExitConfirm(null);
                  if (intent === 'duel') handleLeaveRoom();
                  else if (intent === 'solo-reset') commitResetMatch();
                  else commitQuitToMenu();
                }}
              >
                {t(
                  exitConfirm === 'solo-reset' ? 'reset_confirm_yes' : 'quit_confirm_yes',
                  currentLanguage
                )}
              </Button>
            </>
          }
        >
          <div className="space-y-2">
            <p
              id="quit-confirm-consequence"
              className="text-2xs leading-relaxed font-normal tracking-normal text-ink-muted"
            >
              {t(
                exitConfirm === 'duel'
                  ? 'quit_confirm_body'
                  : exitConfirm === 'solo-reset'
                    ? 'reset_confirm_body'
                    : 'quit_confirm_body_solo',
                currentLanguage
              )}
            </p>
            {/* Whether the ladder is actually on the line, from the same
                verdict the pre-match sheet shows — a Rookie match and a
                sonar match cost the record but not the rank, and saying so
                is the difference between a warning and a scare. */}
            <p className="text-2xs leading-relaxed font-normal tracking-normal text-ink-dim">
              {t(
                unrankedReasons({
                  rules: activeConfig.rules,
                  mode,
                  difficulty: settings.difficulty,
                  // The table's own venue, so a Casual duel is not threatened
                  // with a rank it was never going to move.
                  venueRoomId: tableState?.venueRoomId ?? null,
                }).length === 0
                  ? 'quit_confirm_ranked'
                  : 'quit_confirm_unranked',
                currentLanguage
              )}
            </p>
          </div>
        </Sheet>

        <Sheet
          id="leave-lobby-confirm-modal"
          isOpen={leaveLobbyConfirmOpen}
          onClose={() => setLeaveLobbyConfirmOpen(false)}
          size="xs"
          layer="over"
          accent="warn"
          title={t('lobby_leave_confirm_title', currentLanguage)}
          footer={
            <>
              <Button
                id="btn-leave-lobby-cancel"
                variant="secondary"
                block
                onClick={() => setLeaveLobbyConfirmOpen(false)}
              >
                {t('lobby_leave_confirm_no', currentLanguage)}
              </Button>
              <Button
                id="btn-leave-lobby-confirm"
                variant="danger"
                block
                onClick={() => {
                  setLeaveLobbyConfirmOpen(false);
                  handleLeaveRoom();
                }}
              >
                {t('lobby_leave_confirm_yes', currentLanguage)}
              </Button>
            </>
          }
        >
          <p className="text-2xs leading-relaxed font-normal tracking-normal text-ink-muted">
            {t(
              playerIndex === 0
                ? 'lobby_leave_confirm_body_host'
                : 'lobby_leave_confirm_body_guest',
              currentLanguage
            )}
          </p>
        </Sheet>

        {/* Mandatory first-arrival onboarding: gates EVERYTHING until the
            player locks in their unique username (or restores a profile) */}
        <OnboardingModal
          isOpen={Boolean(profile && !profile.initialized)}
          theme={currentTheme}
          language={currentLanguage}
          /* An invitation is the one link into Phong that gets tapped from
             ANOTHER app, so it is the one that routinely lands a player in a
             browser that is not the one holding their account — a chat app's
             in-app browser, or whatever a QR scan hands off to. There the app
             cannot tell them from a first-time player, and onboarding reads as
             having been signed out of an account that is in fact perfectly
             safe where they left it. Saying so is the whole fix. */
          invited={Boolean(pendingRoomRef.current)}
          onInitialized={(p) => {
            setProfile(p);
            setPlayerId(p.id);
          }}
        />

        {/* Public profile viewer — opened by tapping any username */}
        <PublicProfileModal
          stack={stackOf('public-profile')}
          playerId={publicProfileId}
          onClose={() => setPublicProfileId(null)}
          language={currentLanguage}
          onViewProfile={openPublicProfile}
        />

        {/* Screen swap.
            mode="wait" keeps exactly ONE branch mounted: no double CourtCanvas,
            no two RAF loops, and the suites' negative assertions (that
            #main-menu-screen is absent behind the device gate) cannot be
            tripped by a lingering exit node. Never render both and hide one
            with CSS — display:none still satisfies those assertions' opposite.

            The wrappers are `absolute inset-0`, not `flex-1`: ScoreBoard, the
            link badge, the countdown and the winner overlay all position
            against the nearest positioned ancestor, and a wrapper becomes that
            ancestor. Same box in, same box out. */}
        <AnimatePresence mode="wait" initial={false}>
        {screen === 'menu' ? (
          <motion.div key="menu" className="absolute inset-0 flex flex-col" {...screenMotion}>
          <MainMenu
            quickMatch={quickMatch}
            theme={currentTheme}
            settings={settings}
            onUpdateSettings={(newVals) => setSettings((s) => ({ ...s, ...newVals }))}
            profile={profile}
            playerStatus={playerStatus}
            missions={missions}
            unclaimedMissionsCount={missionsSummary.unclaimed}
            onStartSolo={() => startMatch('solo')}
            onStartPractice={() => startMatch('practice')}
            onStartSplit={() => startMatch('split')}
            onOpenMultiplayer={(venue) => {
              // A PvP room sets the venue a created table lands in, and the
              // browser the lobby shows. No venue means the bare invite flow.
              venueRef.current = { roomId: venue ?? DEFAULT_VENUE_ROOM, visibility: 'private' };
              setLobbyVenue(venue ?? null);
              setVenueTables([]);
              setIsMultiplayerOpen(true);
            }}
            onOpenProfile={() => setIsProfileOpen(true)}
            onOpenMissions={() => setIsMissionsOpen(true)}
            // The four destinations that are not PLAY. Built here because the
            // data is here; mounted by the pager, three at a time.
            //
            // RENDER FUNCTIONS rather than elements, and `isCurrent` is the
            // whole reason: the pager's window holds three slots, so a page
            // can be mounted without being the one on screen — and a page that
            // stays mounted fetches when it becomes a NEIGHBOUR and never
            // again. Three of these ask the server for something that moves,
            // so each needs to know when it has actually arrived. Settings
            // takes the argument and ignores it; a uniform type beats a
            // special case waiting to be forgotten.
            pages={{
              leaderboard: (isCurrent) => (
                <RanksPage
                  language={currentLanguage}
                  currentPlayerId={playerId}
                  onViewProfile={openPublicProfile}
                  isCurrent={isCurrent}
                  onRefetchProfile={fetchProfile}
                />
              ),
              achievements: (isCurrent) => (
                <AchievementsTree
                  language={currentLanguage}
                  playerId={playerId}
                  level={profile?.level || 1}
                  tier={profile?.tier || 'unranked'}
                  active
                  isCurrent={isCurrent}
                />
              ),
              history: (isCurrent) => (
                <HistoryPage
                  language={currentLanguage}
                  playerId={playerId}
                  onViewProfile={openPublicProfile}
                  isCurrent={isCurrent}
                />
              ),
              settings: () => (
                <SettingsPanel
                  settings={settings}
                  onUpdateSettings={(newVals) => setSettings((s) => ({ ...s, ...newVals }))}
                  onTriggerShake={() => setShakeTrigger(Date.now())}
                  indicatorsLockedBySonar={!indicatorsAllowed}
                />
              ),
            }}
          />
          </motion.div>
        ) : (
          <motion.div key="game" className="absolute inset-0 flex flex-col" {...screenMotion}>

        {/* Local 2-player classic court on one screen — offline & unranked */}
        {inSplitMatch && (
          <SplitScreenMatch
            settings={settings}
            theme={currentTheme}
            winningScore={activeConfig.winningScore}
            rules={activeConfig.rules}
            onExitSplitMode={quitToMenu}
          />
        )}

        {inCourtMatch && (
          <>
        {/* Top HUD / Scoreboard */}
        <ScoreBoard
          stats={stats}
          mode={mode}
          theme={currentTheme}
          profile={profile}
          playerStatus={playerStatus}
          soundEnabled={settings.soundEnabled}
          onToggleSound={() => setSettings((s) => ({ ...s, soundEnabled: !s.soundEnabled }))}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenProfile={() => setIsProfileOpen(true)}
          onResetMatch={handleResetMatch}
          // Hidden in a duel because the score belongs to the room, so a
          // local reset could only desync this phone from the other one.
          canResetMatch={mode !== 'multiplayer'}
          // A watcher is told whose court they are looking at. The opponent
          // name beside it is already right: it is the player on the far side
          // of the net from the court being drawn, which is what the whole
          // fan-out makes true for a watcher too.
          watchingName={spectating ? tableState?.seats[spectating.side]?.playerName ?? null : null}
          // Offered only when the other watching seat is actually free: the
          // relay refuses a taken one, and a control that always refuses is
          // worse than no control.
          onSwapSide={
            spectating && tableState?.seats[spectating.side === 0 ? 3 : 2]?.playerId === null
              ? () => handleSwapSeat(spectating.side === 0 ? 3 : 2)
              : undefined
          }
          onQuitToMenu={quitToMenu}
          winningScore={activeConfig.winningScore}
          opponentName={mode === 'multiplayer' ? opponentName || 'Opponent' : `AI (${activeDifficulty})`}
          onViewOpponent={
            mode === 'multiplayer' && isLinkableId(opponentId)
              ? () => openPublicProfile(opponentId)
              : undefined
          }
          language={currentLanguage}
        />

        {/* Mini Radar Sonar Preview (Shows unseen opponent court if enabled).
            Practice Wall has no opponent court, so no radar there. Solo reads
            the simulated half; a duel reads the opponent phone's ball_pos
            stream — either way the refs hold the sender-frame truth. */}
        <RadarPreview
          oppBallRef={oppBallRef}
          oppPaddleXRef={oppPaddleXRef}
          paddleWidthRatio={paddleWidthFor(activeConfig.rules)}
          theme={currentTheme}
          language={currentLanguage}
          active={
            settings.showRadar &&
            activeConfig.rules.opponentSonar &&
            (mode === 'solo' || mode === 'multiplayer')
          }
          // Clears the connection column above it — which is TWO rows when
          // the ping is showing. The ping chip sat at exactly the offset this
          // used for multiplayer, on the same edge and a higher z, so it
          // painted straight over the sonar; permanently, for a spectator,
          // since a watched table is forced onto the relay and the ping is
          // only ever shown on the relay.
          topClass={
            mode !== 'multiplayer'
              ? 'top-14'
              : pingMs > 0 && linkStatus !== 'p2p'
                ? 'top-[7rem]'
                : 'top-[5.5rem]'
          }
        />

        {/* Connection badge and its ping, as ONE column so they cannot overlap
            each other or anything positioned to clear them. */}
        <div className="absolute top-14 right-2 z-30 flex flex-col items-end gap-1">
        {mode === 'multiplayer' && opponentId && (
          <div
            id="link-status-badge"
            className={`rounded-chip border px-2 py-0.5 text-2xs select-none ${
              linkStatus === 'p2p'
                ? 'bg-win/15 border-win/50 text-win'
                : linkStatus === 'connecting'
                  ? 'bg-warn/15 border-warn/50 text-warn animate-pulse'
                  : 'bg-accent/15 border-accent/50 text-accent'
            }`}
            title={
              linkStatus === 'p2p'
                ? 'Direct peer-to-peer connection'
                : linkStatus === 'connecting'
                  ? 'Negotiating direct connection'
                  : 'Playing via server relay'
            }
          >
            {linkStatus === 'p2p' ? 'P2P' : linkStatus === 'connecting' ? 'P2P…' : 'RELAY'}
          </div>
        )}
        {/* The ping is a SIBLING. It used to live inside the badge's own
            textContent, which e2e-gameplay compares with strict equality —
            that assertion only passed because the suite never waits for
            RELAY, the one state that appends it. */}
        {inCourtMatch && mode === 'multiplayer' && pingMs > 0 && linkStatus !== 'p2p' && (
          <div
            id="link-ping"
            data-stale={Date.now() - pingAt > PING_STALE_MS ? '1' : '0'}
            className={`rounded-chip border bg-surface-0/80 px-1.5 py-0.5 text-2xs tnum select-none ${
              Date.now() - pingAt > PING_STALE_MS
                ? 'border-warn/50 text-warn'
                : 'border-line text-ink-dim'
            }`}
          >
            {Date.now() - pingAt > PING_STALE_MS ? '···' : `${pingMs}ms`}
          </div>
        )}
        </div>

        {/* Main Single Half-Court View (The Half-Pong Table) */}
        <main className="flex-1 w-full h-full pt-14 relative flex items-center justify-center">
          {/* Real-time Telemetry Stats Overlay directly on court */}
          {activeConfig.rules.trackTelemetry && (
            <StatsOverlay
              ball={ball}
              paddleX={paddleX}
              totalTouches={totalTouches}
              streak={stats.streak}
              bestStreak={stats.bestStreak}
              oppStreak={stats.oppStreak}
              oppBestStreak={stats.oppBestStreak}
              theme={currentTheme}
              isVisible={telemetryOpen}
              onToggleVisible={() => setTelemetryOpen((o) => !o)}
              language={currentLanguage}
              matchStartTime={matchStartTime}
            />
          )}

          {/* Quick Chat overlay & popup tray (nobody to chat with in practice) */}
          {mode !== 'practice' && activeConfig.rules.quickChat && (
            <QuickChat
              onSendMessage={handleSendQuickChat}
              activeMessages={activeChatMessages}
              theme={currentTheme}
              language={currentLanguage}
              disabled={Boolean(winner)}
            />
          )}

          <CourtCanvas
            ball={ball}
            paddleX={paddleX}
            onPaddleMove={handlePaddleMove}
            settings={settings}
            theme={currentTheme}
            isServing={isServing && isPlayerServer}
            onServe={handleServe}
            paddleWidth={paddleWidthFor(activeConfig.rules)}
            serveAngleLimitDeg={SERVE_MAX_ANGLE_DEG * activeConfig.rules.serveAngleMax}
            autoServeSeconds={activeConfig.rules.autoServeSeconds}
            serveCountdown={serveCountdown}
            oppPaddleXRef={oppPaddleXRef}
            oppBallRef={oppBallRef}
            hasOpponent={mode === 'solo' || mode === 'multiplayer'}
            showOpponentIndicator={settings.showOpponentIndicator && indicatorsAllowed}
            showBallIndicator={settings.showBallIndicator && indicatorsAllowed}
            rallyCount={stats.streak}
            language={currentLanguage}
            shakeTrigger={shakeTrigger}
            netLabel={mode === 'practice' ? t('return_line', currentLanguage) : undefined}
            readOnly={!!spectating}
          />
        </main>

        {/* Winner Overlay Modal */}
        {/* Match-start countdown: the duel initializes only when it hits 0.
            Pointer-events pass through — the paddle can be positioned early. */}
        {mode === 'multiplayer' && matchCountdown !== null && matchCountdown > 0 && (
          <div
            id="match-countdown"
            className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none"
          >
            <div className="flex flex-col items-center gap-2">
              <span
                key={matchCountdown}
                className="animate-count-in text-numeral text-[4.5rem] tnum text-accent"
              >
                {matchCountdown}
              </span>
              <span className="text-kicker text-ink-muted uppercase">
                {t('match_starting', currentLanguage)}
              </span>
            </div>
          </div>
        )}

        {winner && (
          <div
            id="winner-modal-overlay"
            className="absolute inset-0 z-40 flex items-center justify-center bg-surface-0/88 p-4"
          >
            <motion.div
              className="flex w-full max-w-sm flex-col items-center gap-3 rounded-sheet border bg-surface-2 p-5 text-center shadow-sheet"
              style={{
                borderColor:
                  winner === 'player'
                    ? currentTheme.playerPaddleColor
                    : currentTheme.opponentPaddleColor,
              }}
              initial={{ opacity: 0, y: 12, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <h2
                className={`text-hero ${
                  spectating ? 'text-accent' : winner === 'player' ? 'text-win' : 'text-loss'
                }`}
              >
                {/* A watcher won nothing and lost nothing. VICTORY here would
                    be a claim about somebody else's match, so the winner is
                    named instead. */}
                {spectating
                  ? t('watched_wins', currentLanguage, {
                      // Read off the table rather than off `opponentName`,
                      // which is only ever the far side: either seat can be
                      // the one that won. 'Opponent' is the same untranslated
                      // fallback the rest of the file uses for a missing name.
                      name:
                        tableState?.seats[
                          winner === 'player' ? spectating.side : spectating.side === 0 ? 1 : 0
                        ]?.playerName || 'Opponent',
                    })
                  : winner === 'player'
                    ? t('victory', currentLanguage)
                    : t('match_lost', currentLanguage)}
              </h2>

              {/* Paddle-coloured, because that is which score is yours. */}
              <div className="flex items-baseline gap-3 text-numeral tnum">
                <span style={{ color: currentTheme.playerPaddleColor }}>{stats.score}</span>
                <span className="text-title text-ink-dim">–</span>
                <span style={{ color: currentTheme.opponentPaddleColor }}>
                  {stats.opponentScore}
                </span>
              </div>

              {/* The result strip. The end of a match is this game's main
                  progression payoff and it used to be a +XP number in a grey
                  box; the XP bar now actually moves toward the next level.

                  Rendered ALWAYS, not once the result lands. It used to be
                  gated on `lastMatchResult`, which is the same mistake the
                  rank tile inside it already fixed one level down — that tile
                  vanished for an unranked match, which is exactly when a
                  player most wants to be told the ladder did not move. Gated,
                  the whole strip appeared out of nowhere a few hundred
                  milliseconds in and shoved the buttons down the screen, and a
                  player who tapped Rematch on the whistle never saw the match
                  they had just played. The numbers this phone already knows —
                  the score, the rally — are on screen from the first frame,
                  and only what the server owes fills in. */}
              {!spectating && (
                <div className="flex w-full flex-col gap-3">
                  <div className="grid w-full grid-cols-3 gap-2">
                    <StatTile
                      label={t('progression', currentLanguage)}
                      value={lastMatchResult ? `+${lastMatchResult.earnedXp}` : '···'}
                      tone="xp"
                      // The odds had a tile of their own, in the slot the rank
                      // now occupies permanently. They are a PRE-match
                      // prediction and the XP they scaled is right above them,
                      // so this is where they belong anyway.
                      hint={
                        lastMatchResult
                          ? `${t('predicted_odds', currentLanguage)} ${Math.round(
                              lastMatchResult.winProbability * 100
                            )}%`
                          : undefined
                      }
                    />
                    <StatTile
                      label={t('longest_rally', currentLanguage)}
                      value={stats.bestStreak}
                      tone="warn"
                    />
                    {/* Rank, always — the tile used to disappear entirely for
                        an unranked result, which is exactly when a player most
                        wants to be told the ladder did not move. The arrow is
                        the whole answer; the mu behind it is never rendered
                        anywhere (see components/ui/RankBadge.tsx). */}
                    <div
                      id="winner-rank-tile"
                      className="flex flex-col items-center justify-center gap-1 rounded-card border border-line bg-surface-1 px-2 py-2.5"
                    >
                      {/* Stacked, not side by side. The tile is one of three
                          in a grid — 100px on a 390px phone, 84px inside its
                          own padding — and the tier badge alone measures 82px
                          at "Unranked". Beside it even the SINGLE 16px arrow
                          this replaced overflowed the tile and spilled over
                          its neighbour; three would be hopeless. Nothing went
                          red for it because the only layer that can see a
                          layout here is the browser, and nothing asserted this
                          tile at all. */}
                      <div className="flex flex-col items-center gap-1">
                        <TierBadge
                          tier={lastMatchResult?.tier ?? profile?.tier ?? 'unranked'}
                          language={currentLanguage}
                        />
                        {/* One arrow for a minor move, two for a moderate one,
                            three for a large one — and the count comes from the
                            server, so two bundles cannot draw a different number
                            for the same match. h-3.5 with a negative gap rather
                            than the h-4 a single arrow had: this tile is one of
                            three in a grid, so about 100px on a small phone, and
                            it already holds a TierBadge. Three h-4 arrows add
                            48px and push the badge out; three of these come to
                            about 28px. */}
                        {lastMatchResult ? (
                          <span
                            id={`rank-move-${lastMatchResult.rankDirection}`}
                            data-rank-magnitude={lastMatchResult.rankMagnitude}
                            role="img"
                            aria-label={t(
                              rankMoveKey(lastMatchResult.rankDirection, lastMatchResult.rankMagnitude),
                              currentLanguage
                            )}
                            title={t(
                              rankMoveKey(lastMatchResult.rankDirection, lastMatchResult.rankMagnitude),
                              currentLanguage
                            )}
                            className="flex shrink-0 items-center -space-x-1.5"
                          >
                            {lastMatchResult.rankDirection === 'none' ? (
                              <Circle className="h-2.5 w-2.5 fill-current text-rank-steady" />
                            ) : (
                              Array.from(
                                { length: RANK_ARROWS[lastMatchResult.rankMagnitude] },
                                (_, i) =>
                                  lastMatchResult.rankDirection === 'up' ? (
                                    <ArrowUp key={i} className="h-3.5 w-3.5 text-win" />
                                  ) : (
                                    <ArrowDown key={i} className="h-3.5 w-3.5 text-loss" />
                                  )
                              )
                            )}
                          </span>
                        ) : (
                          /* The slot the arrows are about to fill, holding its
                             own height so nothing shifts when they arrive.
                             aria-hidden rather than a "pending" name: the
                             ladder has not answered yet, and announcing a rank
                             movement that does not exist is worse than
                             announcing nothing. The tier badge above is still
                             read, and it is still true. */
                          <span
                            id="rank-move-pending"
                            aria-hidden="true"
                            className="flex shrink-0 items-center"
                          >
                            <Circle className="h-2.5 w-2.5 fill-current text-ink-dim opacity-40" />
                          </span>
                        )}
                      </div>
                      <span className="text-2xs font-normal tracking-normal text-ink-muted uppercase">
                        {lastMatchResult?.tierChanged
                          ? t('rank_updated', currentLanguage)
                          : t('skill_tier', currentLanguage)}
                      </span>
                    </div>
                  </div>

                  {profile && (
                    <ProgressBar
                      value={Math.min(
                        1,
                        Math.max(0, profile.xp - xpForLevel(profile.level)) /
                          Math.max(1, profile.xpNext - xpForLevel(profile.level))
                      )}
                      tone="xp"
                      label={`${t('menu_level', currentLanguage)} ${profile.level}`}
                      trailing={`${profile.xp.toLocaleString()} / ${profile.xpNext.toLocaleString()}`}
                      ariaLabel={t('progression', currentLanguage)}
                    />
                  )}
                </div>
              )}

              {mode === 'multiplayer' &&
                playerIndex !== null &&
                rematchVotes[playerIndex === 0 ? 1 : 0] && (
                  <p className="animate-ready-pulse text-2xs text-accent">
                    {opponentName || 'Opponent'}: {t('chat_rematch', currentLanguage)}
                  </p>
                )}

              <div className="mt-1 flex w-full items-center gap-2">
                {/* No rematch control for a watcher: a rematch is a vote, and
                    a watcher has no vote to cast. The next match of the same
                    table needs nothing from them either — game_start resets
                    the court exactly as it does for a player. */}
                {!spectating && (
                <Button
                  id="btn-play-again"
                  variant="primary"
                  size="lg"
                  block
                  onClick={() => {
                    if (mode === 'multiplayer') {
                      sendNetRef.current({ type: 'rematch_request' });
                    } else {
                      resetMatch();
                    }
                  }}
                  // Held back until the result this match produced is on
                  // screen. Rematch replaces the match it describes, so a
                  // player who taps it on the whistle would never learn what
                  // the one they just played did to their ladder — the whole
                  // point of the strip above. Three doors open it (the result,
                  // a failed record, a hard timeout) so it can never stick,
                  // and Main Menu below waits on NONE of them: no state this
                  // app can reach may have its only exit blocked on a request.
                  disabled={
                    !resultSettled ||
                    (mode === 'multiplayer' &&
                      (opponentId === null ||
                        (playerIndex !== null && rematchVotes[playerIndex])))
                  }
                  icon={
                    <RefreshCw
                      className={`h-4 w-4 ${
                        mode === 'multiplayer' &&
                        playerIndex !== null &&
                        rematchVotes[playerIndex]
                          ? 'animate-spin'
                          : ''
                      }`}
                    />
                  }
                >
                  {mode === 'multiplayer'
                    ? playerIndex !== null && rematchVotes[playerIndex]
                      ? t('waiting_for_opponent', currentLanguage)
                      : t('rematch', currentLanguage)
                    : t('play_again', currentLanguage)}
                </Button>
                )}

                {/* Between-match navigation: back to the out-of-match hub */}
                <Button
                  id="btn-menu-from-win"
                  variant="secondary"
                  size="lg"
                  onClick={quitToMenu}
                  icon={<Home className="h-4 w-4 text-accent" />}
                >
                  {t('main_menu', currentLanguage)}
                </Button>
              </div>
            </motion.div>
          </div>
        )}
          </>
        )}
          </motion.div>
        )}
        </AnimatePresence>

        {/* Daily Missions Modal */}
        <MissionsModal
          stack={stackOf('missions')}
          isOpen={isMissionsOpen}
          onClose={() => setIsMissionsOpen(false)}
          missions={missions}
          onClaimReward={handleClaimMissionReward}
          language={currentLanguage}
          onReroll={handleRerollMission}
          rerolls={rerolls}
        />

        {/* Settings & Customization Modal (device preferences only —
            match settings live on the main menu, pre-match) */}
        <SettingsModal
          stack={stackOf('settings')}
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          settings={settings}
          onUpdateSettings={(newVals) => setSettings((s) => ({ ...s, ...newVals }))}
          profile={profile}
          onTriggerShake={() => setShakeTrigger(Date.now())}
          indicatorsLockedBySonar={!indicatorsAllowed}
        />

        {/* 2-Phone Multiplayer Lobby */}
        <MultiplayerLobby
          stack={stackOf('lobby')}
          isOpen={isMultiplayerOpen}
          onClose={requestLeaveLobby}
          theme={currentTheme}
          roomId={roomId}
          playerIndex={playerIndex}
          opponentName={opponentName}
          isConnected={isConnected}
          currentUsername={profile?.username}
          // The single create door, and it makes a PUBLIC table: one that is
          // listed in the room's browser AND still carries the 4-letter code
          // and QR. The unlisted variant is no longer reachable from the
          // client — `visibility` stays in the protocol, and stays private by
          // DEFAULT at the relay, which is what keeps an old bundle, the
          // invite flow and the test harness working unchanged.
          onCreateRoom={() => handleCreateRoom({ visibility: 'public' })}
          onJoinRoom={handleJoinRoom}
          onLeaveRoom={requestLeaveLobby}
          opponentId={opponentId}
          onViewProfile={openPublicProfile}
          winProbability={matchPrediction}
          roomConfig={roomConfig}
          onUpdateRoomConfig={handleSetRoomConfig}
          readyStates={lobbyReady}
          onSendReady={handleSendReady}
          onStartMatch={handleStartMatch}
          earnedAchievements={profile?.achievements || []}
          language={currentLanguage}
          p2pEnabled={p2pEnabled}
          onToggleP2P={setP2pEnabled}
          venueRoomId={lobbyVenue}
          tables={venueTables}
          tablesLoading={tablesLoading}
          onRefreshTables={() => refreshTables(lobbyVenue)}
          onWatchTable={handleWatchTable}
          tableState={tableState}
          onSwapSeat={handleSwapSeat}
          isPrivate={!!tableState?.isPrivate}
          joinKey={tableState?.joinKey ?? null}
          // Turning the lock ON always mints a FRESH key, so a key already
          // shared stops working — which is the whole point of a lock you can
          // re-set. The relay does the minting; this only asks.
          onSetPrivate={(isPrivate) =>
            sendWhenOpen(ws, () => ({ type: 'set_table_visibility', private: isPrivate }))
          }
        />

        {/* Player Profile & Stats Modal */}
        <ProfileModal
          stack={stackOf('profile')}
          isOpen={isProfileOpen}
          onClose={() => setIsProfileOpen(false)}
          profile={profile}
          playerStatus={playerStatus}
          onUpdateUsername={handleUpdateUsername}
          onRefreshProfile={fetchProfile}
          onViewProfile={openPublicProfile}
          equippedCosmetic={equippedCosmeticId}
          onEquipCosmetic={(id) => void handleEquipCosmetic(id)}
          language={currentLanguage}
          // Menu only, and this modal is why the rule needs restating rather
          // than moving: SettingsModal had one door and this has TWO — the
          // menu's header pill and the in-match HUD's #btn-open-profile, the
          // same instance both times. From a live court, deleting would walk
          // the player out of a match — and out of a DUEL, leaving an opponent
          // alone in a room that was never told anybody had gone. The relay
          // would charge the abandon and the account it charged would already
          // be deleted.
          onDeleteAccount={screen === 'menu' ? handleDeleteAccount : undefined}
        />

        {/* Ranks, Trophies and History are PAGES now, not modals — each had
            exactly one entry point (the tab that is now the page), so there was
            no second door left to keep a sheet open for. Settings is the one
            exception and its modal survives below, because the in-match HUD
            opens it and a live court has no pager to put a page on. */}
      </div>
      </SessionGuard>
    </MobileGatekeeper>
  );
}
