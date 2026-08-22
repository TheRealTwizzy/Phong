import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { DailyMission, LanguageCode } from '../types';
import { ThemeConfig } from '../game/themes';
import { t } from '../i18n/translations';
import { formatMissionReset } from '../game/missions';
import { sound } from '../audio/soundEffects';
import confetti from 'canvas-confetti';
import {
  X,
  Target,
  Trophy,
  Swords,
  Activity,
  Smartphone,
  CheckCircle2,
  Clock,
  Sparkles,
  Zap, RefreshCw } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  missions: DailyMission[];
  onClaimReward: (missionId: string) => Promise<void>;
  onReroll: (missionId: string) => Promise<void>;
  /** Rerolls left today, per tier. Both reset with the UTC day. */
  rerolls: { regular: number; elite: number };
  theme: ThemeConfig;
  language: LanguageCode;
}

export const MissionsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  missions,
  onClaimReward,
  onReroll,
  rerolls,
  theme,
  language,
}) => {
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [rerollingId, setRerollingId] = useState<string | null>(null);

  const handleReroll = async (missionId: string) => {
    if (rerollingId) return;
    setRerollingId(missionId);
    try {
      await onReroll(missionId);
    } finally {
      setRerollingId(null);
    }
  };
  const [countdown, setCountdown] = useState<string>('');

  useEffect(() => {
    const updateCountdown = () => {
      setCountdown(formatMissionReset());
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, []);

  if (!isOpen) return null;

  const completedCount = missions.filter((m) => m.current >= m.target).length;
  const totalCount = missions.length;
  // The list shrinks as tasks are cleared: a claim retires its slot when its
  // tier has nothing fresh left to deal today, so an all-clear day empties it
  // entirely. Without the guard that reads "0 / 0 completed (NaN%)".
  const progressPercent = totalCount ? Math.round((completedCount / totalCount) * 100) : 100;
  const allClear = totalCount === 0;

  const getMissionIcon = (type: DailyMission['type']) => {
    switch (type) {
      case 'games_played':
        return <Activity className="w-5 h-5 text-cyan-400" />;
      case 'matches_won':
        return <Trophy className="w-5 h-5 text-amber-400" />;
      case 'rally':
        return <Zap className="w-5 h-5 text-emerald-400" />;
      case 'multiplayer':
        return <Smartphone className="w-5 h-5 text-fuchsia-400" />;
      case 'points_scored':
        return <Target className="w-5 h-5 text-rose-400" />;
      default:
        return <Target className="w-5 h-5 text-cyan-400" />;
    }
  };

  const handleClaim = async (mission: DailyMission) => {
    if (mission.claimed || mission.current < mission.target || claimingId) return;

    setClaimingId(mission.id);
    sound.playScore();

    try {
      confetti({
        particleCount: 50,
        spread: 60,
        origin: { y: 0.6 },
        colors: ['#00ffcc', '#ff0055', '#ffe600', '#0099ff'],
      });
    } catch {}

    try {
      await onClaimReward(mission.id);
    } finally {
      setClaimingId(null);
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
        <motion.div
          initial={{ opacity: 0, scale: 0.92, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, y: 15 }}
          transition={{ type: 'spring', damping: 25, stiffness: 350 }}
          className="relative w-full max-w-md bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-sheet"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/60">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
                <Target className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-black text-white tracking-wider flex items-center gap-2">
                  {t('missions_title', language)}
                </h2>
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono">
                  <Clock className="w-3 h-3 text-cyan-400" />
                  <span>{t('resets_in', language)}:</span>
                  <span className="text-cyan-400 font-bold">{countdown}</span>
                </div>
              </div>
            </div>

            <button
              id="close-missions-btn"
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Daily Progress Banner */}
          <div className="px-5 py-3.5 bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 border-b border-slate-800">
            <div className="flex items-center justify-between text-xs font-mono mb-1.5">
              <span className="text-slate-300 font-semibold">{t('progress', language)}</span>
              <span className="text-cyan-400 font-bold">
                {completedCount} / {totalCount} {t('completed', language)} ({progressPercent}%)
              </span>
            </div>
            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${progressPercent}%` }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
                className="h-full bg-gradient-to-r from-cyan-500 via-teal-400 to-emerald-400"
              />
            </div>
            {(allClear || completedCount === totalCount) && (
              <p className="text-[11px] text-emerald-400 font-medium mt-2 flex items-center gap-1">
                <Sparkles className="w-3 h-3" />
                {t('all_completed', language)}
              </p>
            )}
          </div>

          {/* Task List */}
          <div className="p-4 space-y-3 scroll-y flex-1">
            {allClear && (
              <p
                id="missions-all-clear"
                className="text-center text-xs text-slate-400 font-mono py-8 px-4 leading-relaxed"
              >
                {t('resets_in', language)} {countdown}
              </p>
            )}
            {missions.map((mission) => {
              const isDone = mission.current >= mission.target;
              const isClaimed = mission.claimed;
              const isClaimable = isDone && !isClaimed;
              const pct = Math.min(100, Math.round((mission.current / mission.target) * 100));
              const isElite = mission.tier === 'elite';
              const left = isElite ? rerolls.elite : rerolls.regular;
              // A finished mission cannot be rerolled: nothing to gain, and a
              // reward to lose.
              const canReroll = left > 0 && !isDone && !isClaimed;

              return (
                <div
                  key={mission.id}
                  id={`mission-card-${mission.id}`}
                  className={`p-3.5 rounded-xl border transition-all ${
                    isClaimed
                      ? 'bg-slate-950/40 border-slate-800/60 opacity-65'
                      : isClaimable
                      ? 'bg-cyan-950/20 border-cyan-500/50 shadow-lg shadow-cyan-950/30'
                      : isElite
                      ? 'bg-amber-950/20 border-amber-500/40'
                      : 'bg-slate-800/40 border-slate-700/60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1">
                      <div className="p-2 rounded-lg bg-slate-900 border border-slate-700/80 shrink-0 mt-0.5">
                        {getMissionIcon(mission.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-bold text-white truncate">
                            {t(mission.titleKey, language)}
                          </h3>
                          {isElite && (
                            <span
                              id={`mission-elite-${mission.id}`}
                              className="px-1.5 py-0.5 rounded text-[10px] font-mono font-black bg-amber-400/20 text-amber-300 border border-amber-400/40"
                            >
                              {t('mission_elite', language)}
                            </span>
                          )}
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            +{mission.xpReward} XP
                          </span>
                        </div>
                        {isElite && mission.unlocks && (
                          <p className="text-[10px] font-mono text-amber-300/90 mt-1">
                            {mission.unlockOwned
                              ? t('mission_unlock_owned', language)
                              : t('mission_unlock_reward', language)}
                          </p>
                        )}
                        <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                          {t(mission.descKey, language)}
                        </p>

                        {/* Progress bar inside card */}
                        <div className="mt-2.5 flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-slate-900 rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all duration-300 ${
                                isDone
                                  ? 'bg-emerald-400'
                                  : 'bg-gradient-to-r from-cyan-400 to-teal-400'
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-[11px] font-mono text-slate-400 shrink-0">
                            {mission.current} / {mission.target}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Action Button */}
                    <div className="shrink-0 self-center">
                      {isClaimed ? (
                        <span className="inline-flex items-center gap-1 text-xs font-mono font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-lg">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {t('claimed', language)}
                        </span>
                      ) : isClaimable ? (
                        <button
                          id={`claim-mission-${mission.id}`}
                          onClick={() => handleClaim(mission)}
                          disabled={claimingId === mission.id}
                          className="px-3 py-1.5 bg-gradient-to-r from-cyan-500 to-teal-400 hover:from-cyan-400 hover:to-teal-300 text-slate-950 font-black text-xs rounded-lg shadow-md shadow-cyan-500/20 transition-all transform active:scale-95 flex items-center gap-1.5 animate-pulse"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          {claimingId === mission.id
                            ? '...'
                            : t('claim_reward', language, { xp: mission.xpReward })}
                        </button>
                      ) : (
                        <div className="flex flex-col items-end gap-1.5">
                          <span className="text-xs font-mono font-medium text-slate-500 px-2 py-1 bg-slate-900 rounded-lg border border-slate-800">
                            {pct}%
                          </span>
                          <button
                            id={`reroll-mission-${mission.id}`}
                            onClick={() => handleReroll(mission.id)}
                            disabled={!canReroll || rerollingId === mission.id}
                            title={t('mission_reroll_left', language, { n: left })}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-mono transition disabled:opacity-40 disabled:cursor-not-allowed border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
                          >
                            <RefreshCw
                              className={`w-3 h-3 ${rerollingId === mission.id ? 'animate-spin' : ''}`}
                            />
                            {left}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between gap-3">
            <p id="missions-free-reroll-note" className="text-[10px] font-mono text-slate-500 leading-snug">
              {t('mission_free_reroll', language)}
            </p>
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-xs font-bold text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
            >
              {t('close', language)}
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
