import React, { useState } from 'react';
import { LanguageCode } from '../types';
import { t } from '../i18n/translations';
import { LeaderboardList } from './LeaderboardList';
import { useArrivalRefetch } from './useArrivalRefetch';
import { RefreshCw } from 'lucide-react';

// The RANKS page. `LeaderboardList` owns the categories, the bots toggle and
// the rows; the title, the refresh and the closing caption live here, carried
// across from the sheet this replaced.
//
// Same reason the History page has one: the list refetches on a `reloadKey` it
// does not own, so a host has to hold it or there is no way to ask the board
// again short of leaving the page and coming back.
//
// That key is also what an ARRIVAL spends. A pager page stays mounted while it
// is a neighbour, so its fetch fired when it slid into the window and never
// again; becoming current is simply another press of the refresh button, and
// needs no second concept to say so.

export interface RanksPageProps {
  language: LanguageCode;
  currentPlayerId: string;
  onViewProfile?: (id: string) => void;
  /** The page the pager is showing, not merely one it has mounted. */
  isCurrent: boolean;
}

export const RanksPage: React.FC<RanksPageProps> = ({
  language,
  currentPlayerId,
  onViewProfile,
  isCurrent,
}) => {
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = () => setReloadKey((k) => k + 1);

  useArrivalRefetch(isCurrent, refresh);

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="text-title truncate">{t('board_title', language)}</h2>
        <button
          id="btn-refresh-leaderboard"
          onClick={refresh}
          title={t('board_refresh', language)}
          aria-label={t('board_refresh', language)}
          className="shrink-0 rounded-ctl border border-line bg-surface-3 p-2 text-ink-muted transition-colors hover:text-ink"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      <LeaderboardList
        language={language}
        currentPlayerId={currentPlayerId}
        onViewProfile={onViewProfile}
        active
        reloadKey={reloadKey}
      />

      <p className="shrink-0 pt-1 text-center text-2xs font-normal tracking-normal text-ink-muted">
        {t('board_footer', language)}
      </p>
    </>
  );
};
