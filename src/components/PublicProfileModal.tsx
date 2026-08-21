import React, { useEffect, useState } from 'react';
import { LanguageCode, PublicProfile } from '../types';
import { ThemeConfig } from '../game/themes';
import { t } from '../i18n/translations';
import { AvatarImage } from './AvatarImage';
import { X, Trophy, Flame, Activity, Target, Award, Bot, Loader2 } from 'lucide-react';

// World-readable profile card — opens when any username is tapped anywhere
// in the UI. Sits above the z-50 modals (leaderboard, history…) that spawn
// it. Data comes from GET /api/profile/:id, which the server sanitizes.
interface PublicProfileModalProps {
  playerId: string | null;
  onClose: () => void;
  theme: ThemeConfig;
  language: LanguageCode;
}

export const PublicProfileModal: React.FC<PublicProfileModalProps> = ({
  playerId,
  onClose,
  theme,
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

  if (!playerId) return null;

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

  return (
    <div
      id="public-profile-modal-overlay"
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-3xl border p-5 flex flex-col gap-4 text-zinc-100 shadow-2xl relative"
        style={{
          backgroundColor: '#0f141f',
          borderColor: theme.accentColor + '50',
          boxShadow: `0 0 35px ${theme.accentColor}20`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          id="btn-close-public-profile"
          onClick={onClose}
          className="absolute top-3.5 right-3.5 p-2 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-white transition"
        >
          <X className="w-4 h-4" />
        </button>

        {state === 'loading' && (
          <div className="py-14 flex items-center justify-center text-zinc-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        )}

        {state === 'missing' && (
          <div className="py-14 text-center text-sm font-mono text-zinc-400">
            {t('profile_not_found', language)}
          </div>
        )}

        {state === 'ready' && profile && (
          <>
            {/* Identity header */}
            <div className="flex items-center gap-3.5 pr-8">
              <AvatarImage
                playerId={profile.id}
                hasAvatar={profile.hasAvatar}
                avatarVersion={profile.avatarVersion}
                size={72}
                className="rounded-2xl border border-white/10"
              />
              <div className="flex flex-col min-w-0">
                <div className="flex items-center gap-1.5">
                  <h2
                    id="public-profile-username"
                    className="text-lg font-black font-mono truncate"
                  >
                    {profile.username}
                  </h2>
                  {profile.isBot && (
                    <span className="flex items-center gap-0.5 text-[9px] font-black px-1.5 py-0.5 rounded bg-purple-500/25 text-purple-300 border border-purple-500/40">
                      <Bot className="w-2.5 h-2.5" />
                      BOT
                    </span>
                  )}
                </div>
                <span className="text-[11px] font-mono" style={{ color: theme.accentColor }}>
                  {profile.rankTitle} · LV{profile.level}
                </span>
                <span className="text-[10px] font-mono text-zinc-500">
                  {t('member_since', language)} {memberSince}
                </span>
              </div>
            </div>

            {/* Headline numbers */}
            <div className="grid grid-cols-3 gap-2">
              <div className="p-2.5 rounded-2xl bg-zinc-900/70 border border-zinc-800 text-center">
                <div className="text-base font-black font-mono text-cyan-300">
                  {profile.eloRating}
                </div>
                <div className="text-[9px] font-mono text-zinc-500 uppercase">ELO</div>
              </div>
              <div className="p-2.5 rounded-2xl bg-zinc-900/70 border border-zinc-800 text-center">
                <div className="text-base font-black font-mono text-emerald-300">{winRate}%</div>
                <div className="text-[9px] font-mono text-zinc-500 uppercase">
                  {t('win_rate', language)}
                </div>
              </div>
              <div className="p-2.5 rounded-2xl bg-zinc-900/70 border border-zinc-800 text-center">
                <div className="text-base font-black font-mono text-amber-300 flex items-center justify-center gap-0.5">
                  <Flame className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                  {profile.dailyStreak}
                </div>
                <div className="text-[9px] font-mono text-zinc-500 uppercase">
                  {t('daily_streak', language)}
                </div>
              </div>
            </div>

            {/* Career stats */}
            <div className="grid grid-cols-2 gap-2">
              <div className="p-3 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex items-center gap-2.5">
                <Trophy className="w-4 h-4 text-amber-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-bold font-mono">
                    {profile.matchesWon}
                    <span className="text-zinc-500 text-[10px]"> / {profile.matchesPlayed}</span>
                  </div>
                  <div className="text-[9px] font-mono text-zinc-500 uppercase truncate">
                    {t('matches_label', language)}
                  </div>
                </div>
              </div>
              <div className="p-3 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex items-center gap-2.5">
                <Activity className="w-4 h-4 text-cyan-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-bold font-mono">{profile.highestRally}</div>
                  <div className="text-[9px] font-mono text-zinc-500 uppercase truncate">
                    {t('max_rally', language)}
                  </div>
                </div>
              </div>
              <div className="p-3 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex items-center gap-2.5">
                <Target className="w-4 h-4 text-rose-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-bold font-mono">{profile.totalPointsScored}</div>
                  <div className="text-[9px] font-mono text-zinc-500 uppercase truncate">
                    {t('total_points', language)}
                  </div>
                </div>
              </div>
              <div className="p-3 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex items-center gap-2.5">
                <Award className="w-4 h-4 text-purple-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-bold font-mono">{profile.achievements.length}</div>
                  <div className="text-[9px] font-mono text-zinc-500 uppercase truncate">
                    {t('achievements', language)}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
