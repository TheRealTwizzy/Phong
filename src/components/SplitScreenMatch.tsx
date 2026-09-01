import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GameSettings, LanguageCode, MatchRules } from '../types';
import { Cosmetic } from '../game/cosmetics';
import {
  PADDLE_Y,
  PADDLE_HEIGHT,
  BASE_BALL_SPEED,
  checkPaddleCollision,
  paddleWidthFor,
  ballRadiusFor,
  maxBallSpeedFor,
  minBallSpeedFor,
  physicsSubsteps,
} from '../game/physics';
import { sound } from '../audio/soundEffects';
import { t } from '../i18n/translations';
import confetti from 'canvas-confetti';
import { RefreshCw, Home } from 'lucide-react';

// Local 2-player classic Pong on ONE device: player 1 defends the bottom
// baseline, player 2 the top, and the net is the halfway line across the
// middle of the play area. Nothing here touches the network or the profile
// store — this mode is deliberately offline and unranked.
interface SplitScreenMatchProps {
  settings: GameSettings;
  theme: Cosmetic;
  /**
   * The room-or-menu derived target, per CLAUDE.md §9.7: match code reads
   * activeConfig, never settings. For a split match the two are the same value
   * by construction — this is compliance, not a behaviour change.
   */
  winningScore: number;
  /**
   * The same rules every other mode plays under. This screen used to take
   * none: it hard-coded `PADDLE_WIDTH_RATIO`, `BALL_BASE_RADIUS` and
   * `MAX_BALL_SPEED`, so all six physics rules its OWN pre-match sheet offers
   * — paddle size, ball size, both speed bounds, serve angle and power — were
   * accepted from the player and then silently ignored.
   */
  rules: MatchRules;
  onExitSplitMode: () => void;
}

// Full-court geometry: y = 0 is player 2's baseline, y = 1 is player 1's.
const P1_PADDLE_Y = PADDLE_Y; // 0.92
const P2_PADDLE_Y = 1 - PADDLE_Y; // 0.08
const NET_Y = 0.5;

// A full court is ~2.2x the travel of a blind half-court leg, so the shared
// half-court speeds are scaled down to keep rallies at the same felt pace.
// The RULES are applied on top of that scale rather than instead of it: the
// scale is geometry, the rules are the match.
const SPEED_SCALE = 0.55;
const SERVE_SPEED = BASE_BALL_SPEED * SPEED_SCALE;

interface FullCourtBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /**
   * Always true here, and present so this really is a BallState — which is
   * what checkPaddleCollision takes, and this passes it one. On a half court
   * `active` answers "is the ball on MY side"; a full court has no other side
   * for it to be on.
   */
  active: boolean;
}

