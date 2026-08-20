import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Achievement } from '../types';
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
  CheckCircle2,
} from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  playerId: string;
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

export const AchievementsModal: React.FC<Props> = ({ isOpen, onClose, playerId }) => {
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [category, setCategory] = useState<'all' | 'beginner' | 'mastery' | 'online' | 'special'>('all');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isOpen && playerId) {
      setIsLoading(true);
      fetch(`/api/achievements?playerId=${playerId}`)
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
  const filtered =
    category === 'all'
      ? achievements
      : achievements.filter((a) => a.category === category);

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
                <span className="text-purple-400">{unlockedCount} / {achievements.length} Badges ({progressPercent}%)</span>
              </div>
              <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-purple-500 to-pink-500 rounded-full transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            {/* Category Filter */}
            <div className="flex gap-1.5 mt-4 overflow-x-auto pb-1">
              {(['all', 'beginner', 'mastery', 'online', 'special'] as const).map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  className={`py-1 px-3 rounded-lg text-xs font-bold whitespace-nowrap transition-colors ${
                    category === cat
                      ? 'bg-purple-500 text-white'
                      : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {cat.charAt(0).toUpperCase() + cat.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* List Content */}
          <div className="p-4 overflow-y-auto flex-1 space-y-2.5">
            {isLoading ? (
              <div className="text-center py-12 text-slate-400 text-sm">Loading trophies...</div>
            ) : (
              filtered.map((ach) => {
                const isUnlocked = !!ach.unlockedAt;
                return (
                  <div
                    key={ach.id}
                    className={`flex items-start gap-3.5 p-3.5 rounded-2xl border transition-all ${
                      isUnlocked
                        ? 'bg-purple-950/20 border-purple-500/30'
                        : 'bg-slate-800/20 border-slate-800 opacity-60'
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
                      ) : (
                        <Lock className="w-5 h-5" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <h4 className={`text-sm font-bold truncate ${isUnlocked ? 'text-white' : 'text-slate-400'}`}>
                          {ach.title}
                        </h4>
                        <span className="text-xs font-bold text-yellow-400 shrink-0">
                          +{ach.xpReward} XP
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">{ach.description}</p>
                      {isUnlocked && (
                        <div className="flex items-center gap-1 text-[10px] text-emerald-400 font-bold mt-1">
                          <CheckCircle2 className="w-3 h-3" />
                          <span>Unlocked</span>
                        </div>
                      )}
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
