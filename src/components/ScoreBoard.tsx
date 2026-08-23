import React from 'react';
import { GameMode, PlayerStats, PlayerProfile, PlayerStatus, LanguageCode } from '../types';
import { ThemeConfig } from '../game/themes';
import { t } from '../i18n/translations';
import { AvatarImage } from './AvatarImage';
import { Volume2, VolumeX, Settings, Flame, RefreshCw, Home, Trophy } from 'lucide-react';

// In-match HUD. Out-of-match navigation (leaderboard, missions, history,
// multiplayer lobby, …) lives on the MainMenu — the HUD only carries what a
// running match needs: scores, sound, restart, device settings, and exit.
//
// The bar used to be `overflow-x-auto` with its scrollbar hidden, which is an
// admission that its contents did not fit. What did not fit was the username:
// with it gone the score cluster can be the anchor it should always have been,
// and everything sits on one row at 390px without scrolling. You know who you
// are; mid-match you need to know the score.
//
// It also carried twenty `sm:` variants. Tailwind's sm breakpoint is 640px and
// this app is phone-only, so every one of them was dead — the HUD had only
// ever rendered its smallest layout.
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
  /**
   * A duel's score belongs to the room, so a local reset would only desync
   * this phone from the other one. Hidden there; every other mode keeps it.
   */
  canResetMatch: boolean;
  onQuitToMenu: () => void;
  winningScore: number;
  opponentName?: string;
  // Provided only when the opponent has a real public profile (multiplayer
  // with a linkable id) — makes their name a tap target.
  onViewOpponent?: () => void;
  language?: LanguageCode;
}

const HudButton: React.FC<{
  id: string;
  label: string;
  onClick: () => void;
  tone?: 'default' | 'accent';
  children: React.ReactNode;
}> = ({ id, label, onClick, tone = 'default', children }) => (
  <button
    id={id}
    onClick={onClick}
    title={label}
    aria-label={label}
    className={`rounded-ctl border border-line bg-surface-3 p-1.5 transition-colors active:scale-95 motion-reduce:active:scale-100 ${
      tone === 'accent' ? 'text-accent' : 'text-ink-muted'
    }`}
  >
    {children}
  </button>
);

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
  canResetMatch,
  onQuitToMenu,
  winningScore,
  opponentName = 'Opponent',
  onViewOpponent,
  language = 'en',
}) => {
  // The rally counter is noise until a rally is actually going.
  const showRally = stats.streak >= 3;
  const isPractice = mode === 'practice';

  return (
    <div
      id="scoreboard-header"
      // No backdrop-filter: this sits over a live 60fps canvas, and blurring
      // it would recomposite the whole court every frame.
      className="absolute inset-x-0 top-0 z-30 flex items-center justify-between gap-2 border-b border-line bg-surface-0/92 px-2 pt-safe pb-1.5"
    >
      {/* Left: identity, without the name */}
      <button
        id="btn-open-profile"
        onClick={onOpenProfile}
        aria-label={t('profile', language)}
        className="flex shrink-0 items-center gap-1.5 rounded-ctl border border-line bg-surface-3 p-1 pr-1.5 transition-colors active:scale-95 motion-reduce:active:scale-100"
      >
        <div className="relative">
          <AvatarImage
            playerId={profile?.id}
            hasAvatar={profile?.hasAvatar}
            avatarVersion={profile?.avatarVersion}
            size={24}
            className="rounded-chip border border-line-strong"
          />
          <span
            id="player-status-dot"
            className={`absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full border-2 border-surface-3 ${
              playerStatus === 'online'
                ? 'bg-win'
                : playerStatus === 'idle'
                  ? 'bg-warn'
                  : 'bg-locked'
            }`}
          />
        </div>
        <span className="rounded-chip bg-xp px-1 text-2xs text-ink-on-accent">
          LV{profile?.level || 1}
        </span>
      </button>

      {/* Centre: the anchor */}
      {isPractice ? (
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-center">
            <span className="text-2xs font-normal tracking-normal text-ink-muted uppercase">
              {t('rally', language)}
            </span>
            <span
              id="practice-rally-count"
              className="text-title tnum leading-none"
              style={{ color: theme.playerPaddleColor }}
            >
              {stats.streak}
            </span>
          </div>
          <div className="flex flex-col items-center">
            <span className="flex items-center gap-0.5 text-2xs font-normal tracking-normal text-ink-muted uppercase">
              <Trophy className="h-2.5 w-2.5 text-warn" />
              {t('best', language)}
            </span>
            <span id="practice-best-rally" className="text-title tnum leading-none text-warn">
              {stats.bestStreak}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex flex-col items-center">
            {onViewOpponent ? (
              <button
                id="btn-view-opponent-profile"
                onClick={onViewOpponent}
                className="max-w-[60px] truncate text-2xs font-normal tracking-normal text-accent uppercase underline decoration-dotted underline-offset-2"
              >
                {opponentName}
              </button>
            ) : (
              <span className="max-w-[60px] truncate text-2xs font-normal tracking-normal text-ink-muted uppercase">
                {opponentName}
              </span>
            )}
            <span
              id="score-opponent"
              className="text-title tnum leading-none"
              style={{ color: theme.opponentPaddleColor }}
            >
              {stats.opponentScore}
            </span>
          </div>

          <div className="flex flex-col items-center">
            <span className="text-2xs text-ink-dim">:</span>
            <span className="text-2xs font-normal tracking-normal text-ink-dim">
              to {winningScore}
            </span>
          </div>

          <div className="flex flex-col items-center">
            <span className="text-2xs font-normal tracking-normal text-ink-muted uppercase">
              {t('you', language)}
            </span>
            <span
              id="score-player"
              className="text-title tnum leading-none"
              style={{ color: theme.playerPaddleColor }}
            >
              {stats.score}
            </span>
          </div>

          {showRally && (
            <div
              // Opacity only. This used to pulse a coloured box-shadow, which
              // repaints rather than compositing.
              className="animate-ready-pulse flex items-center gap-1 rounded-chip border border-warn/40 bg-warn/15 px-1.5 py-0.5 text-2xs tnum text-warn"
              title={t('rally', language)}
            >
              <Flame className="h-3 w-3 fill-current" />
              {stats.streak}
            </div>
          )}
        </div>
      )}

      {/* Right: what a running match needs */}
      <div className="flex shrink-0 items-center gap-1">
        <HudButton id="btn-sound-toggle" label={t('sound_effects', language)} onClick={onToggleSound}>
          {soundEnabled ? (
            <Volume2 className="h-4 w-4 text-win" />
          ) : (
            <VolumeX className="h-4 w-4" />
          )}
        </HudButton>

        {canResetMatch && (
          <HudButton id="btn-reset-match" label={t('reset_match', language)} onClick={onResetMatch}>
            <RefreshCw className="h-4 w-4" />
          </HudButton>
        )}

        <HudButton
          id="btn-open-settings"
          label={t('settings_title', language)}
          onClick={onOpenSettings}
        >
          <Settings className="h-4 w-4" />
        </HudButton>

        {/* Clicked directly by the suites, so it can never move behind a
            closed menu — Playwright cannot click an invisible element. */}
        <HudButton
          id="btn-quit-to-menu"
          label={t('exit_to_menu', language)}
          onClick={onQuitToMenu}
          tone="accent"
        >
          <Home className="h-4 w-4" />
        </HudButton>
      </div>
    </div>
  );
};
