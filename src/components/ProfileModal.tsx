import React, { useState, useEffect, useRef } from 'react';
import { PlayerProfile, PlayerStatus, LanguageCode } from '../types';
import { USERNAME_MAX } from '../profileRules';
import { PLACEMENT_GAMES, xpForLevel } from '../rating';
import { processAvatarFile, uploadAvatar, deleteAvatar } from '../media/avatar';
import { AvatarImage } from './AvatarImage';
import { MatchHistoryList } from './MatchHistoryList';
import { TierBadge } from './TierBadge';
import { t } from '../i18n/translations';
import { Sheet, ProgressBar } from './ui';
import {
  X,
  Trophy,
  Flame,
  Zap,
  Award,
  Check,
  Edit2,
  KeyRound,
  Copy,
  ImagePlus,
  Trash2,
} from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  profile: PlayerProfile | null;
  playerStatus?: PlayerStatus;
  onUpdateUsername: (
    newName: string
  ) => Promise<{ ok: boolean; error?: string; unlockAt?: string }>;
  onRefreshProfile: () => void;
  onViewProfile?: (id: string) => void;
  language?: LanguageCode;
}

// Solo before duel before practice: the order a player meets them in.
const MODE_ORDER = ['solo', 'multiplayer', 'practice'] as const;
const MODE_LABEL: Record<string, string> = {
  solo: 'Solo AI',
  multiplayer: 'Duel',
  practice: 'Practice',
};

