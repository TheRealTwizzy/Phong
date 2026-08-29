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
// Both states share one TONE, and it took two goes to find one that works,
// because this meter stacks DIRECTLY on the XP meter in the header capsule and
// --color-xp is a fixed gold that the LV chip a row above also wears.
//
//   `warn` — the first answer, for the unplaced state, on the reasoning that
//   amber says "this does not count yet". Amber is also what XP says: the two
//   tokens sit 0.044 apart in OKLab on nineteen cosmetics and 0.034 on the
//   light one, where tests/cosmetics.test.ts asks 0.08 of two whole THEMES. So
//   the capsule showed an unplaced player two amber bars with nothing to say
//   which one was the ladder. What `warn` was carrying alone is said three
//   other ways now: the UNRANKED chip, the 2/5 counter, and this meter's own
//   accessible label.
//
//   `accent` — the second, and it cannot work either, for a reason no prop can
//   fix: --color-accent is PER-COSMETIC while --color-xp is fixed, so a
//   cosmetic whose accent is gold puts the two meters back on one colour
//   (quantum-gold 0.018, retro-crt 0.049) however far apart they are on the
//   other seventeen.
//
// So the meter left the accent altogether. `ladder` is a fixed three-stop ramp
// picked by how full the bar is (components/ui/ladderTone.ts), which makes it
// uniform on all twenty cosmetics — the property the first two answers were
// each missing half of. Cool hues on purpose: green and red are reserved for
// won and lost, and this bar fills UP as a player climbs, so a ramp built from
// them would paint the fullest meter — someone about to be promoted, or
// finishing placement — in the colour that means a loss.

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
      tone="ladder"
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
