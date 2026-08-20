import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  BallState,
  GameMode,
  GameSettings,
  PlayerStats,
  WSServerMessage,
  PlayerProfile,
  Achievement,
  MatchEndResult,
  MatchEndPayload,
  PlayerStatus,
  DailyMission,
  LanguageCode,
} from './types';
import { THEMES, ThemeConfig } from './game/themes';
import {
  PADDLE_Y,
  PADDLE_HEIGHT,
  BASE_BALL_SPEED,
  checkPaddleCollision,
  OpponentAI,
} from './game/physics';
import { sound } from './audio/soundEffects';
import { t } from './i18n/translations';
import {
  loadDailyMissions,
  updateMissionProgress,
  claimMission,
  getMissionsStatusSummary,
} from './game/missions';
import { CourtCanvas } from './components/CourtCanvas';
import { ScoreBoard } from './components/ScoreBoard';
import { RadarPreview } from './components/RadarPreview';
import { SettingsModal } from './components/SettingsModal';
import { MultiplayerLobby } from './components/MultiplayerLobby';
import { DualCourtSimulator } from './components/DualCourtSimulator';
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
import confetti from 'canvas-confetti';
import { Trophy, RefreshCw, Smartphone, Play, Sparkles, Award, User, ArrowUp } from 'lucide-react';

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
  ballSpeedFactor: 1.0,
  paddleWidthRatio: 0.22,
  difficulty: 'pro',
  winningScore: 5,
  theme: 'neon',
  language: 'en',
};

