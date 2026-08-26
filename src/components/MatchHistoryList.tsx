import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MatchRecord, LanguageCode } from '../types';
import { t } from '../i18n/translations';
import { isLinkableId, DELETED_PLAYER_ID } from '../profileRules';
import { Button, Pagination, Panel, SegmentedControl } from './ui';
import { Calendar, Cpu, Flame, RefreshCw, Smartphone, Swords, Target } from 'lucide-react';

// One history list for every surface that shows a match history — the
// player's own modal, the profile sheet's history tab, and the public view on
// somebody else's profile. It owns the whole question: which tab, which
// ranked sub-filter, which page, fetched from the paged API and rendered from
// the perspective of the profile whose history it is. Three copies of this
// logic is how the profile sheet came to render an opponent-authored score
// un-mirrored while the history modal mirrored it correctly.
//
// Rows are always the perspective player's own filed record (player1 —
// server-guaranteed), so scoreP1 is their score; the isP1 check stays as a
// defensive habit, not a load-bearing branch.

export type HistoryTab = 'all' | 'pvp' | 'solo' | 'practice';
type RankedFilter = 'all' | 'ranked' | 'unranked';

/** Where the rows come from: my own history, or a public profile's. */
export type MatchHistorySource = { kind: 'me' } | { kind: 'public'; playerId: string };

export interface MatchHistoryListProps {
  language: LanguageCode;
  /** Whose history this is — every row is filed with this id as player1. */
  perspectiveId: string;
  source: MatchHistorySource;
  onViewProfile?: (id: string) => void;
  /** Stable id prefix for tabs/pages/rows, e.g. 'history', 'public-history'. */
  idPrefix: string;
  /** The current page's rows, for a host header's summary tiles. */
  onPageData?: (rows: MatchRecord[]) => void;
  /** Bump to refetch the current page (a host's refresh button). */
  reloadKey?: number;
  /** Offered on the completely empty, unfiltered state (close-and-go-play). */
  onEmptyAction?: () => void;
  className?: string;
}

// Keys, not labels, at module scope — they resolve against the live language
// at render. Solo and practice reuse the app-wide mode names; the PvP tab has
// its own short name because "2-Phone Duel" does not fit a quarter-width tab.
const TABS: { id: HistoryTab; labelKey: string }[] = [
  { id: 'all', labelKey: 'history_tab_all' },
  { id: 'pvp', labelKey: 'history_tab_pvp' },
  { id: 'solo', labelKey: 'mode_solo' },
  { id: 'practice', labelKey: 'mode_practice' },
];

const RANKED_FILTERS: RankedFilter[] = ['all', 'ranked', 'unranked'];
const RANKED_FILTER_KEY: Record<RankedFilter, string> = {
  all: 'history_tab_all',
  ranked: 'history_filter_ranked',
  unranked: 'history_filter_unranked',
};

