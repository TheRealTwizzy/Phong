import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { MatchRecord } from '../types';
import { ThemeConfig } from '../game/themes';
import { isLinkableId } from '../profileRules';
import {
  X,
  History,
  Trophy,
  Flame,
  Swords,
  Calendar,
  RefreshCw,
  Award,
  Smartphone,
  Cpu,
  Target,
  Gamepad2,
  TrendingUp,
} from 'lucide-react';

interface MatchHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  playerId: string;
  theme: ThemeConfig;
  // Tapping an opponent's username opens their public profile (only offered
  // for real player ids — AI pseudo-opponents have none).
  onViewProfile?: (id: string) => void;
}

export const MatchHistoryModal: React.FC<MatchHistoryModalProps> = ({
  isOpen,
  onClose,
  playerId,
  theme,
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

  if (!isOpen) return null;

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

  return (
    <AnimatePresence>
      <div
        id="match-history-modal-overlay"
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
      >
        <motion.div
          id="match-history-container"
          initial={{ opacity: 0, scale: 0.94, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.94, y: 15 }}
          className="bg-slate-900 border rounded-3xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col max-h-sheet text-slate-100"
          style={{
            borderColor: theme.accentColor + '50',
            boxShadow: `0 0 35px ${theme.accentColor}20`,
          }}
        >
          {/* Header Banner */}
          <div
            className="p-5 border-b flex items-center justify-between relative"
            style={{
              backgroundColor: '#0f172a',
              borderColor: theme.courtBorder + '30',
            }}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center border"
                style={{
                  backgroundColor: theme.accentColor + '15',
                  borderColor: theme.accentColor + '40',
                  color: theme.accentColor,
                }}
              >
                <History className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-bold font-mono tracking-wide text-white flex items-center gap-2">
                  MATCH HISTORY
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-sans font-semibold bg-slate-800 text-slate-400 border border-slate-700">
                    Last 10 Matches
                  </span>
                </h2>
                <p className="text-xs text-slate-400">Chronological performance & combat log</p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                id="btn-refresh-match-history"
                onClick={fetchMatches}
                disabled={isLoading}
                title="Refresh match records"
                className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition active:scale-95 disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-cyan-400' : ''}`} />
              </button>

              <button
                id="btn-close-match-history"
                onClick={onClose}
                className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Quick Summary Cards */}
          {totalRecent > 0 && (
            <div className="grid grid-cols-3 gap-2 p-4 bg-slate-950/60 border-b border-slate-800/80">
              <div className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col items-center justify-center">
                <span className="text-[10px] text-slate-400 font-mono uppercase">Record</span>
                <span className="text-sm font-bold font-mono mt-0.5 text-white">
                  <span className="text-emerald-400">{winsCount}W</span> -{' '}
                  <span className="text-rose-400">{lossCount}L</span>
                </span>
              </div>

              <div className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col items-center justify-center">
                <span className="text-[10px] text-slate-400 font-mono uppercase">Win Rate</span>
                <span
                  className={`text-sm font-bold font-mono mt-0.5 ${
                    recentWinRate >= 60
                      ? 'text-emerald-400'
                      : recentWinRate >= 40
                      ? 'text-amber-400'
                      : 'text-rose-400'
                  }`}
                >
                  {recentWinRate}%
                </span>
              </div>

              <div className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col items-center justify-center">
                <span className="text-[10px] text-slate-400 font-mono uppercase">Peak Rally</span>
                <span className="text-sm font-bold font-mono mt-0.5 text-amber-400 flex items-center gap-1">
                  <Flame className="w-3.5 h-3.5 fill-amber-400" />
                  {maxRallyRecent}
                </span>
              </div>
            </div>
          )}

          {/* Matches List Content */}
          <div className="flex-1 scroll-y p-4 space-y-2.5">
            {isLoading && recent10Matches.length === 0 ? (
              <div className="py-16 text-center text-slate-400 space-y-3">
                <RefreshCw className="w-8 h-8 mx-auto animate-spin text-cyan-400" />
                <p className="text-sm font-mono">Fetching combat records from server...</p>
              </div>
            ) : error ? (
              <div className="p-4 rounded-xl bg-rose-950/30 border border-rose-800/50 text-rose-300 text-center text-xs space-y-2">
                <p>{error}</p>
                <button
                  onClick={fetchMatches}
                  className="px-3 py-1 bg-rose-900/60 hover:bg-rose-800 rounded-lg text-white font-mono"
                >
                  Retry
                </button>
              </div>
            ) : recent10Matches.length === 0 ? (
              <div className="py-16 text-center text-slate-400 space-y-3">
                <div className="w-14 h-14 mx-auto rounded-2xl bg-slate-800/80 border border-slate-700 flex items-center justify-center text-slate-500">
                  <Swords className="w-7 h-7" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-bold text-slate-200">No match records found</p>
                  <p className="text-xs text-slate-500 max-w-xs mx-auto">
                    Play Solo matches against the AI or 2-phone online matches to log your match history!
                  </p>
                </div>
                <button
                  onClick={onClose}
                  className="mt-2 px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs rounded-xl font-mono"
                >
                  Play First Match
                </button>
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
                  <div
                    key={match.id || `match-${idx}`}
                    id={`match-record-${match.id || idx}`}
                    className={`p-3.5 rounded-2xl border transition-all flex flex-col gap-2 relative overflow-hidden ${
                      isWinner
                        ? 'bg-emerald-950/20 border-emerald-500/30 hover:border-emerald-500/50'
                        : 'bg-rose-950/20 border-rose-500/30 hover:border-rose-500/50'
                    }`}
                  >
                    {/* Top Row: Result Badge, Mode & Date */}
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-2 py-0.5 rounded-md font-black text-[11px] font-mono tracking-wider ${
                            isWinner
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                              : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                          }`}
                        >
                          {isWinner ? 'VICTORY' : 'DEFEAT'}
                        </span>

                        <span className="flex items-center gap-1 text-[10px] font-mono text-slate-400 uppercase bg-slate-800/80 px-2 py-0.5 rounded-md border border-slate-700/60">
                          {match.mode === 'multiplayer' ? (
                            <>
                              <Smartphone className="w-3 h-3 text-cyan-400" />
                              2-Phone Online
                            </>
                          ) : match.mode === 'practice' ? (
                            <>
                              <Target className="w-3 h-3 text-emerald-400" />
                              Practice
                            </>
                          ) : (
                            <>
                              <Cpu className="w-3 h-3 text-purple-400" />
                              Solo vs {match.difficulty || 'AI'}
                            </>
                          )}
                        </span>
                      </div>

                      <span className="text-[10px] font-mono text-slate-500 flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {formatDate(match.timestamp)}
                      </span>
                    </div>

                    {/* Middle Row: Score Breakdown & Opponent */}
                    <div className="flex items-center justify-between px-1">
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs text-slate-400">Opponent</span>
                        {opponentLinkable ? (
                          <button
                            id={`btn-history-opponent-${match.id || idx}`}
                            onClick={() => onViewProfile!(opponentPlayerId)}
                            className="text-sm font-bold text-cyan-300 hover:text-cyan-200 underline decoration-dotted underline-offset-2 truncate max-w-[200px] text-left transition"
                            title="View profile"
                          >
                            {opponentDisplayName || 'Anonymous'}
                          </button>
                        ) : (
                          <span className="text-sm font-bold text-slate-200 truncate max-w-[200px]">
                            {opponentDisplayName || 'Anonymous'}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        {/* Max Rally */}
                        <div
                          className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800/80 border border-slate-700 text-xs font-mono"
                          title="Max rally count in this match"
                        >
                          <Flame className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                          <span className="text-amber-300 font-bold">{match.maxRally}</span>
                        </div>

                        {/* Final Score */}
                        <div className="flex items-center gap-1.5 font-mono text-lg font-black bg-slate-950/80 px-3 py-1 rounded-xl border border-slate-800">
                          <span className={isWinner ? 'text-emerald-400' : 'text-slate-300'}>
                            {playerScore}
                          </span>
                          <span className="text-slate-600 text-xs">-</span>
                          <span className={!isWinner ? 'text-rose-400' : 'text-slate-400'}>
                            {opponentScore}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer */}
          <div className="p-4 bg-slate-950/80 border-t border-slate-800 flex items-center justify-between text-xs">
            <span className="text-slate-500 font-mono">
              Server-Synchronized Match Log
            </span>
            <button
              id="btn-dismiss-match-history"
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold font-mono rounded-xl transition"
            >
              Close
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
