import React from 'react';
import { LanguageCode } from '../../types';
import { Tier, PLACEMENT_GAMES, isPlaced, tierProgress } from '../../rating';
import { t } from '../../i18n/translations';
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
// becomes text, and it never reaches an aria-label either — ProgressBar emits
// role/aria-valuenow only when given one, so the PLACED meter passes none and
// is decorative by construction. The suites regex the whole document body for
// a raw rating, and rightly so. The tier is spoken by the TierBadge beside it.
//
// The UNPLACED meter is the opposite case and needs the opposite treatment.
// Its value is a count of games played, not a rating, and the visible
// "Placement 2/5" line that used to sit under the ring went with the ring — so
// without a label a screen reader heard "Unranked" and nothing else, with no
// way to learn how many placement games were left. It gets the localized
// string it lost, which announces `played/total` as a percentage of five
// games. Reading a rating out of that is not possible; reading one out of tier
// progress would be.
//
// Both states share one TONE, and the unplaced one used to be `warn`. In the
// header capsule this meter stacks directly on the XP meter, and --color-warn
// and --color-xp are two shades of the same amber in BOTH status ramps —
// 0.044 apart in OKLab on nineteen cosmetics and 0.034 on the light one, where
// tests/cosmetics.test.ts requires 0.08 of two whole themes. Worse than the
// number: --color-xp is the token contract's level-and-XP colour and the LV
// chip on the row above wears it too, so an amber rank meter read as a second
// XP bar rather than as a different measurement. `warn` was carrying "this
// does not count yet" alone when it was chosen; the UNRANKED chip, the 2/5
// counter and this meter's own accessible label all say it now.
//
// What `accent` does NOT do is clear that floor everywhere, and the honest
// version is worth having written down: --color-accent is per-cosmetic while
// --color-xp is fixed gold, so on quantum-gold (0.018) and retro-crt (0.049)
// the two meters are still one colour — as they already were for every PLACED
// player on those two, before this line changed. Seventeen cosmetics move to
// 0.16-0.40 and gilded-age to 0.091; quantum-gold alone comes down, to exactly
// what its placed players already see. No tone in the palette separates a
// second meter from a gold accent, so the remaining case is a palette finding
// and not a prop — tests/cosmetics.test.ts names the two rather than pretending
// a floor holds.

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
      tone="accent"
      className={className}
      ariaLabel={
        placed
          ? undefined
          : t('placement_progress', language, {
              played: String(played),
              total: String(PLACEMENT_GAMES),
            })
      }
      // The BAND, so a promotion starts the new tier empty instead of sliding
      // backwards out of the old one. Placement is a band of its own: the meter
      // counts 1/5 to 5/5 across a session and resumes mid-count.
      resumeKey={`rank:${placed ? tier : 'placement'}`}
    />
  );
};
