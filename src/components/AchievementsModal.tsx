import React, { useState, useEffect } from 'react';
import { Achievement, AchievementBranch, LanguageCode } from '../types';
import { BRANCHES, isBranchRevealed, isRevealed, isUnlockable } from '../achievements';
import { Tier } from '../rating';
import { t } from '../i18n/translations';
import { Sheet, ProgressBar } from './ui';
import {
  X,
  Award,
  Zap,
  Flame,
  Shield,
  Trophy,
  Star,
  Cpu,
  Smartphone,
  Target,
  Sparkles,
  Crown,
  TrendingUp,
  Lock,
  HelpCircle,
  CheckCircle2,
} from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  playerId: string;
  /** Gates are measured against these — see ProgressContext in achievements.ts. */
  level: number;
  tier: Tier;
  language?: LanguageCode;
}

const ICON_MAP: Record<string, React.ReactNode> = {
  zap: <Zap className="w-5 h-5 text-xp" />,
  activity: <Zap className="w-5 h-5 text-win" />,
  flame: <Flame className="w-5 h-5 text-warn" />,
  shield: <Shield className="w-5 h-5 text-accent" />,
  trophy: <Trophy className="w-5 h-5 text-warn" />,
  star: <Star className="w-5 h-5 text-rank-steady" />,
  cpu: <Cpu className="w-5 h-5 text-pink-400 cos-light:text-pink-700" />,
  smartphone: <Smartphone className="w-5 h-5 text-blue-400 cos-light:text-blue-700" />,
  target: <Target className="w-5 h-5 text-loss" />,
  award: <Award className="w-5 h-5 text-warn" />,
  sparkles: <Sparkles className="w-5 h-5 text-xp" />,
  crown: <Crown className="w-5 h-5 text-xp" />,
  'trending-up': <TrendingUp className="w-5 h-5 text-win" />,
};

