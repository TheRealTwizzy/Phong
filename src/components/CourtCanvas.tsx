import React, { useEffect, useRef, useCallback, useState } from 'react';
import { BallState, GameSettings, Particle, Ripple, LanguageCode } from '../types';
import { ThemeConfig } from '../game/themes';
import {
  PADDLE_Y,
  PADDLE_HEIGHT,
  SPIN_MAX,
  ServeAim,
  AIM_FULL_PUSH,
  AIM_DEADZONE,
  aimFromPush,
} from '../game/physics';
import { sound } from '../audio/soundEffects';
import { t } from '../i18n/translations';

interface TrailPoint {
  x: number;
  y: number;
  speed: number;
  time: number;
  radius: number;
}

interface CourtCanvasProps {
  ball: BallState;
  paddleX: number;
  onPaddleMove: (newX: number) => void;
  settings: GameSettings;
  theme: ThemeConfig;
  isServing: boolean;
  onServe: (aim?: ServeAim) => void;
  /** Live paddle width for this match (rules can scale it). */
  paddleWidth: number;
  /** Max serve deflection in degrees under this match's rules. */
  serveAngleLimitDeg: number;
  /** 0 = no auto-serve; otherwise the configured seconds. */
  autoServeSeconds: number;
  /** Seconds left before an auto-serve fires, or null when not counting. */
  serveCountdown: number | null;
  /**
   * The two net indicators read the game's OWN refs, the way RadarPreview
   * does, rather than taking a number prop per frame: `oppEstimatedX` used to
   * sit in the render effect's dependency array, so the whole rAF loop tore
   * itself down and re-armed on every ball update.
   *
   * Both hold the SENDER's frame — the AI's own half in solo, the opponent
   * phone's in a duel — so the head-to-head mirror is applied here.
   */
  oppPaddleXRef: React.MutableRefObject<number>;
  oppBallRef: React.MutableRefObject<BallState | null>;
  /** Follows the opponent's paddle, always. */
  showOpponentIndicator: boolean;
  /** Follows the ball, but only while it is on the opponent's half. */
  showBallIndicator: boolean;
  /** False for the Practice Wall: nobody over there to point at. */
  hasOpponent: boolean;
  rallyCount: number;
  language?: LanguageCode;
  onImpact?: (type: 'paddle' | 'wall' | 'net' | 'score') => void;
  shakeTrigger?: number;
  // Overrides the top-line caption (e.g. Practice Wall's "return line").
  netLabel?: string;
}

