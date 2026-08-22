import { AnimatePresence, motion } from 'motion/react';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  BallState,
  GameMode,
  GameSettings,
  PlayerStats,
  WSClientMessage,
  WSServerMessage,
  PlayerProfile,
  Achievement,
  MatchEndResult,
  MatchEndPayload,
  PlayerStatus,
  DailyMission,
  LanguageCode,
  MatchRules,
  CourtTheme,
  RoomMatchConfig,
} from './types';
import { P2PGameLink, P2PStatus } from './net/p2p';
import { postMatchRecord, flushPendingMatches } from './net/matchRecord';
import { THEMES, ThemeConfig } from './game/themes';
import {
  PADDLE_Y,
  PADDLE_HEIGHT,
  PADDLE_WIDTH_RATIO,
  BALL_BASE_RADIUS,
  BASE_BALL_SPEED,
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
} from './matchRules';
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
import { MultiplayerLobby } from './components/MultiplayerLobby';
import { MainMenu } from './components/MainMenu';
import { SplitScreenMatch } from './components/SplitScreenMatch';
import { ProfileModal } from './components/ProfileModal';
import { LeaderboardModal } from './components/LeaderboardModal';
import { AchievementsModal } from './components/AchievementsModal';
import { AchievementToast } from './components/AchievementToast';
import { MatchHistoryModal } from './components/MatchHistoryModal';
import { StatsOverlay } from './components/StatsOverlay';
import { MissionsModal } from './components/MissionsModal';
import { QuickChat, ChatMessage } from './components/QuickChat';
import { MobileGatekeeper } from './components/MobileGatekeeper';
import { SessionGuard } from './components/SessionGuard';
import { TutorialModal } from './components/TutorialModal';
import { OnboardingModal } from './components/OnboardingModal';
import { PublicProfileModal } from './components/PublicProfileModal';
import {
  Sheet,
  Button,
  ProgressBar,
  StatTile,
  ToastHost,
  useMotion,
  type ToastSpec,
} from './components/ui';
import { isLinkableId } from './profileRules';
import {
  ClientSessionStatus,
  endSession,
  openSession,
  probeSession,
  refreshForBuild,
  resetDevice,
  watchSession,
} from './net/session';
import { DIFFICULTY_ORDER, playableDifficulty, playableWinningScore } from './achievements';
import { TierBadge } from './components/TierBadge';
import confetti from 'canvas-confetti';
import { Trophy, RefreshCw, Home } from 'lucide-react';

/** How many times a lost invitation socket is retried before giving up. */
const MAX_INVITE_RETRIES = 2;

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
  showTrails: true,
  // Taken from the ladder rather than written out, so the shipped default is
  // the easiest rung by construction and cannot drift into being a LOCKED one.
  // It shipped as 'pro', which stays locked until Rookie has been beaten — so
  // every solo match a new player played came back 403 DIFFICULTY_LOCKED and
  // was thrown away, paying no XP, no missions and no history.
  difficulty: DIFFICULTY_ORDER[0],
  winningScore: DEFAULT_WINNING_SCORE,
  rules: DEFAULT_MATCH_RULES,
  theme: 'neon',
  language: 'en',
};

/**
 * The identity of one solo match, minted here because only this device can
 * report it. It rides on the payload, so a retry and a replay from the
 * on-device queue carry the key the first attempt used and the server can see
 * they are the same match rather than three.
 */