export const ProfileModal: React.FC<Props> = ({
  isOpen,
  onClose,
  profile,
  playerStatus = 'online',
  onUpdateUsername,
  onRefreshProfile,
  onViewProfile,
  language = 'en',
}) => {
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [claimCode, setClaimCode] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  const handlePickAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || avatarBusy) return;
    setAvatarBusy(true);
    try {
      const blob = await processAvatarFile(file);
      const result = await uploadAvatar(blob);
      if (result.ok) onRefreshProfile();
    } catch {
      // Undecodable file — leave the current avatar untouched
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleRemoveAvatar = async () => {
    if (avatarBusy) return;
    setAvatarBusy(true);
    try {
      if (await deleteAvatar()) onRefreshProfile();
    } finally {
      setAvatarBusy(false);
    }
  };

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

  useEffect(() => {
    if (profile) {
      setTempName(profile.username);
    }
  }, [profile]);

  if (!profile) return null;

  const handleSaveName = async () => {
    if (!tempName.trim()) return;
    setIsSaving(true);
    setNameError(null);
    try {
      const result = await onUpdateUsername(tempName.trim());
      if (result.ok) {
        setIsEditingName(false);
      } else if (result.error === 'USERNAME_LOCKED' && result.unlockAt) {
        setNameError(
          t('username_locked_until', language, {
            date: new Date(result.unlockAt).toLocaleDateString(language, {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            }),
          })
        );
      } else if (result.error === 'USERNAME_TAKEN') {
        setNameError(t('username_taken', language));
      } else {
        setNameError(t('username_invalid', language));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const winRate =
    profile.matchesPlayed > 0
      ? Math.round((profile.matchesWon / profile.matchesPlayed) * 100)
      : 0;

  // XP calculation for current level slice
  const xpCurrentLevelBase = xpForLevel(profile.level);
  const xpCurrentLevelProgress = Math.max(0, profile.xp - xpCurrentLevelBase);
  const xpNeededForLevel = Math.max(1, profile.xpNext - xpCurrentLevelBase);
  const xpPercent = Math.min(100, Math.round((xpCurrentLevelProgress / xpNeededForLevel) * 100));

  // A stable order, so the table does not reshuffle as rows appear. Modes with
  // no row yet are simply absent — a player who has never opened Practice has
  // nothing to say about it.
  const modeRows = MODE_ORDER.flatMap((mode) => {
    const st = profile.modeStats?.[mode];
    return st && st.matchesPlayed > 0 ? [[mode, st] as const] : [];
  });

  const header = (
    <div className="shrink-0">
          {/* Header Banner */}
          <div className="relative bg-gradient-to-r from-accent/12 via-surface-2 to-surface-2 p-4 border-b border-line">
            <button
              id="close-profile-btn"
              onClick={onClose}
              className="absolute top-4 right-4 p-2 text-slate-400 hover:text-white rounded-full hover:bg-white/10 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-4">
              <div className="relative">
                <AvatarImage
                  playerId={profile.id}
                  hasAvatar={profile.hasAvatar}
                  avatarVersion={profile.avatarVersion}
                  size={72}
                  className="rounded-2xl border-2 border-cyan-500/40 shadow-lg shadow-cyan-500/20"
                />
                <div className="absolute -bottom-2 -right-2 bg-gradient-to-r from-amber-400 to-yellow-500 text-slate-950 font-black text-xs px-2 py-0.5 rounded-full shadow border border-slate-900">
                  LV {profile.level}
                </div>
                {/* Avatar change / remove controls */}
                <div className="absolute -top-2 -right-2 flex gap-1">
                  <button
                    id="btn-change-avatar"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={avatarBusy}
                    title={profile.hasAvatar ? t('change_avatar', language) : t('upload_avatar', language)}
                    className="p-1 rounded-lg bg-slate-800/95 hover:bg-slate-700 text-cyan-300 border border-slate-600 shadow transition active:scale-95 disabled:opacity-50"
                  >
                    <ImagePlus className="w-3 h-3" />
                  </button>
                  {profile.hasAvatar && (
                    <button
                      id="btn-remove-avatar"
                      onClick={handleRemoveAvatar}
                      disabled={avatarBusy}
                      title={t('remove_avatar', language)}
                      className="p-1 rounded-lg bg-slate-800/95 hover:bg-slate-700 text-rose-300 border border-slate-600 shadow transition active:scale-95 disabled:opacity-50"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <input
                  ref={avatarInputRef}
                  id="input-avatar-file"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handlePickAvatar}
                />
              </div>

              <div className="flex-1 min-w-0">
                {isEditingName ? (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        maxLength={USERNAME_MAX}
                        value={tempName}
                        onChange={(e) => {
                          setTempName(e.target.value);
                          setNameError(null);
                        }}
                        className="bg-slate-800 border border-cyan-400/60 rounded-lg px-3 py-1 text-base text-white font-bold focus:outline-none focus:ring-2 focus:ring-cyan-400 min-w-0"
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
                          setNameError(null);
                        }}
                        className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    {nameError && (
                      <p id="username-edit-error" className="text-[10px] font-mono text-rose-400">
                        {nameError}
                      </p>
                    )}
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
                  <TierBadge tier={profile.tier} language={language} size="md" />
                  {profile.tier === 'unranked' && (
                    <span className="text-[10px] text-slate-400 font-mono">
                      {t('placement_progress', language, {
                        // Clamped like RankBadge's meter: placement counts
                        // games AND needs sigma to settle, so an unplaced
                        // player can legitimately hold more ranked games than
                        // the placement number — "12/5" reads as a bug.
                        played: String(Math.min(profile.rankedGames, PLACEMENT_GAMES)),
                        total: String(PLACEMENT_GAMES),
                      })}
                    </span>
                  )}
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
                {/* Progress WITHIN this level, matching the bar beside it.
                    These used to be the cumulative totals while the bar showed
                    the level slice, so the number and the fill disagreed:
                    at level 3 the bar read 38% next to the text "700 / 930". */}
                <span className="text-cyan-400">
                  {xpCurrentLevelProgress.toLocaleString()} / {xpNeededForLevel.toLocaleString()} XP
                </span>
              </div>
              <ProgressBar value={xpPercent / 100} tone="xp" ariaLabel="Experience" />
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
              {t('profile_tab_stats', language)}
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
              {t('public_history_section', language)}
            </button>
          </div>

    </div>
  );

  return (
    <Sheet
      cardId="profile-modal-container"
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      accent="accent"
      header={header}
      footer={
        <>
          <span className="flex-1 text-2xs font-normal tracking-normal text-ink-muted">
            Player ID: <code className="text-ink-muted">{profile.id.slice(0, 10)}...</code>
          </span>
          <button onClick={onRefreshProfile} className="text-2xs text-accent hover:text-ink">
            Sync Data
          </button>
        </>
      }
      bodyClassName="p-4 space-y-4"
    >
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
                        className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-base font-mono tracking-widest text-white placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/60"
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
                    <div className="text-[11px] text-slate-400 mt-1">Best return streak</div>
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

                {/* Per mode. The grid above pools solo and duel into single
                    numbers, which say how much you have played and nothing
                    about how you play each mode. Split Screen is absent
                    because only one of the two people at that phone has an
                    account to write to. */}
                {modeRows.length > 0 && (
                  <div id="profile-mode-stats" className="space-y-2">
                    <div className="text-xs font-mono font-bold uppercase tracking-wider text-slate-400">
                      By Mode
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px] text-slate-300">
                        <thead>
                          <tr className="text-slate-500 text-left whitespace-nowrap">
                            <th className="py-1 pr-2 font-medium">Mode</th>
                            <th className="py-1 px-1.5 font-medium text-right">Played</th>
                            <th className="py-1 px-1.5 font-medium text-right">W–L</th>
                            <th className="py-1 px-1.5 font-medium text-right">Pts</th>
                            <th className="py-1 px-1.5 font-medium text-right">Streak</th>
                            <th className="py-1 pl-1.5 font-medium text-right">Win run</th>
                          </tr>
                        </thead>
                        <tbody>
                          {modeRows.map(([mode, st]) => (
                            <tr
                              key={mode}
                              id={`profile-mode-${mode}`}
                              className="border-t border-slate-800/80 whitespace-nowrap"
                            >
                              <td className="py-1.5 pr-2 text-slate-200">
                                {MODE_LABEL[mode] || mode}
                              </td>
                              <td className="py-1.5 px-1.5 text-right tabular-nums">{st.matchesPlayed}</td>
                              <td className="py-1.5 px-1.5 text-right tabular-nums">
                                {mode === 'practice' ? '—' : `${st.matchesWon}–${st.matchesLost}`}
                              </td>
                              <td className="py-1.5 px-1.5 text-right tabular-nums">
                                {mode === 'practice' ? '—' : st.pointsScored}
                              </td>
                              <td className="py-1.5 px-1.5 text-right tabular-nums text-orange-300">
                                {st.bestStreak}
                              </td>
                              <td className="py-1.5 pl-1.5 text-right tabular-nums">
                                {mode === 'practice' ? '—' : st.bestWinStreak}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              // The shared list — the same tabs, filters, pagination and row
              // renderer as the history modal and the public profile view.
              // The ad-hoc renderer this replaces printed the raw stored
              // scoreP1-scoreP2, which read reversed on any row the opponent
              // had authored, and shipped its strings in English only.
              <MatchHistoryList
                language={language}
                perspectiveId={profile.id}
                source={{ kind: 'me' }}
                onViewProfile={onViewProfile}
                idPrefix="profile-history"
              />
            )}
    </Sheet>
  );
};