export const CourtCanvas: React.FC<CourtCanvasProps> = ({
  ball,
  paddleX,
  onPaddleMove,
  settings,
  theme,
  isServing,
  onServe,
  paddleWidth,
  serveAngleLimitDeg,
  autoServeSeconds,
  serveCountdown,
  oppPaddleXRef,
  oppBallRef,
  showOpponentIndicator,
  showBallIndicator,
  hasOpponent,
  rallyCount,
  language = 'en',
  onImpact,
  shakeTrigger = 0,
  netLabel,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const paddleXRef = useRef<number>(paddleX);
  const particlesRef = useRef<Particle[]>([]);
  const ripplesRef = useRef<Ripple[]>([]);
  const trailRef = useRef<TrailPoint[]>([]);
  const prevBallActiveRef = useRef<boolean>(ball.active);
  const prevBallVyRef = useRef<number>(ball.vy);
  const prevBallVxRef = useRef<number>(ball.vx);
  const shakeAmountRef = useRef<number>(0);
  const prevShakeTriggerRef = useRef<number>(shakeTrigger);
  const dprRef = useRef<number>(Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 3.5));

  paddleXRef.current = paddleX;

  // External trigger for screen shake (e.g. from Settings test button or goal)
  useEffect(() => {
    if (shakeTrigger !== prevShakeTriggerRef.current) {
      prevShakeTriggerRef.current = shakeTrigger;
      const intensity = ((settings.screenShakeIntensity ?? 60) / 100);
      shakeAmountRef.current = Math.min(24, shakeAmountRef.current + 12 * intensity);
    }
  }, [shakeTrigger, settings.screenShakeIntensity]);

  // Handle mobile tilt / gyroscope
  useEffect(() => {
    if (!settings.tiltEnabled) return;

    const handleOrientation = (e: DeviceOrientationEvent) => {
      if (e.gamma !== null) {
        // gamma is left-to-right tilt in degrees (-90 to +90)
        const tilt = Math.max(-30, Math.min(30, e.gamma));
        const normalizedX = 0.5 + (tilt / 30) * 0.45;
        const halfP = paddleWidthRef.current / 2;
        const clampedX = Math.max(halfP, Math.min(1 - halfP, normalizedX));
        onPaddleMove(clampedX);
      }
    };

    window.addEventListener('deviceorientation', handleOrientation);
    return () => {
      window.removeEventListener('deviceorientation', handleOrientation);
    };
  }, [settings.tiltEnabled, onPaddleMove]);

  // Keyboard controls
  useEffect(() => {
    const keysPressed = new Set<string>();
    let animFrame: number;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'Space'].includes(e.code)) {
        e.preventDefault();
        keysPressed.add(e.code);

        if (e.code === 'Space' && isServing) {
          onServe();
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      keysPressed.delete(e.code);
    };

    const keyLoop = () => {
      if (keysPressed.size > 0) {
        let delta = 0;
        if (keysPressed.has('ArrowLeft') || keysPressed.has('KeyA')) delta -= 0.025;
        if (keysPressed.has('ArrowRight') || keysPressed.has('KeyD')) delta += 0.025;

        if (delta !== 0) {
          const halfP = paddleWidthRef.current / 2;
          const nextX = Math.max(halfP, Math.min(1 - halfP, paddleXRef.current + delta));
          onPaddleMove(nextX);
        }
      }
      animFrame = requestAnimationFrame(keyLoop);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    animFrame = requestAnimationFrame(keyLoop);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      cancelAnimationFrame(animFrame);
    };
  }, [onPaddleMove, isServing, onServe]);

  // Create particle burst helper
  const addParticles = useCallback((x: number, y: number, count: number, color: string) => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.2 + Math.random() * 0.8;
      particlesRef.current.push({
        x,
        y,
        vx: Math.cos(angle) * speed * 0.015,
        vy: Math.sin(angle) * speed * 0.015,
        life: 1.0,
        maxLife: 0.3 + Math.random() * 0.4,
        color,
        size: 3 + Math.random() * 4,
      });
    }
  }, []);

  const addRipple = useCallback((x: number, y: number, color: string) => {
    ripplesRef.current.push({
      x,
      y,
      radius: 0.02,
      maxRadius: 0.15,
      opacity: 0.8,
      color,
    });
  }, []);

  // Monitor ball net transitions & impacts
  useEffect(() => {
    const hapticScale = (settings.hapticIntensity || 75) / 100;

    if (!prevBallActiveRef.current && ball.active) {
      // Ball just re-entered player's court from top net!
      addParticles(ball.x, 0.02, 18, theme.netGlowColor);
      addRipple(ball.x, 0.02, theme.netGlowColor);
      sound.playBallIncoming();
      onImpact?.('net');
      if (settings.hapticsEnabled && navigator.vibrate) {
        try {
          navigator.vibrate(Math.max(5, Math.round(18 * hapticScale)));
        } catch {}
      }
    } else if (prevBallActiveRef.current && !ball.active) {
      // Ball just crossed over the net into opponent's court!
      addParticles(ball.x, 0.02, 15, theme.accentColor);
      sound.playNetWhoosh();
      onImpact?.('net');
      if (settings.hapticsEnabled && navigator.vibrate) {
        try {
          navigator.vibrate(Math.max(5, Math.round(14 * hapticScale)));
        } catch {}
      }
    }

    // Check paddle hit detection in canvas for particle effects & haptic
    const intensity = ((settings.screenShakeIntensity ?? 60) / 100);

    if (ball.active && prevBallVyRef.current > 0 && ball.vy < 0 && ball.y > 0.85) {
      addParticles(ball.x, PADDLE_Y, 20, theme.playerPaddleGlow);
      addRipple(ball.x, PADDLE_Y, theme.playerPaddleColor);
      onImpact?.('paddle');

      // Trigger screen shake on paddle impact
      const speedMag = ball.speedMultiplier || 1.0;
      shakeAmountRef.current = Math.min(22, shakeAmountRef.current + (speedMag > 1.2 ? 10 : 5) * intensity);

      if (settings.hapticsEnabled && navigator.vibrate) {
        try {
          navigator.vibrate(Math.max(8, Math.round(25 * hapticScale)));
        } catch {}
      }
    }

    // Check sidewall collision shake
    if (ball.active && ((prevBallVxRef.current < 0 && ball.vx > 0) || (prevBallVxRef.current > 0 && ball.vx < 0))) {
      shakeAmountRef.current = Math.min(16, shakeAmountRef.current + 4 * intensity);
      addParticles(ball.x <= 0.05 ? 0.01 : 0.99, ball.y, 8, theme.courtBorder);
    }

    prevBallActiveRef.current = ball.active;
    prevBallVyRef.current = ball.vy;
    prevBallVxRef.current = ball.vx;
  }, [
    ball.active,
    ball.vy,
    ball.vx,
    ball.x,
    ball.y,
    ball.speedMultiplier,
    theme,
    addParticles,
    addRipple,
    settings.hapticsEnabled,
    settings.hapticIntensity,
    settings.screenShakeIntensity,
    onImpact,
  ]);

  // Serving joystick, and who owns which finger.
  //
  // The aim gesture was always a joystick — push up from wherever the thumb
  // landed, sideways for angle, upward reach for power — but nothing drew it,
  // so the only affordance was a line of pulsing text. Now it draws itself
  // where the thumb lands, for as long as the serve lasts.
  //
  // It is also properly multi-touch. There was ONE aim origin, so a second
  // finger silently overwrote the first one's anchor and the aim jumped. Roles
  // are per pointerId now, the same way SplitScreenMatch tells two players'
  // thumbs apart: during your own serve the first fresh pointer takes the
  // joystick and any other drives the paddle, so you can aim with one thumb
  // and keep steering with the other. A pointer already driving the paddle
  // when the point ended keeps it — the thumb you are playing with is never
  // stolen mid-rally.
  const paddleWidthRef = useRef(paddleWidth);
  paddleWidthRef.current = paddleWidth;
  type PointerRole = 'paddle' | 'joystick' | 'spent';
  const pointerRolesRef = useRef<Map<number, PointerRole>>(new Map());
  /** Where the live joystick is anchored, in 0..1 of the canvas. */
  const joystickRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [aim, setAim] = useState<ServeAim | null>(null);
  const aimRef = useRef<ServeAim | null>(null);
  aimRef.current = aim;

  // How far the aim arrow may swing, mirroring what the match rules allow.
  const serveAngleLimitRef = useRef(serveAngleLimitDeg);
  serveAngleLimitRef.current = serveAngleLimitDeg;

  /** The push from the live joystick's anchor to this event, as an aim. */
  const aimFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): ServeAim | null => {
    const canvas = canvasRef.current;
    const stick = joystickRef.current;
    if (!canvas || !stick) return null;
    const rect = canvas.getBoundingClientRect();
    return aimFromPush(
      (e.clientX - rect.left) / rect.width - stick.x,
      (e.clientY - rect.top) / rect.height - stick.y
    );
  };

  // The serve can fire without the joystick being released: the auto-serve
  // timer, the space bar, or the opponent's ball arriving. Drop the stick, and
  // leave the finger still holding it INERT rather than handing it the paddle —
  // that would teleport the paddle to wherever the aiming thumb happened to be,
  // at the exact moment the rally starts.
  useEffect(() => {
    if (isServing) return;
    const stick = joystickRef.current;
    if (stick) pointerRolesRef.current.set(stick.pointerId, 'spent');
    joystickRef.current = null;
    setAim(null);
  }, [isServing]);

  // Pointer drag event handlers for mouse/touch
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    // During your own serve the first fresh pointer opens the joystick, so a
    // single thumb and a mouse both still serve exactly as they always have.
    if (isServing && !joystickRef.current) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      joystickRef.current = {
        pointerId: e.pointerId,
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
      };
      pointerRolesRef.current.set(e.pointerId, 'joystick');
      setAim(null);
      return;
    }
    pointerRolesRef.current.set(e.pointerId, 'paddle');
    updatePaddleFromEvent(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const role = pointerRolesRef.current.get(e.pointerId);
    if (role === 'joystick') {
      setAim(aimFromEvent(e));
      return;
    }
    if (role === 'spent') return;
    if (role === 'paddle' || e.buttons === 1) updatePaddleFromEvent(e);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const role = pointerRolesRef.current.get(e.pointerId);
    pointerRolesRef.current.delete(e.pointerId);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    if (role !== 'joystick') return;
    const finalAim = aimFromEvent(e);
    joystickRef.current = null;
    setAim(null);
    // A tap with no meaningful drag serves the default way.
    onServe(finalAim || undefined);
  };

  const updatePaddleFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const rawX = (e.clientX - rect.left) / rect.width;
    const halfP = paddleWidth / 2;
    const clampedX = Math.max(halfP, Math.min(1 - halfP, rawX));
    onPaddleMove(clampedX);
  };

  // Main Canvas Render Loop Optimized for Modern Smartphones (DPR 2.0-3.5)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let lastTime = performance.now();

    const render = (time: number) => {
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3.5);
      dprRef.current = dpr;

      // Ensure canvas internal pixel buffer matches physical smartphone display
      const targetW = Math.round(rect.width * dpr);
      const targetH = Math.round(rect.height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      // Apply dynamic camera screen shake
      if (shakeAmountRef.current > 0.05) {
        const angle = Math.random() * Math.PI * 2;
        const shakeX = Math.cos(angle) * shakeAmountRef.current;
        const shakeY = Math.sin(angle) * shakeAmountRef.current;
        ctx.translate(shakeX, shakeY);
        shakeAmountRef.current *= Math.pow(0.85, dt * 60);
      }

      const width = rect.width;
      const height = rect.height;

      // Clear Canvas & draw court background
      ctx.fillStyle = theme.courtColor;
      ctx.fillRect(0, 0, width, height);

      // Draw subtle court grid lines
      if (theme.gridColor !== 'transparent') {
        ctx.strokeStyle = theme.gridColor;
        ctx.lineWidth = 1;
        const gridStep = width / 8;
        for (let x = gridStep; x < width; x += gridStep) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
        for (let y = gridStep; y < height; y += gridStep) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        }
      }

      // Draw Court Side Borders
      ctx.strokeStyle = theme.courtBorder;
      ctx.lineWidth = 3;
      ctx.beginPath();
      // Left border
      ctx.moveTo(1.5, 0);
      ctx.lineTo(1.5, height);
      // Right border
      ctx.moveTo(width - 1.5, 0);
      ctx.lineTo(width - 1.5, height);
      ctx.stroke();

      // ==========================================
      // TOP NET / HALFWAY LINE (THE CORE MECHANIC)
      // ==========================================
      const netY = 6;
      ctx.save();
      ctx.strokeStyle = theme.netLineColor;
      ctx.lineWidth = 5;
      ctx.setLineDash([12, 8]);
      ctx.lineDashOffset = -(time / 50) % 20;

      // Glow effect on net
      ctx.shadowColor = theme.netGlowColor;
      ctx.shadowBlur = 12;

      ctx.beginPath();
      ctx.moveTo(0, netY);
      ctx.lineTo(width, netY);
      ctx.stroke();
      ctx.restore();

      // Net decorative label & crossing indicator
      ctx.fillStyle = theme.netGlowColor;
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(netLabel ?? t('net_halfway_line', language), width / 2, 20);

      // The two net indicators.
      //
      // There used to be one, labelled OPPONENT IN PLAY, and it tracked the
      // BALL — it named one thing and drew another, and it went dark exactly
      // when the opponent was most worth watching. They are separate now
      // because they answer separate questions: where is the other player
      // standing, and is the ball over there. Both are mirrored into this
      // player's frame, the same head-to-head flip the radar applies.
      //
      // Neither is the sonar. The sonar draws the far half and costs the match
      // its rating; these two stay inside the ranked game, which is why a
      // match played WITH the sonar suppresses them (see App.tsx) rather than
      // stacking all three.
      if (hasOpponent) {
        const pulse = (Math.sin(time / 150) + 1) / 2;

        if (showOpponentIndicator) {
          const oppX = (1 - (oppPaddleXRef.current ?? 0.5)) * width;
          ctx.save();
          ctx.fillStyle = theme.opponentPaddleColor;
          ctx.shadowColor = theme.opponentPaddleGlow;
          ctx.shadowBlur = 10 + pulse * 10;
          ctx.beginPath();
          ctx.moveTo(oppX, 28 + pulse * 4);
          ctx.lineTo(oppX - 10, 38 + pulse * 4);
          ctx.lineTo(oppX + 10, 38 + pulse * 4);
          ctx.closePath();
          ctx.fill();
          ctx.font = 'bold 10px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(t('indicator_opponent', language), oppX, 50 + pulse * 3);
          ctx.restore();
        }

        // A second row, so the two never overprint when the opponent is
        // standing exactly where the ball is.
        const ob = oppBallRef.current;
        if (showBallIndicator && ob && ob.active) {
          const ballX = (1 - ob.x) * width;
          ctx.save();
          ctx.fillStyle = theme.ballColor;
          ctx.shadowColor = theme.ballGlow;
          ctx.shadowBlur = 8 + pulse * 8;
          ctx.beginPath();
          ctx.arc(ballX, 62 + pulse * 3, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = 'bold 9px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(t('indicator_ball', language), ballX, 78 + pulse * 3);
          ctx.restore();
        }
      }

      // Draw Ripples
      ripplesRef.current = ripplesRef.current.filter((r) => {
        r.radius += 0.2 * dt;
        r.opacity -= 1.2 * dt;
        if (r.opacity <= 0) return false;

        ctx.save();
        ctx.strokeStyle = r.color;
        ctx.globalAlpha = Math.max(0, r.opacity);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(r.x * width, r.y * height, Math.max(0, r.radius * width), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        return true;
      });

      // ==========================================
      // DECAYING BALL TRAIL EFFECT (SHOWTRAILS)
      // ==========================================
      if (settings.showTrails && ball.active) {
        // Record current ball position snapshot
        const now = time;
        const currentSpeed = ball.speedMultiplier || 1.0;

        trailRef.current.push({
          x: ball.x,
          y: ball.y,
          speed: currentSpeed,
          time: now,
          radius: ball.radius,
        });

        // Prune points older than 280ms or keep up to 18 points max
        trailRef.current = trailRef.current.filter(
          (p) => now - p.time < 280
        );
        if (trailRef.current.length > 20) {
          trailRef.current.splice(0, trailRef.current.length - 20);
        }

        const trailLen = trailRef.current.length;
        if (trailLen > 1) {
          // Render glowing comet trail with decaying opacity
          ctx.save();
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          // Pass 1: Outer glow ribbon
          for (let i = 0; i < trailLen - 1; i++) {
            const p1 = trailRef.current[i];
            const p2 = trailRef.current[i + 1];
            const ratio = (i + 1) / trailLen;
            const alpha = Math.pow(ratio, 1.6) * 0.55;

            ctx.save();
            ctx.strokeStyle = theme.trailColor;
            ctx.shadowColor = theme.ballGlow;
            ctx.shadowBlur = 8 * ratio;
            ctx.globalAlpha = alpha;
            ctx.lineWidth = Math.max(2, ball.radius * width * 1.8 * ratio);

            ctx.beginPath();
            ctx.moveTo(p1.x * width, p1.y * height);
            ctx.lineTo(p2.x * width, p2.y * height);
            ctx.stroke();
            ctx.restore();
          }

          // Pass 2: Inner luminous core
          for (let i = 0; i < trailLen - 1; i++) {
            const p1 = trailRef.current[i];
            const p2 = trailRef.current[i + 1];
            const ratio = (i + 1) / trailLen;
            const alpha = Math.pow(ratio, 2) * 0.8;

            ctx.save();
            ctx.strokeStyle = '#ffffff';
            ctx.globalAlpha = alpha;
            ctx.lineWidth = Math.max(1, ball.radius * width * 0.7 * ratio);

            ctx.beginPath();
            ctx.moveTo(p1.x * width, p1.y * height);
            ctx.lineTo(p2.x * width, p2.y * height);
            ctx.stroke();
            ctx.restore();
          }

          // Pass 3: High speed kinetic spark trail
          if (currentSpeed > 1.25 && Math.random() < 0.35) {
            const head = trailRef.current[trailLen - 1];
            particlesRef.current.push({
              x: head.x + (Math.random() - 0.5) * 0.02,
              y: head.y + (Math.random() - 0.5) * 0.02,
              vx: (Math.random() - 0.5) * 0.005,
              vy: (Math.random() - 0.5) * 0.005,
              life: 0.8,
              maxLife: 0.25,
              color: theme.trailColor,
              size: 2.5,
            });
          }

          ctx.restore();
        }
      } else {
        trailRef.current = [];
      }

      // Draw Particles
      particlesRef.current = particlesRef.current.filter((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.life -= dt / p.maxLife;
        if (p.life <= 0) return false;

        ctx.save();
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.beginPath();
        ctx.arc(p.x * width, p.y * height, Math.max(0, p.size * p.life), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return true;
      });

      // Draw The Ball (Only if active in player's half!)
      if (ball.active) {
        const ballPx = ball.x * width;
        const ballPy = ball.y * height;
        const ballPr = ball.radius * width;

        ctx.save();
        ctx.fillStyle = theme.ballColor;
        ctx.shadowColor = theme.ballGlow;
        ctx.shadowBlur = 14;

        ctx.beginPath();
        ctx.arc(ballPx, ballPy, ballPr, 0, Math.PI * 2);
        ctx.fill();

        // Inner bright core, offset toward the way the ball is curving so a
        // spinning ball reads as spinning rather than as a mystery drift. On a
        // blind half-court the receiver never sees the stroke that produced
        // the spin, so the ball itself has to carry the tell.
        const spin = ball.spin || 0;
        const spinAmount = Math.max(-1, Math.min(1, spin / SPIN_MAX));
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(ballPx + spinAmount * ballPr * 0.42, ballPy, ballPr * 0.5, 0, Math.PI * 2);
        ctx.fill();

        if (Math.abs(spinAmount) > 0.06) {
          // A short arc on the side the ball is being pulled toward, spun by
          // wall-clock so it reads as rotation rather than a static crescent.
          const sweep = Math.min(1.5, 0.5 + Math.abs(spinAmount) * 1.6);
          const phase = (time / 260) * Math.sign(spinAmount);
          ctx.strokeStyle = theme.ballGlow;
          ctx.lineWidth = Math.max(1.5, ballPr * 0.34);
          ctx.beginPath();
          ctx.arc(ballPx, ballPy, ballPr * 1.5, phase, phase + sweep);
          ctx.stroke();
        }
        ctx.restore();
      }

      // ==========================================
      // PLAYER PADDLE (AT BOTTOM OF HALF COURT)
      // ==========================================
      const paddleW = paddleWidth * width;
      const paddleH = PADDLE_HEIGHT * height;
      const paddleCenterPx = paddleXRef.current * width;
      const paddleLeftPx = paddleCenterPx - paddleW / 2;
      const paddleTopPx = PADDLE_Y * height - paddleH / 2;
      const paddleRadius = Math.min(paddleH / 2, 8);

      ctx.save();
      ctx.fillStyle = theme.playerPaddleColor;
      ctx.shadowColor = theme.playerPaddleGlow;
      ctx.shadowBlur = 16;

      // Rounded Paddle bar
      ctx.beginPath();
      ctx.roundRect(paddleLeftPx, paddleTopPx, paddleW, paddleH, paddleRadius);
      ctx.fill();

      // Grip / Center Marker on Paddle
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fillRect(paddleCenterPx - 3, paddleTopPx + 2, 6, paddleH - 4);
      ctx.restore();

      // Serve Prompt Overlay, the joystick, and the aim indicator.
      if (isServing) {
        const liveAim = aimRef.current;
        const stick = joystickRef.current;
        ctx.save();

        // The serving joystick, drawn where the thumb actually landed. It
        // floats rather than sitting in a fixed corner so either hand works
        // and nothing has to be aimed for before it exists.
        //
        // The knob shows the CLAMPED aim, not the raw finger: past full push
        // the serve stops getting stronger, and the knob stopping at the ring
        // is how the player finds that out without being told.
        if (stick) {
          const ax = stick.x * width;
          const ay = stick.y * height;
          const reachX = AIM_FULL_PUSH * width;
          const reachY = AIM_FULL_PUSH * height;

          // Full-power boundary. Only the upward half is reachable — power is
          // read off upward travel alone — so only the upward half is drawn.
          ctx.save();
          ctx.strokeStyle = theme.accentColor;
          ctx.globalAlpha = 0.22;
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 6]);
          ctx.beginPath();
          ctx.ellipse(ax, ay, reachX, reachY, 0, Math.PI, 0);
          ctx.stroke();
          ctx.restore();

          // The deadzone: inside it there is no aim, and releasing is the
          // plain tap-to-serve this has always had.
          ctx.save();
          ctx.strokeStyle = theme.accentColor;
          ctx.globalAlpha = 0.5;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(ax, ay, AIM_DEADZONE * height, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();

          const knobX = ax + (liveAim ? liveAim.angle : 0) * reachX;
          const knobY = ay - (liveAim ? liveAim.power : 0) * reachY;
          ctx.save();
          ctx.strokeStyle = theme.accentColor;
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(knobX, knobY);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = theme.accentColor;
          ctx.shadowColor = theme.accentColor;
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.arc(knobX, knobY, 11, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        if (liveAim) {
          // Slingshot readout: an arrow from the paddle showing the launch
          // direction, its length showing power.
          const originX = paddleCenterPx;
          const originY = paddleTopPx;
          const radians = (liveAim.angle * serveAngleLimitRef.current * Math.PI) / 180;
          const reach = height * (0.10 + 0.28 * liveAim.power);
          const tipX = originX + Math.sin(radians) * reach;
          const tipY = originY - Math.cos(radians) * reach;

          ctx.strokeStyle = theme.accentColor;
          ctx.lineWidth = 3;
          ctx.setLineDash([7, 5]);
          ctx.beginPath();
          ctx.moveTo(originX, originY);
          ctx.lineTo(tipX, tipY);
          ctx.stroke();
          ctx.setLineDash([]);

          // Arrow head
          const head = 9;
          ctx.beginPath();
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(tipX - Math.sin(radians - 0.45) * head, tipY + Math.cos(radians - 0.45) * head);
          ctx.lineTo(tipX - Math.sin(radians + 0.45) * head, tipY + Math.cos(radians + 0.45) * head);
          ctx.closePath();
          ctx.fillStyle = theme.accentColor;
          ctx.fill();

          // Power bar along the bottom
          const barW = width * 0.42;
          const barX = (width - barW) / 2;
          const barY = height * 0.955;
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          ctx.fillRect(barX, barY, barW, 5);
          ctx.fillStyle = theme.accentColor;
          ctx.fillRect(barX, barY, barW * liveAim.power, 5);
        }
        if (!stick) {
          const pulse = (Math.sin(time / 200) + 1) / 2;
          ctx.fillStyle = `rgba(255, 255, 255, ${0.7 + pulse * 0.3})`;
          ctx.font = 'bold 13px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(t('drag_to_aim', language), width / 2, height * 0.75);
          if (autoServeSeconds > 0 && serveCountdown !== null) {
            ctx.font = 'bold 11px monospace';
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.fillText(
              t('auto_serve_in', language, { s: serveCountdown }),
              width / 2,
              height * 0.79
            );
          }
        }
        ctx.restore();
      }

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [
    ball,
    theme,
    settings.showTrails,
    isServing,
    hasOpponent,
    showOpponentIndicator,
    showBallIndicator,
    language,
    netLabel,
    aim,
    autoServeSeconds,
    serveCountdown,
    paddleWidth,
  ]);

  return (
    <div
      ref={containerRef}
      id="half-court-container"
      className="relative w-full h-full select-none overflow-hidden touch-none flex items-center justify-center cursor-grab active:cursor-grabbing"
      style={{ backgroundColor: theme.background }}
    >
      <canvas
        ref={canvasRef}
        id="half-court-canvas"
        className="w-full h-full block touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />

      {/* CRT Scanline Overlay if theme is retro */}
      {theme.scanlines && (
        <div
          className="absolute inset-0 pointer-events-none opacity-25"
          style={{
            backgroundImage:
              'repeating-linear-gradient(0deg, rgba(0,0,0,0.8), rgba(0,0,0,0.8) 1px, transparent 1px, transparent 3px)',
          }}
        />
      )}
    </div>
  );
};
