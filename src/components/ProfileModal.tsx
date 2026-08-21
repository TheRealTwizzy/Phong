import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { PlayerProfile, MatchRecord, PlayerStatus } from '../types';
import {
  X,
  User,
  Trophy,
  Flame,
  Zap,
  TrendingUp,
  Award,
  Check,
  Edit2,
  Calendar,
  Swords,
  ShieldAlert,
  Radio,
  KeyRound,
  Copy,
} from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  profile: PlayerProfile | null;
  playerStatus?: PlayerStatus;
  onUpdateUsername: (newName: string) => Promise<void>;
  onRefreshProfile: () => void;
}

export const ProfileModal: React.FC<Props> = ({
  isOpen,
  onClose,
  profile,
  playerStatus = 'online',
  onUpdateUsername,
  onRefreshProfile,
}) => {
  const [isEditingName, setIsEditingName] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [claimCode, setClaimCode] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  const copyRecoveryCode = () => {
    if (!profile?.recoveryCode) return;
    navigator.clipboard
      ?.writeText(profile.recoveryCode)
      .then(() => {
        setCodeCopied(true);
        setTimeout(() => setCodeCopied(false), 2000);
      })
      .catch(() => {});
  };

  const handleClaim = async () => {
    if (!claimCode.trim() || claimBusy) return;
    if (
      profile &&
      profile.matchesPlayed > 0 &&
      !window.confirm(
        'Restoring another profile will replace the profile currently on this device (its stats will be lost). Continue?'
      )
    ) {
      return;
    }
    setClaimBusy(true);
    setClaimError(null);
    try {
      const res = await fetch('/api/profile/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: claimCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setClaimError(data.error || 'Could not restore profile');
        return;
      }
      localStorage.setItem('half_pong_player_name', data.username);
      // Identity swapped server-side; reload so every view reflects it
      window.location.reload();
    } catch {
      setClaimError('Network error — try again');
    } finally {
      setClaimBusy(false);
    }
  };
  const [tempName, setTempName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'stats' | 'history'>('stats');
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [isLoadingMatches, setIsLoadingMatches] = useState(false);

  useEffect(() => {
    if (profile) {
      setTempName(profile.username);
    }
  }, [profile]);

  useEffect(() => {
    if (isOpen && profile && activeTab === 'history') {
      setIsLoadingMatches(true);
      fetch('/api/matches/me')
        .then((res) => res.json())
        .then((data) => {
          setMatches(data.matches || []);
        })
        .catch(console.error)
        .finally(() => setIsLoadingMatches(false));
    }
  }, [isOpen, profile, activeTab]);

  if (!isOpen || !profile) return null;

  const handleSaveName = async () => {
    if (!tempName.trim()) return;
    setIsSaving(true);
    try {
      await onUpdateUsername(tempName.trim());
      setIsEditingName(false);
    } finally {
      setIsSaving(false);
    }
  };

  const winRate =
    profile.matchesPlayed > 0
      ? Math.round((profile.matchesWon / profile.matchesPlayed) * 100)
      : 0;

  // XP calculation for current level slice
  const xpCurrentLevelBase = Math.round(120 * Math.pow(Math.max(1, profile.level - 1), 1.6));
  const xpCurrentLevelProgress = Math.max(0, profile.xp - xpCurrentLevelBase);
  const xpNeededForLevel = Math.max(1, profile.xpNext - xpCurrentLevelBase);
  const xpPercent = Math.min(100, Math.round((xpCurrentLevelProgress / xpNeededForLevel) * 100));

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
        <motion.div
          id="profile-modal-container"
          initial={{ opacity: 0, scale: 0.92, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, y: 20 }}
          className="bg-slate-900 border border-cyan-500/30 rounded-3xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col max-h-[90vh]"
        >
          {/* Header Banner */}
          <div className="relative bg-gradient-to-r from-cyan-950 via-slate-900 to-indigo-950 p-6 border-b border-slate-800">
            <button
              id="close-profile-btn"
              onClick={onClose}
              className="absolute top-4 right-4 p-2 text-slate-400 hover:text-white rounded-full hover:bg-white/10 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-4">
              <div className="relative">
                <div className="w-18 h-18 rounded-2xl bg-gradient-to-tr from-cyan-500 to-indigo-500 p-0.5 shadow-lg shadow-cyan-500/20">
                  <div className="w-full h-full bg-slate-950 rounded-[14px] flex items-center justify-center">
                    <User className="w-8 h-8 text-cyan-400" />
                  </div>
                </div>
                <div className="absolute -bottom-2 -right-2 bg-gradient-to-r from-amber-400 to-yellow-500 text-slate-950 font-black text-xs px-2 py-0.5 rounded-full shadow border border-slate-900">
                  LV {profile.level}
                </div>
              </div>

              <div className="flex-1 min-w-0">
                {isEditingName ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      maxLength={18}
                      value={tempName}
                      onChange={(e) => setTempName(e.target.value)}
                      className="bg-slate-800 border border-cyan-400/60 rounded-lg px-3 py-1 text-sm text-white font-bold focus:outline-none focus:ring-2 focus:ring-cyan-400"
                      autoFocus
                    />
                    <button
                      onClick={handleSaveName}
                      disabled={isSaving}
                      className="p-1.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-lg"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => {
                        setTempName(profile.username);
                        setIsEditingName(false);
                      }}
                      className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-black text-white truncate">{profile.username}</h2>
                    <span
                      className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                        playerStatus === 'online'
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                          : playerStatus === 'idle'
                          ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                          : 'bg-slate-800 text-slate-400 border-slate-700'
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          playerStatus === 'online'
                            ? 'bg-emerald-400 animate-pulse'
                            : playerStatus === 'idle'
                            ? 'bg-amber-400'
                            : 'bg-slate-500'
                        }`}
                      />
                      {playerStatus === 'online' ? 'ACTIVE' : playerStatus === 'idle' ? 'IDLE' : 'OFFLINE'}
                    </span>
                    <button
                      id="edit-username-btn"
                      onClick={() => setIsEditingName(true)}
                      className="text-slate-400 hover:text-cyan-400 transition-colors p-1"
                      title="Edit Callsign"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-xs font-bold px-2 py-0.5 rounded-md bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
                    {profile.rankTitle}
                  </span>
                  <span className="text-xs text-slate-400">
                    Rating: <strong className="text-white">{profile.eloRating}</strong>
                  </span>
                  {/* Daily Streak Header Badge */}
                  <span
                    id="profile-streak-badge"
                    className="inline-flex items-center gap-1 text-xs font-mono font-bold px-2 py-0.5 rounded-md bg-gradient-to-r from-amber-500/20 to-orange-500/20 text-amber-300 border border-amber-500/40 shadow-sm"
                  >
                    <Flame className="w-3.5 h-3.5 text-amber-400 fill-amber-400 animate-pulse" />
                    <span>{profile.dailyStreak || 1} Day Streak</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Level XP Bar */}
            <div className="mt-5">
              <div className="flex justify-between text-xs text-slate-400 font-semibold mb-1">
                <span>Progress to Level {profile.level + 1}</span>
                <span className="text-cyan-400">{profile.xp} / {profile.xpNext} XP</span>
              </div>
              <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden p-0.5 border border-slate-700">
                <div
                  className="h-full bg-gradient-to-r from-cyan-400 to-indigo-400 rounded-full transition-all duration-500"
                  style={{ width: `${xpPercent}%` }}
                />
              </div>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex border-b border-slate-800 bg-slate-950/50">
            <button
              id="profile-tab-stats"
              onClick={() => setActiveTab('stats')}
              className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${
                activeTab === 'stats'
                  ? 'border-cyan-400 text-cyan-400 bg-cyan-500/5'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Career Statistics
            </button>
            <button
              id="profile-tab-history"
              onClick={() => setActiveTab('history')}
              className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${
                activeTab === 'history'
                  ? 'border-cyan-400 text-cyan-400 bg-cyan-500/5'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Recent Matches
            </button>
          </div>

          {/* Tab Content */}
          <div className="p-6 overflow-y-auto flex-1 space-y-4">
            {activeTab === 'stats' ? (
              <div className="space-y-4">
                {/* Daily Streak Highlight Banner */}
                <div className="bg-gradient-to-r from-amber-950/40 via-orange-950/30 to-slate-900/60 border border-amber-500/40 rounded-2xl p-4 flex items-center justify-between shadow-lg shadow-amber-500/10">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-amber-500/20 border border-amber-400/50 flex items-center justify-center text-amber-400 shadow-inner">
                      <Flame className="w-7 h-7 fill-amber-400 animate-bounce" />
                    </div>
                    <div>
                      <div className="text-xs font-mono font-bold text-amber-300 uppercase tracking-wide">
                        Consecutive Daily Login Streak
                      </div>
                      <div className="text-2xl font-black text-white flex items-baseline gap-1.5">
                        <span>{profile.dailyStreak || 1}</span>
                        <span className="text-xs font-sans text-slate-400 font-normal">
                          {(profile.dailyStreak || 1) === 1 ? 'day active' : 'days in a row!'}
                        </span>
                      </div>
                      <div className="text-[11px] text-amber-200/70 mt-0.5">
                        Keep logging in daily to maintain streak boosts & unlock special themes!
                      </div>
                    </div>
                  </div>
                </div>

                {/* Device Identity & Recovery */}
                <div
                  id="recovery-card"
                  className="bg-slate-900/70 border border-cyan-500/25 rounded-2xl p-4 space-y-3"
                >
                  <div className="flex items-center gap-2 text-cyan-300">
                    <KeyRound className="w-4 h-4" />
                    <span className="text-xs font-mono font-bold uppercase tracking-wider">
                      Profile Recovery Code
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Your profile lives on this device. Save this code somewhere safe — it moves your
                    profile to a new phone or restores it after clearing browser data. Using it
                    generates a fresh code.
                  </p>
                  <div className="flex items-center gap-2">
                    <code
                      id="recovery-code"
                      className="flex-1 text-center text-lg font-black font-mono tracking-[0.2em] text-cyan-300 bg-slate-950 border border-slate-800 rounded-xl py-2 select-all"
                    >
                      {profile.recoveryCode || '····-····'}
                    </code>
                    <button
                      id="btn-copy-recovery"
                      onClick={copyRecoveryCode}
                      title="Copy code"
                      className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition active:scale-95"
                    >
                      {codeCopied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                  <div className="pt-1 border-t border-slate-800/80 space-y-2">
                    <p className="text-[11px] text-slate-400">
                      Have a code from another device? Restore that profile here:
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        id="input-claim-code"
                        value={claimCode}
                        onChange={(e) => setClaimCode(e.target.value.toUpperCase())}
                        placeholder="XXXX-XXXX"
                        maxLength={9}
                        className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm font-mono tracking-widest text-white placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/60"
                      />
                      <button
                        id="btn-claim-profile"
                        onClick={handleClaim}
                        disabled={claimBusy || !claimCode.trim()}
                        className="px-4 py-2 rounded-xl font-mono text-xs font-bold bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500 text-white transition active:scale-95"
                      >
                        {claimBusy ? '…' : 'Restore'}
                      </button>
                    </div>
                    {claimError && <p className="text-[11px] text-rose-400">{claimError}</p>}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-3.5 flex flex-col">
                    <div className="flex items-center gap-2 text-slate-400 text-xs font-medium mb-1">
                      <Trophy className="w-4 h-4 text-yellow-400" />
                      <span>Win Rate</span>
                    </div>
                    <div className="text-2xl font-black text-white">{winRate}%</div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      {profile.matchesWon} Won / {profile.matchesPlayed} Matches
                    </div>
                  </div>

                  <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-3.5 flex flex-col">
                    <div className="flex items-center gap-2 text-slate-400 text-xs font-medium mb-1">
                      <Flame className="w-4 h-4 text-orange-400" />
                      <span>Highest Rally</span>
                    </div>
                    <div className="text-2xl font-black text-white">{profile.highestRally}</div>
                    <div className="text-[11px] text-slate-400 mt-1">Single Point Record</div>
                  </div>

                  <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-3.5 flex flex-col">
                    <div className="flex items-center gap-2 text-slate-400 text-xs font-medium mb-1">
                      <Zap className="w-4 h-4 text-cyan-400" />
                      <span>Total Points</span>
                    </div>
                    <div className="text-2xl font-black text-white">{profile.totalPointsScored}</div>
                    <div className="text-[11px] text-slate-400 mt-1">Volleys past opponent</div>
                  </div>

                  <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-3.5 flex flex-col">
                    <div className="flex items-center gap-2 text-slate-400 text-xs font-medium mb-1">
                      <Award className="w-4 h-4 text-purple-400" />
                      <span>Achievements</span>
                    </div>
                    <div className="text-2xl font-black text-white">{profile.achievements.length}</div>
                    <div className="text-[11px] text-slate-400 mt-1">Badges Unlocked</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                {isLoadingMatches ? (
                  <div className="text-center py-8 text-slate-400 text-sm">Loading match history...</div>
                ) : matches.length === 0 ? (
                  <div className="text-center py-8 text-slate-500 text-sm">
                    No matches recorded yet. Play a solo or multiplayer game to build your record!
                  </div>
                ) : (
                  matches.map((m) => {
                    const isWin = m.winnerId === profile.id;
                    return (
                      <div
                        key={m.id}
                        className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-3 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-9 h-9 rounded-lg font-black text-xs flex items-center justify-center ${
                              isWin
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                            }`}
                          >
                            {isWin ? 'WIN' : 'LOSS'}
                          </div>
                          <div>
                            <div className="text-sm font-bold text-white">
                              vs {m.player1Id === profile.id ? m.player2Name : m.player1Name}
                            </div>
                            <div className="text-[11px] text-slate-400 flex items-center gap-2">
                              <span>Score: {m.scoreP1} - {m.scoreP2}</span>
                              <span>•</span>
                              <span>Max Rally: {m.maxRally}</span>
                            </div>
                          </div>
                        </div>
                        <div className="text-right text-[11px] text-slate-500">
                          {new Date(m.timestamp).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-4 bg-slate-950 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
            <span>Player ID: <code className="text-slate-300 font-mono">{profile.id.slice(0, 10)}...</code></span>
            <button
              onClick={onRefreshProfile}
              className="text-cyan-400 hover:text-cyan-300 font-bold"
            >
              Sync Data
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
