import React, { useState } from 'react';
import { MatchRecord, LanguageCode } from '../types';
import { t } from '../i18n/translations';
import { Sheet, Button, StatTile } from './ui';
import { MatchHistoryList } from './MatchHistoryList';
import { X, History, Flame, RefreshCw } from 'lucide-react';

// The player's own history. The list itself — tabs, ranked sub-filter,
// pagination, the rows — is MatchHistoryList, shared with the profile sheet
// and the public profile view; this modal owns only the Sheet chrome and the
// summary tiles over whatever page the list is showing.

interface MatchHistoryModalProps {
  language: LanguageCode;
  isOpen: boolean;
  onClose: () => void;
  playerId: string;
  // Tapping an opponent's username opens their public profile (only offered
  // for real player ids — AI pseudo-opponents have none).
  onViewProfile?: (id: string) => void;
}

export const MatchHistoryModal: React.FC<MatchHistoryModalProps> = ({
  language,
  isOpen,
  onClose,
  playerId,
  onViewProfile,
}) => {
  const [pageRows, setPageRows] = useState<MatchRecord[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  // Summary over the page on screen — the tiles describe what the player is
  // looking at, filters included, not a fixed "last 10" that the tabs would
  // silently stop being true for. Practice sessions have no winner, so they
  // count toward neither column.
  const decided = pageRows.filter((m) => m.mode !== 'practice');
  const winsCount = decided.filter((m) => m.winnerId === playerId).length;
  const lossCount = decided.length - winsCount;
  const recentWinRate = decided.length > 0 ? Math.round((winsCount / decided.length) * 100) : 0;
  const maxRallyRecent = pageRows.reduce((max, m) => Math.max(max, m.maxRally || 0), 0);

  const header = (
    <div className="shrink-0 border-b border-line bg-surface-1 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-card border border-accent/40 bg-accent/12 p-2.5 text-accent">
            <History className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-title">{t('match_history_title', language)}</h2>
            <p className="text-2xs font-normal tracking-normal text-ink-muted">
              {t('history_subtitle', language)}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            id="btn-refresh-match-history"
            onClick={() => setReloadKey((k) => k + 1)}
            title={t('history_refresh', language)}
            aria-label={t('history_refresh', language)}
            className="rounded-ctl border border-line bg-surface-3 p-2 text-ink-muted transition-colors hover:text-ink"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            id="btn-close-match-history"
            onClick={onClose}
            aria-label={t('history_close', language)}
            className="rounded-ctl border border-line bg-surface-3 p-2 text-ink-muted transition-colors hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {pageRows.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2">
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
    </div>
  );

  const footer = (
    <>
      <span className="flex-1 text-2xs font-normal tracking-normal text-ink-muted">
        {t('history_footer', language)}
      </span>
      <Button id="btn-dismiss-match-history" size="sm" variant="secondary" onClick={onClose}>
        {t('close', language)}
      </Button>
    </>
  );

  return (
    <Sheet
      id="match-history-modal-overlay"
      cardId="match-history-container"
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      accent="accent"
      header={header}
      footer={footer}
      bodyClassName="p-3"
    >
      {isOpen && (
        <MatchHistoryList
          language={language}
          perspectiveId={playerId}
          source={{ kind: 'me' }}
          onViewProfile={onViewProfile}
          idPrefix="history"
          onPageData={setPageRows}
          reloadKey={reloadKey}
          onEmptyAction={onClose}
        />
      )}
    </Sheet>
  );
};
