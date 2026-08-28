import React, { useState } from 'react';
import { LanguageCode } from '../types';
import { t } from '../i18n/translations';
import { LeaderboardList } from './LeaderboardList';
import { Sheet, Button } from './ui';
import { X, Trophy, RefreshCw } from 'lucide-react';

// The chrome around `LeaderboardList` — title, close, refresh — and nothing
// else. The categories and the bots toggle moved into the list itself, where
// the state they drive already lived; `MatchHistoryList` has always worked this
// way, and it is what lets the same list render inside a sheet or as a page
// without either one having to know about a filter.
//
// Note the consequence: those controls now scroll with the rows instead of
// sitting pinned in the header. No suite reads them (`#filter-leaderboard-*`
// and `#toggle-show-bots` appear in none), so this is a visual change with no
// test to catch it — it is called out here rather than left to be noticed.

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentPlayerId: string;
  // Tapping any row opens that player's public profile.
  onViewProfile?: (id: string) => void;
  language: LanguageCode;
}

export const LeaderboardModal: React.FC<Props> = ({
  isOpen,
  onClose,
  currentPlayerId,
  onViewProfile,
  language,
}) => {
  // The refresh button lives out here in the footer while the fetch lives in
  // the list, so the two talk through a counter rather than through a ref.
  const [reloadKey, setReloadKey] = useState(0);

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
    </div>
  );

  const footer = (
    <>
      <span className="flex-1 text-2xs font-normal tracking-normal text-ink-muted">
        {t('board_footer', language)}
      </span>
      <Button
        id="btn-refresh-leaderboard"
        size="sm"
        variant="secondary"
        icon={<RefreshCw className="w-3.5 h-3.5" />}
        onClick={() => setReloadKey((k) => k + 1)}
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
      <LeaderboardList
        language={language}
        currentPlayerId={currentPlayerId}
        onViewProfile={onViewProfile}
        active={isOpen}
        reloadKey={reloadKey}
      />
    </Sheet>
  );
};
