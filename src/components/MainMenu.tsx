import React, { useState } from 'react';
import { AIDifficulty, GameMode, GameSettings, PlayerProfile, PlayerStatus } from '../types';
import { ThemeConfig } from '../game/themes';
import { t } from '../i18n/translations';
import { AvatarImage } from './AvatarImage';
import { TierBadge } from './TierBadge';
import { aiRating, winProbability, recommendedDifficulty } from '../rating';
import { normalizeRules } from '../matchRules';
import { MatchRulesPanel } from './MatchRulesPanel';
import {
  Bot,
  Dumbbell,
  Users,
  Smartphone,
  Target,
  Trophy,
  Award,
  History,
  User,
  Settings,
  BookOpen,
  Play,
  Shield,
  Flame,
  ChevronDown,
} from 'lucide-react';

// Out-of-match hub: pick a mode, lock in the match settings (difficulty,
// points to win) BEFORE play starts, and reach every non-match screen.
// Paddle width and ball speed are fixed engine constants — deliberately
// absent from this screen and every other one.
interface MainMenuProps {
  theme: ThemeConfig;
  settings: GameSettings;
  onUpdateSettings: (newSettings: Partial<GameSettings>) => void;
  profile: PlayerProfile | null;
  playerStatus: PlayerStatus;
  unclaimedMissionsCount: number;
  onStartSolo: () => void;
  onStartPractice: () => void;
  onStartSplit: () => void;
  onOpenMultiplayer: () => void;
  onOpenProfile: () => void;
  onOpenLeaderboard: () => void;
  onOpenAchievements: () => void;
  onOpenHistory: () => void;
  onOpenMissions: () => void;
  onOpenSettings: () => void;
  onOpenTutorial: () => void;
}

