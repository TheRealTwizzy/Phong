import React from 'react';
import { LanguageCode } from '../../types';
import { Tier, PLACEMENT_GAMES, isPlaced, tierProgress } from '../../rating';
import { t } from '../../i18n/translations';
import { TierBadge } from '../TierBadge';

// The ladder, made into something you can see the next rung of.
//
// `tierProgress()` has been sitting in rating.ts documented "for a badge
// progress ring" and called from nowhere. This is the ring.
//
// Two states, because one number cannot honestly serve both:
//   placed   — an arc showing how far through the current tier you are
//   unplaced — a segmented meter of ranked games toward PLACEMENT_GAMES
// tierProgress(25) returns a meaningless mid-band value for someone with zero
// ranked games, so showing the arc before placement would be a lie. The
// placement count is also the promise the Profile modal already makes.
//
// HARD RULE: rankMu enters tierProgress() and reaches a stroke-dashoffset.
// It never becomes text, and there is no numeric aria-label. The suites regex
// the whole document body for a raw rating, and rightly so.

const SIZE = { chip: 0, hero: 72 } as const;

export interface RankBadgeProps {
  tier: Tier;
  rankMu: number;
  rankedGames: number;
  rankSigma: number;
  size?: keyof typeof SIZE;
  language?: LanguageCode;
  id?: string;
}

const RING = 72;
const STROKE = 5;
const R = (RING - STROKE) / 2;
const C = 2 * Math.PI * R;

export const RankBadge: React.FC<RankBadgeProps> = ({
  tier,
  rankMu,
  rankedGames,
  rankSigma,
  size = 'chip',
  language = 'en',
  id,
}) => {
  // `chip` is exactly the old badge, unchanged — #tier-badge-{tier} lives here.
  if (size === 'chip') return <TierBadge tier={tier} language={language} />;

  const placed = isPlaced(rankedGames, rankSigma);
  const played = Math.min(rankedGames, PLACEMENT_GAMES);
  const progress = placed ? tierProgress(rankMu) : played / PLACEMENT_GAMES;

  return (
    <div id={id} className="flex shrink-0 flex-col items-center gap-1">
      <div className="relative" style={{ width: RING, height: RING }}>
        <svg width={RING} height={RING} className="-rotate-90" aria-hidden="true">
          <circle
            cx={RING / 2}
            cy={RING / 2}
            r={R}
            fill="none"
            strokeWidth={STROKE}
            className="stroke-surface-3"
          />
          <circle
            cx={RING / 2}
            cy={RING / 2}
            r={R}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - progress)}
            className={placed ? 'stroke-accent' : 'stroke-warn'}
            style={{ transition: 'stroke-dashoffset var(--tw-duration, 420ms) ease-out' }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <TierBadge tier={tier} language={language} />
        </div>
      </div>

      {!placed && (
        <span className="text-2xs tnum text-warn">
          {t('placement_progress', language, {
            played: String(played),
            total: String(PLACEMENT_GAMES),
          })}
        </span>
      )}
    </div>
  );
};
