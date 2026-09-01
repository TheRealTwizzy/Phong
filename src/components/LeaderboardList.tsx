import React, { useEffect, useState } from 'react';
import { LeaderboardEntry, LanguageCode } from '../types';
import { t } from '../i18n/translations';
import { AvatarImage } from './AvatarImage';
import { TierBadge } from './TierBadge';
import { Button, Panel } from './ui';
import { Crown, Medal, RefreshCw } from 'lucide-react';

// The leaderboard itself — the category strip, the bots toggle and the rows —
// with no chrome of its own, so the same list serves the modal it grew up in
// and the RANKS page it is becoming. `MatchHistoryList` is the pattern: the
// filters are LIST state, so they belong to the list rather than to whichever
// header happens to be above it.
//
// Deliberately no `idPrefix` (which MatchHistoryList does need): only ever one
// leaderboard is on screen, where a history list renders three times at once —
// the player's own, the profile sheet's tab, and somebody else's public view.
// An unused prefix would just be untested surface, and it would make
// `#leaderboard-row-*` a computed string that the browser suites already name
// literally.

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

export interface LeaderboardListProps {
  language: LanguageCode;
  currentPlayerId: string;
  /** Tapping any row opens that player's public profile. */
  onViewProfile?: (id: string) => void;
  /**
   * Whether this list is actually on screen and should be fetching.
   *
   * The modal passes its `isOpen`. A pager page passes whether it is the
   * CURRENT page — which is the distinction that stops mattering silently once
   * a page can be mounted without being visible: three off-screen pages
   * refetching on every filter change is bandwidth nobody asked for.
   */
  active: boolean;
  /** Bump to refetch the current view (a host's refresh button). */
  reloadKey?: number;
}

export const LeaderboardList: React.FC<LeaderboardListProps> = ({
  language,
  currentPlayerId,
  onViewProfile,
  active,
  reloadKey = 0,
}) => {
  const [category, setCategory] = useState<SortCategory>('elo');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  // Shown by default, and safe to be: bot rows carry `rank: null`, so a
  // human's number is identical whether they are listed or not. Hidden by
  // default meant a new player met an empty board — the ladder they were
  // being invited to climb had nothing on it. The toggle still hides them.
  const [showBots, setShowBots] = useState(true);
  // A failed fetch used to be `.catch(console.error)` and nothing else, so the
  // render fell through to the empty state and told the player "No ranking
  // entries found. Be the first to claim the top spot!" — a confident,
  // specific, and wrong claim about the ladder, on a dropped connection.
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setIsLoading(true);
    fetch(`/api/leaderboard?sort=${category}&limit=50${showBots ? '&bots=1' : ''}`)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          setEntries(data.leaderboard || []);
          setError(null);
        }
      })
      .catch((e) => {
        console.error(e);
        // The rows already on screen are kept, exactly as they are across a
        // category switch: an error is a reason to say so, not to blank what
        // the player was reading.
        if (!cancelled) setError(t('load_failed', language));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    // A page can be unmounted mid-flight by a swipe, where the modal could only
    // be closed; setting state after that is a warning and a leak.
    return () => {
      cancelled = true;
    };
  }, [active, category, showBots, reloadKey, retryKey, language]);

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

  return (
    <>
      {/* Filter tabs */}
      <div
        role="tablist"
        aria-label={t('board_category', language)}
        className="grid shrink-0 grid-cols-4 gap-1 rounded-card border border-line bg-surface-1 p-1"
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
        className="flex shrink-0 cursor-pointer select-none items-center justify-between px-1 text-2xs font-normal tracking-normal text-ink-muted"
      >
        <span>{t('board_show_bots', language)}</span>
        <input
          type="checkbox"
          checked={showBots}
          onChange={(e) => setShowBots(e.target.checked)}
          className="h-4 w-4 accent-violet-500"
        />
      </label>

      {/* `entries.length === 0`, not a bare `isLoading`: a refetch must never
          blank what is already on screen. Arriving on the RANKS page refetches
          every time, so the bare form swapped the board for a spinner on every
          arrival — staleness traded for a flash, and the flash is worse. It
          fixes switching category and toggling bots for free, which threw the
          rows away and rebuilt them the same way. Same rule
          `MatchHistoryList` has carried all along. */}
      {isLoading && entries.length === 0 ? (
        <div className="flex shrink-0 items-center justify-center gap-2 py-12 text-2xs font-normal tracking-normal text-ink-muted">
          <RefreshCw className="w-4 h-4 animate-spin text-warn" data-motion-essential />
          <span>{t('board_loading', language)}</span>
        </div>
      ) : error && entries.length === 0 ? (
        <Panel accent="loss" className="shrink-0 space-y-2 bg-loss/10 text-center text-ink">
          <p className="text-2xs font-normal tracking-normal">{error}</p>
          <Button size="sm" variant="danger" onClick={() => setRetryKey((n) => n + 1)}>
            {t('retry', language)}
          </Button>
        </Panel>
      ) : entries.length === 0 ? (
        <div className="shrink-0 py-12 text-center text-2xs font-normal tracking-normal text-ink-dim">
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
              className={`shrink-0 ${isMe ? 'bg-warn/10' : ''}`}
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
    </>
  );
};
