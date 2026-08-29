import React from 'react';
import { LanguageCode } from '../types';
import { Tier, TIER_STYLE, TIER_LABEL_KEY } from '../rating';
import { t } from '../i18n/translations';

// The player's visible skill rank. Deliberately the ONLY public expression of
// rating — raw mu/sigma numbers are never rendered anywhere in the UI.
// Follows the existing tinted-chip pattern used for status pills and BOT tags.
interface TierBadgeProps {
  tier: Tier;
  language?: LanguageCode;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  /**
   * Position on the ranked ladder, for the top rung only. Overlord is the one
   * rung with nothing above it, so it reads as a COUNTDOWN — `#1` through
   * `#100` — rather than as a word every player up there shares. Absent (or on
   * any other tier) the badge is exactly what it always was, which is also what
   * an Overlord outside the top 100 falls back to.
   */
  ladderPosition?: number;
}

export const TierBadge: React.FC<TierBadgeProps> = ({
  tier,
  language = 'en',
  size = 'sm',
  className = '',
  ladderPosition,
}) => {
  // 11px is the type floor for the shell; this chip was the last thing under
  // it. TIER_STYLE keeps supplying the per-tier colour — rank colour is the
  // one thing allowed to override the single accent, because in a competitive
  // game the colour of your rank IS your identity.
  // `xs` is `sm` with its vertical padding spent. The menu capsule stacks a
  // label row and two meters inside the 30px its avatar sets, and at `sm` the
  // chip's own `py-0.5` made that column 30.1px — which put the header 0.09px
  // past the offset the toast stack clears it by. Sub-pixel, invisible, and
  // exactly the kind of drift the height assertion in e2e-menu exists to catch;
  // the gaps between the meters are not where that slack comes from.
  const dims =
    size === 'md'
      ? 'text-xs px-2 py-0.5 rounded-ctl'
      : size === 'xs'
        ? 'text-2xs px-1 py-0 rounded-chip'
        : 'text-2xs px-1.5 py-0.5 rounded-chip';
  const label = t(TIER_LABEL_KEY[tier], language);
  // `#7` rather than a new string in seven locales, and not a new convention
  // either: LeaderboardList already prints a plain position exactly this way.
  // The tier NAME stays in `title`, so the badge still says what rung this is
  // for anyone who asks, and TIER_LABEL_KEY keeps quoting every tier_* key.
  const countdown = tier === 'overlord' && ladderPosition != null;
  return (
    <span
      id={`tier-badge-${tier}`}
      className={`inline-flex items-center border uppercase ${dims} ${TIER_STYLE[tier]} ${className}`}
      title={countdown ? `${label} #${ladderPosition}` : label}
      // In countdown mode the only rendered text is `#7`, and `title` is not
      // reliably announced — nor reachable at all by keyboard or touch, since
      // this span is not focusable. Without a label the rank the number stands
      // for is simply lost. Absent otherwise, where the visible text already
      // IS the tier name and a label would only repeat it.
      aria-label={countdown ? `${label} #${ladderPosition}` : undefined}
    >
      {/* min-w-0 + truncate on the INNER span, because this is an inline-flex
          box: the label is an anonymous flex item, whose automatic minimum size
          is its content, so text-overflow on the outer span CLIPS rather than
          ellipsising. The menu capsule caps this chip and "Cyber Overlord" is
          fourteen characters — the full label stays in `title`, and the tier
          colour says the rest. Every other call site leaves the width
          unconstrained, so this never fires there. */}
      <span className={`min-w-0 truncate${countdown ? ' tnum' : ''}`}>
        {countdown ? `#${ladderPosition}` : label}
      </span>
    </span>
  );
};
