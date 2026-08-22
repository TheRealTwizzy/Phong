import React, { useState, useEffect, useCallback } from 'react';
import { MatchRecord } from '../types';
import { isLinkableId } from '../profileRules';
import { Sheet, Button, Panel, StatTile } from './ui';
import {
  X,
  History,
  Flame,
  Swords,
  Calendar,
  RefreshCw,
  Smartphone,
  Cpu,
  Target,
} from 'lucide-react';

interface MatchHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  playerId: string;
  // Tapping an opponent's username opens their public profile (only offered
  // for real player ids — AI pseudo-opponents have none).
  onViewProfile?: (id: string) => void;
}

export const MatchHistoryModal: React.FC<MatchHistoryModalProps> = ({
  isOpen,
  onClose,
  playerId,
  onViewProfile,
}) => {
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMatches = useCallback(async () => {
    if (!playerId) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/matches/me');
      if (!res.ok) throw new Error('Failed to fetch match history');
      const data = await res.json();
      setMatches(data.matches || []);
    } catch (err: any) {
      setError(err.message || 'Could not load match records');
    } finally {
      setIsLoading(false);
    }
  }, [playerId]);

  useEffect(() => {
    if (isOpen) {
      fetchMatches();
    }
  }, [isOpen, fetchMatches]);

  // Take the most recent 10 matches
  const recent10Matches = matches.slice(0, 10);

  // Compute summary stats over recent matches
  const totalRecent = recent10Matches.length;
  const winsCount = recent10Matches.filter((m) => m.winnerId === playerId).length;
  const lossCount = totalRecent - winsCount;
  const recentWinRate = totalRecent > 0 ? Math.round((winsCount / totalRecent) * 100) : 0;
  const maxRallyRecent = recent10Matches.reduce((max, m) => Math.max(max, m.maxRally || 0), 0);

  const formatDate = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  const header = (
    <div className="shrink-0 border-b border-line bg-surface-1 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-card border border-accent/40 bg-accent/12 p-2.5 text-accent">
            <History className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-title">
              MATCH HISTORY
              <span className="rounded-chip border border-line bg-surface-3 px-1.5 py-0.5 text-2xs font-normal tracking-normal text-ink-muted">
                Last 10
              </span>
            </h2>
            <p className="text-2xs font-normal tracking-normal text-ink-muted">
              Chronological performance &amp; combat log
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            id="btn-refresh-match-history"
            onClick={fetchMatches}
            disabled={isLoading}
            title="Refresh match records"
            aria-label="Refresh match records"
            className="rounded-ctl border border-line bg-surface-3 p-2 text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${isLoading ? 'animate-spin text-accent' : ''}`}
              data-motion-essential
            />
          </button>
          <button
            id="btn-close-match-history"
            onClick={onClose}
            aria-label="Close match history"
            className="rounded-ctl border border-line bg-surface-3 p-2 text-ink-muted transition-colors hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {totalRecent > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <StatTile
            label="Record"
            value={
              <span>
                <span className="text-win">{winsCount}W</span>
                <span className="text-ink-dim"> - </span>
                <span className="text-loss">{lossCount}L</span>
              </span>
            }
          />
          <StatTile
            label="Win Rate"
            value={`${recentWinRate}%`}
            tone={recentWinRate >= 60 ? 'win' : recentWinRate >= 40 ? 'warn' : 'loss'}
          />
          <StatTile
            label="Peak Rally"
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
        Server-synchronized match log
      </span>
      <Button id="btn-dismiss-match-history" size="sm" variant="secondary" onClick={onClose}>
        Close
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
      bodyClassName="p-3 space-y-2.5"
    >
      {isLoading && recent10Matches.length === 0 ? (
        <div className="space-y-3 py-16 text-center text-ink-muted">
          <RefreshCw
            className="mx-auto h-8 w-8 animate-spin text-accent"
            data-motion-essential
          />
          <p className="text-2xs font-normal tracking-normal">
            Fetching combat records from server...
          </p>
        </div>
      ) : error ? (
        <Panel accent="loss" className="space-y-2 bg-loss/10 text-center text-ink">
          <p className="text-2xs font-normal tracking-normal">{error}</p>
          <Button size="sm" variant="danger" onClick={fetchMatches}>
            Retry
          </Button>
        </Panel>
      ) : recent10Matches.length === 0 ? (
        <div className="space-y-3 py-16 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-card border border-line bg-surface-3 text-ink-dim">
            <Swords className="h-7 w-7" />
          </div>
          <div className="space-y-1">
            <p className="text-2xs text-ink">No match records found</p>
            <p className="mx-auto max-w-xs text-2xs font-normal tracking-normal text-ink-dim">
              Play solo matches against the AI or 2-phone online matches to log your match
              history.
            </p>
          </div>
          <Button size="md" variant="primary" onClick={onClose}>
            Play First Match
          </Button>
        </div>
      ) : (
        recent10Matches.map((match, idx) => {
          const isWinner = match.winnerId === playerId;
          const isP1 = match.player1Id === playerId;
          const playerScore = isP1 ? match.scoreP1 : match.scoreP2;
          const opponentScore = isP1 ? match.scoreP2 : match.scoreP1;
          const opponentDisplayName = isP1 ? match.player2Name : match.player1Name;
          const opponentPlayerId = isP1 ? match.player2Id : match.player1Id;
          const opponentLinkable = onViewProfile && isLinkableId(opponentPlayerId);

          return (
            <Panel
              key={match.id || `match-${idx}`}
              id={`match-record-${match.id || idx}`}
              accent={isWinner ? 'win' : 'loss'}
              className={`flex flex-col gap-2 ${isWinner ? 'bg-win/8' : 'bg-loss/8'}`}
            >
              {/* Result, mode and date */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`rounded-chip border px-2 py-0.5 text-2xs ${
                      isWinner
                        ? 'border-win/40 bg-win/20 text-win'
                        : 'border-loss/40 bg-loss/20 text-loss'
                    }`}
                  >
                    {isWinner ? 'VICTORY' : 'DEFEAT'}
                  </span>

                  <span className="flex items-center gap-1 rounded-chip border border-line bg-surface-3 px-2 py-0.5 text-2xs font-normal tracking-normal text-ink-muted uppercase">
                    {match.mode === 'multiplayer' ? (
                      <>
                        <Smartphone className="h-3 w-3 text-accent" />
                        2-Phone
                      </>
                    ) : match.mode === 'practice' ? (
                      <>
                        <Target className="h-3 w-3 text-win" />
                        Practice
                      </>
                    ) : (
                      <>
                        <Cpu className="h-3 w-3 text-violet-400" />
                        Solo vs {match.difficulty || 'AI'}
                      </>
                    )}
                  </span>
                </div>

                <span className="flex shrink-0 items-center gap-1 text-2xs font-normal tracking-normal text-ink-dim">
                  <Calendar className="h-3 w-3" />
                  {formatDate(match.timestamp)}
                </span>
              </div>

              {/* Opponent and final score */}
              <div className="flex items-center justify-between gap-2 px-1">
                <div className="flex min-w-0 flex-col">
                  <span className="text-2xs font-normal tracking-normal text-ink-muted">
                    Opponent
                  </span>
                  {opponentLinkable ? (
                    <button
                      id={`btn-history-opponent-${match.id || idx}`}
                      onClick={() => onViewProfile!(opponentPlayerId)}
                      title="View profile"
                      className="max-w-[180px] truncate text-left text-2xs text-accent underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
                    >
                      {opponentDisplayName || 'Anonymous'}
                    </button>
                  ) : (
                    <span className="max-w-[180px] truncate text-2xs text-ink">
                      {opponentDisplayName || 'Anonymous'}
                    </span>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <div
                    className="flex items-center gap-1 rounded-ctl border border-line bg-surface-3 px-2 py-1 text-2xs"
                    title="Max rally count in this match"
                  >
                    <Flame className="h-3.5 w-3.5 fill-warn text-warn" />
                    <span className="tnum text-warn">{match.maxRally}</span>
                  </div>

                  <div className="flex items-center gap-1.5 rounded-ctl border border-line bg-surface-1 px-3 py-1 text-title tnum">
                    <span className={isWinner ? 'text-win' : 'text-ink-muted'}>
                      {playerScore}
                    </span>
                    <span className="text-2xs text-ink-dim">-</span>
                    <span className={!isWinner ? 'text-loss' : 'text-ink-muted'}>
                      {opponentScore}
                    </span>
                  </div>
                </div>
              </div>
            </Panel>
          );
        })
      )}
    </Sheet>
  );
};
