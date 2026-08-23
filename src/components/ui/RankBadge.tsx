import React from 'react';
import { LanguageCode } from '../../types';
import { Tier, PLACEMENT_GAMES, TIER_STYLE, isPlaced, tierProgress } from '../../rating';
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
// A round cap draws a blob of its own width at each end, so an arc shorter than
// the cap is ALL cap: at a tier floor the meter rendered as a detached cyan dot
// beside the badge with no ring to explain it, which is what it was reported as.
const MIN_ARC = STROKE * 1.6;

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
    <div id={id} className="flex shrink-0 flex-col items-center gap-1.5">
      <div className="relative shrink-0" style={{ width: RING, height: RING }}>
        <svg width={RING} height={RING} className="-rotate-90" aria-hidden="true">
          {/* The track is NOT stroke-surface-3: this renders inside
              <Panel variant="raised">, which IS bg-surface-3. The track was the
              same colour as the card behind it, so the meter had no ring at all
              — just an accent arc floating in space beside the badge. */}
          <circle
            cx={RING / 2}
            cy={RING / 2}
            r={R}
            fill="none"
            strokeWidth={STROKE}
            className="stroke-line"
          />
          {C * progress >= MIN_ARC && (
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
          )}
        </svg>
        {/* The rank's COLOUR goes inside the ring; its NAME goes below.
            The chip is text, and at eleven characters ("GRANDMASTER") it is
            half again as wide as the 72px ring — centring it inside meant the
            meter was drawn straight through the label, and the label itself
            overflowed the card. Nothing inside the ring can be wider than it. */}
        <div
          className={`absolute inset-[13px] rounded-full border ${TIER_STYLE[tier]}`}
          aria-hidden="true"
        />
      </div>

      <TierBadge tier={tier} language={language} />

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
