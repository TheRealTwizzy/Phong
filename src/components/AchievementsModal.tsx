import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Achievement, AchievementBranch, LanguageCode } from '../types';
import { BRANCHES, isRevealed, isUnlockable } from '../achievements';
import { t } from '../i18n/translations';
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
  language?: LanguageCode;
}

const ICON_MAP: Record<string, React.ReactNode> = {
  zap: <Zap className="w-5 h-5 text-yellow-400" />,
  activity: <Zap className="w-5 h-5 text-emerald-400" />,
  flame: <Flame className="w-5 h-5 text-orange-400" />,
  shield: <Shield className="w-5 h-5 text-cyan-400" />,
  trophy: <Trophy className="w-5 h-5 text-amber-400" />,
  star: <Star className="w-5 h-5 text-purple-400" />,
  cpu: <Cpu className="w-5 h-5 text-pink-400" />,
  smartphone: <Smartphone className="w-5 h-5 text-blue-400" />,
  target: <Target className="w-5 h-5 text-rose-400" />,
  award: <Award className="w-5 h-5 text-amber-300" />,
  sparkles: <Sparkles className="w-5 h-5 text-yellow-300" />,
  crown: <Crown className="w-5 h-5 text-yellow-400" />,
  'trending-up': <TrendingUp className="w-5 h-5 text-emerald-300" />,
};

export const AchievementsModal: React.FC<Props> = ({ isOpen, onClose, playerId, language = 'en' }) => {
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

  if (!isOpen) return null;

  const unlockedCount = achievements.filter((a) => a.unlockedAt).length;
  const earned = achievements.filter((a) => a.unlockedAt).map((a) => a.id);

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

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
        <motion.div
          id="achievements-modal-container"
          initial={{ opacity: 0, scale: 0.92, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, y: 20 }}
          className="bg-slate-900 border border-purple-500/30 rounded-3xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col max-h-[90vh]"
        >
          {/* Header */}
          <div className="p-6 bg-gradient-to-r from-purple-950/60 via-slate-900 to-indigo-950/60 border-b border-slate-800 relative">
            <button
              id="close-achievements-btn"
              onClick={onClose}
              className="absolute top-4 right-4 p-2 text-slate-400 hover:text-white rounded-full hover:bg-white/10 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-2xl bg-purple-400/10 border border-purple-400/30 text-purple-400">
                <Award className="w-7 h-7" />
              </div>
              <div>
                <h2 className="text-xl font-black text-white">Career Achievements</h2>
                <p className="text-xs text-slate-400">Unlock trophies and earn XP rewards</p>
              </div>
            </div>

            {/* Overall Progress */}
            <div className="mt-4 bg-slate-950/60 p-3 rounded-xl border border-slate-800/80">
              <div className="flex justify-between items-center text-xs mb-1.5 font-bold">
                <span className="text-slate-300">Completion Status</span>
                <span className="text-purple-400">
                  {unlockedCount} / {achievements.length} ({progressPercent}%)
                  <span className="text-slate-500 ml-2">
                    · {t('ach_this_branch', language)} {branchDone}/{rows.length}
                  </span>
                </span>
              </div>
              <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-purple-500 to-pink-500 rounded-full transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            {/* Branch tabs — one short tree each, rather than one long list */}
            <div className="flex gap-1.5 mt-4 overflow-x-auto pb-1">
              {BRANCHES.map((b) => {
                const nodes = achievements.filter((a) => a.branch === b.id);
                const done = nodes.filter((a) => a.unlockedAt).length;
                return (
                  <button
                    key={b.id}
                    id={`ach-branch-${b.id}`}
                    onClick={() => setBranch(b.id)}
                    className={`py-1 px-3 rounded-lg text-xs font-bold whitespace-nowrap transition-colors ${
                      branch === b.id
                        ? 'bg-purple-500 text-white'
                        : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t(b.titleKey, language)}
                    <span className="ml-1.5 opacity-70 font-mono">
                      {done}/{nodes.length}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* List Content */}
          <div className="p-4 overflow-y-auto flex-1 space-y-2.5">
            {isLoading ? (
              <div className="text-center py-12 text-slate-400 text-sm">Loading trophies...</div>
            ) : (
              rows.map(({ ach, depth, lastChild }) => {
                const isUnlocked = !!ach.unlockedAt;
                const reachable = isUnlockable(ach.id, earned);
                const revealed = isRevealed(ach.id, earned);
                return (
                  <div key={ach.id} className="flex items-stretch" id={`ach-row-${ach.id}`}>
                    {/* Connector rail: one rung of indentation per depth, with
                        the elbow drawn into the parent above it. */}
                    {depth > 0 && (
                      <div className="flex shrink-0" aria-hidden="true">
                        {Array.from({ length: depth - 1 }).map((_, i) => (
                          <div key={i} className="w-4 border-l border-slate-700/70 ml-2" />
                        ))}
                        <div className="w-4 ml-2 relative">
                          <div
                            className={`absolute left-0 top-0 w-px bg-slate-700/70 ${
                              lastChild ? 'h-6' : 'h-full'
                            }`}
                          />
                          <div className="absolute left-0 top-6 w-4 h-px bg-slate-700/70" />
                        </div>
                      </div>
                    )}

                    <div
                      className={`flex-1 flex items-start gap-3.5 p-3.5 rounded-2xl border transition-all min-w-0 ${
                        isUnlocked
                          ? 'bg-purple-950/20 border-purple-500/30'
                          : reachable
                            ? 'bg-slate-800/20 border-slate-800 opacity-80'
                            : 'bg-slate-900/40 border-slate-800/60 opacity-45'
                      }`}
                    >
                      <div
                        className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border ${
                          isUnlocked
                            ? 'bg-purple-500/20 border-purple-400/40 text-purple-300'
                            : 'bg-slate-800 border-slate-700 text-slate-600'
                        }`}
                      >
                        {isUnlocked ? (
                          ICON_MAP[ach.icon] || <Award className="w-5 h-5 text-purple-400" />
                        ) : revealed ? (
                          <Lock className="w-5 h-5" />
                        ) : (
                          <HelpCircle className="w-5 h-5" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <h4
                            className={`text-sm font-bold truncate ${
                              isUnlocked ? 'text-white' : 'text-slate-400'
                            }`}
                          >
                            {revealed ? ach.title : t('ach_hidden_title', language)}
                          </h4>
                          <span className="text-xs font-bold text-yellow-400 shrink-0">
                            {revealed ? `+${ach.xpReward} XP` : '???'}
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {revealed ? ach.description : t('ach_hidden_desc', language)}
                        </p>
                        {isUnlocked ? (
                          <div className="flex items-center gap-1 text-[10px] text-emerald-400 font-bold mt-1">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>{t('ach_unlocked', language)}</span>
                          </div>
                        ) : (
                          !reachable && (
                            <div className="flex items-center gap-1 text-[10px] text-slate-500 font-bold mt-1">
                              <Lock className="w-3 h-3" />
                              <span>
                                {t('ach_requires', language, {
                                  name: isRevealed(ach.parent || '', earned)
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
          </div>

          {/* Footer */}
          <div className="p-4 bg-slate-950 border-t border-slate-800 text-center text-xs text-slate-400">
            Unlocking achievements accelerates your player level and leaderboard standing!
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
