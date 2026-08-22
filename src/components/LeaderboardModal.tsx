import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { LeaderboardEntry } from '../types';
import { AvatarImage } from './AvatarImage';
import { TierBadge } from './TierBadge';
import { X, Trophy, Crown, Medal, RefreshCw } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentPlayerId: string;
  // Tapping any row opens that player's public profile.
  onViewProfile?: (id: string) => void;
}

type SortCategory = 'elo' | 'level' | 'rally' | 'wins';

export const LeaderboardModal: React.FC<Props> = ({
  isOpen,
  onClose,
  currentPlayerId,
  onViewProfile,
}) => {
  const [category, setCategory] = useState<SortCategory>('elo');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  // Bot rankings hidden by default; showing them never changes a human's rank
  const [showBots, setShowBots] = useState(false);

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

  if (!isOpen) return null;

  const renderRankBadge = (rank: number | null) => {
    if (rank === null) {
      return (
        <div className="w-8 h-8 rounded-full bg-violet-500/15 border border-violet-400/40 flex items-center justify-center text-violet-300 text-[9px] font-black font-mono">
          BOT
        </div>
      );
    }
    if (rank === 1) {
      return (
        <div className="w-8 h-8 rounded-full bg-amber-400/20 border border-amber-400/50 flex items-center justify-center text-amber-300">
          <Crown className="w-4 h-4 fill-amber-400" />
        </div>
      );
    }
    if (rank === 2) {
      return (
        <div className="w-8 h-8 rounded-full bg-slate-300/20 border border-slate-300/50 flex items-center justify-center text-slate-200">
          <Medal className="w-4 h-4" />
        </div>
      );
    }
    if (rank === 3) {
      return (
        <div className="w-8 h-8 rounded-full bg-amber-700/20 border border-amber-700/50 flex items-center justify-center text-amber-600">
          <Medal className="w-4 h-4" />
        </div>
      );
    }
    return (
      <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 text-xs font-bold font-mono">
        #{rank}
      </div>
    );
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
        <motion.div
          id="leaderboard-modal-container"
          initial={{ opacity: 0, scale: 0.92, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, y: 20 }}
          className="bg-slate-900 border border-amber-500/30 rounded-3xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col max-h-sheet"
        >
          {/* Header */}
          <div className="p-6 bg-gradient-to-r from-amber-950/60 via-slate-900 to-indigo-950/60 border-b border-slate-800 relative">
            <button
              id="close-leaderboard-btn"
              onClick={onClose}
              className="absolute top-4 right-4 p-2 text-slate-400 hover:text-white rounded-full hover:bg-white/10 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-2xl bg-amber-400/10 border border-amber-400/30 text-amber-400">
                <Trophy className="w-7 h-7" />
              </div>
              <div>
                <h2 className="text-xl font-black text-white">Global Leaderboard</h2>
                <p className="text-xs text-slate-400">Live rankings and competitive player records</p>
              </div>
            </div>

            {/* Filter Tabs */}
            <div className="grid grid-cols-4 gap-1.5 mt-5 bg-slate-950/70 p-1 rounded-xl border border-slate-800">
              <button
                id="filter-leaderboard-elo"
                onClick={() => setCategory('elo')}
                className={`py-1.5 px-2 rounded-lg text-xs font-bold transition-all ${
                  category === 'elo'
                    ? 'bg-amber-400 text-slate-950 shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Skill Tier
              </button>
              <button
                id="filter-leaderboard-level"
                onClick={() => setCategory('level')}
                className={`py-1.5 px-2 rounded-lg text-xs font-bold transition-all ${
                  category === 'level'
                    ? 'bg-amber-400 text-slate-950 shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Level / XP
              </button>
              <button
                id="filter-leaderboard-rally"
                onClick={() => setCategory('rally')}
                className={`py-1.5 px-2 rounded-lg text-xs font-bold transition-all ${
                  category === 'rally'
                    ? 'bg-amber-400 text-slate-950 shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Top Rally
              </button>
              <button
                id="filter-leaderboard-wins"
                onClick={() => setCategory('wins')}
                className={`py-1.5 px-2 rounded-lg text-xs font-bold transition-all ${
                  category === 'wins'
                    ? 'bg-amber-400 text-slate-950 shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Victories
              </button>
            </div>

            {/* Bot visibility toggle — bots never affect human ranks */}
            <label
              id="toggle-show-bots"
              className="flex items-center justify-between mt-2.5 px-1 text-[11px] font-mono text-slate-400 cursor-pointer select-none"
              title="Bots are ranked separately and never change a human player's rank"
            >
              <span>Show AI bot rankings</span>
              <input
                type="checkbox"
                checked={showBots}
                onChange={(e) => setShowBots(e.target.checked)}
                className="accent-violet-500 w-4 h-4"
              />
            </label>
          </div>

          {/* List Content */}
          <div className="p-4 scroll-y flex-1 space-y-2">
            {isLoading ? (
              <div className="text-center py-12 text-slate-400 text-sm flex items-center justify-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin text-amber-400" />
                <span>Fetching rankings...</span>
              </div>
            ) : entries.length === 0 ? (
              <div className="text-center py-12 text-slate-500 text-sm">
                No ranking entries found. Be the first to claim the top spot!
              </div>
            ) : (
              entries.map((entry) => {
                const isMe = entry.id === currentPlayerId;
                return (
                  <button
                    key={entry.id}
                    id={`leaderboard-row-${entry.id}`}
                    onClick={() => onViewProfile?.(entry.id)}
                    className={`w-full text-left flex items-center justify-between p-3 rounded-2xl border transition-all active:scale-[0.99] ${
                      isMe
                        ? 'bg-amber-500/10 border-amber-400/50 shadow-md shadow-amber-500/10'
                        : 'bg-slate-800/40 border-slate-800 hover:bg-slate-800/70'
                    }`}
                    title="View profile"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {renderRankBadge(entry.rank)}
                      <AvatarImage
                        playerId={entry.id}
                        hasAvatar={Boolean(entry.avatarVersion)}
                        avatarVersion={entry.avatarVersion}
                        size={32}
                        className="rounded-lg border border-white/10"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-bold truncate ${isMe ? 'text-amber-300' : 'text-white'}`}>
                            {entry.username}
                          </span>
                          {isMe && (
                            <span className="text-[10px] uppercase font-black px-1.5 py-0.5 rounded bg-amber-400 text-slate-950">
                              YOU
                            </span>
                          )}
                          {entry.isBot && (
                            <span className="text-[10px] uppercase font-black px-1.5 py-0.5 rounded bg-violet-500/25 text-violet-300 border border-violet-400/40">
                              BOT
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 flex items-center gap-2">
                          <span className="text-cyan-300 font-semibold">LV {entry.level}</span>
                          <span>•</span>
                          <span>{entry.winRate}% Win Rate</span>
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      {category === 'elo' && (
                        <div className="flex flex-col items-end gap-0.5">
                          <TierBadge tier={entry.tier} />
                          <div className="text-[10px] text-slate-400 uppercase font-medium">
                            {entry.rankedGames} ranked
                          </div>
                        </div>
                      )}
                      {category === 'level' && (
                        <div>
                          <div className="text-sm font-black text-cyan-400">{entry.xp.toLocaleString()} XP</div>
                          <div className="text-[10px] text-slate-400 uppercase font-medium">Level {entry.level}</div>
                        </div>
                      )}
                      {category === 'rally' && (
                        <div>
                          <div className="text-sm font-black text-orange-400">{entry.highestRally} Hits</div>
                          <div className="text-[10px] text-slate-400 uppercase font-medium">Max Rally</div>
                        </div>
                      )}
                      {category === 'wins' && (
                        <div>
                          <div className="text-sm font-black text-emerald-400">{entry.matchesWon} Won</div>
                          <div className="text-[10px] text-slate-400 uppercase font-medium">
                            {entry.matchesPlayed} Played
                          </div>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Footer */}
          <div className="p-4 bg-slate-950 border-t border-slate-800 flex items-center justify-between">
            <span className="text-xs text-slate-400">Updates live after every completed match</span>
            <button
              onClick={() => fetchLeaderboard(category, showBots)}
              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
