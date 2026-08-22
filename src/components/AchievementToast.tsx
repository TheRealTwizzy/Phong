import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Achievement, LanguageCode } from '../types';
import { t } from '../i18n/translations';
import { Award, Zap, Flame, Shield, Trophy, Star, Cpu, Smartphone, Target, Sparkles, Crown, TrendingUp } from 'lucide-react';

interface Props {
  achievement: Achievement | null;
  levelUp: number | null;
  onClose: () => void;
  language: LanguageCode;
}

const ICON_MAP: Record<string, React.ReactNode> = {
  zap: <Zap className="w-6 h-6 text-yellow-400" />,
  activity: <Zap className="w-6 h-6 text-emerald-400" />,
  flame: <Flame className="w-6 h-6 text-orange-400" />,
  shield: <Shield className="w-6 h-6 text-cyan-400" />,
  trophy: <Trophy className="w-6 h-6 text-amber-400" />,
  star: <Star className="w-6 h-6 text-purple-400" />,
  cpu: <Cpu className="w-6 h-6 text-pink-400" />,
  smartphone: <Smartphone className="w-6 h-6 text-blue-400" />,
  target: <Target className="w-6 h-6 text-rose-400" />,
  award: <Award className="w-6 h-6 text-amber-300" />,
  sparkles: <Sparkles className="w-6 h-6 text-yellow-300" />,
  crown: <Crown className="w-6 h-6 text-yellow-400" />,
  'trending-up': <TrendingUp className="w-6 h-6 text-emerald-300" />,
};

export const AchievementToast: React.FC<Props> = ({ achievement, levelUp, onClose, language }) => {
  useEffect(() => {
    if (achievement || levelUp) {
      const timer = setTimeout(() => {
        onClose();
      }, 4500);
      return () => clearTimeout(timer);
    }
  }, [achievement, levelUp, onClose]);

  return (
    <AnimatePresence>
      {(achievement || levelUp) && (
        <motion.div
          id="achievement-toast"
          initial={{ opacity: 0, y: -60, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -40, scale: 0.95 }}
          transition={{ type: 'spring', damping: 20, stiffness: 300 }}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-11/12 max-w-md pointer-events-auto"
        >
          {levelUp ? (
            <div className="bg-gradient-to-r from-amber-500/20 via-yellow-500/30 to-amber-500/20 backdrop-blur-xl border border-yellow-400/50 rounded-2xl p-4 shadow-2xl shadow-yellow-500/20 flex items-center gap-4 text-white">
              <div className="w-12 h-12 rounded-xl bg-yellow-400/20 border border-yellow-400/40 flex items-center justify-center shrink-0">
                <Crown className="w-7 h-7 text-yellow-300 animate-pulse" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold uppercase tracking-wider text-yellow-400">{t('toast_level_up', language)}</div>
                <div className="text-base font-black text-white truncate">{t('toast_level_promoted', language, { n: levelUp })}</div>
                <div className="text-xs text-yellow-200/80">{t('toast_level_hint', language)}</div>
              </div>
            </div>
          ) : achievement ? (
            <div className="bg-gradient-to-r from-cyan-950/90 via-slate-900/90 to-cyan-950/90 backdrop-blur-xl border border-cyan-500/40 rounded-2xl p-4 shadow-2xl shadow-cyan-500/20 flex items-center gap-4 text-white">
              <div className="w-12 h-12 rounded-xl bg-cyan-500/20 border border-cyan-400/40 flex items-center justify-center shrink-0">
                {ICON_MAP[achievement.icon] || <Award className="w-6 h-6 text-cyan-400" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold uppercase tracking-wider text-cyan-400 flex items-center justify-between">
                  <span>{t('toast_achievement_unlocked', language)}</span>
                  <span className="text-yellow-400 font-bold">+{achievement.xpReward} XP</span>
                </div>
                <div className="text-base font-bold text-white truncate">{achievement.title}</div>
                <div className="text-xs text-slate-300 truncate">{achievement.description}</div>
              </div>
            </div>
          ) : null}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
