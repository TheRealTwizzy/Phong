import React, { useState, useEffect, useMemo } from 'react';
import { BallState, LanguageCode } from '../types';
import { t } from '../i18n/translations';
import { Cosmetic } from '../game/cosmetics';
import {
  Activity,
  Gauge,
  Zap,
  Flame,
  Clock,
  Compass,
  ChevronDown,
  ChevronUp,
  X,
  Radio,
} from 'lucide-react';

interface StatsOverlayProps {
  ball: BallState;
  paddleX: number;
  totalTouches: number;
  streak: number;
  bestStreak: number;
  oppStreak: number;
  oppBestStreak: number;
  theme: Cosmetic;
  isVisible: boolean;
  onToggleVisible: () => void;
  matchStartTime: number | null;
  language: LanguageCode;
}

export const StatsOverlay: React.FC<StatsOverlayProps> = ({
  ball,
  paddleX,
  totalTouches,
  streak,
  bestStreak,
  oppStreak,
  oppBestStreak,
  theme,
  isVisible,
  onToggleVisible,
  matchStartTime,
  language,
}) => {
  const [isMinimized, setIsMinimized] = useState<boolean>(false);
  const [topSpeed, setTopSpeed] = useState<number>(0);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  // Calculate instantaneous speed
  const currentSpeed = useMemo(() => {
    if (!ball.active) return 0;
    const rawSpeed = Math.hypot(ball.vx, ball.vy);
    // Convert to realistic arcade pong km/h (base speed ~ 60 km/h)
    return Math.round(rawSpeed * 95);
  }, [ball.vx, ball.vy, ball.active]);

  // Track session top speed
  useEffect(() => {
    if (currentSpeed > topSpeed) {
      setTopSpeed(currentSpeed);
    }
  }, [currentSpeed, topSpeed]);

  // Match stopwatch
  useEffect(() => {
    if (!matchStartTime) {
      setElapsedSeconds(0);
      return;
    }
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - matchStartTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [matchStartTime]);

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // Trajectory angle in degrees
  const angleDeg = useMemo(() => {
    if (!ball.active || (ball.vx === 0 && ball.vy === 0)) return 0;
    const rad = Math.atan2(ball.vx, -ball.vy);
    return Math.round((rad * 180) / Math.PI);
  }, [ball.vx, ball.vy, ball.active]);

  if (!isVisible) {
    return (
      <button
        id="btn-show-stats-overlay"
        onClick={onToggleVisible}
        title={t('telemetry_show', language)}
        className="absolute top-14 left-3 z-30 flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-slate-900/80 hover:bg-slate-800 border border-slate-700/80 text-cyan-400 font-mono text-[11px] backdrop-blur-md transition-all active:scale-95 shadow-md"
      >
        <Activity className="w-3.5 h-3.5" />
      </button>
    );
  }

  return (
    <div
      id="court-stats-overlay"
      className="absolute top-14 left-3 z-30 w-52 rounded-2xl border backdrop-blur-lg shadow-2xl transition-all font-mono select-none overflow-hidden"
      style={{
        backgroundColor: 'rgba(10, 15, 29, 0.88)',
        borderColor: theme.accentColor + '40',
        boxShadow: `0 0 20px ${theme.accentColor}25`,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-950/60 border-b border-slate-800/80">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
          <span className="text-[11px] font-black tracking-wider text-cyan-300 flex items-center gap-1">
            <Activity className="w-3.5 h-3.5" />
            {t('telemetry_title', language)}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsMinimized(!isMinimized)}
            className="p-0.5 text-slate-400 hover:text-white rounded"
            title={t(isMinimized ? 'telemetry_expand' : 'telemetry_minimize', language)}
          >
            {isMinimized ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={onToggleVisible}
            className="p-0.5 text-slate-400 hover:text-white rounded"
            title={t('telemetry_close', language)}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!isMinimized && (
        <div className="p-2.5 space-y-2 text-[11px]">
          {/* Live Ball Speed Gauge */}
          <div className="bg-slate-900/90 rounded-xl p-2 border border-slate-800">
            <div className="flex justify-between items-center text-[10px] text-slate-400 mb-1">
              <span className="flex items-center gap-1">
                <Gauge className="w-3 h-3 text-cyan-400" />
                {t('telemetry_velocity', language)}
              </span>
              <span className="text-slate-500">
                {t('telemetry_peak', language)}: {topSpeed} km/h
              </span>
            </div>

            <div className="flex items-baseline justify-between">
              <span className="text-lg font-black text-white leading-none">
                {ball.active ? currentSpeed : 0}{' '}
                <span className="text-[10px] font-normal text-cyan-400">km/h</span>
              </span>
              <span className="text-[10px] font-bold text-amber-400">
                {ball.active ? (ball.speedMultiplier || 1).toFixed(1) : '1.0'}x{' '}
                {t('telemetry_base', language)}
              </span>
            </div>

            {/* Speed Bar */}
            <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mt-1.5">
              <div
                className="h-full bg-gradient-to-r from-cyan-400 via-amber-400 to-rose-500 rounded-full transition-all duration-100"
                style={{ width: `${Math.min(100, ((ball.active ? currentSpeed : 0) / 160) * 100)}%` }}
              />
            </div>
          </div>

          {/* Grid Stats: Total Touches & Match Timer */}
          <div className="grid grid-cols-2 gap-1.5">
            {/* Total Touches */}
            <div className="bg-slate-900/90 rounded-xl p-2 border border-slate-800 flex flex-col">
              <span className="text-[9px] text-slate-400 flex items-center gap-1">
                <Zap className="w-2.5 h-2.5 text-amber-400" />
                {t('telemetry_touches', language)}
              </span>
              <span className="text-sm font-black text-amber-300 mt-0.5">{totalTouches}</span>
            </div>

            {/* Match Clock */}
            <div className="bg-slate-900/90 rounded-xl p-2 border border-slate-800 flex flex-col">
              <span className="text-[9px] text-slate-400 flex items-center gap-1">
                <Clock className="w-2.5 h-2.5 text-indigo-400" />
                {t('telemetry_time', language)}
              </span>
              <span className="text-sm font-black text-indigo-300 mt-0.5">
                {formatTime(elapsedSeconds)}
              </span>
            </div>
          </div>

          {/* Rally & Trajectory Angle */}
          <div className="grid grid-cols-2 gap-1.5">
            <div className="bg-slate-900/90 rounded-xl p-2 border border-slate-800 flex flex-col">
              <span className="text-[9px] text-slate-400 flex items-center gap-1">
                <Flame className="w-2.5 h-2.5 text-orange-400" />
                {t('telemetry_rally_max', language)}
              </span>
              {/* Two streaks, side by side and never mixed: yours and theirs.
                  A streak counts one player's own consecutive returns, so
                  putting them in one number — which is what this used to be —
                  told you neither. */}
              <span className="text-xs font-bold text-slate-200 mt-0.5">
                <span id="telemetry-my-streak" className="text-orange-400 font-black">
                  {streak}
                </span>
                {' / '}
                <span id="telemetry-my-best">{bestStreak}</span>
                <span className="text-slate-500">
                  {' · '}
                  <span id="telemetry-opp-streak">{oppStreak}</span>
                  {' / '}
                  <span id="telemetry-opp-best">{oppBestStreak}</span>
                </span>
              </span>
            </div>

            <div className="bg-slate-900/90 rounded-xl p-2 border border-slate-800 flex flex-col">
              <span className="text-[9px] text-slate-400 flex items-center gap-1">
                <Compass className="w-2.5 h-2.5 text-emerald-400" />
                {t('telemetry_deflection', language)}
              </span>
              <span className="text-xs font-bold text-emerald-300 mt-0.5">
                {angleDeg > 0 ? `+${angleDeg}` : angleDeg}°
              </span>
            </div>
          </div>

          {/* Paddle Pos Indicator */}
          <div className="px-2 py-1 rounded-lg bg-slate-950/60 border border-slate-800/80 flex items-center justify-between text-[10px] text-slate-400">
            <span>
              {t('telemetry_paddle_pos', language)}:{' '}
              {/* The paddle is drawn to canvas and appears nowhere else in the
                  DOM, so this readout is the only place a browser suite can
                  ask where it is without sampling pixels. */}
              <span id="telemetry-paddle-pos">{Math.round(paddleX * 100)}</span>%
            </span>
            <span className="text-cyan-400 font-semibold">{t(ball.active ? 'telemetry_in_court' : 'telemetry_in_flight', language)}</span>
          </div>
        </div>
      )}
    </div>
  );
};
