import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useMotion } from './ui/motion';
import { BallState, GameSettings, Particle, Ripple, LanguageCode } from '../types';
import { Cosmetic } from '../game/cosmetics';
import {
  PADDLE_Y,
  PADDLE_HEIGHT,
  SERVE_BALL_Y,
  SPIN_MAX,
  ServeAim,
  AIM_FULL_PUSH,
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
  theme: Cosmetic;
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
  /**
   * A court somebody else is playing on.
   *
   * Drops every pointer handler outright rather than ignoring the events
   * inside them: a watcher has no paddle to drive and no serve to aim, and a
   * handler that runs and then declines is a handler that can still capture a
   * pointer, arm a joystick or leave a stale press behind.
   */
  readOnly?: boolean;
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
  readOnly = false,
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
  const ballPropRef = useRef(ball);
  ballPropRef.current = ball;

  /**
   * `prefers-reduced-motion`, for the effects the canvas draws itself.
   *
   * `useMotion()` governs every DOM animation in the app and the canvas is
   * outside its reach, so screen shake, the impact particles and the ball
   * trail all ignored the setting entirely — and camera shake is the canonical
   * vestibular trigger, which is the one this most needed to respect. Read
   * through a ref because the render loop is armed once per match and must not
   * re-arm to learn about it.
   */
  const { reduced: reducedMotion } = useMotion();
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;
  // Multiplied into every shake, so a single `0` switches all of them off at
  // once and no future call site can forget to ask.
  const shakeScale = () => (reducedRef.current ? 0 : (settings.screenShakeIntensity ?? 60) / 100);

  // External trigger for screen shake (e.g. from Settings test button or goal)
  useEffect(() => {
    if (shakeTrigger !== prevShakeTriggerRef.current) {
      prevShakeTriggerRef.current = shakeTrigger;
      const intensity = shakeScale();
      shakeAmountRef.current = Math.min(24, shakeAmountRef.current + 12 * intensity);
    }
  }, [shakeTrigger, settings.screenShakeIntensity]);

  // Handle mobile tilt / gyroscope
  useEffect(() => {
    // A watcher has no paddle to tilt. Dropping the pointer handlers is not
    // enough on its own: tilt and the keyboard below reach onPaddleMove
    // without ever touching the canvas.
    if (readOnly || !settings.tiltEnabled) return;

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
  }, [readOnly, settings.tiltEnabled, onPaddleMove]);

  // Keyboard controls
  useEffect(() => {
    if (readOnly) return; // see the tilt effect above — and Space would serve
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

    // Per SECOND, not per frame. It was a flat 0.025 added every animation
    // frame, so the paddle moved exactly twice as fast on a 120Hz display as
    // on a 60Hz one — the same defect the pointer path had, on the one input
    // a desktop actually uses.
    const KEY_PADDLE_SPEED = 0.025 * 60;
    let keyLast = performance.now();
    const keyLoop = (now: number) => {
      const dt = Math.min((now - keyLast) / 1000, 0.05);
      keyLast = now;
      if (keysPressed.size > 0) {
        let delta = 0;
        if (keysPressed.has('ArrowLeft') || keysPressed.has('KeyA')) delta -= KEY_PADDLE_SPEED * dt;
        if (keysPressed.has('ArrowRight') || keysPressed.has('KeyD')) delta += KEY_PADDLE_SPEED * dt;

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
  }, [readOnly, onPaddleMove, isServing, onServe]);

  // Create particle burst helper
  const addParticles = useCallback((x: number, y: number, count: number, color: string) => {
    // A burst of moving objects is motion too, and every call site goes
    // through here, so one check covers the impacts, the sidewalls and the
    // net crossing rather than three that could each be forgotten.
    if (reducedRef.current) return;
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
    const intensity = shakeScale();

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

    // Check sidewall collision shake. The proximity test matters: a PADDLE hit
    // that returns the ball across the court reverses `vx` too, and without it
    // the sparks were drawn at the court edge for a contact that happened at
    // the baseline.
    const nearWall = ball.x <= 0.06 || ball.x >= 0.94;
    if (
      ball.active &&
      nearWall &&
      ((prevBallVxRef.current < 0 && ball.vx > 0) || (prevBallVxRef.current > 0 && ball.vx < 0))
    ) {
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
  // One rule decides every case: a role is the pointer's AGE RANK among the
  // fingers currently down. The oldest drives the paddle — always, serving or
  // not — and the second, while this player is serving, is the aiming
  // joystick. Anything after that is ignored.
  //
  // That is the way round the game actually plays. A player comes into a serve
  // already holding the paddle from the point they just lost, so the held
  // thumb is the paddle and the thumb they reach in with is the stick. It used
  // to be the reverse: the first finger down took the joystick and any later
  // one drove the paddle, which stole the thumb they were already playing with
  // and handed steering to the one that came to aim.
  //
  // Everything else falls out of the same rule. All fingers up, next one down
  // is rank 0 and takes the paddle. The paddle thumb lifts mid-aim and the
  // aiming thumb becomes rank 0, so it takes the paddle and the aim is
  // dropped — the paddle is never left with nobody driving it. And a serve
  // that fires without the stick being released (the auto-serve timer, the
  // space bar) simply ends the joystick role: the finger holding it is still
  // rank 1, so the paddle does NOT teleport to it at the moment the rally
  // starts.
  const paddleWidthRef = useRef(paddleWidth);
  paddleWidthRef.current = paddleWidth;
  const isServingRef = useRef(isServing);
  isServingRef.current = isServing;

  /** Live pointers, oldest first. The index IS the role. */
  const pointerOrderRef = useRef<number[]>([]);
  /**
   * Where each live pointer last was, in canvas-WIDTH units on BOTH axes —
   * the units `aimFromPush` is stated in, so the angle drawn is the angle
   * served. `x` doubles as the normalized paddle position.
   */
  const pointerPosRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  /** Whoever currently holds the paddle, so a handover can be spotted. */
  const paddleIdRef = useRef<number | null>(null);
  /** Where the live joystick is anchored, in the same width units. */
  const joystickRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [aim, setAim] = useState<ServeAim | null>(null);
  const aimRef = useRef<ServeAim | null>(null);
  aimRef.current = aim;

  // How far a serve may swing under this match's rules. The aim is measured
  // against it rather than against the stock 55°, so the line the player
  // follows is the line the ball takes at every rule setting.
  const serveAngleLimitRef = useRef(serveAngleLimitDeg);
  serveAngleLimitRef.current = serveAngleLimitDeg;

  const posFromEvent = (
    e: React.PointerEvent<HTMLCanvasElement>
  ): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return null;
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.width,
    };
  };

  /** The paddle is locked to its pointer's centre — no grab offset, ever. */
  const movePaddleTo = (x: number) => {
    const halfP = paddleWidthRef.current / 2;
    onPaddleMove(Math.max(halfP, Math.min(1 - halfP, x)));
  };

  /** The drag from the live joystick's anchor to a position, as an aim. */
  const aimFromPos = (pos: { x: number; y: number }): ServeAim | null => {
    const stick = joystickRef.current;
    if (!stick) return null;
    return aimFromPush(pos.x - stick.x, pos.y - stick.y, serveAngleLimitRef.current);
  };

  /**
   * Re-derive both roles from the current ranking. Called whenever the ranking
   * or the serve state can have changed — a pointer down, up or cancelled, and
   * `isServing` flipping either way.
   */
  const syncRoles = () => {
    const order = pointerOrderRef.current;
    const positions = pointerPosRef.current;
    const paddleId = order.length > 0 ? order[0] : null;
    const joystickId = isServingRef.current && order.length > 1 ? order[1] : null;

    if (paddleId !== null && paddleId !== paddleIdRef.current) {
      const pos = positions.get(paddleId);
      if (pos) movePaddleTo(pos.x);
    }
    paddleIdRef.current = paddleId;

    const stickId = joystickRef.current ? joystickRef.current.pointerId : null;
    if (stickId !== joystickId) {
      const pos = joystickId === null ? undefined : positions.get(joystickId);
      // A pointer can BECOME the stick without an event of its own — both
      // fingers already down when the point ends — so the anchor is wherever
      // it happens to be sitting, not where it first landed.
      joystickRef.current = pos && joystickId !== null
        ? { pointerId: joystickId, x: pos.x, y: pos.y }
        : null;
      setAim(null);
    }
  };

  // The serve can fire without the joystick being released: the auto-serve
  // timer, the space bar, or the opponent's ball arriving. The stick stops
  // existing; the finger holding it keeps its rank and stays off the paddle.
  useEffect(() => {
    syncRoles();
    // syncRoles reads refs only — re-running it on every render would be noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isServing]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    const pos = posFromEvent(e);
    if (!pos) return;
    if (!pointerOrderRef.current.includes(e.pointerId)) {
      pointerOrderRef.current.push(e.pointerId);
    }
    pointerPosRef.current.set(e.pointerId, pos);
    syncRoles();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointerPosRef.current.has(e.pointerId)) return;
    const pos = posFromEvent(e);
    if (!pos) return;
    pointerPosRef.current.set(e.pointerId, pos);
    if (pointerOrderRef.current[0] === e.pointerId) {
      movePaddleTo(pos.x);
      return;
    }
    if (joystickRef.current?.pointerId === e.pointerId) setAim(aimFromPos(pos));
  };

  /**
   * A lifted finger serves if it was the one aiming; a CANCELLED one never
   * does. They shared a handler before, so a pointer the system took away
   * mid-gesture — a notification shade, an edge-swipe — fired the serve.
   */
  const releasePointer = (e: React.PointerEvent<HTMLCanvasElement>, serve: boolean) => {
    const wasStick = joystickRef.current?.pointerId === e.pointerId;
    const pos = posFromEvent(e);
    const finalAim = wasStick && pos ? aimFromPos(pos) : null;
    pointerOrderRef.current = pointerOrderRef.current.filter((id) => id !== e.pointerId);
    pointerPosRef.current.delete(e.pointerId);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    syncRoles();
    // A tap with no meaningful drag serves the default way.
    if (wasStick && serve) onServe(finalAim || undefined);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => releasePointer(e, true);
  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) =>
    releasePointer(e, false);

  /**
   * Every finger is gone, and none of them served.
   *
   * CLAUDE.md §18 reads as though this file already had the abort paths
   * `useMenuSwipe` has, and it did not: only `pointerup` and `pointercancel`
   * ever removed a pointer. A pointer that goes away without either — the
   * documented Android `intent://` hand-off to another browser, the app
   * switcher, a tab change — left its id at the head of `pointerOrderRef`
   * forever. The paddle then follows a finger that is not on the glass, and
   * the next real finger down is rank 1, which makes it the JOYSTICK: the
   * paddle is dead, and the only control that answers is one that exists only
   * during a serve.
   */
  const abortPointers = () => {
    if (!pointerOrderRef.current.length && !pointerPosRef.current.size) return;
    pointerOrderRef.current = [];
    pointerPosRef.current.clear();
    syncRoles();
  };
  const abortRef = useRef(abortPointers);
  abortRef.current = abortPointers;

  useEffect(() => {
    const bail = () => {
      if (document.visibilityState !== 'visible') abortRef.current();
    };
    const gone = () => abortRef.current();
    document.addEventListener('visibilitychange', bail);
    window.addEventListener('pagehide', gone);
    return () => {
      document.removeEventListener('visibilitychange', bail);
      window.removeEventListener('pagehide', gone);
    };
  }, []);

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

      // The ball is read from a REF, not from the prop closure. App rebuilds
      // the ball object every frame (`setBall({...})`), so with `ball` in the
      // dependency array below this effect tore the whole rAF loop down and
      // re-armed it sixty times a second — which is the exact bug the note on
      // `oppPaddleXRef` above says was fixed for a different prop, with the
      // actual culprit left in. It also re-stamped `lastTime` at commit time
      // each frame, so `dt` measured commit-to-vsync rather than frame-to-frame
      // and every particle, ripple and shake decay was keyed off the wrong
      // interval.
      const ballNow = ballPropRef.current;

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
      if (settings.showTrails && ballNow.active) {
        // Record current ball position snapshot
        const now = time;
        const currentSpeed = ballNow.speedMultiplier || 1.0;

        trailRef.current.push({
          x: ballNow.x,
          y: ballNow.y,
          speed: currentSpeed,
          time: now,
          radius: ballNow.radius,
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
            ctx.lineWidth = Math.max(2, ballNow.radius * width * 1.8 * ratio);

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
            ctx.lineWidth = Math.max(1, ballNow.radius * width * 0.7 * ratio);

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

      // Draw The Ball (Only if active in player's half, and not being held for
      // a serve — the held ball is drawn on the paddle, below).
      if (ballNow.active && !isServing) {
        const ballPx = ballNow.x * width;
        const ballPy = ballNow.y * height;
        const ballPr = ballNow.radius * width;

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
        const spin = ballNow.spin || 0;
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

      // The ball waiting to be served, locked to the top centre of the paddle
      // and tracking it. This is the exact point `handleServe` launches from,
      // so the ball being aimed is the ball that leaves — nothing was drawn
      // here at all before, and the ball then appeared out of nowhere, a
      // visible distance up the court, the instant the serve fired.
      if (isServing) {
        ctx.save();
        ctx.fillStyle = theme.ballColor;
        ctx.shadowColor = theme.ballGlow;
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.arc(paddleCenterPx, SERVE_BALL_Y * height, ballNow.radius * width, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // The serve: ONE overlay, and one line saying where the ball goes.
      //
      // There were two — a joystick at the anchor (ring, deadzone circle, knob
      // and its own line) AND a separate slingshot readout from the paddle with
      // an arrowhead and a power bar pinned to the bottom of the screen. Two
      // competing pictures of a single gesture.
      // Not for a watcher: the aim overlay and its "drag to aim" prompt are
      // an instruction to somebody who cannot act on it. The ball still sits
      // on the paddle, which is what a serve LOOKS like from the other side of
      // the table.
      if (isServing && !readOnly) {
        const liveAim = aimRef.current;
        const stick = joystickRef.current;
        ctx.save();

        // The stick floats — it anchors wherever the aiming thumb lands rather
        // than sitting in a fixed corner, so either hand works and nothing has
        // to be aimed for before it exists.
        //
        // Only the UPWARD half is drawn, whichever way the thumb is dragging.
        // It shows the RESOLVED serve, not the finger: a drag below the anchor
        // is a slingshot, and drawing the half the ball actually leaves through
        // is what makes that legible rather than surprising.
        if (stick) {
          // Width units on both axes, so this is a true circle on screen and
          // the fill reaches the edge at exactly the distance that is full
          // power. An ellipse here would be a promise the ball cannot keep.
          const ax = stick.x * width;
          const ay = stick.y * width;
          const reach = AIM_FULL_PUSH * width;

          ctx.save();
          ctx.fillStyle = theme.accentColor;
          ctx.strokeStyle = theme.accentColor;

          const halfDisc = (radius: number) => {
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.arc(ax, ay, radius, Math.PI, 0);
            ctx.closePath();
          };

          // The half circle itself, and the full-power boundary it ends at.
          // Kept faint: it covers a third of the court at full reach, and the
          // court under it is the thing being aimed at.
          ctx.globalAlpha = 0.09;
          halfDisc(reach);
          ctx.fill();
          ctx.globalAlpha = 0.45;
          ctx.lineWidth = 2;
          ctx.stroke();

          // Filled from the centre toward that circumference by power.
          if (liveAim && liveAim.power > 0) {
            ctx.globalAlpha = 0.2;
            halfDisc(reach * liveAim.power);
            ctx.fill();
          }
          ctx.restore();
        }

        // A single line from the paddle, along the exact path the ball will
        // take — rule-scaled, so it stays honest when a match narrows or
        // widens what a serve is allowed to do. Its length is the power.
        if (liveAim) {
          const radians = (liveAim.angle * serveAngleLimitRef.current * Math.PI) / 180;
          const reach = height * (0.1 + 0.28 * liveAim.power);
          ctx.save();
          ctx.strokeStyle = theme.accentColor;
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.shadowColor = theme.accentColor;
          ctx.shadowBlur = 8;
          ctx.beginPath();
          ctx.moveTo(paddleCenterPx, paddleTopPx);
          ctx.lineTo(
            paddleCenterPx + Math.sin(radians) * reach,
            paddleTopPx - Math.cos(radians) * reach
          );
          ctx.stroke();
          ctx.restore();
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
    // `ball` and `aim` are deliberately ABSENT: both change identity every
    // frame and both are read through refs inside the loop. Putting either
    // back re-arms the rAF loop per frame again.
    theme,
    settings.showTrails,
    isServing,
    hasOpponent,
    showOpponentIndicator,
    showBallIndicator,
    language,
    netLabel,
    autoServeSeconds,
    serveCountdown,
    paddleWidth,
    readOnly,
  ]);

  return (
    <div
      ref={containerRef}
      id="half-court-container"
      // The serve prompt and the joystick are drawn to canvas and appear
      // nowhere else in the DOM, so this is the only place a browser suite can
      // ask whether a serve is still pending — the same reason
      // `telemetry-paddle-pos` exists. It read the prompt out of
      // `document.body.textContent`, which canvas text never reaches, so the
      // check passed whatever the app did.
      data-serving={isServing ? '1' : '0'}
      data-readonly={readOnly ? '1' : '0'}
      className={`relative w-full h-full select-none overflow-hidden touch-none flex items-center justify-center ${
        readOnly ? '' : 'cursor-grab active:cursor-grabbing'
      }`}
      style={{ backgroundColor: theme.background }}
    >
      <canvas
        ref={canvasRef}
        id="half-court-canvas"
        className="w-full h-full block touch-none"
        onPointerDown={readOnly ? undefined : handlePointerDown}
        onPointerMove={readOnly ? undefined : handlePointerMove}
        onPointerUp={readOnly ? undefined : handlePointerUp}
        // This canvas CAPTURES on pointerdown (it is a `touch-none` surface
        // with no competing scroller and no inner button), so losing that
        // capture means the pointer has genuinely been taken away. Treated
        // exactly like a cancel: the finger is gone and it did not serve.
        onLostPointerCapture={readOnly ? undefined : handlePointerCancel}
        onPointerCancel={readOnly ? undefined : handlePointerCancel}
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