export const AchievementsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  playerId,
  level,
  tier,
  language = 'en',
}) => {
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [branch, setBranch] = useState<AchievementBranch>('foundation');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isOpen && playerId) {
      setIsLoading(true);
      fetch('/api/achievements')
        .then((res) => res.json())
        .then((data) => {
          setAchievements(data.achievements || []);
        })
        .catch(console.error)
        .finally(() => setIsLoading(false));
    }
  }, [isOpen, playerId]);

  const unlockedCount = achievements.filter((a) => a.unlockedAt).length;
  const earned = achievements.filter((a) => a.unlockedAt).map((a) => a.id);
  const progress = { level, tier };
  const branchOpen = (id: AchievementBranch) => isBranchRevealed(id, earned, progress);

  // Depth-first walk of one branch, so a child always renders directly under
  // its parent and the connector lines line up with the tree they describe.
  const rows: { ach: Achievement; depth: number; lastChild: boolean }[] = [];
  const walk = (node: Achievement, depth: number, lastChild: boolean) => {
    rows.push({ ach: node, depth, lastChild });
    const kids = achievements.filter((a) => a.parent === node.id);
    kids.forEach((kid, i) => walk(kid, depth + 1, i === kids.length - 1));
  };
  achievements
    .filter((a) => a.branch === branch && !a.parent)
    .forEach((root, i, all) => walk(root, 0, i === all.length - 1));

  const branchDone = rows.filter((r) => r.ach.unlockedAt).length;

  const progressPercent =
    achievements.length > 0 ? Math.round((unlockedCount / achievements.length) * 100) : 0;

  const header = (
    <div className="shrink-0 relative border-b border-line bg-gradient-to-r from-rank-steady/12 via-surface-2 to-surface-2 p-4">
      <button
        id="close-achievements-btn"
        onClick={onClose}
        aria-label={t('close', language)}
        className="absolute top-3 right-3 rounded-ctl p-2 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
      >
        <X className="w-5 h-5" />
      </button>

      <div className="flex items-center gap-3">
        <div className="rounded-card border border-rank-steady/30 bg-rank-steady/10 p-2.5 text-rank-steady">
          <Award className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-title">Career Achievements</h2>
          <p className="text-2xs font-normal tracking-normal text-ink-muted">
            Unlock trophies and earn XP rewards
          </p>
        </div>
      </div>

      {/* Overall progress */}
      <div className="mt-3 rounded-card border border-line bg-surface-1 p-3">
        <ProgressBar
          value={progressPercent / 100}
          tone="accent"
          label="Completion Status"
          trailing={
            <>
              {unlockedCount} / {achievements.length} ({progressPercent}%)
              <span className="ml-2 text-ink-dim">
                · {t('ach_this_branch', language)} {branchDone}/{rows.length}
              </span>
            </>
          }
          ariaLabel="Completion status"
        />
      </div>

      {/* Branch tabs — one short tree each, rather than one long list */}
      <div className="scroll-x mt-3 flex gap-1.5 pb-1">
              {BRANCHES.map((b) => {
                const nodes = achievements.filter((a) => a.branch === b.id);
                const done = nodes.filter((a) => a.unlockedAt).length;
                // A concealed branch shows as a lock rather than a name: the
                // whole tree is the silhouette, so finding it is the reward.
                const open = branchOpen(b.id);
                return (
                  <button
                    key={b.id}
                    id={`ach-branch-${b.id}`}
                    data-locked={open ? 'false' : 'true'}
                    onClick={() => setBranch(b.id)}
                    aria-selected={branch === b.id}
                    data-selected={branch === b.id ? 'true' : 'false'}
                    className={`flex min-h-8 items-center gap-1 whitespace-nowrap rounded-ctl px-3 py-1 text-2xs transition-colors ${
                      branch === b.id
                        ? 'bg-rank-steady text-ink'
                        : open
                          ? 'bg-surface-3 text-ink-muted hover:text-ink'
                          : 'bg-surface-1 text-locked hover:text-ink-muted'
                    }`}
                  >
                    {open ? (
                      <>
                        {t(b.titleKey, language)}
                        <span className="ml-0.5 tnum opacity-70">
                          {done}/{nodes.length}
                        </span>
                      </>
                    ) : (
                      <>
                        <Lock className="w-3 h-3" />
                        <span>???</span>
                      </>
                    )}
                  </button>
                );
              })}
      </div>
    </div>
  );

  return (
    <Sheet
      cardId="achievements-modal-container"
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      accent="accent"
      header={header}
      footer={
        <p className="flex-1 text-center text-2xs font-normal tracking-normal text-ink-muted">
          Unlocking achievements accelerates your player level and leaderboard standing.
        </p>
      }
      bodyClassName="p-3 space-y-2.5"
    >
            {isLoading ? (
              <div className="py-12 text-center text-2xs font-normal tracking-normal text-ink-muted">Loading trophies...</div>
            ) : !branchOpen(branch) ? (
              <div
                id="ach-branch-locked"
                className="flex flex-col items-center gap-2 py-14 px-6 text-center"
              >
                <Lock className="w-8 h-8 text-locked" />
                <p className="text-2xs text-ink-muted">{t('branch_locked', language)}</p>
                <p className="max-w-xs text-2xs leading-relaxed font-normal tracking-normal text-ink-dim">
                  {t(BRANCHES.find((b) => b.id === branch)?.gateHintKey || 'branch_locked', language)}
                </p>
              </div>
            ) : (
              rows.map(({ ach, depth, lastChild }) => {
                const isUnlocked = !!ach.unlockedAt;
                const reachable = isUnlockable(ach.id, earned, progress);
                const revealed = isRevealed(ach.id, earned, progress);
                return (
                  <div key={ach.id} className="flex items-stretch" id={`ach-row-${ach.id}`}>
                    {/* Connector rail: one rung of indentation per depth, with
                        the elbow drawn into the parent above it. */}
                    {depth > 0 && (
                      <div className="flex shrink-0" aria-hidden="true">
                        {Array.from({ length: depth - 1 }).map((_, i) => (
                          <div key={i} className="w-4 border-l border-line-strong ml-2" />
                        ))}
                        <div className="w-4 ml-2 relative">
                          <div
                            className={`absolute left-0 top-0 w-px bg-line-strong ${
                              lastChild ? 'h-6' : 'h-full'
                            }`}
                          />
                          <div className="absolute left-0 top-6 w-4 h-px bg-line-strong" />
                        </div>
                      </div>
                    )}

                    <div
                      className={`flex min-w-0 flex-1 items-start gap-3.5 rounded-card border p-3.5 transition-colors ${
                        isUnlocked
                          ? 'border-rank-steady/30 bg-rank-steady/10'
                          : reachable
                            ? 'border-line bg-surface-3/40 opacity-80'
                            : 'border-line/60 bg-surface-1 opacity-45'
                      }`}
                    >
                      <div
                        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-ctl border ${
                          isUnlocked
                            ? 'border-rank-steady/40 bg-rank-steady/20 text-rank-steady'
                            : 'border-line bg-surface-3 text-locked'
                        }`}
                      >
                        {isUnlocked ? (
                          ICON_MAP[ach.icon] || <Award className="w-5 h-5 text-rank-steady" />
                        ) : revealed ? (
                          <Lock className="w-5 h-5" />
                        ) : (
                          <HelpCircle className="w-5 h-5" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <h4
                            className={`truncate text-2xs ${
                              isUnlocked ? 'text-ink' : 'text-ink-muted'
                            }`}
                          >
                            {revealed ? ach.title : t('ach_hidden_title', language)}
                          </h4>
                          <span className="shrink-0 text-2xs text-xp">
                            {revealed ? `+${ach.xpReward} XP` : '???'}
                          </span>
                        </div>
                        <p className="mt-0.5 text-2xs font-normal tracking-normal text-ink-muted">
                          {revealed ? ach.description : t('ach_hidden_desc', language)}
                        </p>
                        {isUnlocked ? (
                          <div className="mt-1 flex items-center gap-1 text-2xs text-win">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>{t('ach_unlocked', language)}</span>
                          </div>
                        ) : (
                          !reachable && (
                            <div className="mt-1 flex items-center gap-1 text-2xs text-ink-dim">
                              <Lock className="w-3 h-3" />
                              <span>
                                {t('ach_requires', language, {
                                  name: isRevealed(ach.parent || '', earned, progress)
                                    ? achievements.find((a) => a.id === ach.parent)?.title || ''
                                    : t('ach_hidden_title', language),
                                })}
                              </span>
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
    </Sheet>
  );
};
