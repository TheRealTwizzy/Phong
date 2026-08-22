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
import { START_MU, normalizeDifficulty } from './rating';
import {
  DEFAULT_MATCH_RULES,
  DEFAULT_ROOM_CONFIG,
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
import { TutorialModal } from './components/TutorialModal';
import { OnboardingModal } from './components/OnboardingModal';
import { PublicProfileModal } from './components/PublicProfileModal';
import { isLinkableId } from './profileRules';
import { TierBadge } from './components/TierBadge';
import confetti from 'canvas-confetti';
import { Trophy, RefreshCw, Home } from 'lucide-react';

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
  showStatsOverlay: true,
  showTrails: true,
  difficulty: 'pro',
  winningScore: 5,
  rules: DEFAULT_MATCH_RULES,
  theme: 'neon',
  language: 'en',
};

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

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

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

  // Record Match Result to Server Database and Track Daily Missions
  const recordMatchCompletion = useCallback(
    async (isWinner: boolean) => {
      // Practice Wall and Split Screen are unranked: no winner is ever set
      // for them, and even if one were, nothing gets recorded.
      if (modeRef.current === 'practice' || modeRef.current === 'split') return;

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
          // state it owns instead of trusting the numbers above.
          roomId: modeRef.current === 'multiplayer' ? roomId || undefined : undefined,
        };

        const outcome = await postMatchRecord(payload);
        if (!outcome.ok) {
          if (outcome.reason === 'unidentified') {
            // The server no longer recognises this device (its signing secret
            // was rotated by a reset or a deploy that lost the data volume).
            // Re-syncing surfaces the uninitialized profile, which re-opens
            // onboarding instead of leaving the player silently unrecorded.
            fetchProfile();
          }
          // Queued for replay; tell the player rather than silently losing it.
          setToastRecordFailed(true);
          return;
        }
        const result = outcome.result!;
        setLastMatchResult(result);
        setToastRecordFailed(false);
        if (result.profile) {
          setProfile(result.profile);
        }
        // The server advanced today's missions as part of recording the match.
        if (result.missions) {
          setMissions(result.missions);
        }

        // Show celebrations
        if (result.leveledUp) {
          setToastLevelUp(result.profile.level);
          confetti({ particleCount: 150, spread: 90, origin: { y: 0.5 } });
        } else if (result.newAchievements && result.newAchievements.length > 0) {
          setToastAchievement(result.newAchievements[0]);
          confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
        }
      } catch (e) {
        console.error('Failed to record match on server:', e);
        setToastRecordFailed(true);
      }
    },
    [playerId, opponentId, opponentName, roomId]
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

  // Check URL room code on mount (?room=CODE)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get('room');
    if (roomCode) {
      setIsMultiplayerOpen(true);
    }
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
      mode !== 'multiplayer' || (opponentId !== null && !isMultiplayerOpen);
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

      case 'game_start':
        // The terms ride along with every start, so a phone can never begin a
        // match on a ruleset it was not told about.
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
        setLastMatchResult(null);
        setRematchVotes([false, false]);
        p2pRef.current?.resetMatchState(msg.servingPlayer);
        break;

      case 'opponent_paddle':
        setOppPaddleX(msg.x);
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

      case 'opponent_left':
        setMatchPrediction(null);
        setOpponentName(null);
        setOpponentId(null);
        setRematchVotes([false, false]);
        p2pRef.current?.close();
        p2pRef.current = null;
        setLinkStatus('relay');
        alert('Opponent disconnected from the match.');
        break;

      case 'pong':
        setPingMs(Date.now() - msg.timestamp);
        break;

      case 'error':
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
    };

    setWs(socket);
    return socket;
  }, []);

  // Display names ride the device cookie server-side; the client never sends
  // one (usernames are unique identities, not free-text callsigns).
  const handleCreateRoom = () => {
    let socket = ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      socket = connectWebSocket();
    }
    const checkAndSend = () => {
      if (socket?.readyState === WebSocket.OPEN) {
        // The host opens the room on their own menu choices; from then on the
        // room owns them and the lobby is where they change.
        socket.send(
          JSON.stringify({
            type: 'create_room',
            playerId,
            config: normalizeRoomConfig({
              winningScore: settingsRef.current.winningScore,
              rules: settingsRef.current.rules,
            }),
          })
        );
      } else {
        setTimeout(checkAndSend, 100);
      }
    };
    checkAndSend();
  };

  const handleJoinRoom = (code: string) => {
    let socket = ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      socket = connectWebSocket();
    }
    const checkAndSend = () => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'join_room', roomId: code, playerId }));
      } else {
        setTimeout(checkAndSend, 100);
      }
    };
    checkAndSend();
  };

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

  const handleLeaveRoom = () => {
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
    setIsServing(true);
    setIsPlayerServer(true);
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
      handleLeaveRoom();
      return;
    }
    if (mode === 'practice') {
      void submitPracticeSession(statsRef.current.maxRally);
    }
    setScreen('menu');
    resetMatch();
  };

  const currentTheme: ThemeConfig = THEMES[settings.theme] || THEMES.neon;
  const missionsSummary = getMissionsStatusSummary(missions);

  const inSplitMatch = screen === 'game' && mode === 'split';
  const inCourtMatch = screen === 'game' && mode !== 'split';

  return (
    <MobileGatekeeper language={currentLanguage}>
      <div
        id="app-root-container"
        className="relative w-full h-full overflow-hidden flex flex-col font-sans select-none"
        style={{ backgroundColor: currentTheme.background }}
      >
        {/* Pop-up achievement and level up notifications */}
        <AchievementToast
          achievement={toastAchievement}
          levelUp={toastLevelUp}
          onClose={() => {
            setToastAchievement(null);
            setToastLevelUp(null);
          }}
        />

        {toastUnlock && (
          <button
            id="toast-unlock"
            onClick={() => setToastUnlock(null)}
            className="absolute top-3 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-amber-950/90 border border-amber-400/60 text-amber-200 font-mono text-[11px] shadow-lg"
          >
            {t('mission_unlock_earned', currentLanguage, {
              name: THEMES[toastUnlock as CourtTheme]?.name || toastUnlock,
            })}
          </button>
        )}

        {toastPracticeXp !== null && (
          <button
            id="toast-practice-xp"
            onClick={() => setToastPracticeXp(null)}
            className="absolute top-3 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-cyan-950/90 border border-cyan-500/60 text-cyan-200 font-mono text-[11px] shadow-lg"
          >
            {t('practice_xp_earned', currentLanguage, { xp: toastPracticeXp })}
          </button>
        )}

        {toastRecordFailed && (
          <button
            id="toast-record-failed"
            onClick={() => setToastRecordFailed(false)}
            className="absolute top-3 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-amber-950/90 border border-amber-500/60 text-amber-200 font-mono text-[11px] shadow-lg"
          >
            {t('match_not_saved', currentLanguage)}
          </button>
        )}

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
          theme={currentTheme}
          language={currentLanguage}
        />

        {/* Out-of-match hub: mode select + pre-match settings + navigation */}
        {screen === 'menu' && (
          <MainMenu
            theme={currentTheme}
            settings={settings}
            onUpdateSettings={(newVals) => setSettings((s) => ({ ...s, ...newVals }))}
            profile={profile}
            playerStatus={playerStatus}
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
        )}

        {/* Local 2-player classic court on one screen — offline & unranked */}
        {inSplitMatch && (
          <SplitScreenMatch
            settings={settings}
            theme={currentTheme}
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
            Practice Wall has no opponent court, so no radar there. */}
        <RadarPreview
          oppBall={oppBall}
          oppPaddleX={oppPaddleX}
          paddleWidthRatio={paddleWidthFor(activeConfig.rules)}
          theme={currentTheme}
          active={settings.showRadar && activeConfig.rules.opponentSonar && mode === 'solo'}
        />

        {/* Connection badge: direct P2P vs server relay (multiplayer only) */}
        {mode === 'multiplayer' && opponentId && (
          <div
            id="link-status-badge"
            className={`absolute top-14 right-2 z-30 px-2 py-0.5 rounded-full border font-mono text-[10px] tracking-wide select-none ${
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
            {pingMs > 0 && linkStatus !== 'p2p' ? ` ${pingMs}ms` : ''}
          </div>
        )}

        {/* Main Single Half-Court View (The Half-Pong Table) */}
        <main className="flex-1 w-full h-full pt-14 relative flex items-center justify-center">
          {/* Real-time Telemetry Stats Overlay directly on court */}
          <StatsOverlay
            ball={ball}
            paddleX={paddleX}
            totalTouches={totalTouches}
            rallyCount={stats.rallyCount}
            maxRally={stats.maxRally}
            theme={currentTheme}
            isVisible={settings.showStatsOverlay && activeConfig.rules.trackTelemetry}
            onToggleVisible={() =>
              setSettings((s) => ({ ...s, showStatsOverlay: !s.showStatsOverlay }))
            }
            matchStartTime={matchStartTime}
          />

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
        {winner && (
          <div
            id="winner-modal-overlay"
            className="absolute inset-0 z-40 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-300"
          >
            <div
              className="w-full max-w-sm rounded-2xl border p-6 flex flex-col items-center gap-4 text-center shadow-2xl text-white"
              style={{
                backgroundColor: '#10141e',
                borderColor: winner === 'player' ? currentTheme.playerPaddleColor : currentTheme.opponentPaddleColor,
                boxShadow: `0 0 40px ${winner === 'player' ? currentTheme.playerPaddleGlow : currentTheme.opponentPaddleGlow}40`,
              }}
            >
              <div
                className="p-4 rounded-2xl border"
                style={{
                  backgroundColor: (winner === 'player' ? currentTheme.playerPaddleColor : currentTheme.opponentPaddleColor) + '20',
                  borderColor: winner === 'player' ? currentTheme.playerPaddleColor : currentTheme.opponentPaddleColor,
                }}
              >
                <Trophy className="w-10 h-10 text-amber-400" />
              </div>

              <div className="flex flex-col gap-1">
                <h2 className="text-2xl font-black font-mono tracking-wide">
                  {winner === 'player' ? t('victory', currentLanguage) : t('match_lost', currentLanguage)}
                </h2>
                <p className="text-xs text-zinc-400 font-mono">
                  {t('final_score', currentLanguage)}: {stats.score} - {stats.opponentScore}
                </p>
                <p className="text-[11px] text-zinc-500 font-mono">
                  {t('longest_rally', currentLanguage)}: {stats.maxRally} {t('rally', currentLanguage)}
                </p>
              </div>

              {/* Progression & Rewards Earned Box */}
              {lastMatchResult && (
                <div className="w-full bg-slate-900/80 border border-slate-800 rounded-xl p-3 flex items-center justify-around text-xs">
                  <div>
                    <div className="text-yellow-400 font-bold text-sm">+{lastMatchResult.earnedXp} XP</div>
                    <div className="text-[10px] text-slate-400 uppercase">{t('progression', currentLanguage)}</div>
                  </div>
                  <div className="w-px h-8 bg-slate-800" />
                  <div>
                    {lastMatchResult.tier ? (
                      <>
                        <TierBadge tier={lastMatchResult.tier} language={currentLanguage} size="md" />
                        <div className="text-[10px] text-slate-400 uppercase mt-0.5">
                          {lastMatchResult.tierChanged ? t('rank_updated', currentLanguage) : t('skill_tier', currentLanguage)}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="font-bold text-sm text-cyan-300">
                          {Math.round(lastMatchResult.winProbability * 100)}%
                        </div>
                        <div className="text-[10px] text-slate-400 uppercase">
                          {t('predicted_odds', currentLanguage)}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {mode === 'multiplayer' && playerIndex !== null && rematchVotes[playerIndex === 0 ? 1 : 0] && (
                <p className="text-[11px] text-cyan-300 font-mono animate-pulse">
                  {opponentName || 'Opponent'}: {t('chat_rematch', currentLanguage)}
                </p>
              )}

              <div className="flex items-center gap-2 w-full mt-2">
                <button
                  id="btn-play-again"
                  onClick={() => {
                    if (mode === 'multiplayer') {
                      sendNetRef.current({ type: 'rematch_request' });
                    } else {
                      resetMatch();
                    }
                  }}
                  disabled={mode === 'multiplayer' && (opponentId === null || (playerIndex !== null && rematchVotes[playerIndex]))}
                  className="flex-1 py-3 rounded-xl font-mono text-xs font-bold bg-cyan-500 hover:bg-cyan-400 disabled:bg-zinc-700 disabled:text-zinc-400 text-zinc-950 transition active:scale-95 shadow-lg flex items-center justify-center gap-1.5"
                >
                  <RefreshCw className={`w-4 h-4 ${mode === 'multiplayer' && playerIndex !== null && rematchVotes[playerIndex] ? 'animate-spin' : ''}`} />
                  <span>
                    {mode === 'multiplayer'
                      ? playerIndex !== null && rematchVotes[playerIndex]
                        ? t('waiting_for_opponent', currentLanguage)
                        : t('rematch', currentLanguage)
                      : t('play_again', currentLanguage)}
                  </span>
                </button>

                {/* Between-match navigation: back to the out-of-match hub */}
                <button
                  id="btn-menu-from-win"
                  onClick={quitToMenu}
                  className="px-4 py-3 rounded-xl font-mono text-xs font-bold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 transition active:scale-95 flex items-center justify-center gap-1.5"
                >
                  <Home className="w-4 h-4 text-cyan-400" />
                  <span>{t('main_menu', currentLanguage)}</span>
                </button>
              </div>
            </div>
          </div>
        )}
          </>
        )}

        {/* Daily Missions Modal */}
        <MissionsModal
          isOpen={isMissionsOpen}
          onClose={() => setIsMissionsOpen(false)}
          missions={missions}
          onClaimReward={handleClaimMissionReward}
          theme={currentTheme}
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
          currentTheme={currentTheme}
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
          earnedAchievements={profile?.achievements || []}
          language={currentLanguage}
          onReadyToPlay={() => {
            setIsMultiplayerOpen(false);
            setIsServing(true);
          }}
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
          theme={currentTheme}
          onViewProfile={openPublicProfile}
        />
      </div>
    </MobileGatekeeper>
  );
}
