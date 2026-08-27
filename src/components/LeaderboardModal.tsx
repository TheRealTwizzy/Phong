import React, { useState, useEffect } from 'react';
import { LeaderboardEntry, LanguageCode } from '../types';
import { t } from '../i18n/translations';
import { AvatarImage } from './AvatarImage';
import { TierBadge } from './TierBadge';
import { Sheet, Button, Panel } from './ui';
import { X, Trophy, Crown, Medal, RefreshCw } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentPlayerId: string;
  // Tapping any row opens that player's public profile.
  onViewProfile?: (id: string) => void;
  language: LanguageCode;
}

type SortCategory = 'elo' | 'level' | 'rally' | 'wins';

const CATEGORIES: { id: SortCategory; labelKey: string }[] = [
  // "Skill Tier", never the estimator's name: the ladder shows a tier, and a
  // raw rating number is never rendered anywhere in this app. These sit at
  // module scope, so they hold a KEY and resolve against the live language at
  // render — a label baked in here would be English for everyone.
  { id: 'elo', labelKey: 'board_cat_elo' },
  { id: 'level', labelKey: 'board_cat_level' },
  { id: 'rally', labelKey: 'board_cat_rally' },
  { id: 'wins', labelKey: 'board_cat_wins' },
];

export const LeaderboardModal: React.FC<Props> = ({
  isOpen,
  onClose,
  currentPlayerId,
  onViewProfile,
  language,
}) => {
  const [category, setCategory] = useState<SortCategory>('elo');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  // Shown by default, and safe to be: bot rows carry `rank: null`, so a
  // human's number is identical whether they are listed or not. Hidden by
  // default meant a new player met an empty board — the ladder they were
  // being invited to climb had nothing on it. The toggle still hides them.
  const [showBots, setShowBots] = useState(true);

  const fetchLeaderboard = (cat: SortCategory, bots: boolean) => {
    setIsLoading(true);
    fetch(`/api/leaderboard?sort=${cat}&limit=50${bots ? '&bots=1' : ''}`)
      .then((res) => res.json())
      .then((data) => {
        setEntries(data.leaderboard || []);
      })
      .catch(console.error)
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    if (isOpen) {
      fetchLeaderboard(category, showBots);
    }
  }, [isOpen, category, showBots]);

  // Gold, silver and bronze are the content here, not chrome — a medal that
  // took the shell's accent would stop reading as a medal.
  const renderRankBadge = (rank: number | null) => {
    if (rank === null) {
      return (
        <div className="w-8 h-8 rounded-full bg-rank-steady/15 border border-rank-steady/40 flex items-center justify-center text-rank-steady text-2xs">
          {t('board_bot', language)}
        </div>
      );
    }
    if (rank === 1) {
      return (
        <div className="w-8 h-8 rounded-full bg-warn/20 border border-warn/50 flex items-center justify-center text-warn">
          <Crown className="w-4 h-4 fill-warn" />
        </div>
      );
    }
    if (rank === 2) {
      return (
        <div className="w-8 h-8 rounded-full bg-slate-300/20 border border-slate-300/50 flex items-center justify-center text-ink">
          <Medal className="w-4 h-4" />
        </div>
      );
    }
    if (rank === 3) {
      return (
        <div className="w-8 h-8 rounded-full bg-warn/20 border border-warn/50 flex items-center justify-center text-warn">
          <Medal className="w-4 h-4" />
        </div>
      );
    }
    return (
      <div className="w-8 h-8 rounded-full bg-surface-3 flex items-center justify-center text-ink-muted text-2xs tnum">
        #{rank}
      </div>
    );
  };

  const header = (
    <div className="shrink-0 relative border-b border-line bg-gradient-to-r from-warn/12 via-surface-2 to-surface-2 p-4">
      <button
        id="close-leaderboard-btn"
        onClick={onClose}
        aria-label={t('board_close', language)}
        className="absolute top-3 right-3 rounded-ctl p-2 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
      >
        <X className="w-5 h-5" />
      </button>

      <div className="flex items-center gap-3">
        <div className="rounded-card border border-warn/30 bg-warn/10 p-2.5 text-warn">
          <Trophy className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-title">{t('board_title', language)}</h2>
          <p className="text-2xs font-normal tracking-normal text-ink-muted">
            {t('board_subtitle', language)}
          </p>
        </div>
      </div>

      {/* Filter tabs */}
      <div
        role="tablist"
        aria-label={t('board_category', language)}
        className="mt-4 grid grid-cols-4 gap-1 rounded-card border border-line bg-surface-1 p-1"
      >
        {CATEGORIES.map((c) => {
          const selected = category === c.id;
          return (
            <button
              key={c.id}
              id={`filter-leaderboard-${c.id}`}
              role="tab"
              aria-selected={selected}
              data-selected={selected ? 'true' : 'false'}
              onClick={() => setCategory(c.id)}
              className={`min-h-8 rounded-ctl px-1 py-1.5 text-2xs transition-colors ${
                selected
                  ? 'bg-warn text-ink-on-accent'
                  : 'text-ink-muted hover:bg-surface-3 hover:text-ink'
              }`}
            >
              {t(c.labelKey, language)}
            </button>
          );
        })}
      </div>

      {/* Bots are ranked separately and never change a human player's rank. */}
      <label
        id="toggle-show-bots"
        className="mt-2.5 flex cursor-pointer select-none items-center justify-between px-1 text-2xs font-normal tracking-normal text-ink-muted"
      >
        <span>{t('board_show_bots', language)}</span>
        <input
          type="checkbox"
          checked={showBots}
          onChange={(e) => setShowBots(e.target.checked)}
          className="h-4 w-4 accent-violet-500"
        />
      </label>
    </div>
  );

  const footer = (
    <>
      <span className="flex-1 text-2xs font-normal tracking-normal text-ink-muted">
        {t('board_footer', language)}
      </span>
      <Button
        size="sm"
        variant="secondary"
        icon={<RefreshCw className="w-3.5 h-3.5" />}
        onClick={() => fetchLeaderboard(category, showBots)}
      >
        {t('board_refresh', language)}
      </Button>
    </>
  );

  return (
    <Sheet
      cardId="leaderboard-modal-container"
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      accent="warn"
      header={header}
      footer={footer}
      bodyClassName="p-3 space-y-2"
    >
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-2xs font-normal tracking-normal text-ink-muted">
          <RefreshCw className="w-4 h-4 animate-spin text-warn" data-motion-essential />
          <span>{t('board_loading', language)}</span>
        </div>
      ) : entries.length === 0 ? (
        <div className="py-12 text-center text-2xs font-normal tracking-normal text-ink-dim">
          {t('board_empty', language)}
        </div>
      ) : (
        entries.map((entry) => {
          const isMe = entry.id === currentPlayerId;
          return (
            <Panel
              as="div"
              key={entry.id}
              variant={isMe ? 'raised' : 'flat'}
              accent={isMe ? 'warn' : 'neutral'}
              padded={false}
              className={isMe ? 'bg-warn/10' : ''}
            >
              <button
                id={`leaderboard-row-${entry.id}`}
                onClick={() => onViewProfile?.(entry.id)}
                title={t('view_profile', language)}
                className="flex w-full items-center justify-between gap-2 p-3 text-left transition-transform active:scale-[0.99] motion-reduce:active:scale-100"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {renderRankBadge(entry.rank)}
                  <AvatarImage
                    playerId={entry.id}
                    hasAvatar={Boolean(entry.avatarVersion)}
                    avatarVersion={entry.avatarVersion}
                    size={32}
                    className="rounded-ctl border border-line-strong"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`truncate text-2xs ${isMe ? 'text-warn' : 'text-ink'}`}
                      >
                        {entry.username}
                      </span>
                      {isMe && (
                        <span className="rounded-chip bg-warn px-1.5 py-0.5 text-2xs text-ink-on-accent uppercase">
                          {t('you', language)}
                        </span>
                      )}
                      {entry.isBot && (
                        <span className="rounded-chip border border-rank-steady/40 bg-rank-steady/25 px-1.5 py-0.5 text-2xs text-rank-steady uppercase">
                          {t('board_bot', language)}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-2xs font-normal tracking-normal text-ink-muted">
                      <span className="text-accent">{t('level', language)} {entry.level}</span>
                      <span>•</span>
                      <span>{entry.winRate}% {t('win_rate', language)}</span>
                    </div>
                  </div>
                </div>

                <div className="shrink-0 text-right">
                  {category === 'elo' && (
                    <div className="flex flex-col items-end gap-0.5">
                      <TierBadge tier={entry.tier} />
                      <div className="text-2xs font-normal tracking-normal text-ink-muted uppercase">
                        {t('board_ranked_games', language, { n: entry.rankedGames })}
                      </div>
                    </div>
                  )}
                  {category === 'level' && (
                    <>
                      <div className="text-2xs tnum text-accent">
                        {entry.xp.toLocaleString()} {t('xp', language)}
                      </div>
                      <div className="text-2xs font-normal tracking-normal text-ink-muted uppercase">
                        {t('menu_level', language)} {entry.level}
                      </div>
                    </>
                  )}
                  {category === 'rally' && (
                    <>
                      <div className="text-2xs tnum text-warn">{entry.highestRally} {t('board_hits', language)}</div>
                      <div className="text-2xs font-normal tracking-normal text-ink-muted uppercase">
                        {t('board_max_rally', language)}
                      </div>
                    </>
                  )}
                  {category === 'wins' && (
                    <>
                      <div className="text-2xs tnum text-win">{entry.matchesWon} {t('board_won', language)}</div>
                      <div className="text-2xs font-normal tracking-normal text-ink-muted uppercase">
                        {entry.matchesPlayed} {t('board_played', language)}
                      </div>
                    </>
                  )}
                </div>
              </button>
            </Panel>
          );
        })
      )}
    </Sheet>
  );
};
