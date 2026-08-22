import React, { useEffect, useState } from 'react';
import { LanguageCode, PublicProfile } from '../types';
import { t } from '../i18n/translations';
import { AvatarImage } from './AvatarImage';
import { TierBadge } from './TierBadge';
import { Sheet, Panel, StatTile } from './ui';
import { Trophy, Flame, Activity, Target, Award, Bot, Loader2 } from 'lucide-react';

// World-readable profile card — opens when any username is tapped anywhere
// in the UI. Sits above the z-50 modals (leaderboard, history…) that spawn
// it. Data comes from GET /api/profile/:id, which the server sanitizes.
interface PublicProfileModalProps {
  playerId: string | null;
  onClose: () => void;
  language: LanguageCode;
}

export const PublicProfileModal: React.FC<PublicProfileModalProps> = ({
  playerId,
  onClose,
  language,
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
      id="public-profile-modal-overlay"
      isOpen={Boolean(playerId)}
      onClose={onClose}
      size="sm"
      layer="over"
      accent="accent"
      closeId="btn-close-public-profile"
      closeLabel={t('close', language)}
      title={
        state === 'ready' && profile ? (
          <span className="flex items-center gap-1.5">
            <span id="public-profile-username" className="truncate">
              {profile.username}
            </span>
            {profile.isBot && (
              <span className="flex items-center gap-0.5 rounded-chip border border-violet-500/40 bg-violet-500/25 px-1.5 py-0.5 text-2xs text-violet-300">
                <Bot className="h-2.5 w-2.5" />
                BOT
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
                <TierBadge tier={profile.tier} language={language} />
                <span className="text-2xs text-accent">LV{profile.level}</span>
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
              <Award className="h-4 w-4 text-violet-400" />,
              profile.achievements.length,
              t('achievements', language)
            )}
          </div>
        </>
      )}
    </Sheet>
  );
};
