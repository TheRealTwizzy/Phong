import React, { useState, useEffect, useRef, useCallback } from 'react';
import { BallState, GameSettings, PlayerStats } from '../types';
import { ThemeConfig } from '../game/themes';
import { PADDLE_Y, PADDLE_HEIGHT, checkPaddleCollision, BASE_BALL_SPEED, MAX_BALL_SPEED } from '../game/physics';
import { sound } from '../audio/soundEffects';
import { CourtCanvas } from './CourtCanvas';
import confetti from 'canvas-confetti';
import { RefreshCw, Play, Volume2, VolumeX } from 'lucide-react';

interface DualCourtSimulatorProps {
  settings: GameSettings;
  theme: ThemeConfig;
  onExitSplitMode: () => void;
}

export const DualCourtSimulator: React.FC<DualCourtSimulatorProps> = ({
  settings,
  theme,
  onExitSplitMode,
}) => {
  // P1 Half Court State
  const [p1PaddleX, setP1PaddleX] = useState<number>(0.5);
  const [p1Ball, setP1Ball] = useState<BallState>({
    x: 0.5,
    y: 0.85,
    vx: 0.35,
    vy: -BASE_BALL_SPEED * settings.ballSpeedFactor,
    radius: 0.022,
    active: true,
  });

  // P2 Half Court State
  const [p2PaddleX, setP2PaddleX] = useState<number>(0.5);
  const [p2Ball, setP2Ball] = useState<BallState>({
    x: 0.5,
    y: 0.0,
    vx: -0.35,
    vy: BASE_BALL_SPEED * settings.ballSpeedFactor,
    radius: 0.022,
    active: false,
  });

  const [p1Score, setP1Score] = useState<number>(0);
  const [p2Score, setP2Score] = useState<number>(0);
  const [rallyCount, setRallyCount] = useState<number>(0);
  const [isServing, setIsServing] = useState<boolean>(true);
  const [serverHalf, setServerHalf] = useState<1 | 2>(1);
  const [winner, setWinner] = useState<string | null>(null);

  const p1PaddleRef = useRef<number>(p1PaddleX);
  const p2PaddleRef = useRef<number>(p2PaddleX);
  const p1BallRef = useRef<BallState>(p1Ball);
  const p2BallRef = useRef<BallState>(p2Ball);

  p1PaddleRef.current = p1PaddleX;
  p2PaddleRef.current = p2PaddleX;
  p1BallRef.current = p1Ball;
  p2BallRef.current = p2Ball;

  const serve = useCallback((server: 1 | 2) => {
    setIsServing(false);
    setWinner(null);

    const initialSpeed = BASE_BALL_SPEED * settings.ballSpeedFactor;
    const initialVx = (Math.random() - 0.5) * 0.7;

    if (server === 1) {
      setP1Ball({
        x: p1PaddleRef.current,
        y: PADDLE_Y - 0.05,
        vx: initialVx,
        vy: -initialSpeed,
        radius: 0.022,
        active: true,
      });
      setP2Ball((b) => ({ ...b, active: false }));
    } else {
      setP2Ball({
        x: p2PaddleRef.current,
        y: PADDLE_Y - 0.05,
        vx: initialVx,
        vy: -initialSpeed,
        radius: 0.022,
        active: true,
      });
      setP1Ball((b) => ({ ...b, active: false }));
    }
  }, [settings.ballSpeedFactor]);

  // Main simulation physics loop
  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();

    const loop = (time: number) => {
      const dt = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;

      if (isServing || winner) {
        animId = requestAnimationFrame(loop);
        return;
      }

      // --- SIMULATE P1 HALF ---
      if (p1BallRef.current.active) {
        let b = { ...p1BallRef.current };
        b.x += b.vx * dt;
        b.y += b.vy * dt;

        // Wall collisions (left/right)
        if (b.x - b.radius <= 0) {
          b.x = b.radius;
          b.vx = Math.abs(b.vx);
          sound.playWallBounce();
        } else if (b.x + b.radius >= 1) {
          b.x = 1 - b.radius;
          b.vx = -Math.abs(b.vx);
          sound.playWallBounce();
        }

        // P1 Paddle collision
        const hit = checkPaddleCollision(b, p1PaddleRef.current, settings.paddleWidthRatio);
        if (hit.hit && hit.angle !== undefined && hit.speed !== undefined) {
          b.vy = -Math.abs(hit.speed * Math.cos(hit.angle));
          b.vx = hit.speed * Math.sin(hit.angle);
          b.y = PADDLE_Y - PADDLE_HEIGHT / 2 - b.radius;
          sound.playPaddleHit(hit.speed / BASE_BALL_SPEED);
          setRallyCount((r) => r + 1);
        }

        // Check Ball Crossing TOP Net into P2's half!
        if (b.y <= 0) {
          // Disappear from P1's screen
          b.active = false;

          // Reappear at TOP of P2's screen!
          // Optics: x mirrors across the table (1 - x), vx is inverted (-vx), vy enters downward (+vy)
          setP2Ball({
            x: Math.max(0.02, Math.min(0.98, 1 - b.x)),
            y: 0.02,
            vx: -b.vx,
            vy: Math.abs(b.vy),
            radius: b.radius,
            active: true,
          });
        }

        // P1 Missed Ball (Point for P2)
        if (b.y >= 1.05) {
          sound.playLose();
          setP2Score((s) => {
            const nextScore = s + 1;
            if (nextScore >= settings.winningScore) {
              setWinner('Player 2 (Top Half)');
              confetti({ particleCount: 80, spread: 70, origin: { y: 0.4 } });
            } else {
              setIsServing(true);
              setServerHalf(1);
            }
            return nextScore;
          });
          setRallyCount(0);
          b.active = false;
        }

        setP1Ball(b);
      }

      // --- SIMULATE P2 HALF ---
      if (p2BallRef.current.active) {
        let b = { ...p2BallRef.current };
        b.x += b.vx * dt;
        b.y += b.vy * dt;

        // Wall collisions
        if (b.x - b.radius <= 0) {
          b.x = b.radius;
          b.vx = Math.abs(b.vx);
          sound.playWallBounce();
        } else if (b.x + b.radius >= 1) {
          b.x = 1 - b.radius;
          b.vx = -Math.abs(b.vx);
          sound.playWallBounce();
        }

        // P2 Paddle collision
        const hit = checkPaddleCollision(b, p2PaddleRef.current, settings.paddleWidthRatio);
        if (hit.hit && hit.angle !== undefined && hit.speed !== undefined) {
          b.vy = -Math.abs(hit.speed * Math.cos(hit.angle));
          b.vx = hit.speed * Math.sin(hit.angle);
          b.y = PADDLE_Y - PADDLE_HEIGHT / 2 - b.radius;
          sound.playPaddleHit(hit.speed / BASE_BALL_SPEED);
          setRallyCount((r) => r + 1);
        }

        // Check Ball Crossing TOP Net into P1's half!
        if (b.y <= 0) {
          // Disappear from P2's screen
          b.active = false;

          // Reappear at TOP of P1's screen!
          setP1Ball({
            x: Math.max(0.02, Math.min(0.98, 1 - b.x)),
            y: 0.02,
            vx: -b.vx,
            vy: Math.abs(b.vy),
            radius: b.radius,
            active: true,
          });
        }

        // P2 Missed Ball (Point for P1)
        if (b.y >= 1.05) {
          sound.playScore();
          setP1Score((s) => {
            const nextScore = s + 1;
            if (nextScore >= settings.winningScore) {
              setWinner('Player 1 (Bottom Half)');
              confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } });
            } else {
              setIsServing(true);
              setServerHalf(2);
            }
            return nextScore;
          });
          setRallyCount(0);
          b.active = false;
        }

        setP2Ball(b);
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [isServing, winner, settings.paddleWidthRatio, settings.winningScore]);

  const resetAll = () => {
    setP1Score(0);
    setP2Score(0);
    setRallyCount(0);
    setWinner(null);
    setIsServing(true);
    setServerHalf(1);
    setP1PaddleX(0.5);
    setP2PaddleX(0.5);
  };

  return (
    <div id="dual-court-simulator" className="relative w-full h-full flex flex-col bg-zinc-950 text-white select-none">
      {/* Top Controls Bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900/90 z-20">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono font-bold text-cyan-400">DUAL HALF SIMULATOR</span>
          <span className="text-xs text-zinc-400 hidden sm:inline">
            Notice how the ball disappears at the top of one half and enters the top of the other half!
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 font-mono text-sm px-3 py-1 rounded-lg bg-zinc-800 border border-zinc-700">
            <span className="text-cyan-400 font-bold">P1: {p1Score}</span>
            <span className="text-zinc-500">|</span>
            <span className="text-pink-400 font-bold">P2: {p2Score}</span>
            <span className="text-zinc-500">|</span>
            <span className="text-amber-400 text-xs">Rally: {rallyCount}</span>
          </div>

          <button
            onClick={resetAll}
            className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700"
            title="Reset Score"
          >
            <RefreshCw className="w-4 h-4" />
          </button>

          <button
            onClick={onExitSplitMode}
            className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-zinc-950 font-mono text-xs font-bold"
          >
            Back to 1-Screen
          </button>
        </div>
      </div>

      {/* Main Dual Courts (Side by side on desktop, stacked on mobile) */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3 p-3 min-h-0">
        {/* PLAYER 1 HALF */}
        <div className="relative rounded-xl border border-cyan-500/40 overflow-hidden flex flex-col bg-zinc-900/60 shadow-lg">
          <div className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded bg-black/60 font-mono text-[10px] text-cyan-400 border border-cyan-500/30">
            PLAYER 1 (Device A)
          </div>
          <div className="flex-1 relative">
            <CourtCanvas
              ball={p1Ball}
              paddleX={p1PaddleX}
              onPaddleMove={setP1PaddleX}
              settings={settings}
              theme={{
                ...theme,
                playerPaddleColor: '#00f0ff',
                playerPaddleGlow: '#00f0ff',
              }}
              isServing={isServing && serverHalf === 1}
              onServe={() => serve(1)}
              isBallInOpponentCourt={p2Ball.active}
              oppEstimatedX={1 - p2PaddleX}
              rallyCount={rallyCount}
            />
          </div>
        </div>

        {/* PLAYER 2 HALF */}
        <div className="relative rounded-xl border border-pink-500/40 overflow-hidden flex flex-col bg-zinc-900/60 shadow-lg">
          <div className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded bg-black/60 font-mono text-[10px] text-pink-400 border border-pink-500/30">
            PLAYER 2 (Device B)
          </div>
          <div className="flex-1 relative">
            <CourtCanvas
              ball={p2Ball}
              paddleX={p2PaddleX}
              onPaddleMove={setP2PaddleX}
              settings={settings}
              theme={{
                ...theme,
                playerPaddleColor: '#ff007f',
                playerPaddleGlow: '#ff007f',
              }}
              isServing={isServing && serverHalf === 2}
              onServe={() => serve(2)}
              isBallInOpponentCourt={p1Ball.active}
              oppEstimatedX={1 - p1PaddleX}
              rallyCount={rallyCount}
            />
          </div>
        </div>
      </div>

      {/* Winner Modal */}
      {winner && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="p-6 rounded-2xl bg-zinc-900 border border-cyan-400/50 flex flex-col items-center gap-4 text-center max-w-sm">
            <h3 className="text-xl font-mono font-black text-cyan-400 uppercase">
              {winner} WON!
            </h3>
            <p className="text-xs text-zinc-400">
              Final Score: {p1Score} - {p2Score}
            </p>
            <button
              onClick={resetAll}
              className="px-6 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-zinc-950 font-mono font-bold text-sm"
            >
              Play Again
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
