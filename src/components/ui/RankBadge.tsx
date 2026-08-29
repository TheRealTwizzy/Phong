import React from 'react';
import { LanguageCode } from '../../types';
import { Tier, PLACEMENT_GAMES, isPlaced, tierProgress } from '../../rating';
import { TierBadge } from '../TierBadge';
import { ProgressBar } from './ProgressBar';

// The ladder, made into something you can see the next rung of.
//
// `tierProgress()` had been sitting in rating.ts documented "for a badge
// progress ring" and called from nowhere. This is that meter.
//
// Two states, because one number cannot honestly serve both:
//   placed   — how far through the current tier you are
//   unplaced — a count of ranked games toward PLACEMENT_GAMES
// tierProgress(25) returns a meaningless mid-band value for someone with zero
// ranked games, so showing tier progress before placement would be a lie. The
// placement count is also the promise the Profile modal already makes.
//
// It was a 72px SVG ring and is now a horizontal bar, for two reasons beyond
// the space it gave back to the PLAY page. The ring's arc was a hand-rolled
// `transition: stroke-dashoffset`, which bypassed useMotion() and made this the
// one meter in the app that ignored prefers-reduced-motion; and a round line
// cap draws a blob of its own width at each end, so an arc shorter than the cap
// was ALL cap — at a tier floor the meter rendered as a detached cyan dot
// beside the badge with no ring to explain it, which is what it was reported
// as. A scaleX fill has no cap and renders a floor value as a hairline, so that
// whole class of bug does not survive the change. Do not put the ring back
// without solving both again.
//
// HARD RULE: rankMu enters tierProgress() and reaches a transform. It never
// becomes text, and there is no numeric aria-label — which is now enforced by
// omission, since ProgressBar emits role/aria-valuenow only when given an
// ariaLabel and this passes none. The suites regex the whole document body for
// a raw rating, and rightly so. The tier is spoken by the TierBadge beside it.

export interface RankBadgeProps {
  tier: Tier;
  rankMu: number;
  rankedGames: number;
  rankSigma: number;
  size?: 'chip' | 'bar';
  language?: LanguageCode;
  id?: string;
  className?: string;
}

export const RankBadge: React.FC<RankBadgeProps> = ({
  tier,
  rankMu,
  rankedGames,
  rankSigma,
  size = 'chip',
  language = 'en',
  id,
  className = '',
}) => {
  // `chip` is exactly the old badge, unchanged — #tier-badge-{tier} lives here.
  if (size === 'chip') return <TierBadge tier={tier} language={language} className={className} />;

  const placed = isPlaced(rankedGames, rankSigma);
  const played = Math.min(rankedGames, PLACEMENT_GAMES);
  const progress = placed ? tierProgress(rankMu) : played / PLACEMENT_GAMES;

  return (
    <ProgressBar
      id={id}
      value={progress}
      height="sm"
      tone={placed ? 'accent' : 'warn'}
      className={className}
      // The BAND, so a promotion starts the new tier empty instead of sliding
      // backwards out of the old one. Placement is a band of its own: the meter
      // counts 1/5 to 5/5 across a session and resumes mid-count.
      resumeKey={`rank:${placed ? tier : 'placement'}`}
    />
  );
};
