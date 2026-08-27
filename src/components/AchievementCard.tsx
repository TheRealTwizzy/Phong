import React from 'react';
import { Achievement, LanguageCode } from '../types';
import { t } from '../i18n/translations';
import { Award, Zap, Flame, Shield, Trophy, Star, Cpu, Smartphone, Target, Sparkles, Crown, TrendingUp } from 'lucide-react';

// The two celebration cards, and nothing else. Positioning, motion, the tap
// target and the expiry timer all belong to ToastHost — this file used to own
// its own of each, which is how it ended up with a timer that never fired and
// no way to tap it away. See src/components/ui/Toast.tsx.

const ICON_MAP: Record<string, React.ReactNode> = {
  zap: <Zap className="w-6 h-6 text-xp" />,
  activity: <Zap className="w-6 h-6 text-win" />,
  flame: <Flame className="w-6 h-6 text-warn" />,
  shield: <Shield className="w-6 h-6 text-accent" />,
  trophy: <Trophy className="w-6 h-6 text-warn" />,
  star: <Star className="w-6 h-6 text-rank-steady" />,
  cpu: <Cpu className="w-6 h-6 text-pink-400 cos-light:text-pink-700" />,
  smartphone: <Smartphone className="w-6 h-6 text-blue-400 cos-light:text-blue-700" />,
  target: <Target className="w-6 h-6 text-loss" />,
  award: <Award className="w-6 h-6 text-warn" />,
  sparkles: <Sparkles className="w-6 h-6 text-xp" />,
  crown: <Crown className="w-6 h-6 text-xp" />,
  'trending-up': <TrendingUp className="w-6 h-6 text-win" />,
};

export const LevelUpCard: React.FC<{ level: number; language: LanguageCode }> = ({
  level,
  language,
}) => (
  <div className="bg-gradient-to-r from-warn/20 via-xp/30 to-warn/20 backdrop-blur-xl border border-xp/50 rounded-2xl p-4 shadow-2xl shadow-xp/20 flex items-center gap-4 text-ink">
    <div className="w-12 h-12 rounded-xl bg-xp/20 border border-xp/40 flex items-center justify-center shrink-0">
      <Crown className="w-7 h-7 text-xp animate-pulse" />
    </div>
    <div className="flex-1 min-w-0">
      <div className="text-xs font-bold uppercase tracking-wider text-xp">{t('toast_level_up', language)}</div>
      <div className="text-base font-black text-ink truncate">{t('toast_level_promoted', language, { n: level })}</div>
      <div className="text-xs text-xp/80">{t('toast_level_hint', language)}</div>
    </div>
  </div>
);

export const AchievementCard: React.FC<{ achievement: Achievement; language: LanguageCode }> = ({
  achievement,
  language,
}) => (
  <div className="bg-gradient-to-r from-accent/15 via-surface-2/90 to-accent/15 backdrop-blur-xl border border-accent/40 rounded-2xl p-4 shadow-2xl shadow-accent/20 flex items-center gap-4 text-ink">
    <div className="w-12 h-12 rounded-xl bg-accent/20 border border-accent/40 flex items-center justify-center shrink-0">
      {ICON_MAP[achievement.icon] || <Award className="w-6 h-6 text-accent" />}
    </div>
    <div className="flex-1 min-w-0">
      <div className="text-xs font-bold uppercase tracking-wider text-accent flex items-center justify-between">
        <span>{t('toast_achievement_unlocked', language)}</span>
        <span className="text-xp font-bold">+{achievement.xpReward} XP</span>
      </div>
      <div className="text-base font-bold text-ink truncate">{achievement.title}</div>
      <div className="text-xs text-ink truncate">{achievement.description}</div>
    </div>
  </div>
);
