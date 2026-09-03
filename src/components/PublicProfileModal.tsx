import React, { useEffect, useState } from 'react';
import { LanguageCode, PublicProfile } from '../types';
import { t } from '../i18n/translations';
import { COSMETICS, cosmeticVars, normalizeCosmeticId } from '../game/cosmetics';
import { TITLES } from '../game/titles';
import { AvatarImage } from './AvatarImage';
import { MatchHistoryList } from './MatchHistoryList';
import { TierBadge } from './TierBadge';
import { Sheet, Panel, StatTile } from './ui';
import { Trophy, Flame, Activity, Target, Award, Bot, Loader2 } from 'lucide-react';

// World-readable profile card — opens when any username is tapped anywhere
// in the UI. It is the topmost entry in App's sheet stack, because every
// route into it is a username tapped on something else — a leaderboard row, a
// history card, the lobby, the in-match opponent — so whatever spawned it is
// underneath. Data comes from GET /api/profile/:id, which the server sanitizes.
interface PublicProfileModalProps {
  /** Position in App's open-sheet stack; forwarded to Sheet. See Sheet's `stack`. */
  stack?: { index: number; count: number };

  playerId: string | null;
  onClose: () => void;
  language: LanguageCode;
  /**
   * Tapping a username inside this profile's match history swaps the modal
   * to that player in place — same sheet, new id — rather than stacking a
   * third layer.
   */
  onViewProfile?: (id: string) => void;
}

export const PublicProfileModal: React.FC<PublicProfileModalProps> = ({
  playerId,
  onClose,
  language,
  onViewProfile,
  stack,
}) => {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');

  useEffect(() => {
    if (!playerId) return;
    let cancelled = false;
    setState('loading');
    setProfile(null);
    fetch(`/api/profile/${encodeURIComponent(playerId)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (cancelled) return;
        if (data?.profile?.id) {
          setProfile(data.profile);
          setState('ready');
        } else {
          setState('missing');
        }
      })
      .catch(() => {
        if (!cancelled) setState('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  const winRate =
    profile && profile.matchesPlayed > 0
      ? Math.round((profile.matchesWon / profile.matchesPlayed) * 100)
      : 0;
  const memberSince = profile
    ? new Date(profile.createdAt).toLocaleDateString(language, {
        year: 'numeric',
        month: 'short',
      })
    : '';

  const careerStat = (
    icon: React.ReactNode,
    value: React.ReactNode,
    label: string
  ) => (
    <Panel variant="inset" className="flex items-center gap-2.5">
      <span className="shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-2xs tnum text-ink">{value}</div>
        <div className="truncate text-2xs font-normal tracking-normal text-ink-muted uppercase">
          {label}
        </div>
      </div>
    </Panel>
  );

  return (
    <Sheet
      stack={stack}
      id="public-profile-modal-overlay"
      isOpen={Boolean(playerId)}
      onClose={onClose}
      size="md"
      layer="over"
      accent="accent"
      cardId="public-profile-card"
      cardStyle={cosmeticVars(COSMETICS[normalizeCosmeticId(profile?.cosmetic)]) as React.CSSProperties}
      cardMode={COSMETICS[normalizeCosmeticId(profile?.cosmetic)].mode}
      closeId="btn-close-public-profile"
      closeLabel={t('close', language)}
      title={
        state === 'ready' && profile ? (
          <span className="flex items-center gap-1.5">
            <span id="public-profile-username" className="truncate">
              {profile.username}
            </span>
            {profile.isBot && (
              <span className="flex items-center gap-0.5 rounded-chip border border-rank-steady/40 bg-rank-steady/25 px-1.5 py-0.5 text-2xs text-rank-steady">
                <Bot className="h-2.5 w-2.5" />
                {t('board_bot', language)}
              </span>
            )}
          </span>
        ) : (
          ' '
        )
      }
    >
      {state === 'loading' && (
        <div className="flex items-center justify-center py-14 text-ink-muted">
          <Loader2 className="h-6 w-6 animate-spin" data-motion-essential />
        </div>
      )}

      {state === 'missing' && (
        <div className="py-14 text-center text-2xs font-normal tracking-normal text-ink-muted">
          {t('profile_not_found', language)}
        </div>
      )}

      {state === 'ready' && profile && (
        <>
          {/* Identity */}
          <div className="flex items-center gap-3.5">
            <AvatarImage
              playerId={profile.id}
              hasAvatar={profile.hasAvatar}
              avatarVersion={profile.avatarVersion}
              size={72}
              className="rounded-card border border-line-strong"
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-1.5">
                <TierBadge
                  tier={profile.tier}
                  language={language}
                  ladderPosition={profile.ladderPosition}
                />
                <span className="text-2xs text-accent">LV{profile.level}</span>
                {/* Guarded on the catalogue: an older bundle may meet a title a
                    newer server has since shipped, and a chip with no name is
                    worse than none. */}
                {profile.title && TITLES[profile.title] && (
                  <span
                    id="public-title-chip"
                    className="rounded-chip border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs text-accent"
                  >
                    {t(TITLES[profile.title].nameKey, language)}
                  </span>
                )}
              </span>
              <span className="text-2xs font-normal tracking-normal text-ink-dim">
                {t('member_since', language)} {memberSince}
              </span>
            </div>
          </div>

          {/* Headline numbers */}
          <div className="grid grid-cols-3 gap-2">
            <StatTile
              label={t('ranked_games', language)}
              value={profile.rankedGames}
              tone="accent"
            />
            <StatTile label={t('win_rate', language)} value={`${winRate}%`} tone="win" />
            <StatTile
              label={t('daily_streak', language)}
              value={profile.dailyStreak}
              tone="warn"
              icon={<Flame className="h-3.5 w-3.5 fill-current" />}
            />
          </div>

          {/* Career */}
          <div className="grid grid-cols-2 gap-2">
            {careerStat(
              <Trophy className="h-4 w-4 text-warn" />,
              <>
                {profile.matchesWon}
                <span className="text-ink-dim"> / {profile.matchesPlayed}</span>
              </>,
              t('matches_label', language)
            )}
            {careerStat(
              <Activity className="h-4 w-4 text-accent" />,
              profile.highestRally,
              t('max_rally', language)
            )}
            {careerStat(
              <Target className="h-4 w-4 text-loss" />,
              profile.totalPointsScored,
              t('total_points', language)
            )}
            {careerStat(
              <Award className="h-4 w-4 text-rank-steady" />,
              profile.achievements.length,
              t('achievements', language)
            )}
          </div>

          {/* Match history, public. Hidden for bots: the roster plays no
              matches, and an empty tabbed list on every bot profile is
              noise, not information. */}
          {!profile.isBot && (
            <div className="flex flex-col gap-2">
              <span className="text-kicker text-ink-dim uppercase">
                {t('public_history_section', language)}
              </span>
              <MatchHistoryList
                language={language}
                perspectiveId={profile.id}
                source={{ kind: 'public', playerId: profile.id }}
                onViewProfile={onViewProfile}
                idPrefix="public-history"
              />
            </div>
          )}
        </>
      )}
    </Sheet>
  );
};