const newSoloMatchKey = (): string =>
  `solo:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;

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
  const [isLeaderboardOpen, setIsLeaderboardOpen] = useState<boolean>(false);
  const [isAchievementsOpen, setIsAchievementsOpen] = useState<boolean>(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState<boolean>(false);
  const [isTutorialOpen, setIsTutorialOpen] = useState<boolean>(false);
  const [shakeTrigger, setShakeTrigger] = useState<number>(0);
  // Any tapped username opens this player's public profile (z-[60], above
  // whichever modal spawned it). null = closed.
  const [publicProfileId, setPublicProfileId] = useState<string | null>(null);
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

  // Toast notifications
  const [toastAchievement, setToastAchievement] = useState<Achievement | null>(null);
  const [toastLevelUp, setToastLevelUp] = useState<number | null>(null);
  // A match that failed to reach the server is parked on the device; the
  // player is told rather than left looking at an untracked result.
  const [toastRecordFailed, setToastRecordFailed] = useState<boolean>(false);
  const [toastPracticeXp, setToastPracticeXp] = useState<number | null>(null);
  // A permanent unlock banked from an elite mission — worth announcing.
  const [toastUnlock, setToastUnlock] = useState<string | null>(null);
  const [toastOpponentLeft, setToastOpponentLeft] = useState<boolean>(false);
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
    rallyCount: 0,
    maxRally: 0,
    aces: 0,
    matchesWon: 0,
  });

  // Active Player Half Court Ball State
  const [ball, setBall] = useState<BallState>({
    x: 0.5,
    y: 0.82,
    vx: 0.3,
    vy: -BASE_BALL_SPEED,
    radius: BALL_BASE_RADIUS,
    active: true,
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
  const [rematchVotes, setRematchVotes] = useState<[boolean, boolean]>([false, false]);
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
  const [quitConfirmOpen, setQuitConfirmOpen] = useState<boolean>(false);
  const [toastEjected, setToastEjected] = useState<boolean>(false);
  // 'relay' = via server; 'connecting' = P2P handshake running; 'p2p' = direct
  const [linkStatus, setLinkStatus] = useState<'relay' | 'connecting' | 'p2p'>('relay');
  const [p2pEnabled, setP2pEnabled] = useState<boolean>(true);

  // The terms the CURRENT match is played on. A duel takes them from the room
  // so both sides agree; every other mode takes them from the menu.
  const activeConfig: RoomMatchConfig =
    mode === 'multiplayer' && roomConfig
      ? roomConfig
      : { winningScore: settings.winningScore, rules: settings.rules };

  // Refs for high-speed 60fps physics loop without stale closures
  const ballRef = useRef<BallState>(ball);
  const oppBallRef = useRef<BallState | null>(oppBall);
  const paddleXRef = useRef<number>(paddleX);
  const prevPaddleXRef = useRef<number>(paddleX);
  const paddleVxRef = useRef<number>(0);
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
  const countdownArmedRef = useRef<boolean>(countdownArmed);

  ballRef.current = ball;
  oppBallRef.current = oppBall;
  paddleXRef.current = paddleX;
  modeRef.current = mode;
  screenRef.current = screen;
  wsRef.current = ws;
  isServingRef.current = isServing;
  statsRef.current = stats;
  settingsRef.current = settings;
  profileRef.current = profile;
  playerIndexRef.current = playerIndex;
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
      setProfile(res.profile);
      setPlayerId(res.profile.id);
    }
  }, []);

  // Refetch once the profile exists (the device cookie is set by then) and
  // again whenever the UTC day rolls over while the tab stays open.
  useEffect(() => {
    if (!profile?.id) return;
    // Replay anything an earlier session couldn't deliver, then refresh.
    void flushPendingMatches().then((recovered) => {
      if (recovered > 0) fetchProfile();
    });
    void refreshMissions();
    const timer = setTimeout(() => void refreshMissions(), msUntilMissionReset() + 1000);
    return () => clearTimeout(timer);
  }, [profile?.id, refreshMissions]);

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
  const applyMatchResult = useCallback((matchKey: string, result: MatchEndResult) => {
    if (!result) return;
    if (matchKey && shownMatchKeyRef.current === matchKey) return;
    if (matchKey) shownMatchKeyRef.current = matchKey;

    setLastMatchResult(result);
    setToastRecordFailed(false);
    if (result.profile) setProfile(result.profile);
    // The server advanced today's missions as part of recording the match.
    if (result.missions) setMissions(result.missions);

    if (result.leveledUp) {
      setToastLevelUp(result.profile.level);
      confetti({ particleCount: 150, spread: 90, origin: { y: 0.5 } });
    } else if (result.newAchievements && result.newAchievements.length > 0) {
      setToastAchievement(result.newAchievements[0]);
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
    }
  }, []);

  // Record Match Result to Server Database and Track Daily Missions
  const recordMatchCompletion = useCallback(
    async (isWinner: boolean) => {
      // Practice Wall and Split Screen are unranked: no winner is ever set
      // for them, and even if one were, nothing gets recorded.
      if (modeRef.current === 'practice' || modeRef.current === 'split') return;

      // A duel's key is derived so the relay lands on the same one; a solo
      // match has only this device to report it, so it mints its own.
      const matchKey =
        modeRef.current === 'multiplayer' && roomId
          ? duelMatchKey(roomId, matchSeqRef.current)
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
          maxRally: statsRef.current.maxRally,
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

        const outcome = await postMatchRecord(payload);
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
        applyMatchResult(matchKey, outcome.result!);
      } catch (e) {
        console.error('Failed to record match on server:', e);
        if (shownMatchKeyRef.current !== matchKey) setToastRecordFailed(true);
      }
    },
    [playerId, opponentId, opponentName, roomId, applyMatchResult]
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
    if (recordedWinnerRef.current === winner) return;
    recordedWinnerRef.current = winner;
    recordMatchCompletion(winner === 'player');
  }, [winner, recordMatchCompletion]);

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
      if (data.unlocked) setToastUnlock(data.unlocked);
    } catch (e) {
      console.error('Failed to claim mission reward', e);
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
          senderName: `AI (${settings.difficulty})`,
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
    aiRef.current.setDifficulty(settings.difficulty);
  }, [settings]);

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
  // An invitation that loses its socket before the server has answered is not
  // a refusal — it is an unanswered question, and latching autoJoinedRef on
  // the ATTEMPT turned every such blip into "the link is broken". Bounded, so
  // a genuinely unreachable relay stops rather than spinning.
  const inviteRetriesRef = useRef<number>(0);
  const [inviteRetry, setInviteRetry] = useState<number>(0);
  useEffect(() => {
    const roomCode = new URLSearchParams(window.location.search).get('room');
    if (roomCode) pendingRoomRef.current = roomCode.trim().toUpperCase();
  }, []);

  // Handle paddle movement & velocity
  const handlePaddleMove = useCallback((newX: number) => {
    setPaddleX(newX);
    paddleVxRef.current = (newX - prevPaddleXRef.current) * 60;
    prevPaddleXRef.current = newX;

    // Send position to multiplayer opponent
    if (modeRef.current === 'multiplayer') {
      sendNetRef.current({ type: 'paddle_move', x: newX });
    }
  }, []);

  // Serve the ball
  const handleServe = useCallback(
    (aim?: ServeAim) => {
      if (!isServingRef.current) return;
      // A duel's serve needs someone on the other end. A host waiting in the
      // lobby is already on the court underneath it, so without this a serve
      // (auto or tapped) would fire the ball into an empty room, where it
      // crosses the net and is simply gone.
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
          y: PADDLE_Y - 0.05,
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
            x: 0.5,
            y: PADDLE_Y - 0.05,
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
  // lobby out of the way — which is also the moment they can first see it.
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
    const active = isServing && isPlayerServer && screen === 'game' && !winner && duelReady;
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
          maxRally: statsRef.current.maxRally,
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
        setRoomId(msg.roomId);
        setPlayerIndex(msg.playerIndex);
        playerIndexRef.current = msg.playerIndex;
        setMode('multiplayer');
        setScreen('game');
        p2pRef.current?.close();
        p2pRef.current = null;
        setLinkStatus('relay');
        break;

      case 'room_joined':
        // Answered. Stop treating a later disconnect as an unfulfilled invite.
        pendingRoomRef.current = null;
        joinInFlightRef.current = false;
        // Holding a seat means the lobby is the right surface until the match
        // starts, so a seat granted while the lobby is shut reopens it. The
        // player can dismiss the lobby in the moment between asking for a seat
        // and being given one, and this case then put them on a live court
        // with no Ready control — holding the room while the host waited for a
        // readiness they had no way to signal.
        setIsMultiplayerOpen(true);
        setRoomId(msg.roomId);
        setPlayerIndex(msg.playerIndex);
        playerIndexRef.current = msg.playerIndex;
        setOpponentName(msg.opponentName);
        setOpponentId(msg.opponentId);
        setMode('multiplayer');
        setScreen('game');
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
        if (p2pEnabled) {
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
        matchKeyRef.current = '';
        shownMatchKeyRef.current = '';
        setRoomConfig(msg.config);
        p2pRef.current?.setConfig(msg.config);
        setStats({
          score: 0,
          opponentScore: 0,
          rallyCount: 0,
          maxRally: 0,
          aces: 0,
          matchesWon: 0,
        });
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
        // The host starting the match is what closes BOTH lobbies: nobody
        // walks onto the court until the room says the match exists.
        setIsMultiplayerOpen(false);
        setIsServing(true);
        p2pRef.current?.resetMatchState(msg.servingPlayer, matchSeqRef.current);
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
        setStats((s) => {
          const nextRally = s.rallyCount + 1;
          return { ...s, rallyCount: nextRally, maxRally: Math.max(s.maxRally, nextRally) };
        });
        break;
      }

      case 'score_update': {
        // Between points the ball is nowhere, so the sonar goes dark on both
        // phones — the same thing the solo sim does when a point ends.
        setOppBall(null);
        const myIdx = playerIndexRef.current;
        if (myIdx === 0) {
          setStats((s) => ({
            ...s,
            score: msg.p1Score,
            opponentScore: msg.p2Score,
            rallyCount: 0,
          }));
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
          setStats((s) => ({
            ...s,
            score: msg.p2Score,
            opponentScore: msg.p1Score,
            rallyCount: 0,
          }));
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
        applyMatchResult(msg.matchKey, msg.result);
        break;

      case 'session_invalid':
        // The relay refused this socket: the account is held by another
        // device now. The heartbeat would reach the same conclusion within
        // seconds, but the relay already knows, so act on it immediately —
        // this is the duel half of the same eviction the REST routes enforce.
        setSessionStatus(msg.status);
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
        const midMatch = !winner && !isMultiplayerOpen && screenRef.current === 'game';
        if (midMatch) {
          setToastOpponentLeft(true);
          setTimeout(() => setToastOpponentLeft(false), 6000);
          handleLeaveRoom();
        }
        break;
      }

      case 'pong':
        setPingMs(Date.now() - msg.timestamp);
        break;

      case 'error':
        // The server answered — a dead or full room is a verdict, not a blip.
        pendingRoomRef.current = null;
        joinInFlightRef.current = false;
        alert(msg.message);
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
      // A dead socket answers nothing, so any join waiting on one is over —
      // released here rather than in handleJoinRoom, which stops watching the
      // moment it sends. A socket that dies after `join_room` goes out but
      // before `room_joined` or `error` comes back would otherwise latch the
      // guard for good, and every later Join would return early without even
      // opening a replacement socket.
      joinInFlightRef.current = false;
      // The socket dying UNDER a live duel means this player was ejected —
      // the relay has already recorded the abandon and told the opponent.
      // A deliberate leave sets the flag first and lands here silently.
      if (intentionalCloseRef.current) {
        intentionalCloseRef.current = false;
        return;
      }
      // The invitation is still outstanding: this socket never produced a
      // room_joined or an error, so ask again on a fresh one.
      if (pendingRoomRef.current && inviteRetriesRef.current < MAX_INVITE_RETRIES) {
        inviteRetriesRef.current += 1;
        autoJoinedRef.current = false;
        setInviteRetry((n) => n + 1);
      }
      const midMatch =
        modeRef.current === 'multiplayer' &&
        screenRef.current === 'game' &&
        !!opponentIdRef.current;
      if (midMatch) {
        setToastEjected(true);
        setTimeout(() => setToastEjected(false), 8000);
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

  const handleCreateRoom = () => {
    let socket = ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      socket = connectWebSocket();
    }
    // The host opens the room on their own menu choices; from then on the
    // room owns them and the lobby is where they change.
    sendWhenOpen(socket, () => ({
      type: 'create_room',
      playerId,
      config: normalizeRoomConfig({
        winningScore: settingsRef.current.winningScore,
        rules: settingsRef.current.rules,
      }),
    }));
  };

  const handleJoinRoom = (code: string) => {
    if (joinInFlightRef.current) return;
    joinInFlightRef.current = true;
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
    intentionalCloseRef.current = true;
    p2pRef.current?.close();
    p2pRef.current = null;
    setLinkStatus('relay');
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'leave_room' }));
      ws.close();
    }
    setWs(null);
    setRoomId(null);
    setOpponentName(null);
    setOpponentId(null);
    setRoomConfig(null);
    setMatchCountdown(null);
    setCountdownArmed(false);
    setLobbyReady([false, false]);
    setQuitConfirmOpen(false);
    setMode('solo');
    setScreen('menu');
    resetMatch();
  };

  // Main 60/120 FPS Physics Engine Loop
  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();

    const gameLoop = (time: number) => {
      const dt = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;

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
      if (screenRef.current !== 'game' || modeRef.current === 'split' || isServingRef.current || winner) {
        animId = requestAnimationFrame(gameLoop);
        return;
      }

      const currentMode = modeRef.current;
      const currentSettings = settingsRef.current;

      // ==============================================================
      // 1. UPDATE BALL IN PLAYER'S VISIBLE HALF COURT
      // ==============================================================
      if (ballRef.current.active) {
        let b = { ...ballRef.current };
        b.x += b.vx * dt;
        b.y += b.vy * dt;

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
          paddleVxRef.current
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
          setTotalTouches((t) => t + 1);
          setStats((s) => {
            const nextRally = s.rallyCount + 1;
            // Practice Wall and Split Screen never record a match, so their
            // guaranteed returns still can't feed the rally mission.
            return {
              ...s,
              rallyCount: nextRally,
              maxRally: Math.max(s.maxRally, nextRally),
            };
          });
        }

        // ==============================================================
        // 2. BALL REACHES TOP NET (Y <= 0)
        //    - Practice Wall: the net is a RETURN LINE — the ball bounces
        //      straight back; it never leaves the player's screen.
        //    - Everything else: it disappears across the divide!
        // ==============================================================
        if (currentMode === 'practice') {
          if (b.y - b.radius <= 0) {
            b.y = b.radius;
            b.vy = Math.abs(b.vy);
            sound.playWallBounce();
          }
        } else if (b.y <= 0) {
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
                speedMultiplier: hitResult.speed ? hitResult.speed / BASE_BALL_SPEED : 1,
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

          if (currentMode === 'multiplayer') {
            sendNetRef.current({
              type: 'point_scored',
              scorer: playerIndexRef.current === 0 ? 'p2' : 'p1',
            });
          } else if (currentMode === 'practice') {
            // No opponent, no score — the streak just resets and the player
            // serves again. Best streak stays on the board.
            setStats((s) => ({ ...s, rallyCount: 0 }));
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
              return { ...s, opponentScore: nextOppScore, rallyCount: 0 };
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
          aiRef.current.paddleVx
        );

        if (oppHit.hit && oppHit.angle !== undefined && oppHit.speed !== undefined) {
          ob.vy = -Math.abs(oppHit.speed * Math.cos(oppHit.angle));
          ob.vx = oppHit.speed * Math.sin(oppHit.angle);
          ob.y = PADDLE_Y - PADDLE_HEIGHT / 2 - ob.radius;

          sound.playOpponentPaddleHit();
          setTotalTouches((t) => t + 1);
          setStats((s) => ({ ...s, rallyCount: s.rallyCount + 1 }));
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
            radius: ob.radius,
            active: true,
          });
        }

        // Opponent AI Missed the Ball - PLAYER SCORES!
        if (ob.y >= 1.05) {
          ob.active = false;
          sound.playScore();

          setStats((s) => {
            const nextScore = s.score + 1;
            // An ace: the player served and the opponent never got the ball
            // back over, so the rally never actually started.
            const ace = servedThisPointRef.current && s.rallyCount <= 1;
            if (nextScore >= configRef.current.winningScore) {
              setWinner('player');
              confetti({ particleCount: 120, spread: 80, origin: { y: 0.6 } });
            } else {
              setIsServing(true);
              setIsPlayerServer(false); // AI serves next
            }
            return {
              ...s,
              score: nextScore,
              aces: s.aces + (ace ? 1 : 0),
              matchesWon: nextScore >= configRef.current.winningScore ? s.matchesWon + 1 : s.matchesWon,
              rallyCount: 0,
            };
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

  const resetMatch = () => {
    setStats((s) => ({
      ...s,
      score: 0,
      opponentScore: 0,
      rallyCount: 0,
      maxRally: 0,
    }));
    setTotalTouches(0);
    setMatchStartTime(Date.now());
    setWinner(null);
    setLastMatchResult(null);
    setTelemetryOpen(false);
    setIsServing(true);
    setIsPlayerServer(true);
    // A new match is a new thing to record and a new result to show.
    matchKeyRef.current = '';
    shownMatchKeyRef.current = '';
    aiRef.current.reset();
    setBall({
      x: 0.5,
      y: 0.82,
      vx: 0.3,
      vy: -BASE_BALL_SPEED,
      radius: ballRadiusRef.current,
      active: true,
    });
    setOppBall(null);
  };

  // Menu → court. Match settings (difficulty, winning score) are already
  // locked in on the menu before this runs — nothing re-opens them mid-match.
  const startMatch = (newMode: GameMode) => {
    setMode(newMode);
    setScreen('game');
    resetMatch();
  };

  // Court → menu, from the HUD home button or the winner overlay. Multiplayer
  // additionally tears the room down (handleLeaveRoom returns to menu itself).
  // Practice Wall banks its best return streak when the player leaves. No
  // match is recorded and no rating moves — the server decides what the streak
  // is worth and holds a daily cap, since a guaranteed-return drill would
  // otherwise be the fastest XP in the game.
  const submitPracticeSession = useCallback(async (bestStreak: number) => {
    if (bestStreak < 3) return;
    try {
      const res = await fetch('/api/practice/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bestStreak }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.profile) setProfile(data.profile);
      if (data.earnedXp > 0) setToastPracticeXp(data.earnedXp);
    } catch (e) {
      console.error('Failed to bank practice session:', e);
    }
  }, []);

  const quitToMenu = () => {
    if (mode === 'multiplayer') {
      // A live duel is worth a second look before walking out: leaving
      // mid-match is an abandon, and ranked repeats cost rating. A finished
      // match, or a lobby with no opponent, leaves without ceremony.
      const liveMatch = !winner && opponentId !== null && !isMultiplayerOpen;
      if (liveMatch) {
        setQuitConfirmOpen(true);
        return;
      }
      handleLeaveRoom();
      return;
    }
    if (mode === 'practice') {
      void submitPracticeSession(statsRef.current.maxRally);
    }
    setScreen('menu');
    resetMatch();
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

  const currentTheme: ThemeConfig = THEMES[settings.theme] || THEMES.neon;
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
      {/* The equipped court theme's accent is published ONCE, here. The shell
          reads it back as var(--theme-accent) rather than concatenating two
          hex digits of alpha onto a colour at every call site wanting a tint. */}
      <div
        id="app-root-container"
        className="relative w-full h-full overflow-hidden flex flex-col font-sans select-none"
        style={
          {
            backgroundColor: currentTheme.background,
            '--theme-accent': currentTheme.accentColor,
          } as React.CSSProperties
        }
      >
        {/* Pop-up achievement and level up notifications */}
        <AchievementToast
          achievement={toastAchievement}
          levelUp={toastLevelUp}
          language={currentLanguage}
          onClose={() => {
            setToastAchievement(null);
            setToastLevelUp(null);
          }}
        />

        <ToastHost
          toasts={[
            toastUnlock && {
              id: 'toast-unlock',
              tone: 'xp' as const,
              content: t('mission_unlock_earned', currentLanguage, {
                name: THEMES[toastUnlock as CourtTheme]?.name || toastUnlock,
              }),
              onDismiss: () => setToastUnlock(null),
            },
            toastPracticeXp !== null && {
              id: 'toast-practice-xp',
              tone: 'info' as const,
              content: t('practice_xp_earned', currentLanguage, { xp: toastPracticeXp }),
              onDismiss: () => setToastPracticeXp(null),
            },
            toastEjected && {
              id: 'toast-ejected',
              tone: 'loss' as const,
              content: t('connection_lost_notice', currentLanguage),
              onDismiss: () => setToastEjected(false),
            },
            toastOpponentLeft && {
              id: 'toast-opponent-left',
              tone: 'loss' as const,
              content: t('opponent_left_notice', currentLanguage),
              onDismiss: () => setToastOpponentLeft(false),
            },
            toastRecordFailed && {
              id: 'toast-record-failed',
              tone: 'warn' as const,
              content: t('match_not_saved', currentLanguage),
              onDismiss: () => setToastRecordFailed(false),
            },
          ].filter(Boolean) as ToastSpec[]}
        />

        <Sheet
          id="quit-confirm-modal"
          isOpen={quitConfirmOpen}
          onClose={() => setQuitConfirmOpen(false)}
          size="xs"
          layer="over"
          accent="loss"
          title={t('quit_confirm_title', currentLanguage)}
          footer={
            <>
              <Button
                id="btn-quit-cancel"
                variant="secondary"
                block
                onClick={() => setQuitConfirmOpen(false)}
              >
                {t('quit_confirm_no', currentLanguage)}
              </Button>
              <Button
                id="btn-quit-confirm"
                variant="danger"
                block
                onClick={() => {
                  setQuitConfirmOpen(false);
                  handleLeaveRoom();
                }}
              >
                {t('quit_confirm_yes', currentLanguage)}
              </Button>
            </>
          }
        >
          <p className="text-2xs leading-relaxed font-normal tracking-normal text-ink-muted">
            {t('quit_confirm_body', currentLanguage)}
          </p>
        </Sheet>

        {/* Mandatory first-arrival onboarding: gates EVERYTHING until the
            player locks in their unique username (or restores a profile) */}
        <OnboardingModal
          isOpen={Boolean(profile && !profile.initialized)}
          theme={currentTheme}
          language={currentLanguage}
          onInitialized={(p) => {
            setProfile(p);
            setPlayerId(p.id);
          }}
        />

        {/* Public profile viewer — opened by tapping any username */}
        <PublicProfileModal
          playerId={publicProfileId}
          onClose={() => setPublicProfileId(null)}
          language={currentLanguage}
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
            onOpenMultiplayer={() => setIsMultiplayerOpen(true)}
            onOpenProfile={() => setIsProfileOpen(true)}
            onOpenLeaderboard={() => setIsLeaderboardOpen(true)}
            onOpenAchievements={() => setIsAchievementsOpen(true)}
            onOpenHistory={() => setIsHistoryOpen(true)}
            onOpenMissions={() => setIsMissionsOpen(true)}
            onOpenSettings={() => setIsSettingsOpen(true)}
            onOpenTutorial={() => setIsTutorialOpen(true)}
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
          onResetMatch={resetMatch}
          canResetMatch={mode !== 'multiplayer'}
          onQuitToMenu={quitToMenu}
          winningScore={activeConfig.winningScore}
          opponentName={mode === 'multiplayer' ? opponentName || 'Opponent' : `AI (${settings.difficulty})`}
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
          topClass={mode === 'multiplayer' ? 'top-[5.5rem]' : 'top-14'}
        />

        {/* Connection badge: direct P2P vs server relay (multiplayer only) */}
        {mode === 'multiplayer' && opponentId && (
          <div
            id="link-status-badge"
            className={`absolute top-14 right-2 z-30 rounded-chip border px-2 py-0.5 text-2xs select-none ${
              linkStatus === 'p2p'
                ? 'bg-emerald-500/15 border-emerald-400/50 text-emerald-300'
                : linkStatus === 'connecting'
                  ? 'bg-amber-500/15 border-amber-400/50 text-amber-300 animate-pulse'
                  : 'bg-cyan-500/15 border-cyan-400/50 text-cyan-300'
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
            className="absolute top-[5.5rem] right-2 z-30 rounded-chip border border-line bg-surface-0/80 px-1.5 text-2xs tnum text-ink-dim select-none"
          >
            {pingMs}ms
          </div>
        )}

        {/* Main Single Half-Court View (The Half-Pong Table) */}
        <main className="flex-1 w-full h-full pt-14 relative flex items-center justify-center">
          {/* Real-time Telemetry Stats Overlay directly on court */}
          {activeConfig.rules.trackTelemetry && (
            <StatsOverlay
              ball={ball}
              paddleX={paddleX}
              totalTouches={totalTouches}
              rallyCount={stats.rallyCount}
              maxRally={stats.maxRally}
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
            isBallInOpponentCourt={
              mode !== 'practice' &&
              (oppBall?.active || (!ball.active && !(isServing && isPlayerServer)))
            }
            oppEstimatedX={oppBall?.active ? 1 - oppBall.x : 0.5}
            rallyCount={stats.rallyCount}
            language={currentLanguage}
            shakeTrigger={shakeTrigger}
            netLabel={mode === 'practice' ? t('return_line', currentLanguage) : undefined}
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
                className="animate-count-in text-numeral text-[4.5rem] tnum text-(--theme-accent)"
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
                className={`text-hero ${winner === 'player' ? 'text-win' : 'text-loss'}`}
              >
                {winner === 'player'
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
                  box; the XP bar now actually moves toward the next level. */}
              {lastMatchResult && (
                <div className="flex w-full flex-col gap-3">
                  <div className="grid w-full grid-cols-3 gap-2">
                    <StatTile
                      label={t('progression', currentLanguage)}
                      value={`+${lastMatchResult.earnedXp}`}
                      tone="xp"
                    />
                    <StatTile
                      label={t('longest_rally', currentLanguage)}
                      value={stats.maxRally}
                      tone="warn"
                    />
                    {lastMatchResult.tier ? (
                      <div className="flex flex-col items-center justify-center gap-1 rounded-card border border-line bg-surface-1 px-2 py-2.5">
                        <TierBadge tier={lastMatchResult.tier} language={currentLanguage} />
                        <span className="text-2xs font-normal tracking-normal text-ink-muted uppercase">
                          {lastMatchResult.tierChanged
                            ? t('rank_updated', currentLanguage)
                            : t('skill_tier', currentLanguage)}
                        </span>
                      </div>
                    ) : (
                      <StatTile
                        label={t('predicted_odds', currentLanguage)}
                        value={`${Math.round(lastMatchResult.winProbability * 100)}%`}
                        tone="accent"
                      />
                    )}
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
                  disabled={
                    mode === 'multiplayer' &&
                    (opponentId === null ||
                      (playerIndex !== null && rematchVotes[playerIndex]))
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
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          settings={settings}
          onUpdateSettings={(newVals) => setSettings((s) => ({ ...s, ...newVals }))}
          profile={profile}
          onOpenTutorial={() => setIsTutorialOpen(true)}
          onTriggerShake={() => setShakeTrigger(Date.now())}
        />

        {/* Tutorial & Onboarding Interactive Modal */}
        <TutorialModal
          isOpen={isTutorialOpen}
          onClose={() => setIsTutorialOpen(false)}
          onComplete={() => setIsTutorialOpen(false)}
          theme={currentTheme}
          language={currentLanguage}
        />

        {/* 2-Phone Multiplayer Lobby */}
        <MultiplayerLobby
          isOpen={isMultiplayerOpen}
          onClose={() => setIsMultiplayerOpen(false)}
          theme={currentTheme}
          roomId={roomId}
          playerIndex={playerIndex}
          opponentName={opponentName}
          isConnected={isConnected}
          currentUsername={profile?.username}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          onLeaveRoom={handleLeaveRoom}
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
          onOpenTutorial={() => setIsTutorialOpen(true)}
          p2pEnabled={p2pEnabled}
          onToggleP2P={setP2pEnabled}
        />

        {/* Player Profile & Stats Modal */}
        <ProfileModal
          isOpen={isProfileOpen}
          onClose={() => setIsProfileOpen(false)}
          profile={profile}
          playerStatus={playerStatus}
          onUpdateUsername={handleUpdateUsername}
          onRefreshProfile={fetchProfile}
          onViewProfile={openPublicProfile}
          language={currentLanguage}
        />

        {/* Global Leaderboard Modal */}
        <LeaderboardModal
          isOpen={isLeaderboardOpen}
          onClose={() => setIsLeaderboardOpen(false)}
          currentPlayerId={playerId}
          onViewProfile={openPublicProfile}
          language={currentLanguage}
        />

        {/* Achievements & Trophies Modal */}
        <AchievementsModal
          isOpen={isAchievementsOpen}
          onClose={() => setIsAchievementsOpen(false)}
          playerId={playerId}
          level={profile?.level || 1}
          tier={profile?.tier || 'unranked'}
          language={currentLanguage}
        />

        {/* Match History Modal */}
        <MatchHistoryModal
          isOpen={isHistoryOpen}
          onClose={() => setIsHistoryOpen(false)}
          playerId={playerId}
          onViewProfile={openPublicProfile}
          language={currentLanguage}
        />
      </div>
      </SessionGuard>
    </MobileGatekeeper>
  );
}
