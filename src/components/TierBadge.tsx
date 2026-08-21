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
  size?: 'sm' | 'md';
  className?: string;
}

export const TierBadge: React.FC<TierBadgeProps> = ({
  tier,
  language = 'en',
  size = 'sm',
  className = '',
}) => {
  const dims =
    size === 'md'
      ? 'text-xs px-2 py-0.5 rounded-md'
      : 'text-[9px] px-1.5 py-0.5 rounded';
  return (
    <span
      id={`tier-badge-${tier}`}
      className={`inline-flex items-center font-black font-mono uppercase tracking-wide border ${dims} ${TIER_STYLE[tier]} ${className}`}
      title={t(TIER_LABEL_KEY[tier], language)}
    >
      {t(TIER_LABEL_KEY[tier], language)}
    </span>
  );
};
