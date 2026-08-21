import React from 'react';
import { GameMode, PlayerStats, PlayerProfile, PlayerStatus, LanguageCode } from '../types';
import { ThemeConfig } from '../game/themes';
import { t } from '../i18n/translations';
import {
  Volume2,
  VolumeX,
  Settings,
  Flame,
  RefreshCw,
  Home,
  User,
  Trophy,
} from 'lucide-react';

// In-match HUD. Out-of-match navigation (leaderboard, missions, history,
// multiplayer lobby, …) lives on the MainMenu — the HUD only carries what a
// running match needs: scores, sound, restart, device settings, and exit.
interface ScoreBoardProps {
  stats: PlayerStats;
  mode: GameMode;
  theme: ThemeConfig;
  profile: PlayerProfile | null;
  playerStatus?: PlayerStatus;
  soundEnabled: boolean;
  onToggleSound: () => void;
  onOpenSettings: () => void;
  onOpenProfile: () => void;
  onResetMatch: () => void;
  onQuitToMenu: () => void;
  winningScore: number;
  opponentName?: string;
  language?: LanguageCode;
}

export const ScoreBoard: React.FC<ScoreBoardProps> = ({
  stats,
  mode,
  theme,
  profile,
  playerStatus = 'online',
  soundEnabled,
  onToggleSound,
  onOpenSettings,
  onOpenProfile,
  onResetMatch,
  onQuitToMenu,
  winningScore,
  opponentName = 'Opponent',
  language = 'en',
}) => {
  const isHighRally = stats.rallyCount >= 5;
  const isPractice = mode === 'practice';

  return (
    <div
      id="scoreboard-header"
      className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-2 sm:px-3 py-1.5 border-b backdrop-blur-md transition-colors duration-300 gap-1.5 sm:gap-2 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0"
      style={{
        backgroundColor: 'rgba(10, 15, 25, 0.88)',
        borderColor: theme.courtBorder + '30',
      }}
    >
      {/* Left: Player Profile & Status Indicator */}
      <button
        id="btn-open-profile"
        onClick={onOpenProfile}
        className="flex items-center gap-1.5 p-1 pl-1.5 pr-2 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 transition active:scale-95 text-left"
        title={`Player Profile (${playerStatus.toUpperCase()})`}
      >
        <div className="relative">
          <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg bg-cyan-500/20 border border-cyan-400/40 flex items-center justify-center text-cyan-300">
            <User className="w-3.5 h-3.5" />
          </div>
          {/* Status Indicator Dot */}
          <span
            id="player-status-dot"
            className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border-2 border-slate-900 ${
              playerStatus === 'online'
                ? 'bg-emerald-400 shadow-sm shadow-emerald-400/80 animate-pulse'
                : playerStatus === 'idle'
                ? 'bg-amber-400 shadow-sm shadow-amber-400/80'
                : 'bg-zinc-500'
            }`}
            title={`Status: ${playerStatus}`}
          />
        </div>

        <div className="flex flex-col">
          <div className="flex items-center gap-1">
            <span className="text-[10px] sm:text-[11px] font-bold text-white max-w-[60px] sm:max-w-[85px] truncate leading-tight">
              {profile?.username || 'Player'}
            </span>
            <span className="text-[8px] sm:text-[9px] font-black px-1 rounded bg-amber-400 text-slate-950">
              LV{profile?.level || 1}
            </span>
          </div>
          <div className="flex items-center gap-1.5 leading-none mt-0.5">
            <span className="text-[8px] sm:text-[9px] text-cyan-300/80 font-mono">
              {profile?.eloRating || 1200} ELO
            </span>
          </div>
        </div>
      </button>

      {/* Center: Score Display (match modes) or Rally Streak (practice) */}
      {isPractice ? (
        <div className="flex items-center gap-3 sm:gap-4 font-mono">
          <div className="flex flex-col items-center">
            <span className="text-[8px] sm:text-[9px] text-zinc-400 uppercase tracking-tight">
              {t('rally', language)}
            </span>
            <span
              id="practice-rally-count"
              className="text-lg sm:text-2xl font-black leading-none"
              style={{ color: theme.playerPaddleColor }}
            >
              {stats.rallyCount}
            </span>
          </div>

          <div className="flex flex-col items-center">
            <span className="text-[8px] sm:text-[9px] text-zinc-400 uppercase tracking-tight flex items-center gap-0.5">
              <Trophy className="w-2.5 h-2.5 text-amber-400" />
              {t('best', language)}
            </span>
            <span
              id="practice-best-rally"
              className="text-lg sm:text-2xl font-black leading-none text-amber-400"
            >
              {stats.maxRally}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 sm:gap-3.5 font-mono">
          {/* Opponent Side Score */}
          <div className="flex flex-col items-center">
            <span className="text-[8px] sm:text-[9px] text-zinc-400 uppercase tracking-tight truncate max-w-[45px] sm:max-w-[70px]">
              {opponentName}
            </span>
            <span
              id="score-opponent"
              className="text-lg sm:text-2xl font-black leading-none"
              style={{ color: theme.opponentPaddleColor }}
            >
              {stats.opponentScore}
            </span>
          </div>

          {/* Colon Divider */}
          <div className="flex flex-col items-center justify-center">
            <span className="text-zinc-600 text-xs font-bold">:</span>
            <span className="text-[7px] sm:text-[8px] text-zinc-500 font-sans">to {winningScore}</span>
          </div>

          {/* Player Side Score */}
          <div className="flex flex-col items-center">
            <span className="text-[8px] sm:text-[9px] text-zinc-400 uppercase tracking-tight">
              {t('you', language)}
            </span>
            <span
              id="score-player"
              className="text-lg sm:text-2xl font-black leading-none"
              style={{ color: theme.playerPaddleColor }}
            >
              {stats.score}
            </span>
          </div>

          {/* Rally Badge */}
          <div
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-bold transition-all ${
              isHighRally
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm animate-pulse'
                : 'bg-zinc-800/80 text-zinc-300 border border-zinc-700/50'
            }`}
            title="Current Volley Rally Count"
          >
            <Flame className={`w-3 h-3 ${isHighRally ? 'text-amber-400 fill-amber-400' : 'text-zinc-400'}`} />
            <span>{stats.rallyCount}</span>
          </div>
        </div>
      )}

      {/* Right: Action Buttons */}
      <div className="flex items-center gap-1 sm:gap-1.5">
        <button
          id="btn-sound-toggle"
          onClick={onToggleSound}
          title={t('sound_effects', language)}
          className="p-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition active:scale-95"
        >
          {soundEnabled ? <Volume2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-400" /> : <VolumeX className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-zinc-500" />}
        </button>

        <button
          id="btn-reset-match"
          onClick={onResetMatch}
          title={t('reset_match', language)}
          className="p-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition active:scale-95"
        >
          <RefreshCw className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
        </button>

        <button
          id="btn-open-settings"
          onClick={onOpenSettings}
          title={t('settings_title', language)}
          className="p-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition active:scale-95"
        >
          <Settings className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
        </button>

        <button
          id="btn-quit-to-menu"
          onClick={onQuitToMenu}
          title={t('exit_to_menu', language)}
          className="p-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-cyan-400 border border-zinc-700 transition active:scale-95"
        >
          <Home className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
        </button>
      </div>
    </div>
  );
};
