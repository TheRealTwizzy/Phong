import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { ThemeConfig } from '../game/themes';
import { LanguageCode } from '../types';
import { t } from '../i18n/translations';
import { sound } from '../audio/soundEffects';
import { Sheet, Button } from './ui';
import {
  X,
  BookOpen,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Sparkles,
  Smartphone,
  Radio,
  Gamepad2,
  Activity,
} from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  theme: ThemeConfig;
  language?: LanguageCode;
  onCompleteTutorial?: () => void;
}

export const TutorialModal: React.FC<Props> = ({
  isOpen,
  onClose,
  theme,
  language = 'en',
  onCompleteTutorial,
}) => {
  const [step, setStep] = useState(0);
  const [practicePaddleX, setPracticePaddleX] = useState(0.5);
  const [practiceBall, setPracticeBall] = useState({ x: 0.5, y: 0.2, vx: 0.008, vy: 0.012 });
  const [hits, setHits] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Reset step when opened
  useEffect(() => {
    if (isOpen) {
      setStep(0);
      setHits(0);
    }
  }, [isOpen]);

  // Mini-interactive practice court in Step 2 (Controls & Spin)
  useEffect(() => {
    if (!isOpen || step !== 1) return;
    let animId: number;

    const loop = () => {
      setPracticeBall((prev) => {
        let nx = prev.x + prev.vx;
        let ny = prev.y + prev.vy;
        let nvx = prev.vx;
        let nvy = prev.vy;

        // Side walls
        if (nx <= 0.05 || nx >= 0.95) {
          nvx = -nvx;
          nx = Math.max(0.05, Math.min(0.95, nx));
          sound.playWallBounce();
        }

        // Top net
        if (ny <= 0.05) {
          nvy = Math.abs(nvy);
          sound.playNetWhoosh();
        }

        // Bottom paddle
        if (ny >= 0.88 && prev.y < 0.88) {
          const paddleWidth = 0.28;
          if (Math.abs(nx - practicePaddleX) <= paddleWidth / 2 + 0.04) {
            nvy = -Math.abs(nvy);
            const offset = (nx - practicePaddleX) / (paddleWidth / 2);
            nvx = offset * 0.014;
            setHits((h) => h + 1);
            sound.playPaddleHit(1.2);
          }
        }

        // Missed bottom baseline -> reset to top serve
        if (ny >= 0.98) {
          ny = 0.1;
          nx = 0.5;
          nvy = 0.012;
          nvx = (Math.random() - 0.5) * 0.01;
        }

        return { x: nx, y: ny, vx: nvx, vy: nvy };
      });

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [isOpen, step, practicePaddleX]);


  const totalSteps = 4;

  const handleNext = () => {
    if (step < totalSteps - 1) {
      sound.playWallBounce();
      setStep(step + 1);
    } else {
      sound.playScore(true);
      onCompleteTutorial?.();
      onClose();
    }
  };

  const handlePrev = () => {
    if (step > 0) {
      sound.playWallBounce();
      setStep(step - 1);
    }
  };

  const header = (
    <div className="shrink-0 flex items-center justify-between gap-2 border-b border-line bg-surface-1 p-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-ctl border border-accent/40 bg-accent/20 text-accent">
          <BookOpen className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <h2 className="text-title truncate">{t('tutorial_title', language)}</h2>
          <div className="text-2xs tnum font-normal tracking-normal text-ink-muted">
            Step {step + 1} of {totalSteps}
          </div>
        </div>
      </div>

      <button
        id="btn-close-tutorial"
        onClick={onClose}
        aria-label="Close tutorial"
        className="shrink-0 rounded-ctl p-2 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );

  const footer = (
    <>
      <div className="flex flex-1 items-center gap-1.5">
        {Array.from({ length: totalSteps }).map((_, idx) => (
          <button
            key={idx}
            onClick={() => setStep(idx)}
            aria-label={`Step ${idx + 1}`}
            className={`h-2 rounded-chip transition-all ${
              idx === step ? 'w-6 bg-accent' : 'w-2 bg-surface-4 hover:bg-line-strong'
            }`}
          />
        ))}
      </div>

      {step > 0 && (
        <Button
          id="btn-tutorial-prev"
          size="sm"
          variant="secondary"
          icon={<ArrowLeft className="h-3.5 w-3.5" />}
          onClick={handlePrev}
        >
          {t('tutorial_prev', language)}
        </Button>
      )}
      <Button
        id="btn-tutorial-next"
        size="sm"
        variant="primary"
        iconRight={
          step === totalSteps - 1 ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <ArrowRight className="h-4 w-4" />
          )
        }
        onClick={handleNext}
      >
        {step === totalSteps - 1 ? t('tutorial_finish', language) : t('tutorial_next', language)}
      </Button>
    </>
  );

  return (
    <Sheet
      cardId="tutorial-modal-container"
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      accent="accent"
      header={header}
      footer={footer}
      bodyClassName="scroll-y p-5 space-y-4"
    >
            {/* Step 1: Half Court Concept */}
            {step === 0 && (
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="space-y-4 text-center"
              >
                {/* Visual Half-Court Diagram */}
                <div className="relative mx-auto w-48 h-48 rounded-2xl border-2 overflow-hidden bg-slate-950 flex flex-col" style={{ borderColor: theme.courtBorder }}>
                  {/* Opponent Half (Clouded) */}
                  <div className="flex-1 bg-slate-900/90 border-b-2 border-dashed border-cyan-400 flex flex-col items-center justify-center p-2 relative">
                    <span className="text-[10px] font-mono text-cyan-300 font-black uppercase tracking-wider">
                      Opponent's Half
                    </span>
                    <span className="text-[9px] text-slate-400 font-sans mt-0.5">(Invisible / In Radar)</span>
                    {/* Ghost ball */}
                    <div className="w-3 h-3 rounded-full bg-pink-500/80 shadow-md shadow-pink-500/50 absolute top-4 left-1/3 animate-bounce" />
                  </div>

                  {/* Net line glow */}
                  <div className="h-1 w-full bg-cyan-400 shadow-md shadow-cyan-400/80" />

                  {/* Player's Half (Visible) */}
                  <div className="flex-1 bg-slate-950 flex flex-col items-center justify-end p-2 relative">
                    <div className="w-3.5 h-3.5 rounded-full bg-white shadow-lg shadow-cyan-400 absolute top-3 left-1/2 -translate-x-1/2" />
                    {/* Player paddle */}
                    <div className="w-16 h-2 rounded-full bg-cyan-400 shadow-md shadow-cyan-400/80 mb-1" />
                    <span className="text-[10px] font-mono text-emerald-400 font-bold">Your Screen</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <h3 className="text-lg font-black text-white flex items-center justify-center gap-2">
                    <Sparkles className="w-4 h-4 text-cyan-400" />
                    {t('tutorial_step1_title', language)}
                  </h3>
                  <p className="text-xs sm:text-sm text-slate-300 leading-relaxed max-w-sm mx-auto">
                    {t('tutorial_step1_desc', language)}
                  </p>
                </div>
              </motion.div>
            )}

            {/* Step 2: Controls & Spin Practice */}
            {step === 1 && (
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="space-y-3 text-center"
              >
                <div className="space-y-1">
                  <h3 className="text-lg font-black text-white flex items-center justify-center gap-2">
                    <Gamepad2 className="w-4 h-4 text-emerald-400" />
                    {t('tutorial_step2_title', language)}
                  </h3>
                  <p className="text-xs text-slate-300 max-w-sm mx-auto">
                    {t('tutorial_step2_desc', language)}
                  </p>
                </div>

                {/* Mini Practice Canvas Container */}
                <div className="relative mx-auto w-full max-w-xs h-40 rounded-2xl border bg-slate-950 overflow-hidden select-none touch-none" style={{ borderColor: theme.courtBorder + '60' }}>
                  {/* Top net */}
                  <div className="absolute top-2 left-0 right-0 h-0.5 border-t border-dashed border-cyan-400" />
                  <div className="absolute top-3 left-1/2 -translate-x-1/2 text-[8px] font-mono text-cyan-400/80">NET LINE</div>

                  {/* Practice Ball */}
                  <div
                    className="absolute w-3 h-3 rounded-full bg-white shadow-md shadow-cyan-400 transition-all duration-75 -translate-x-1/2 -translate-y-1/2"
                    style={{
                      left: `${practiceBall.x * 100}%`,
                      top: `${practiceBall.y * 100}%`,
                    }}
                  />

                  {/* Practice Paddle */}
                  <div
                    className="absolute bottom-3 h-2 rounded-full bg-cyan-400 shadow-md shadow-cyan-400 transition-all duration-75 -translate-x-1/2"
                    style={{
                      width: '28%',
                      left: `${practicePaddleX * 100}%`,
                    }}
                  />

                  {/* Interactive Slider Bar */}
                  <div className="absolute bottom-0 left-0 right-0 p-1 bg-slate-900/90 border-t border-slate-800 flex items-center justify-between px-3">
                    <span className="text-[9px] font-mono text-slate-400">Practice Volleys: <strong className="text-white">{hits}</strong></span>
                    <input
                      type="range"
                      min="0.15"
                      max="0.85"
                      step="0.01"
                      value={practicePaddleX}
                      onChange={(e) => setPracticePaddleX(parseFloat(e.target.value))}
                      className="w-32 accent-cyan-400 h-1 bg-slate-700 rounded-lg cursor-pointer"
                    />
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 block">
                  👉 Slide your thumb / use range slider to practice return volleys
                </span>
              </motion.div>
            )}

            {/* Step 3: Sonar & Radar */}
            {step === 2 && (
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="space-y-4 text-center"
              >
                {/* Sonar preview card */}
                <div className="relative mx-auto w-48 p-3 rounded-2xl border bg-slate-950 flex flex-col items-center gap-2" style={{ borderColor: theme.accentColor + '60' }}>
                  <div className="flex items-center gap-1 text-[10px] font-mono text-cyan-400">
                    <Radio className="w-3.5 h-3.5 animate-pulse text-cyan-400" />
                    <span>OPPONENT SONAR</span>
                  </div>

                  <div className="w-36 h-28 rounded-xl border border-slate-700 bg-slate-900 relative overflow-hidden">
                    {/* Net at bottom of radar */}
                    <div className="absolute bottom-0 left-0 right-0 h-1 border-t border-dashed border-cyan-400" />

                    {/* Opponent paddle */}
                    <div className="absolute top-2 left-1/4 w-10 h-1.5 rounded-full bg-rose-500 shadow-sm shadow-rose-500" />

                    {/* Ball in radar */}
                    <div className="absolute top-1/2 left-1/3 w-2.5 h-2.5 rounded-full bg-white shadow-md shadow-cyan-400 animate-pulse" />

                    <div className="absolute bottom-1 left-2 text-[8px] font-mono text-emerald-400">
                      ← Left Entry
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <h3 className="text-lg font-black text-white flex items-center justify-center gap-2">
                    <Radio className="w-4 h-4 text-cyan-400" />
                    {t('tutorial_step3_title', language)}
                  </h3>
                  <p className="text-xs sm:text-sm text-slate-300 leading-relaxed max-w-sm mx-auto">
                    {t('tutorial_step3_desc', language)}
                  </p>
                </div>
              </motion.div>
            )}

            {/* Step 4: 2-Phone Duel */}
            {step === 3 && (
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="space-y-4 text-center"
              >
                {/* 2 Phones Diagram */}
                <div className="flex items-center justify-center gap-3">
                  <div className="w-20 h-28 rounded-xl border-2 border-cyan-400 bg-slate-950 p-1.5 flex flex-col justify-between shadow-lg shadow-cyan-500/20">
                    <div className="w-full h-1 bg-cyan-400/80 rounded-full" />
                    <span className="text-[9px] font-mono text-cyan-300 font-bold">Phone 1</span>
                    <div className="w-8 h-1.5 bg-cyan-400 rounded-full mx-auto" />
                  </div>

                  <div className="flex flex-col items-center">
                    <span className="text-xs font-mono font-bold text-amber-400">NET</span>
                    <div className="w-6 h-0.5 border-t-2 border-dashed border-amber-400 my-1" />
                    <span className="text-[10px] text-slate-400">4-Letter Code</span>
                  </div>

                  <div className="w-20 h-28 rounded-xl border-2 border-pink-500 bg-slate-950 p-1.5 flex flex-col justify-between shadow-lg shadow-pink-500/20 rotate-180">
                    <div className="w-full h-1 bg-pink-500/80 rounded-full" />
                    <span className="text-[9px] font-mono text-pink-300 font-bold rotate-180">Phone 2</span>
                    <div className="w-8 h-1.5 bg-pink-500 rounded-full mx-auto" />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <h3 className="text-lg font-black text-white flex items-center justify-center gap-2">
                    <Smartphone className="w-4 h-4 text-amber-400" />
                    {t('tutorial_step4_title', language)}
                  </h3>
                  <p className="text-xs sm:text-sm text-slate-300 leading-relaxed max-w-sm mx-auto">
                    {t('tutorial_step4_desc', language)}
                  </p>
                </div>
              </motion.div>
            )}
    </Sheet>
  );
};