export const SplitScreenMatch: React.FC<SplitScreenMatchProps> = ({
  settings,
  winningScore,
  rules,
  theme,
  onExitSplitMode,
}) => {
  const lang: LanguageCode = settings.language || 'en';

  const [p1Score, setP1Score] = useState<number>(0);
  const [p2Score, setP2Score] = useState<number>(0);
  // One streak per side, and they belong to their own player: a streak counts
  // that player's own consecutive returns and ends only when THEY miss. The
  // other player letting the ball past is a point won, not a streak broken.
  // Split Screen records nothing on any profile, so these live and die with
  // the match — but they are the same rule the rest of the game plays by.
  const [streaks, setStreaks] = useState<[number, number]>([0, 0]);
  const [isServing, setIsServing] = useState<boolean>(true);
  const [server, setServer] = useState<1 | 2>(1);
  const [winner, setWinner] = useState<1 | 2 | null>(null);

  // The rules the match is played under, read by the loop through a ref so a
  // re-render does not re-arm it. Fixed for the life of a match, as everywhere
  // else — the pre-match sheet is the only place they can be set.
  const rulesRef = useRef<MatchRules>(rules);
  rulesRef.current = rules;
  const paddleWidth = paddleWidthFor(rules);
  const ballRadius = ballRadiusFor(rules);
  // Both bounds scaled into this court's own units, so a raised ballSpeedMax
  // makes a split match faster exactly as it makes a half-court match faster.
  const speedCap = maxBallSpeedFor(rules) * SPEED_SCALE;
  const speedMin = minBallSpeedFor(rules) * SPEED_SCALE;
  const serveSpeed = Math.max(speedMin, Math.min(SERVE_SPEED, speedCap));
  const geomRef = useRef({ paddleWidth, ballRadius, speedCap, speedMin, serveSpeed });
  geomRef.current = { paddleWidth, ballRadius, speedCap, speedMin, serveSpeed };

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const p1PaddleRef = useRef<number>(0.5);
  const p2PaddleRef = useRef<number>(0.5);
  // Last frame's positions, so each paddle's own speed can be measured.
  const p1PrevRef = useRef<number>(0.5);
  const p2PrevRef = useRef<number>(0.5);
  const ballRef = useRef<FullCourtBall>({
    x: 0.5,
    y: P1_PADDLE_Y - 0.06,
    vx: 0,
    vy: 0,
    radius: ballRadiusFor(rules),
    active: true,
  });
  // The physics loop reads/writes these refs synchronously (a state updater
  // runs too late — the loop could tick again and score the same ball twice);
  // the matching useState values exist purely to drive the HUD.
  const isServingRef = useRef<boolean>(true);
  const serverRef = useRef<1 | 2>(1);
  const winnerRef = useRef<1 | 2 | null>(null);
  const p1ScoreRef = useRef<number>(0);
  const p2ScoreRef = useRef<number>(0);
  const rallyRef = useRef<[number, number]>([0, 0]);
  // Which paddle each active pointer drives, so two thumbs can play at once.
  const pointerOwnersRef = useRef<Map<number, 1 | 2>>(new Map());

  const clampPaddle = (x: number) => {
    const half = geomRef.current.paddleWidth / 2;
    return Math.max(half, Math.min(1 - half, x));
  };

  const serve = useCallback(() => {
    if (!isServingRef.current || winnerRef.current) return;
    const from = serverRef.current;
    setIsServing(false);
    isServingRef.current = false;

    const vx = (Math.random() - 0.5) * 0.45;
    ballRef.current = {
      x: from === 1 ? p1PaddleRef.current : p2PaddleRef.current,
      y: from === 1 ? P1_PADDLE_Y - 0.06 : P2_PADDLE_Y + 0.06,
      vx,
      // Player 1 (bottom) serves upward; player 2 (top) serves downward.
      vy: from === 1 ? -geomRef.current.serveSpeed : geomRef.current.serveSpeed,
      radius: geomRef.current.ballRadius,
      active: true,
    };
  }, []);

  const resetPoint = (nextServer: 1 | 2) => {
    setServer(nextServer);
    serverRef.current = nextServer;
    setIsServing(true);
    isServingRef.current = true;
    ballRef.current = {
      x: 0.5,
      y: nextServer === 1 ? P1_PADDLE_Y - 0.06 : P2_PADDLE_Y + 0.06,
      vx: 0,
      vy: 0,
      radius: geomRef.current.ballRadius,
      active: true,
    };
  };

  const resetAll = () => {
    p1ScoreRef.current = 0;
    p2ScoreRef.current = 0;
    setP1Score(0);
    setP2Score(0);
    setStreaks([0, 0]);
    rallyRef.current = [0, 0];
    setWinner(null);
    winnerRef.current = null;
    p1PaddleRef.current = 0.5;
    p2PaddleRef.current = 0.5;
    resetPoint(1);
  };

  // Physics: one ball, one continuous court, both paddles local.
  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();

    const loop = (time: number) => {
      const dt = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;

      if (isServingRef.current || winnerRef.current) {
        // Keep the ball glued to the server's paddle while they line up.
        if (isServingRef.current && !winnerRef.current) {
          const from = serverRef.current;
          ballRef.current.x = from === 1 ? p1PaddleRef.current : p2PaddleRef.current;
        }
        animId = requestAnimationFrame(loop);
        return;
      }

      const geom = geomRef.current;
      const activeRules = rulesRef.current;
      // Each paddle's own speed, sampled once a frame against the position the
      // collision below reads — the same rule App follows. Nothing passed a
      // paddle velocity here at all, so `driveCoupling` saw a stationary
      // paddle on every contact and there was no paddle drive and no spin in
      // this mode whatsoever.
      const p1Vx = (p1PaddleRef.current - p1PrevRef.current) / (dt || 0.016);
      const p2Vx = (p2PaddleRef.current - p2PrevRef.current) / (dt || 0.016);
      p1PrevRef.current = p1PaddleRef.current;
      p2PrevRef.current = p2PaddleRef.current;

      const b = { ...ballRef.current };
      // Substepped for the reason the half-court loop is: the paddle test is a
      // POINT sample with a window about `PADDLE_HEIGHT + 2r` tall, and one
      // jump at speed over a clamped frame steps clean over it.
      const steps = physicsSubsteps(Math.hypot(b.vx, b.vy), dt, b.radius);
      const sdt = dt / steps;

      for (let step = 0; step < steps; step++) {
        b.x += b.vx * sdt;
        b.y += b.vy * sdt;

        // Side walls
        if (b.x - b.radius <= 0) {
          b.x = b.radius;
          b.vx = Math.abs(b.vx);
          sound.playWallBounce();
        } else if (b.x + b.radius >= 1) {
          b.x = 1 - b.radius;
          b.vx = -Math.abs(b.vx);
          sound.playWallBounce();
        }

        // Player 1's paddle sits exactly where the shared half-court collision
        // routine expects one, so it is reused as-is.
        const p1Hit = checkPaddleCollision(b, p1PaddleRef.current, geom.paddleWidth, p1Vx, activeRules);
        if (p1Hit.hit && p1Hit.angle !== undefined && p1Hit.speed !== undefined) {
          const speed = Math.max(geom.speedMin, Math.min(p1Hit.speed, geom.speedCap));
          b.vy = -Math.abs(speed * Math.cos(p1Hit.angle));
          b.vx = speed * Math.sin(p1Hit.angle);
          b.y = P1_PADDLE_Y - PADDLE_HEIGHT / 2 - b.radius;
          sound.playPaddleHit(speed / geom.serveSpeed);
          rallyRef.current = [rallyRef.current[0] + 1, rallyRef.current[1]];
          setStreaks(rallyRef.current);
        }

        // Player 2's paddle is the same geometry flipped about the net, so the
        // ball is mirrored into the routine's frame and the result mirrored
        // back — the paddle's own velocity with it, since left and right swap
        // across the mirror too.
        const mirrored = { ...b, y: 1 - b.y, vy: -b.vy };
        const p2Hit = checkPaddleCollision(mirrored, p2PaddleRef.current, geom.paddleWidth, -p2Vx, activeRules);
        if (p2Hit.hit && p2Hit.angle !== undefined && p2Hit.speed !== undefined) {
          const speed = Math.max(geom.speedMin, Math.min(p2Hit.speed, geom.speedCap));
          b.vy = Math.abs(speed * Math.cos(p2Hit.angle));
          b.vx = speed * Math.sin(p2Hit.angle);
          b.y = P2_PADDLE_Y + PADDLE_HEIGHT / 2 + b.radius;
          sound.playOpponentPaddleHit();
          rallyRef.current = [rallyRef.current[0], rallyRef.current[1] + 1];
          setStreaks(rallyRef.current);
        }

        // Past either baseline is a point, and the sweep stops there rather
        // than carrying the ball on past it.
        if (b.y >= 1.05 || b.y <= -0.05) break;
      }

      // Baselines: a ball past a player's baseline is a point for the other.
      if (b.y >= 1.05) {
        sound.playScore();
        // P1 let it past, so P1's streak ends — and only P1's.
        rallyRef.current = [0, rallyRef.current[1]];
        setStreaks(rallyRef.current);
        p2ScoreRef.current += 1;
        setP2Score(p2ScoreRef.current);
        if (p2ScoreRef.current >= winningScore) {
          winnerRef.current = 2;
          setWinner(2);
          confetti({ particleCount: 90, spread: 70, origin: { y: 0.3 } });
        } else {
          resetPoint(1);
        }
        animId = requestAnimationFrame(loop);
        return;
      }

      if (b.y <= -0.05) {
        sound.playScore();
        // P2 let it past, so P2's streak ends — and only P2's.
        rallyRef.current = [rallyRef.current[0], 0];
        setStreaks(rallyRef.current);
        p1ScoreRef.current += 1;
        setP1Score(p1ScoreRef.current);
        if (p1ScoreRef.current >= winningScore) {
          winnerRef.current = 1;
          setWinner(1);
          confetti({ particleCount: 90, spread: 70, origin: { y: 0.7 } });
        } else {
          resetPoint(2);
        }
        animId = requestAnimationFrame(loop);
        return;
      }

      ballRef.current = b;
      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [winningScore]);

  // Keyboard: player 1 uses the arrow keys, player 2 uses A / D.
  useEffect(() => {
    const pressed = new Set<string>();
    let frame: number;

    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'Space'].includes(e.code)) {
        e.preventDefault();
        pressed.add(e.code);
        if (e.code === 'Space') serve();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => pressed.delete(e.code);

    const keyLoop = () => {
      let d1 = 0;
      let d2 = 0;
      if (pressed.has('ArrowLeft')) d1 -= 0.025;
      if (pressed.has('ArrowRight')) d1 += 0.025;
      if (pressed.has('KeyA')) d2 -= 0.025;
      if (pressed.has('KeyD')) d2 += 0.025;
      if (d1 !== 0) p1PaddleRef.current = clampPaddle(p1PaddleRef.current + d1);
      if (d2 !== 0) p2PaddleRef.current = clampPaddle(p2PaddleRef.current + d2);
      frame = requestAnimationFrame(keyLoop);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    frame = requestAnimationFrame(keyLoop);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      cancelAnimationFrame(frame);
    };
  }, [serve]);

  // Touch/mouse: the half a pointer starts in decides the paddle it drives,
  // so both players can drag at the same time on one screen.
  const paddleForEvent = (e: React.PointerEvent<HTMLCanvasElement>): 1 | 2 | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    return y >= NET_Y ? 1 : 2;
  };

  const moveFromEvent = (e: React.PointerEvent<HTMLCanvasElement>, which: 1 | 2) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = clampPaddle((e.clientX - rect.left) / rect.width);
    if (which === 1) p1PaddleRef.current = x;
    else p2PaddleRef.current = x;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const which = paddleForEvent(e);
    if (!which) return;
    pointerOwnersRef.current.set(e.pointerId, which);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    moveFromEvent(e, which);
    // Only a tap on the serving player's own half launches the serve.
    if (isServingRef.current && which === serverRef.current) serve();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const which = pointerOwnersRef.current.get(e.pointerId);
    if (which) moveFromEvent(e, which);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointerOwnersRef.current.delete(e.pointerId);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  };

  // Canvas render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;

    const drawPaddle = (
      x: number,
      centerY: number,
      width: number,
      height: number,
      color: string,
      glow: string
    ) => {
      const w = geomRef.current.paddleWidth * width;
      const h = PADDLE_HEIGHT * height;
      const left = x * width - w / 2;
      const top = centerY * height - h / 2;
      ctx.save();
      ctx.fillStyle = color;
      ctx.shadowColor = glow;
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.roundRect(left, top, w, h, Math.min(h / 2, 8));
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(x * width - 3, top + 2, 6, h - 4);
      ctx.restore();
    };

    const render = (time: number) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3.5);
      const targetW = Math.round(rect.width * dpr);
      const targetH = Math.round(rect.height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const width = rect.width;
      const height = rect.height;

      ctx.save();
      ctx.scale(dpr, dpr);

      ctx.fillStyle = theme.courtColor;
      ctx.fillRect(0, 0, width, height);

      if (theme.gridColor !== 'transparent') {
        ctx.strokeStyle = theme.gridColor;
        ctx.lineWidth = 1;
        const step = width / 8;
        for (let x = step; x < width; x += step) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
        for (let y = step; y < height; y += step) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        }
      }

      // Side borders
      ctx.strokeStyle = theme.courtBorder;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(1.5, 0);
      ctx.lineTo(1.5, height);
      ctx.moveTo(width - 1.5, 0);
      ctx.lineTo(width - 1.5, height);
      ctx.stroke();

      // The net: halfway across the play area, dividing the two players.
      ctx.save();
      ctx.strokeStyle = theme.netLineColor;
      ctx.lineWidth = 4;
      ctx.setLineDash([12, 8]);
      ctx.lineDashOffset = -(time / 50) % 20;
      ctx.shadowColor = theme.netGlowColor;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(0, NET_Y * height);
      ctx.lineTo(width, NET_Y * height);
      ctx.stroke();
      ctx.restore();

      // Ball
      const b = ballRef.current;
      const br = b.radius * width;
      ctx.save();
      ctx.fillStyle = theme.ballColor;
      ctx.shadowColor = theme.ballGlow;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(b.x * width, b.y * height, br, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(b.x * width, b.y * height, br * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      drawPaddle(p1PaddleRef.current, P1_PADDLE_Y, width, height, '#00f0ff', '#00f0ff');
      drawPaddle(p2PaddleRef.current, P2_PADDLE_Y, width, height, '#ff007f', '#ff007f');

      // Serve prompt on the serving player's side, rotated to face them.
      if (isServingRef.current && !winnerRef.current) {
        const pulse = (Math.sin(time / 200) + 1) / 2;
        ctx.save();
        ctx.fillStyle = `rgba(255,255,255,${0.65 + pulse * 0.35})`;
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        if (serverRef.current === 1) {
          ctx.fillText(t('tap_to_serve', lang), width / 2, height * 0.7);
        } else {
          ctx.translate(width / 2, height * 0.3);
          ctx.rotate(Math.PI);
          ctx.fillText(t('tap_to_serve', lang), 0, 0);
        }
        ctx.restore();
      }

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [theme, lang]);

  return (
    <div
      id="split-screen-match"
      className="relative w-full h-full flex flex-col select-none"
      style={{ backgroundColor: theme.background }}
    >
      {/* Player 2 (top) HUD — rotated so it reads from the far side */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-zinc-950/80 z-20 rotate-180">
        <button
          id="btn-split-exit"
          onClick={onExitSplitMode}
          title={t('exit_to_menu', lang)}
          className="p-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-cyan-400 border border-zinc-700 transition active:scale-95"
        >
          <Home className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2 font-mono text-sm">
          <span className="text-[9px] uppercase text-zinc-400">P2</span>
          <span className="text-xl font-black text-pink-400 leading-none">{p2Score}</span>
        </div>
        <div className="w-8" />
      </div>

      {/* Full court */}
      <div className="flex-1 relative min-h-0">
        <canvas
          ref={canvasRef}
          id="split-court-canvas"
          className="w-full h-full block touch-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />

        {theme.scanlines && (
          <div
            className="absolute inset-0 pointer-events-none opacity-25"
            style={{
              backgroundImage:
                'repeating-linear-gradient(0deg, rgba(0,0,0,0.8), rgba(0,0,0,0.8) 1px, transparent 1px, transparent 3px)',
            }}
          />
        )}

        {/* Unranked reminder, parked on the net line */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
          <span className="px-2 py-0.5 rounded-full bg-black/50 border border-zinc-700 text-[8px] font-mono text-zinc-400 uppercase tracking-widest">
            {t('mode_split', lang)} · {t('rally', lang)} {streaks[0]} — {streaks[1]}
          </span>
        </div>
      </div>

      {/* Player 1 (bottom) HUD */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-zinc-800 bg-zinc-950/80 z-20">
        <button
          id="btn-split-exit-p1"
          onClick={onExitSplitMode}
          title={t('exit_to_menu', lang)}
          className="p-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-cyan-400 border border-zinc-700 transition active:scale-95"
        >
          <Home className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2 font-mono text-sm">
          <span className="text-[9px] uppercase text-zinc-400">P1</span>
          <span className="text-xl font-black text-cyan-400 leading-none">{p1Score}</span>
          <span className="text-[8px] text-zinc-500">to {winningScore}</span>
        </div>
        <button
          id="btn-split-reset"
          onClick={resetAll}
          title={t('reset_match', lang)}
          className="p-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition active:scale-95"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Winner overlay — shown to both sides */}
      {winner && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/80 backdrop-blur-md p-4">
          <div className="rotate-180">
            <h3 className={`text-xl font-mono font-black uppercase ${winner === 2 ? 'text-pink-400' : 'text-cyan-400'}`}>
              {t('player_wins', lang, { n: winner })}
            </h3>
          </div>

          <p className="text-xs font-mono text-zinc-400">
            {t('final_score', lang)}: {p1Score} - {p2Score}
          </p>

          <div className="flex items-center gap-2">
            <button
              onClick={resetAll}
              className="px-5 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-ink-on-accent font-mono font-bold text-xs active:scale-95 transition"
            >
              {t('play_again', lang)}
            </button>
            <button
              onClick={onExitSplitMode}
              className="px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 font-mono font-bold text-xs active:scale-95 transition"
            >
              {t('exit_to_menu', lang)}
            </button>
          </div>

          <h3 className={`text-xl font-mono font-black uppercase ${winner === 2 ? 'text-pink-400' : 'text-cyan-400'}`}>
            {t('player_wins', lang, { n: winner })}
          </h3>
        </div>
      )}
    </div>
  );
};