export const MainMenu: React.FC<MainMenuProps> = ({
  theme,
  settings,
  onUpdateSettings,
  profile,
  playerStatus,
  unclaimedMissionsCount,
  onStartSolo,
  onStartPractice,
  onStartSplit,
  onOpenMultiplayer,
  onOpenProfile,
  onOpenLeaderboard,
  onOpenAchievements,
  onOpenHistory,
  onOpenMissions,
  onOpenSettings,
  onOpenTutorial,
}) => {
  const lang = settings.language || 'en';
  const [expandedMode, setExpandedMode] = useState<GameMode | null>(null);

  const modes: {
    id: GameMode;
    icon: React.ReactNode;
    labelKey: string;
    descKey: string;
    accent: string;
  }[] = [
    { id: 'solo', icon: <Bot className="w-5 h-5" />, labelKey: 'mode_solo', descKey: 'menu_solo_desc', accent: '#22d3ee' },
    { id: 'practice', icon: <Dumbbell className="w-5 h-5" />, labelKey: 'mode_practice', descKey: 'menu_practice_desc', accent: '#34d399' },
    { id: 'split', icon: <Users className="w-5 h-5" />, labelKey: 'mode_split', descKey: 'menu_split_desc', accent: '#f472b6' },
    { id: 'multiplayer', icon: <Smartphone className="w-5 h-5" />, labelKey: 'mode_multiplayer', descKey: 'menu_multiplayer_desc', accent: '#a78bfa' },
  ];

  const handleModeTap = (id: GameMode) => {
    if (id === 'multiplayer') {
      // The lobby IS the pre-match setup for 2-phone duels.
      onOpenMultiplayer();
      return;
    }
    setExpandedMode((cur) => (cur === id ? null : id));
  };

  const startExpanded = () => {
    if (expandedMode === 'solo') onStartSolo();
    else if (expandedMode === 'practice') onStartPractice();
    else if (expandedMode === 'split') onStartSplit();
  };

  // Hidden MMR drives every prediction on this screen (solo play moves it,
  // even though it can never move the visible tier).
  const myRating = { mu: profile?.mmrMu ?? 25, sigma: profile?.mmrSigma ?? 25 / 3 };
  const bestDifficulty = recommendedDifficulty(myRating);

  const navButtons: { id: string; icon: React.ReactNode; labelKey: string; onClick: () => void; badge?: number }[] = [
    { id: 'missions', icon: <Target className="w-4 h-4 text-cyan-400" />, labelKey: 'daily_missions', onClick: onOpenMissions, badge: unclaimedMissionsCount },
    { id: 'leaderboard', icon: <Trophy className="w-4 h-4 text-amber-400" />, labelKey: 'leaderboard', onClick: onOpenLeaderboard },
    { id: 'achievements', icon: <Award className="w-4 h-4 text-purple-400" />, labelKey: 'achievements', onClick: onOpenAchievements },
    { id: 'history', icon: <History className="w-4 h-4 text-cyan-400" />, labelKey: 'history', onClick: onOpenHistory },
    { id: 'profile', icon: <User className="w-4 h-4 text-emerald-400" />, labelKey: 'profile', onClick: onOpenProfile },
    { id: 'tutorial', icon: <BookOpen className="w-4 h-4 text-cyan-400" />, labelKey: 'start_tutorial', onClick: onOpenTutorial },
    { id: 'settings', icon: <Settings className="w-4 h-4 text-zinc-300" />, labelKey: 'settings', onClick: onOpenSettings },
  ];

  return (
    <div
      id="main-menu-screen"
      className="relative w-full h-full overflow-y-auto flex flex-col select-none text-zinc-100"
      style={{ backgroundColor: theme.background }}
    >
      {/* Ambient glow backdrop */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(circle at 50% 18%, ${theme.accentColor}14 0%, transparent 60%)`,
        }}
      />

      <div className="relative flex flex-col gap-4 px-4 pt-5 pb-6 min-h-full">
        {/* Player identity pill */}
        <button
          id="menu-profile-pill"
          onClick={onOpenProfile}
          className="self-start flex items-center gap-2 p-1.5 pr-3 rounded-2xl bg-slate-900/80 hover:bg-slate-800/80 border border-slate-700/80 transition active:scale-95"
        >
          <div className="relative">
            <AvatarImage
              playerId={profile?.id}
              hasAvatar={profile?.hasAvatar}
              avatarVersion={profile?.avatarVersion}
              size={32}
              className="rounded-xl border border-cyan-400/40"
            />
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-900 ${
                playerStatus === 'online'
                  ? 'bg-emerald-400'
                  : playerStatus === 'idle'
                  ? 'bg-amber-400'
                  : 'bg-zinc-500'
              }`}
            />
          </div>
          <div className="flex flex-col text-left">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-white max-w-[110px] truncate">
                {profile?.username || 'Player'}
              </span>
              <span className="text-[9px] font-black px-1 rounded bg-amber-400 text-slate-950">
                LV{profile?.level || 1}
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 text-[9px] font-mono text-cyan-300/80">
              <TierBadge tier={profile?.tier || 'unranked'} language={lang} />
              <span className="inline-flex items-center gap-0.5 px-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold">
                <Flame className="w-2.5 h-2.5 text-amber-400 fill-amber-400" />
                {profile?.dailyStreak || 1}d
              </span>
            </div>
          </div>
        </button>

        {/* Title block */}
        <div className="flex flex-col items-center gap-1 py-2">
          <h1
            className="text-4xl font-black font-mono tracking-[0.3em] pl-[0.3em]"
            style={{ color: theme.accentColor, textShadow: `0 0 24px ${theme.accentColor}80` }}
          >
            {t('app_title', lang)}
          </h1>
          <p className="text-[11px] text-zinc-400 font-mono tracking-widest uppercase">
            {t('app_subtitle', lang)}
          </p>
        </div>

        {/* Mode selection */}
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-mono font-bold text-zinc-400 uppercase tracking-widest">
            {t('choose_mode', lang)}
          </span>

          {modes.map((m) => {
            const isExpanded = expandedMode === m.id;
            return (
              <div
                key={m.id}
                className={`rounded-2xl border overflow-hidden transition-colors ${
                  isExpanded ? 'bg-slate-900/90' : 'bg-slate-900/50'
                }`}
                style={{ borderColor: isExpanded ? m.accent + '80' : '#27272a' }}
              >
                <button
                  id={`menu-mode-${m.id}`}
                  onClick={() => handleModeTap(m.id)}
                  className="w-full flex items-center gap-3 p-3 text-left transition active:scale-[0.99]"
                >
                  <div
                    className="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0"
                    style={{ color: m.accent, borderColor: m.accent + '50', backgroundColor: m.accent + '15' }}
                  >
                    {m.icon}
                  </div>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm font-mono font-bold text-white">{t(m.labelKey, lang)}</span>
                    <span className="text-[10px] text-zinc-400 leading-tight">{t(m.descKey, lang)}</span>
                  </div>
                  {m.id !== 'multiplayer' && (
                    <ChevronDown
                      className={`w-4 h-4 text-zinc-500 shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    />
                  )}
                  {m.id === 'multiplayer' && <Play className="w-4 h-4 text-zinc-500 shrink-0" />}
                </button>

                {/* Pre-match setup panel — the ONLY place match settings change */}
                {isExpanded && (
                  <div className="px-3 pb-3 flex flex-col gap-3 border-t border-zinc-800/80 pt-3">
                    {m.id !== 'practice' && (
                      <span className="text-[9px] font-mono font-bold text-zinc-500 uppercase tracking-widest -mb-1">
                        {t('match_settings', lang)}
                      </span>
                    )}

                    {m.id === 'solo' && (
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[10px] font-mono text-zinc-400 flex items-center gap-1">
                          <Shield className="w-3 h-3" />
                          {t('ai_difficulty', lang)}
                          <span className="ml-auto text-[9px] text-zinc-500 normal-case">
                            {t('win_chance', lang)}
                          </span>
                        </label>
                        <div className="grid grid-cols-4 gap-1.5">
                          {(['rookie', 'pro', 'cyber', 'chaos'] as AIDifficulty[]).map((diff) => {
                            // Pre-match prediction from hidden MMR vs this AI
                            // anchor — the same number that scales match XP.
                            const chance = Math.round(winProbability(myRating, aiRating(diff, myRating.mu)) * 100);
                            return (
                              <button
                                key={diff}
                                id={`menu-diff-${diff}`}
                                onClick={() => onUpdateSettings({ difficulty: diff })}
                                className={`relative py-1.5 px-1 rounded-lg border text-[10px] font-mono capitalize transition flex flex-col items-center gap-0.5 ${
                                  settings.difficulty === diff
                                    ? 'border-cyan-400 bg-cyan-950/60 text-cyan-200 font-bold'
                                    : 'border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:bg-zinc-800'
                                }`}
                              >
                                <span>{diff}</span>
                                <span
                                  id={`menu-diff-${diff}-odds`}
                                  className={`text-[9px] font-bold ${
                                    chance >= 60
                                      ? 'text-emerald-400'
                                      : chance >= 40
                                        ? 'text-amber-400'
                                        : 'text-rose-400'
                                  }`}
                                >
                                  {chance}%
                                </span>
                                {diff === bestDifficulty && (
                                  <span
                                    id="menu-diff-balanced"
                                    className="absolute -top-1.5 left-1/2 -translate-x-1/2 text-[7px] font-black tracking-wider px-1 rounded bg-cyan-400 text-slate-950"
                                  >
                                    {t('balanced', lang)}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {(m.id === 'solo' || m.id === 'split') && (
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[10px] font-mono text-zinc-400">
                          {t('winning_score', lang)}
                        </label>
                        <div className="grid grid-cols-4 gap-1.5">
                          {[3, 5, 10, 15].map((pts) => (
                            <button
                              key={pts}
                              id={`menu-pts-${pts}`}
                              onClick={() => onUpdateSettings({ winningScore: pts })}
                              className={`py-1.5 rounded-lg text-[10px] font-mono border transition ${
                                settings.winningScore === pts
                                  ? 'border-cyan-400 bg-cyan-950/60 text-cyan-200 font-bold'
                                  : 'border-zinc-800 bg-zinc-900/60 text-zinc-400'
                              }`}
                            >
                              {pts} pts
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <MatchRulesPanel
                      settings={settings}
                      onUpdateRules={(patch) =>
                        onUpdateSettings({ rules: normalizeRules({ ...settings.rules, ...patch }) })
                      }
                      lang={lang}
                      mode={m.id}
                    />

                    <button
                      id={`menu-start-${m.id}`}
                      onClick={startExpanded}
                      className="w-full py-3 rounded-xl font-mono text-xs font-black tracking-widest uppercase text-zinc-950 transition active:scale-95 shadow-lg flex items-center justify-center gap-1.5"
                      style={{ backgroundColor: m.accent }}
                    >
                      <Play className="w-4 h-4" />
                      {m.id === 'practice' ? t('start_training', lang) : t('start_match', lang)}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Out-of-match navigation */}
        <div className="grid grid-cols-4 gap-2 mt-auto pt-2">
          {navButtons.map((b) => (
            <button
              key={b.id}
              id={`menu-nav-${b.id}`}
              onClick={b.onClick}
              title={t(b.labelKey, lang)}
              className="relative flex flex-col items-center gap-1 p-2 rounded-xl bg-slate-900/60 hover:bg-slate-800/70 border border-slate-800 transition active:scale-95"
            >
              {b.icon}
              <span className="text-[8px] font-mono text-zinc-400 leading-none truncate max-w-full">
                {t(b.labelKey, lang)}
              </span>
              {(b.badge ?? 0) > 0 && (
                <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-rose-500 text-white text-[9px] font-black font-mono flex items-center justify-center border border-slate-900">
                  {b.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
