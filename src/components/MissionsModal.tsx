import React, { useState, useEffect } from 'react';
import { DailyMission, LanguageCode } from '../types';
import { t } from '../i18n/translations';
import { formatMissionReset } from '../game/missions';
import { sound } from '../audio/soundEffects';
import { Sheet, Button, Panel, ProgressBar, useMotion } from './ui';
import confetti from 'canvas-confetti';
import {
  X,
  Target,
  Trophy,
  Activity,
  Smartphone,
  CheckCircle2,
  Clock,
  Sparkles,
  Zap,
  RefreshCw,
} from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  missions: DailyMission[];
  onClaimReward: (missionId: string) => Promise<void>;
  onReroll: (missionId: string) => Promise<void>;
  /** Rerolls left today, per tier. Both reset with the UTC day. */
  rerolls: { regular: number; elite: number };
  language: LanguageCode;
}

export const MissionsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  missions,
  onClaimReward,
  onReroll,
  rerolls,
  language,
}) => {
  const m = useMotion();
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [rerollingId, setRerollingId] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<string>('');

  const handleReroll = async (missionId: string) => {
    if (rerollingId) return;
    setRerollingId(missionId);
    try {
      await onReroll(missionId);
    } finally {
      setRerollingId(null);
    }
  };

  useEffect(() => {
    const updateCountdown = () => {
      setCountdown(formatMissionReset());
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, []);

  const completedCount = missions.filter((mi) => mi.current >= mi.target).length;
  const totalCount = missions.length;
  // The list shrinks as tasks are cleared: a claim retires its slot when its
  // tier has nothing fresh left to deal today, so an all-clear day empties it
  // entirely. Without the guard that reads "0 / 0 completed (NaN%)".
  const progressPercent = totalCount ? Math.round((completedCount / totalCount) * 100) : 100;
  const allClear = totalCount === 0;

  const getMissionIcon = (type: DailyMission['type']) => {
    switch (type) {
      case 'games_played':
        return <Activity className="h-5 w-5 text-accent" />;
      case 'matches_won':
        return <Trophy className="h-5 w-5 text-warn" />;
      case 'rally':
        return <Zap className="h-5 w-5 text-win" />;
      case 'multiplayer':
        return <Smartphone className="h-5 w-5 text-fuchsia-400 cos-light:text-fuchsia-700" />;
      case 'points_scored':
        return <Target className="h-5 w-5 text-loss" />;
      default:
        return <Target className="h-5 w-5 text-accent" />;
    }
  };

  const handleClaim = async (mission: DailyMission) => {
    if (mission.claimed || mission.current < mission.target || claimingId) return;

    setClaimingId(mission.id);
    sound.playScore();

    // A full-screen particle burst is exactly what reduced-motion is for.
    if (!m.reduced) {
      try {
        confetti({
          particleCount: 50,
          spread: 60,
          origin: { y: 0.6 },
          colors: ['#19e3ff', '#ff4d6a', '#ffc53d', '#2fd97b'],
        });
      } catch {}
    }

    try {
      await onClaimReward(mission.id);
    } finally {
      setClaimingId(null);
    }
  };

  const header = (
    <div className="shrink-0 border-b border-line bg-surface-1">
      <div className="flex items-center justify-between gap-2 px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="rounded-card border border-accent/30 bg-accent/12 p-2 text-accent">
            <Target className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-title">{t('missions_title', language)}</h2>
            <div className="flex items-center gap-1.5 text-2xs font-normal tracking-normal text-ink-muted">
              <Clock className="h-3 w-3 text-accent" />
              <span>{t('resets_in', language)}:</span>
              <span className="tnum text-accent">{countdown}</span>
            </div>
          </div>
        </div>

        <button
          id="close-missions-btn"
          onClick={onClose}
          aria-label={t('close', language)}
          className="shrink-0 rounded-ctl p-2 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="border-t border-line px-4 py-3">
        <ProgressBar
          value={progressPercent / 100}
          tone={completedCount === totalCount && totalCount > 0 ? 'win' : 'accent'}
          label={t('progress', language)}
          trailing={`${completedCount} / ${totalCount} ${t('completed', language)} (${progressPercent}%)`}
          ariaLabel={t('progress', language)}
        />
        {(allClear || completedCount === totalCount) && (
          <p className="mt-2 flex items-center gap-1 text-2xs font-normal tracking-normal text-win">
            <Sparkles className="h-3 w-3" />
            {t('all_completed', language)}
          </p>
        )}
      </div>
    </div>
  );

  const footer = (
    <>
      <p
        id="missions-free-reroll-note"
        className="flex-1 text-2xs leading-snug font-normal tracking-normal text-ink-dim"
      >
        {t('mission_free_reroll', language)}
      </p>
      <Button size="sm" variant="secondary" onClick={onClose}>
        {t('close', language)}
      </Button>
    </>
  );

  return (
    <Sheet
      cardId="missions-modal-container"
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      accent="neutral"
      header={header}
      footer={footer}
      bodyClassName="p-4 space-y-3"
    >
      {allClear && (
        <p
          id="missions-all-clear"
          className="px-4 py-8 text-center text-2xs leading-relaxed font-normal tracking-normal text-ink-muted"
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
          <Panel
            key={mission.id}
            id={`mission-card-${mission.id}`}
            variant={isClaimed ? 'inset' : 'flat'}
            accent={isClaimable ? 'accent' : isElite ? 'warn' : 'neutral'}
            className={
              isClaimed
                ? 'opacity-65'
                : isClaimable
                  ? 'bg-accent/10'
                  : isElite
                    ? 'bg-warn/8'
                    : ''
            }
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-1 items-start gap-3">
                <div className="mt-0.5 shrink-0 rounded-ctl border border-line bg-surface-1 p-2">
                  {getMissionIcon(mission.type)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h3 className="truncate text-2xs text-ink">
                      {t(mission.titleKey, language)}
                    </h3>
                    {isElite && (
                      <span
                        id={`mission-elite-${mission.id}`}
                        className="rounded-chip border border-warn/40 bg-warn/20 px-1.5 py-0.5 text-2xs text-warn"
                      >
                        {t('mission_elite', language)}
                      </span>
                    )}
                    <span className="rounded-chip border border-xp/25 bg-xp/10 px-1.5 py-0.5 text-2xs text-xp">
                      +{mission.xpReward} XP
                    </span>
                  </div>
                  {isElite && mission.unlocks && (
                    <p className="mt-1 text-2xs font-normal tracking-normal text-warn">
                      {mission.unlockOwned
                        ? t('mission_unlock_owned', language)
                        : t('mission_unlock_reward', language)}
                    </p>
                  )}
                  <p className="mt-0.5 text-2xs leading-relaxed font-normal tracking-normal text-ink-muted">
                    {t(mission.descKey, language)}
                  </p>

                  <div className="mt-2.5 flex items-center gap-2">
                    <ProgressBar
                      className="flex-1"
                      height="sm"
                      value={mission.current / mission.target}
                      tone={isDone ? 'win' : 'accent'}
                    />
                    <span className="shrink-0 text-2xs tnum font-normal tracking-normal text-ink-muted">
                      {mission.current} / {mission.target}
                    </span>
                  </div>
                </div>
              </div>

              <div className="shrink-0 self-center">
                {isClaimed ? (
                  <span className="inline-flex items-center gap-1 rounded-ctl border border-win/30 bg-win/10 px-2.5 py-1 text-2xs text-win">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {t('claimed', language)}
                  </span>
                ) : isClaimable ? (
                  <Button
                    id={`claim-mission-${mission.id}`}
                    size="sm"
                    variant="primary"
                    onClick={() => handleClaim(mission)}
                    disabled={claimingId === mission.id}
                    icon={<Sparkles className="h-3.5 w-3.5" />}
                    className="animate-ready-pulse"
                  >
                    {claimingId === mission.id
                      ? '...'
                      : t('claim_reward', language, { xp: mission.xpReward })}
                  </Button>
                ) : (
                  <div className="flex flex-col items-end gap-1.5">
                    <span className="rounded-ctl border border-line bg-surface-1 px-2 py-1 text-2xs tnum text-ink-dim">
                      {pct}%
                    </span>
                    <button
                      id={`reroll-mission-${mission.id}`}
                      onClick={() => handleReroll(mission.id)}
                      disabled={!canReroll || rerollingId === mission.id}
                      title={t('mission_reroll_left', language, { n: left })}
                      className="inline-flex items-center gap-1 rounded-ctl border border-line bg-surface-1 px-2 py-1 text-2xs text-ink-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <RefreshCw
                        className={`h-3 w-3 ${rerollingId === mission.id ? 'animate-spin' : ''}`}
                        data-motion-essential
                      />
                      {left}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </Panel>
        );
      })}
    </Sheet>
  );
};
