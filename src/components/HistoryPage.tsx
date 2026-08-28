import React, { useState } from 'react';
import { LanguageCode, MatchRecord } from '../types';
import { t } from '../i18n/translations';
import { MatchHistoryList } from './MatchHistoryList';
import { useArrivalRefetch } from './useArrivalRefetch';
import { StatTile } from './ui';
import { Flame, RefreshCw } from 'lucide-react';

// The HISTORY page. `MatchHistoryList` owns the tabs, the filter and the
// paging; what lives here is the chrome the retired sheet used to carry — the
// title, the refresh, the summary tiles and the closing caption.
//
// Two of those are not decoration, and both were dropped for a moment when the
// sheet was retired:
//
//  - The refresh. The list refetches on a `reloadKey` it does not own, so
//    without a host holding one there is no way to ask the server again at
//    all. `e2e-history` caught this by timing out on a control that had
//    stopped existing.
//  - The tiles. They read the page ON SCREEN through `onPageData` — filters
//    included — rather than a fixed "last 10" the tabs would quietly stop
//    being true for. NOTHING tested them, so deleting them was silent; they
//    came back because `tests/i18n.test.ts` reported `history_record` and
//    `history_peak_rally` as keys the product had stopped asking for, which is
//    the dead-weight check doing a job it was not written for.
//
// The refresh key does double duty: a pager page stays mounted while it is a
// neighbour, so its fetch fired when it slid into the window and never again.
// Arriving on the page is simply another press of that button.

export interface HistoryPageProps {
  language: LanguageCode;
  playerId: string;
  onViewProfile?: (id: string) => void;
  /** The page the pager is showing, not merely one it has mounted. */
  isCurrent: boolean;
}

export const HistoryPage: React.FC<HistoryPageProps> = ({
  language,
  playerId,
  onViewProfile,
  isCurrent,
}) => {
  const [pageRows, setPageRows] = useState<MatchRecord[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = () => setReloadKey((k) => k + 1);

  useArrivalRefetch(isCurrent, refresh);

  // Summary over the page on screen — the tiles describe what the player is
  // looking at, filters included, not a fixed "last 10" that the tabs would
  // silently stop being true for. Practice sessions have no winner, so they
  // count toward neither column.
  const decided = pageRows.filter((m) => m.mode !== 'practice');
  const winsCount = decided.filter((m) => m.winnerId === playerId).length;
  const lossCount = decided.length - winsCount;
  const recentWinRate = decided.length > 0 ? Math.round((winsCount / decided.length) * 100) : 0;
  const maxRallyRecent = pageRows.reduce((max, m) => Math.max(max, m.maxRally || 0), 0);

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="text-title truncate">{t('match_history_title', language)}</h2>
        <button
          id="btn-refresh-match-history"
          onClick={refresh}
          title={t('history_refresh', language)}
          aria-label={t('history_refresh', language)}
          className="shrink-0 rounded-ctl border border-line bg-surface-3 p-2 text-ink-muted transition-colors hover:text-ink"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {pageRows.length > 0 && (
        <div className="grid shrink-0 grid-cols-3 gap-2">
          <StatTile
            label={t('history_record', language)}
            value={
              <span>
                <span className="text-win">{winsCount}W</span>
                <span className="text-ink-dim"> - </span>
                <span className="text-loss">{lossCount}L</span>
              </span>
            }
          />
          <StatTile
            label={t('win_rate', language)}
            value={`${recentWinRate}%`}
            tone={recentWinRate >= 60 ? 'win' : recentWinRate >= 40 ? 'warn' : 'loss'}
          />
          <StatTile
            label={t('history_peak_rally', language)}
            value={maxRallyRecent}
            tone="warn"
            icon={<Flame className="h-3.5 w-3.5 fill-current" />}
          />
        </div>
      )}

      <MatchHistoryList
        language={language}
        perspectiveId={playerId}
        source={{ kind: 'me' }}
        onViewProfile={onViewProfile}
        idPrefix="history"
        onPageData={setPageRows}
        reloadKey={reloadKey}
      />

      <p className="shrink-0 pt-1 text-center text-2xs font-normal tracking-normal text-ink-muted">
        {t('history_footer', language)}
      </p>
    </>
  );
};
