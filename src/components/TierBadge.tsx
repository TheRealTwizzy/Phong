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
  // 11px is the type floor for the shell; this chip was the last thing under
  // it. TIER_STYLE keeps supplying the per-tier colour — rank colour is the
  // one thing allowed to override the single accent, because in a competitive
  // game the colour of your rank IS your identity.
  const dims =
    size === 'md'
      ? 'text-xs px-2 py-0.5 rounded-ctl'
      : 'text-2xs px-1.5 py-0.5 rounded-chip';
  return (
    <span
      id={`tier-badge-${tier}`}
      className={`inline-flex items-center border uppercase ${dims} ${TIER_STYLE[tier]} ${className}`}
      title={t(TIER_LABEL_KEY[tier], language)}
    >
      {t(TIER_LABEL_KEY[tier], language)}
    </span>
  );
};
