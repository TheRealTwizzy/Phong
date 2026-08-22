import React, { useEffect, useRef } from 'react';
import { BallState } from '../types';
import { ThemeConfig } from '../game/themes';
import { LanguageCode } from '../types';
import { t } from '../i18n/translations';
import { Radio } from 'lucide-react';

// The sonar draws itself: a requestAnimationFrame loop reads the game's OWN
// refs and writes styles straight onto the DOM. It used to be fed through
// React state with a 75ms CSS transition on every dot — while the player
// dragged their paddle, pointer events flooded the render loop and the sonar
// visibly trailed the ball it was supposed to be tracking. Refs + direct
// style writes cost one render total and are frame-accurate under any load.
//
// Visibility is part of the same frame loop: the sonar exists to show the
// half you CANNOT see, so it fades out the moment the ball enters the
// player's view and returns when the ball is back on the opponent's half.

interface RadarPreviewProps {
  oppBallRef: React.MutableRefObject<BallState | null>;
  oppPaddleXRef: React.MutableRefObject<number>;
  paddleWidthRatio: number;
  theme: ThemeConfig;
  active: boolean;
  /** Tailwind top-* class. A duel passes a lower slot: the P2P/RELAY link
      badge owns the top-right corner there, and the two never coexisted
      before the sonar worked in PvP. */
  topClass?: string;
  language: LanguageCode;
}

export const RadarPreview: React.FC<RadarPreviewProps> = ({
  language,
  oppBallRef,
  oppPaddleXRef,
  paddleWidthRatio,
  theme,
  active,
  topClass = 'top-14',
}) => {
  const boxEl = useRef<HTMLDivElement>(null);
  const ballEl = useRef<HTMLDivElement>(null);
  const paddleEl = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      const ob = oppBallRef.current;
      const ballOnOpponentHalf = !!(ob && ob.active);
      if (boxEl.current) {
        boxEl.current.style.opacity = ballOnOpponentHalf ? '1' : '0';
      }
      if (ballOnOpponentHalf && ballEl.current && ob) {
        // Mirrored into the player's perspective: a ball that left on the
        // left reads on the left. y=0 is the net (bottom of the mini court).
        ballEl.current.style.left = `${(1 - ob.x) * 100}%`;
        ballEl.current.style.top = `${(1 - ob.y) * 100}%`;
      }
      if (paddleEl.current) {
        const px = oppPaddleXRef.current ?? 0.5;
        const leftPct = Math.max(
          0,
          Math.min(100 - paddleWidthRatio * 100, ((1 - px) - paddleWidthRatio / 2) * 100)
        );
        paddleEl.current.style.left = `${leftPct}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, paddleWidthRatio, oppBallRef, oppPaddleXRef]);

  if (!active) return null;

  return (
    <div
      id="radar-preview-container"
      ref={boxEl}
      className={`absolute ${topClass} right-3 z-20 flex flex-col items-center p-2 rounded-xl backdrop-blur-md border shadow-lg pointer-events-none`}
      style={{
        backgroundColor: 'rgba(10, 15, 25, 0.75)',
        borderColor: theme.accentColor + '40',
        // Starts hidden; the frame loop fades it in when the ball is on the
        // opponent's half. Opacity only — position updates must never tween.
        opacity: 0,
        transition: 'opacity 180ms ease-out',
      }}
    >
      <div
        className="flex items-center gap-1 mb-1 text-[10px] font-mono tracking-wider opacity-80"
        style={{ color: theme.accentColor }}
      >
        <Radio className="w-3 h-3 animate-pulse" />
        <span>{t('sonar_label', language)}</span>
      </div>

      {/* Mini opponent court: their baseline at the top, the net at the bottom */}
      <div
        className="relative w-24 h-32 rounded-lg border overflow-hidden"
        style={{
          backgroundColor: theme.courtColor,
          borderColor: theme.courtBorder + '30',
        }}
      >
        <div
          className="absolute bottom-0 left-0 right-0 h-1 border-t-2 border-dashed"
          style={{ borderColor: theme.netLineColor }}
        />

        <div
          id="radar-opp-paddle"
          ref={paddleEl}
          className="absolute top-2 h-1.5 rounded-full shadow-sm"
          style={{
            width: `${paddleWidthRatio * 100}%`,
            backgroundColor: theme.opponentPaddleColor,
            boxShadow: `0 0 6px ${theme.opponentPaddleGlow}`,
          }}
        />

        <div
          id="radar-opp-ball"
          ref={ballEl}
          className="absolute w-2.5 h-2.5 rounded-full -translate-x-1/2 -translate-y-1/2 shadow-sm"
          style={{
            backgroundColor: theme.ballColor,
            boxShadow: `0 0 8px ${theme.ballGlow}`,
          }}
        />
      </div>
    </div>
  );
};
