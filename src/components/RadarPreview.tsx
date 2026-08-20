import React from 'react';
import { BallState } from '../types';
import { THEMES, ThemeConfig } from '../game/themes';
import { Radio } from 'lucide-react';

interface RadarPreviewProps {
  oppBall: BallState | null;
  oppPaddleX: number;
  paddleWidthRatio: number;
  theme: ThemeConfig;
  active: boolean;
}

export const RadarPreview: React.FC<RadarPreviewProps> = ({
  oppBall,
  oppPaddleX,
  paddleWidthRatio,
  theme,
  active,
}) => {
  if (!active) return null;

  return (
    <div
      id="radar-preview-container"
      className="absolute top-14 right-3 z-20 flex flex-col items-center p-2 rounded-xl backdrop-blur-md border shadow-lg transition-all duration-300 pointer-events-none"
      style={{
        backgroundColor: 'rgba(10, 15, 25, 0.75)',
        borderColor: theme.accentColor + '40',
      }}
    >
      <div className="flex items-center gap-1 mb-1 text-[10px] font-mono tracking-wider opacity-80" style={{ color: theme.accentColor }}>
        <Radio className="w-3 h-3 animate-pulse" />
        <span>OPPONENT SONAR</span>
      </div>

      {/* Mini Opponent Court (Opponent's baseline is at top of mini court, Net is at bottom) */}
      <div
        className="relative w-24 h-32 rounded-lg border overflow-hidden"
        style={{
          backgroundColor: theme.courtColor,
          borderColor: theme.courtBorder + '30',
        }}
      >
        {/* Net line at bottom of radar (facing player's net) */}
        <div
          className="absolute bottom-0 left-0 right-0 h-1 border-t-2 border-dashed"
          style={{ borderColor: theme.netLineColor }}
        />

        {/* Opponent's Paddle at the far end of their court */}
        <div
          className="absolute top-2 h-1.5 rounded-full transition-all duration-75 shadow-sm"
          style={{
            width: `${paddleWidthRatio * 100}%`,
            left: `${Math.max(0, Math.min(100 - paddleWidthRatio * 100, ((1 - oppPaddleX) - paddleWidthRatio / 2) * 100))}%`,
            backgroundColor: theme.opponentPaddleColor,
            boxShadow: `0 0 6px ${theme.opponentPaddleGlow}`,
          }}
        />

        {/* Ball inside Opponent's Court */}
        {oppBall && oppBall.active && (
          <div
            className="absolute w-2.5 h-2.5 rounded-full -translate-x-1/2 -translate-y-1/2 transition-all duration-75 shadow-sm"
            style={{
              // Aligned with player court perspective: left exit on board appears on left side of sonar
              left: `${(1 - oppBall.x) * 100}%`,
              // In opponent's view, y=0 is net (bottom of radar), y=1 is baseline (top of radar)
              top: `${(1 - oppBall.y) * 100}%`,
              backgroundColor: theme.ballColor,
              boxShadow: `0 0 8px ${theme.ballGlow}`,
            }}
          />
        )}

        {/* Status text */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          {(!oppBall || !oppBall.active) && (
            <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-tighter">
              Ball in your court
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