export const MatchHistoryList: React.FC<MatchHistoryListProps> = ({
  language,
  perspectiveId,
  source,
  onViewProfile,
  idPrefix,
  onPageData,
  reloadKey = 0,
  onEmptyAction,
  className = '',
}) => {
  const [tab, setTab] = useState<HistoryTab>('all');
  const [ranked, setRanked] = useState<RankedFilter>('all');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<MatchRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read through a ref so a host re-rendering (and rebuilding the callback)
  // does not retrigger the fetch effect.
  const onPageDataRef = useRef(onPageData);
  onPageDataRef.current = onPageData;

  const sourceKey = source.kind === 'me' ? 'me' : source.playerId;
  const fetchPage = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const base =
        sourceKey === 'me'
          ? '/api/matches/me'
          : `/api/profile/${encodeURIComponent(sourceKey)}/matches`;
      const params = new URLSearchParams({ tab, page: String(page) });
      if (ranked !== 'all') params.set('ranked', ranked);
      const res = await fetch(`${base}?${params.toString()}`);
      if (!res.ok) throw new Error(t('history_load_failed', language));
      const data = await res.json();
      const matches: MatchRecord[] = data.matches || [];
      setRows(matches);
      setTotal(Number.isFinite(data.total) ? data.total : matches.length);
      if (Number.isFinite(data.pageSize) && data.pageSize > 0) setPageSize(data.pageSize);
      onPageDataRef.current?.(matches);
    } catch (err: any) {
      setError(err?.message || t('history_load_failed', language));
    } finally {
      setIsLoading(false);
    }
  }, [sourceKey, tab, ranked, page, language, reloadKey]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  // A filter change resets to page 1, but the data can also shrink under the
  // page we are on (retention, another device recording). Walk back instead
  // of showing a stranded empty page.
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const selectTab = (next: HistoryTab) => {
    if (next === tab) return;
    setTab(next);
    setRanked('all');
    setPage(1);
  };
  const selectRanked = (next: RankedFilter) => {
    if (next === ranked) return;
    setRanked(next);
    setPage(1);
  };

  const formatDate = (isoString: string) => {
    try {
      return new Date(isoString).toLocaleDateString(language, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  const unfiltered = tab === 'all' && ranked === 'all';

  return (
    <div className={`flex flex-col gap-2.5 ${className}`}>
      {/* Mode tabs */}
      <div
        role="tablist"
        aria-label={t('history_filter_label', language)}
        className="grid grid-cols-4 gap-1 rounded-card border border-line bg-surface-1 p-1"
      >
        {TABS.map((entry) => {
          const selected = tab === entry.id;
          return (
            <button
              key={entry.id}
              id={`${idPrefix}-tab-${entry.id}`}
              role="tab"
              aria-selected={selected}
              data-selected={selected ? 'true' : 'false'}
              onClick={() => selectTab(entry.id)}
              className={`min-h-8 rounded-ctl px-1 py-1.5 text-2xs transition-colors ${
                selected
                  ? 'bg-accent text-ink-on-accent'
                  : 'text-ink-muted hover:bg-surface-3 hover:text-ink'
              }`}
            >
              {t(entry.labelKey, language)}
            </button>
          );
        })}
      </div>

      {/* Ranked sub-filter — only where it can distinguish anything. Practice
          rows are all unranked by construction, and 'all' spans modes. */}
      {(tab === 'pvp' || tab === 'solo') && (
        <SegmentedControl
          columns={3}
          ariaLabel={t('history_filter_label', language)}
          value={ranked}
          onChange={selectRanked}
          options={RANKED_FILTERS.map((f) => ({
            value: f,
            id: `${idPrefix}-sub-${f}`,
            label: t(RANKED_FILTER_KEY[f], language),
          }))}
        />
      )}

      {isLoading && rows.length === 0 ? (
        <div className="space-y-3 py-16 text-center text-ink-muted">
          <RefreshCw className="mx-auto h-8 w-8 animate-spin text-accent" data-motion-essential />
          <p className="text-2xs font-normal tracking-normal">{t('history_loading', language)}</p>
        </div>
      ) : error ? (
        <Panel accent="loss" className="space-y-2 bg-loss/10 text-center text-ink">
          <p className="text-2xs font-normal tracking-normal">{error}</p>
          <Button size="sm" variant="danger" onClick={() => void fetchPage()}>
            {t('retry', language)}
          </Button>
        </Panel>
      ) : rows.length === 0 ? (
        <div className="space-y-3 py-12 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-card border border-line bg-surface-3 text-ink-dim">
            <Swords className="h-7 w-7" />
          </div>
          {unfiltered ? (
            <>
              <div className="space-y-1">
                <p className="text-2xs text-ink">{t('history_empty_title', language)}</p>
                <p className="mx-auto max-w-xs text-2xs font-normal tracking-normal text-ink-dim">
                  {t('history_empty_desc', language)}
                </p>
              </div>
              {onEmptyAction && (
                <Button size="md" variant="primary" onClick={onEmptyAction}>
                  {t('history_empty_cta', language)}
                </Button>
              )}
            </>
          ) : (
            <p className="mx-auto max-w-xs text-2xs font-normal tracking-normal text-ink-dim">
              {t('history_empty_filtered', language)}
            </p>
          )}
        </div>
      ) : (
        <>
          {rows.map((match, idx) => {
            const isPractice = match.mode === 'practice';
            const isWinner = match.winnerId === perspectiveId;
            const isP1 = match.player1Id === perspectiveId;
            const playerScore = isP1 ? match.scoreP1 : match.scoreP2;
            const opponentScore = isP1 ? match.scoreP2 : match.scoreP1;
            const opponentPlayerId = isP1 ? match.player2Id : match.player1Id;
            // A player who deleted their account leaves this row behind — it
            // is this player's own record of a game they really played — with
            // the pointers into the deleted account scrubbed. The stored name
            // is an English fallback for a client that predates this; here it
            // becomes the localized label. isLinkableId already refuses the
            // id, so the name is not a tap target either.
            const opponentDeleted = opponentPlayerId === DELETED_PLAYER_ID;
            const opponentDisplayName = opponentDeleted
              ? t('history_deleted_player', language)
              : isP1
              ? match.player2Name
              : match.player1Name;
            const opponentLinkable = onViewProfile && isLinkableId(opponentPlayerId);

            return (
              <Panel
                key={match.id || `match-${idx}`}
                id={`${idPrefix}-record-${match.id || idx}`}
                accent={isPractice ? 'neutral' : isWinner ? 'win' : 'loss'}
                className={`flex flex-col gap-2 ${
                  isPractice ? '' : isWinner ? 'bg-win/8' : 'bg-loss/8'
                }`}
              >
                {/* Result, mode and date */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {/* A wall session has no winner, so no W/L chip. */}
                    {!isPractice && (
                      <span
                        className={`rounded-chip border px-2 py-0.5 text-2xs ${
                          isWinner
                            ? 'border-win/40 bg-win/20 text-win'
                            : 'border-loss/40 bg-loss/20 text-loss'
                        }`}
                      >
                        {t(isWinner ? 'result_win' : 'result_loss', language)}
                      </span>
                    )}

                    <span className="flex items-center gap-1 rounded-chip border border-line bg-surface-3 px-2 py-0.5 text-2xs font-normal tracking-normal text-ink-muted uppercase">
                      {match.mode === 'multiplayer' ? (
                        <>
                          <Smartphone className="h-3 w-3 text-accent" />
                          {t('history_mode_duel', language)}
                        </>
                      ) : isPractice ? (
                        <>
                          <Target className="h-3 w-3 text-win" />
                          {t('history_practice', language)}
                        </>
                      ) : (
                        <>
                          <Cpu className="h-3 w-3 text-violet-400" />
                          {t('history_mode_solo', language, {
                            difficulty: match.difficulty || 'AI',
                          })}
                        </>
                      )}
                    </span>

                    {/* Only a positive verdict gets a chip: 0 and the NULL of
                        a legacy row both mean "did not move the ladder". */}
                    {match.ranked === 1 && (
                      <span className="rounded-chip border border-accent/40 bg-accent/12 px-2 py-0.5 text-2xs text-accent uppercase">
                        {t('history_filter_ranked', language)}
                      </span>
                    )}
                  </div>

                  <span className="flex shrink-0 items-center gap-1 text-2xs font-normal tracking-normal text-ink-dim">
                    <Calendar className="h-3 w-3" />
                    {formatDate(match.timestamp)}
                  </span>
                </div>

                {/* Opponent and final score — a practice session has neither,
                    only the streak the visit reached. */}
                <div className="flex items-center justify-between gap-2 px-1">
                  {isPractice ? (
                    <span className="text-2xs font-normal tracking-normal text-ink-muted">
                      {t('history_rally_hint', language)}
                    </span>
                  ) : (
                    <div className="flex min-w-0 flex-col">
                      <span className="text-2xs font-normal tracking-normal text-ink-muted">
                        {t('history_opponent', language)}
                      </span>
                      {opponentLinkable ? (
                        <button
                          id={`${idPrefix}-opponent-${match.id || idx}`}
                          onClick={() => onViewProfile!(opponentPlayerId)}
                          title={t('view_profile', language)}
                          className="max-w-[180px] truncate text-left text-2xs text-accent underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
                        >
                          {opponentDisplayName || t('history_anonymous', language)}
                        </button>
                      ) : (
                        <span className="max-w-[180px] truncate text-2xs text-ink">
                          {opponentDisplayName || t('history_anonymous', language)}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="flex shrink-0 items-center gap-2">
                    <div
                      className="flex items-center gap-1 rounded-ctl border border-line bg-surface-3 px-2 py-1 text-2xs"
                      title={t('history_rally_hint', language)}
                    >
                      <Flame className="h-3.5 w-3.5 fill-warn text-warn" />
                      <span className="tnum text-warn">{match.maxRally}</span>
                    </div>

                    {!isPractice && (
                      <div className="flex items-center gap-1.5 rounded-ctl border border-line bg-surface-1 px-3 py-1 text-title tnum">
                        <span className={isWinner ? 'text-win' : 'text-ink-muted'}>
                          {playerScore}
                        </span>
                        <span className="text-2xs text-ink-dim">-</span>
                        <span className={!isWinner ? 'text-loss' : 'text-ink-muted'}>
                          {opponentScore}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
            );
          })}

          <div className="flex flex-col items-center gap-1 pt-1">
            <Pagination
              page={page}
              pageCount={pageCount}
              onPage={setPage}
              idPrefix={idPrefix}
              language={language}
            />
            {pageCount > 1 && (
              <span
                id={`${idPrefix}-page-label`}
                className="text-2xs font-normal tracking-normal text-ink-dim"
              >
                {t('history_page_label', language, {
                  page: String(page),
                  pages: String(pageCount),
                })}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
};
