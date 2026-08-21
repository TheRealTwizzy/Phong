import React, { useEffect, useRef, useCallback, useState } from 'react';
import { BallState, GameSettings, Particle, Ripple, LanguageCode } from '../types';
import { ThemeConfig } from '../game/themes';
import { PADDLE_Y, PADDLE_HEIGHT, ServeAim } from '../game/physics';
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
  isBallInOpponentCourt: boolean;
  oppEstimatedX?: number;
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
  isBallInOpponentCourt,
  oppEstimatedX = 0.5,
  rallyCount,
  language = 'en',
  onImpact,
  shakeTrigger = 0,
  netLabel,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef<boolean>(false);
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

  // Serve aiming: while the serve prompt is up, a drag from the paddle sets
  // direction and power. A plain tap still serves, so the old one-tap feel is
  // intact for anyone who does not want to aim.
  const paddleWidthRef = useRef(paddleWidth);
  paddleWidthRef.current = paddleWidth;
  const aimStartRef = useRef<{ x: number; y: number } | null>(null);
  const [aim, setAim] = useState<ServeAim | null>(null);
  const aimRef = useRef<ServeAim | null>(null);
  aimRef.current = aim;

  // Drag distance, in fractions of the court, that counts as a full pull.
  // How far the aim arrow may swing, mirroring what the match rules allow.
  const serveAngleLimitRef = useRef(serveAngleLimitDeg);
  serveAngleLimitRef.current = serveAngleLimitDeg;

  const AIM_FULL_PULL = 0.22;
  const AIM_DEADZONE = 0.02;

  const aimFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): ServeAim | null => {
    const canvas = canvasRef.current;
    const start = aimStartRef.current;
    if (!canvas || !start) return null;
    const rect = canvas.getBoundingClientRect();
    const dx = (e.clientX - rect.left) / rect.width - start.x;
    const dy = (e.clientY - rect.top) / rect.height - start.y;
    if (Math.hypot(dx, dy) < AIM_DEADZONE) return null;
    // Pull back (downward) for power, sideways for direction — a slingshot.
    const power = Math.max(0, Math.min(1, dy / AIM_FULL_PULL));
    const angle = Math.max(-1, Math.min(1, -dx / AIM_FULL_PULL));
    return { angle, power };
  };

  // Pointer drag event handlers for mouse/touch
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isServing) {
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        aimStartRef.current = {
          x: (e.clientX - rect.left) / rect.width,
          y: (e.clientY - rect.top) / rect.height,
        };
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {}
      }
      return;
    }
    isDraggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    updatePaddleFromEvent(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (aimStartRef.current) {
      setAim(aimFromEvent(e));
      return;
    }
    if (isDraggingRef.current || e.buttons === 1) {
      updatePaddleFromEvent(e);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (aimStartRef.current) {
      const finalAim = aimFromEvent(e);
      aimStartRef.current = null;
      setAim(null);
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      // A tap with no meaningful drag serves the default way.
      onServe(finalAim || undefined);
      return;
    }
    isDraggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
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

      // Pulsing sonar warning arrow when ball is over in the opponent's court
      if (isBallInOpponentCourt) {
        const pulse = (Math.sin(time / 150) + 1) / 2;
        const indicatorX = oppEstimatedX * width;

        ctx.save();
        ctx.fillStyle = theme.opponentPaddleColor;
        ctx.shadowColor = theme.opponentPaddleGlow;
        ctx.shadowBlur = 10 + pulse * 10;

        // Draw animated indicator chevron at the net where the ball/opponent is active
        ctx.beginPath();
        ctx.moveTo(indicatorX, 28 + pulse * 6);
        ctx.lineTo(indicatorX - 10, 38 + pulse * 6);
        ctx.lineTo(indicatorX + 10, 38 + pulse * 6);
        ctx.closePath();
        ctx.fill();

        ctx.font = 'bold 10px monospace';
        ctx.fillText(t('opponent_in_play', language), indicatorX, 52 + pulse * 4);
        ctx.restore();
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

        // Inner bright core
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(ballPx, ballPy, ballPr * 0.5, 0, Math.PI * 2);
        ctx.fill();
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

      // Serve Prompt Overlay, and the aim indicator once a drag starts.
      if (isServing) {
        const liveAim = aimRef.current;
        ctx.save();
        if (liveAim) {
          // Slingshot readout: an arrow from the paddle showing the launch
          // direction, its length showing power.
          const originX = paddleCenterPx;
          const originY = paddleTopPx;
          const radians = (liveAim.angle * serveAngleLimitRef.current * Math.PI) / 180;
          const reach = height * (0.10 + 0.28 * liveAim.power);
          const tipX = originX + Math.sin(radians) * reach;
          const tipY = originY - Math.cos(radians) * reach;

          ctx.strokeStyle = theme.accent;
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
          ctx.fillStyle = theme.accent;
          ctx.fill();

          // Power bar along the bottom
          const barW = width * 0.42;
          const barX = (width - barW) / 2;
          const barY = height * 0.955;
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          ctx.fillRect(barX, barY, barW, 5);
          ctx.fillStyle = theme.accent;
          ctx.fillRect(barX, barY, barW * liveAim.power, 5);
        } else {
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
    isBallInOpponentCourt,
    oppEstimatedX,
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