export default function App() {
  const [settings, setSettings] = useState<GameSettings>(() => {
    const saved = localStorage.getItem('half_pong_settings');
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });

  // Persistent Player Identification
  const [playerId] = useState<string>(() => {
    let id = localStorage.getItem('half_pong_player_id');
    if (!id) {
      id = `usr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      localStorage.setItem('half_pong_player_id', id);
    }
    return id;
  });

  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [lastMatchResult, setLastMatchResult] = useState<MatchEndResult | null>(null);

  // Daily Missions State
  const [missions, setMissions] = useState<DailyMission[]>(() => loadDailyMissions());
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
    radius: 0.022,
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

  // Refs for high-speed 60fps physics loop without stale closures
  const ballRef = useRef<BallState>(ball);
  const oppBallRef = useRef<BallState | null>(oppBall);
  const paddleXRef = useRef<number>(paddleX);
  const prevPaddleXRef = useRef<number>(paddleX);
  const paddleVxRef = useRef<number>(0);
  const aiRef = useRef<OpponentAI>(new OpponentAI(settings.difficulty));
  const modeRef = useRef<GameMode>(mode);
  const wsRef = useRef<WebSocket | null>(ws);
  const isServingRef = useRef<boolean>(isServing);
  const statsRef = useRef<PlayerStats>(stats);
  const settingsRef = useRef<GameSettings>(settings);
  const profileRef = useRef<PlayerProfile | null>(profile);

  ballRef.current = ball;
  oppBallRef.current = oppBall;
  paddleXRef.current = paddleX;
  modeRef.current = mode;
  wsRef.current = ws;
  isServingRef.current = isServing;
  statsRef.current = stats;
  settingsRef.current = settings;
  profileRef.current = profile;

  const currentLanguage: LanguageCode = settings.language || 'en';

  // Fetch Player Profile from Server
  const fetchProfile = useCallback(() => {
    const savedName = localStorage.getItem('half_pong_player_name') || undefined;
    const url = `/api/profile/${playerId}${savedName ? `?username=${encodeURIComponent(savedName)}` : ''}`;
    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (data && data.id) {
          setProfile(data);
          localStorage.setItem('half_pong_player_name', data.username);
        }
      })
      .catch((e) => console.error('Profile fetch error:', e));
  }, [playerId]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  // Update Callsign / Username
  const handleUpdateUsername = async (newName: string) => {
    try {
      const res = await fetch(`/api/profile/${playerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newName }),
      });
      const data = await res.json();
      if (data && data.id) {
        setProfile(data);
        localStorage.setItem('half_pong_player_name', data.username);
      }
    } catch (e) {
      console.error('Failed to update username:', e);
    }
  };

  // Record Match Result to Server Database and Track Daily Missions
  const recordMatchCompletion = useCallback(
    async (isWinner: boolean) => {
      // Advance daily missions: games_played, matches_won, multiplayer
      const { missions: m1 } = updateMissionProgress('games_played', 1);
      let updatedMissions = m1;

      if (isWinner) {
        const { missions: m2 } = updateMissionProgress('matches_won', 1);
        updatedMissions = m2;
      }

      if (modeRef.current === 'multiplayer') {
        const { missions: m3 } = updateMissionProgress('multiplayer', 1);
        updatedMissions = m3;
      }

      setMissions(updatedMissions);

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
          mode: modeRef.current,
          difficulty: settingsRef.current.difficulty,
          isWinner,
        };

        const res = await fetch('/api/match/record', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const result: MatchEndResult = await res.json();
        setLastMatchResult(result);
        if (result.profile) {
          setProfile(result.profile);
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
      }
    },
    [playerId, opponentId, opponentName]
  );

  // Trigger match completion on winner change
  useEffect(() => {
    if (winner) {
      recordMatchCompletion(winner === 'player');
    }
  }, [winner, recordMatchCompletion]);

  // Daily Mission Claim Handler
  const handleClaimMissionReward = async (missionId: string) => {
    const { missions: updated, claimedMission } = claimMission(missionId);
    setMissions(updated);

    if (claimedMission && profile) {
      try {
        const nextXp = profile.currentXp + claimedMission.xpReward;
        const res = await fetch(`/api/profile/${playerId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentXp: nextXp }),
        });
        const updatedProf = await res.json();
        if (updatedProf && updatedProf.id) {
          setProfile(updatedProf);
        }
      } catch (e) {
        console.error('Failed to claim mission reward on profile', e);
      }
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

    // Send over WebSocket if in multiplayer
    if (mode === 'multiplayer' && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'quick_chat',
          text,
          senderName: myName,
        })
      );
    } else if (mode === 'solo' || mode === 'practice') {
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
    if (modeRef.current === 'multiplayer' && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'paddle_move', x: newX }));
    }
  }, []);

  // Serve the ball
  const handleServe = useCallback(() => {
    if (!isServingRef.current) return;
    setIsServing(false);
    isServingRef.current = false;
    setWinner(null);
    setLastMatchResult(null);

    const speed = BASE_BALL_SPEED * settingsRef.current.ballSpeedFactor;
    const initialVx = (Math.random() - 0.5) * 0.7;

    if (isPlayerServer) {
      // Serve starts from player's paddle heading UP towards net
      setBall({
        x: paddleXRef.current,
        y: PADDLE_Y - 0.05,
        vx: initialVx,
        vy: -speed,
        radius: 0.022,
        active: true,
      });
      setOppBall(null);
    } else {
      // Opponent is serving: Ball starts in opponent's half
      setBall((b) => ({ ...b, active: false }));
      if (modeRef.current === 'solo' || modeRef.current === 'practice') {
        setOppBall({
          x: 0.5,
          y: PADDLE_Y - 0.05,
          vx: (Math.random() - 0.5) * 0.7,
          vy: -speed,
          radius: 0.022,
          active: true,
        });
      }
    }
  }, [isPlayerServer]);

  // WebSocket Connection Lifecycle
  const connectWebSocket = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const socket = new WebSocket(wsUrl);

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

        switch (msg.type) {
          case 'room_created':
            setRoomId(msg.roomId);
            setPlayerIndex(msg.playerIndex);
            setMode('multiplayer');
            break;

          case 'room_joined':
            setRoomId(msg.roomId);
            setPlayerIndex(msg.playerIndex);
            setOpponentName(msg.opponentName);
            setOpponentId(msg.opponentId);
            setMode('multiplayer');
            break;

          case 'opponent_joined':
            setOpponentName(msg.opponentName);
            setOpponentId(msg.opponentId);
            sound.playScore();
            break;

          case 'game_start':
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
            setIsPlayerServer(msg.servingPlayer === playerIndex);
            setIsServing(true);
            setWinner(null);
            setLastMatchResult(null);
            setRematchVotes([false, false]);
            break;

          case 'opponent_paddle':
            setOppPaddleX(msg.x);
            break;

          case 'ball_incoming': {
            // Ball crossed the net on opponent's phone and arrived here!
            const inc = msg.ball;
            setBall({
              x: inc.x,
              y: 0.02,
              vx: inc.vx,
              vy: inc.vy,
              radius: 0.022,
              active: true,
              speedMultiplier: inc.speedMultiplier,
            });
            setStats((s) => {
              const nextRally = s.rallyCount + 1;
              const { missions: m } = updateMissionProgress('rally', nextRally);
              setMissions(m);
              return { ...s, rallyCount: nextRally, maxRally: Math.max(s.maxRally, nextRally) };
            });
            break;
          }

          case 'score_update':
            // Update scores based on playerIndex
            if (playerIndex === 0) {
              setStats((s) => ({
                ...s,
                score: msg.p1Score,
                opponentScore: msg.p2Score,
                rallyCount: 0,
              }));
              if (msg.p1Score >= settingsRef.current.winningScore) {
                setWinner('player');
                confetti({ particleCount: 100, spread: 80, origin: { y: 0.6 } });
              } else if (msg.p2Score >= settingsRef.current.winningScore) {
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
              if (msg.p2Score >= settingsRef.current.winningScore) {
                setWinner('player');
                confetti({ particleCount: 100, spread: 80, origin: { y: 0.6 } });
              } else if (msg.p1Score >= settingsRef.current.winningScore) {
                setWinner('opponent');
              } else {
                setIsPlayerServer(msg.nextServer === 1);
                setIsServing(true);
              }
            }
            break;

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

          case 'rematch_state':
            setRematchVotes(msg.votes);
            break;

          case 'opponent_left':
            setOpponentName(null);
            setOpponentId(null);
            setRematchVotes([false, false]);
            alert('Opponent disconnected from the match.');
            break;

          case 'pong':
            setPingMs(Date.now() - msg.timestamp);
            break;

          case 'error':
            alert(msg.message);
            break;
        }
      } catch (err) {
        console.error('WS parse error:', err);
      }
    };

    socket.onclose = () => {
      setIsConnected(false);
    };

    setWs(socket);
    return socket;
  }, [playerIndex, opponentName]);

  const handleCreateRoom = (name: string) => {
    let socket = ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      socket = connectWebSocket();
    }
    const checkAndSend = () => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'create_room',
            playerId,
            playerName: name || profile?.username || 'Player 1',
          })
        );
      } else {
        setTimeout(checkAndSend, 100);
      }
    };
    checkAndSend();
  };

  const handleJoinRoom = (code: string, name: string) => {
    let socket = ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      socket = connectWebSocket();
    }
    const checkAndSend = () => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'join_room',
            roomId: code,
            playerId,
            playerName: name || profile?.username || 'Player 2',
          })
        );
      } else {
        setTimeout(checkAndSend, 100);
      }
    };
    checkAndSend();
  };

  const handleLeaveRoom = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'leave_room' }));
      ws.close();
    }
    setWs(null);
    setRoomId(null);
    setOpponentName(null);
    setOpponentId(null);
    setMode('solo');
    resetMatch();
  };

  // Main 60/120 FPS Physics Engine Loop
  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();

    const gameLoop = (time: number) => {
      const dt = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;

      if (isServingRef.current || winner) {
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

        // Sidewall bounces
        if (b.x - b.radius <= 0) {
          b.x = b.radius;
          b.vx = Math.abs(b.vx);
          sound.playWallBounce();
        } else if (b.x + b.radius >= 1) {
          b.x = 1 - b.radius;
          b.vx = -Math.abs(b.vx);
          sound.playWallBounce();
        }

        // Paddle Collision at bottom (y ~ 0.92)
        const hitResult = checkPaddleCollision(
          b,
          paddleXRef.current,
          currentSettings.paddleWidthRatio,
          paddleVxRef.current
        );

        if (hitResult.hit && hitResult.angle !== undefined && hitResult.speed !== undefined) {
          b.vy = -Math.abs(hitResult.speed * Math.cos(hitResult.angle));
          b.vx = hitResult.speed * Math.sin(hitResult.angle);
          b.y = PADDLE_Y - PADDLE_HEIGHT / 2 - b.radius;

          sound.playPaddleHit(hitResult.speed / BASE_BALL_SPEED);
          setTotalTouches((t) => t + 1);
          setStats((s) => {
            const nextRally = s.rallyCount + 1;
            const { missions: m } = updateMissionProgress('rally', nextRally);
            setMissions(m);
            return {
              ...s,
              rallyCount: nextRally,
              maxRally: Math.max(s.maxRally, nextRally),
            };
          });
        }

        // ==============================================================
        // 2. BALL CROSSES TOP NET (Y <= 0) - DISAPPEARS ACROSS THE DIVIDE!
        // ==============================================================
        if (b.y <= 0) {
          // Ball disappears from player's screen!
          b.active = false;

          if (currentMode === 'multiplayer') {
            // Broadcast net crossing to remote player's phone
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(
                JSON.stringify({
                  type: 'ball_cross_net',
                  ball: {
                    x: b.x,
                    vx: b.vx,
                    vy: b.vy,
                    spin: 0,
                    speedMultiplier: hitResult.speed ? hitResult.speed / BASE_BALL_SPEED : 1,
                  },
                })
              );
            }
          } else if (currentMode === 'solo' || currentMode === 'practice') {
            // Spawn ball on unseen Opponent AI's half court
            setOppBall({
              x: Math.max(0.02, Math.min(0.98, 1 - b.x)),
              y: 0.02,
              vx: -b.vx,
              vy: Math.abs(b.vy),
              radius: b.radius,
              active: true,
            });
          }
        }

        // ==============================================================
        // 3. BALL MISSED BASELINE (Y >= 1.05) - OPPONENT SCORES!
        // ==============================================================
        if (b.y >= 1.05) {
          b.active = false;
          sound.playLose();

          if (currentMode === 'multiplayer') {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(
                JSON.stringify({
                  type: 'point_scored',
                  scorer: playerIndex === 0 ? 'p2' : 'p1',
                })
              );
            }
          } else {
            // Solo mode point for AI
            setStats((s) => {
              const nextOppScore = s.opponentScore + 1;
              if (nextOppScore >= currentSettings.winningScore) {
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
      if ((currentMode === 'solo' || currentMode === 'practice') && oppBallRef.current?.active) {
        let ob = { ...oppBallRef.current };
        ob.x += ob.vx * dt;
        ob.y += ob.vy * dt;

        // Opponent side wall bounces
        if (ob.x - ob.radius <= 0) {
          ob.x = ob.radius;
          ob.vx = Math.abs(ob.vx);
          sound.playWallBounce();
        } else if (ob.x + ob.radius >= 1) {
          ob.x = 1 - ob.radius;
          ob.vx = -Math.abs(ob.vx);
          sound.playWallBounce();
        }

        // Update Opponent AI Paddle tracking
        aiRef.current.update(ob, dt, currentSettings.paddleWidthRatio);
        setOppPaddleX(aiRef.current.paddleX);

        // Check Opponent Paddle Collision
        const oppHit = checkPaddleCollision(
          ob,
          aiRef.current.paddleX,
          currentSettings.paddleWidthRatio,
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

          // Advance points scored mission
          const { missions: mPts } = updateMissionProgress('points_scored', 1);
          setMissions(mPts);

          setStats((s) => {
            const nextScore = s.score + 1;
            if (nextScore >= currentSettings.winningScore) {
              setWinner('player');
              confetti({ particleCount: 120, spread: 80, origin: { y: 0.6 } });
            } else {
              setIsServing(true);
              setIsPlayerServer(false); // AI serves next
            }
            return {
              ...s,
              score: nextScore,
              matchesWon: nextScore >= currentSettings.winningScore ? s.matchesWon + 1 : s.matchesWon,
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
      vy: -BASE_BALL_SPEED * settings.ballSpeedFactor,
      radius: 0.022,
      active: true,
    });
    setOppBall(null);
  };

  const currentTheme: ThemeConfig = THEMES[settings.theme] || THEMES.neon;
  const missionsSummary = getMissionsStatusSummary(missions);

  // Render Dual Court Simulator if in 'split' mode
  if (mode === 'split') {
    return (
      <DualCourtSimulator
        settings={settings}
        theme={currentTheme}
        onExitSplitMode={() => {
          setMode('solo');
          resetMatch();
        }}
      />
    );
  }

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
          onOpenMultiplayer={() => setIsMultiplayerOpen(true)}
          onOpenProfile={() => setIsProfileOpen(true)}
          onOpenLeaderboard={() => setIsLeaderboardOpen(true)}
          onOpenAchievements={() => setIsAchievementsOpen(true)}
          onOpenHistory={() => setIsHistoryOpen(true)}
          onOpenMissions={() => setIsMissionsOpen(true)}
          onResetMatch={resetMatch}
          winningScore={settings.winningScore}
          opponentName={mode === 'multiplayer' ? opponentName || 'Opponent' : `AI (${settings.difficulty})`}
          isOnlineConnected={isConnected}
          pingMs={pingMs}
          language={currentLanguage}
          unclaimedMissionsCount={missionsSummary.unclaimed}
        />

        {/* Mini Radar Sonar Preview (Shows unseen opponent court if enabled) */}
        <RadarPreview
          oppBall={oppBall}
          oppPaddleX={oppPaddleX}
          paddleWidthRatio={settings.paddleWidthRatio}
          theme={currentTheme}
          active={settings.showRadar && (mode === 'solo' || mode === 'practice')}
        />

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
            isVisible={settings.showStatsOverlay}
            onToggleVisible={() =>
              setSettings((s) => ({ ...s, showStatsOverlay: !s.showStatsOverlay }))
            }
            matchStartTime={matchStartTime}
          />

          {/* Quick Chat overlay & popup tray */}
          <QuickChat
            onSendMessage={handleSendQuickChat}
            activeMessages={activeChatMessages}
            theme={currentTheme}
            language={currentLanguage}
            disabled={Boolean(winner)}
          />

          <CourtCanvas
            ball={ball}
            paddleX={paddleX}
            onPaddleMove={handlePaddleMove}
            settings={settings}
            theme={currentTheme}
            isServing={isServing && isPlayerServer}
            onServe={handleServe}
            isBallInOpponentCourt={oppBall?.active || (!ball.active && !isServing)}
            oppEstimatedX={oppBall?.active ? 1 - oppBall.x : 0.5}
            rallyCount={stats.rallyCount}
            language={currentLanguage}
            shakeTrigger={shakeTrigger}
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
                    <div className={`font-bold text-sm ${lastMatchResult.eloDelta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {lastMatchResult.eloDelta >= 0 ? `+${lastMatchResult.eloDelta}` : lastMatchResult.eloDelta} ELO
                    </div>
                    <div className="text-[10px] text-slate-400 uppercase">{t('elo_rating', currentLanguage)}</div>
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
                      if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'rematch_request' }));
                      }
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

                {mode !== 'multiplayer' && (
                  <button
                    id="btn-multiplayer-from-win"
                    onClick={() => setIsMultiplayerOpen(true)}
                    className="px-4 py-3 rounded-xl font-mono text-xs font-bold bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 transition active:scale-95 flex items-center justify-center gap-1.5"
                  >
                    <Smartphone className="w-4 h-4 text-cyan-400" />
                    <span>2-Phone</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Daily Missions Modal */}
        <MissionsModal
          isOpen={isMissionsOpen}
          onClose={() => setIsMissionsOpen(false)}
          missions={missions}
          onClaimReward={handleClaimMissionReward}
          theme={currentTheme}
          language={currentLanguage}
        />

        {/* Settings & Customization Modal */}
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          settings={settings}
          onUpdateSettings={(newVals) => setSettings((s) => ({ ...s, ...newVals }))}
          currentMode={mode}
          onSelectMode={(newMode) => {
            setMode(newMode);
            if (newMode === 'multiplayer') setIsMultiplayerOpen(true);
            resetMatch();
          }}
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
          onReadyToPlay={() => {
            setIsMultiplayerOpen(false);
            setIsServing(true);
          }}
          onOpenTutorial={() => setIsTutorialOpen(true)}
        />

        {/* Player Profile & Stats Modal */}
        <ProfileModal
          isOpen={isProfileOpen}
          onClose={() => setIsProfileOpen(false)}
          profile={profile}
          playerStatus={playerStatus}
          onUpdateUsername={handleUpdateUsername}
          onRefreshProfile={fetchProfile}
        />

        {/* Global Leaderboard Modal */}
        <LeaderboardModal
          isOpen={isLeaderboardOpen}
          onClose={() => setIsLeaderboardOpen(false)}
          currentPlayerId={playerId}
        />

        {/* Achievements & Trophies Modal */}
        <AchievementsModal
          isOpen={isAchievementsOpen}
          onClose={() => setIsAchievementsOpen(false)}
          playerId={playerId}
        />

        {/* Match History Modal */}
        <MatchHistoryModal
          isOpen={isHistoryOpen}
          onClose={() => setIsHistoryOpen(false)}
          playerId={playerId}
          theme={currentTheme}
        />
      </div>
    </MobileGatekeeper>
  );
}
