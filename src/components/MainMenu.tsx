import React, { useState } from 'react';
import {
  Achievement,
  DailyMission,
  GameMode,
  GameSettings,
  PlayerProfile,
  PlayerStatus,
} from '../types';
import { ThemeConfig } from '../game/themes';
import { t } from '../i18n/translations';
import { AvatarImage } from './AvatarImage';
import {
  AI_DIFFICULTIES,
  aiRating,
  winProbability,
  recommendedDifficulty,
  xpForLevel,
} from '../rating';
import { normalizeRules } from '../matchRules';
import { hasUnlock, unlockedBy } from '../achievements';
import { MatchRulesPanel } from './MatchRulesPanel';
import { useQuickMatch } from '../net/useQuickMatch';
import {
  Button,
  Panel,
  ProgressBar,
  RankBadge,
  SegmentedControl,
  Sheet,
  UnlockHintSheet,
} from './ui';
import {
  Bot,
  Dumbbell,
  Users,
  Smartphone,
  Swords,
  Target,
  Trophy,
  Award,
  History,
  User,
  Settings,
  BookOpen,
  Play,
  Shield,
  Flame,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

// Out-of-match hub. Reads top-down as WHO YOU ARE → WHAT YOU PLAY → WHAT'S
// NEXT, which is the shape a competitive title's home screen takes.
//
// The shell does not scroll; exactly one region does. Header and tab bar are
// shrink-0 flex children of a full-height column rather than position:fixed,
// because dvh changes as mobile browser chrome collapses and a fixed bar
// would jump mid-scroll.
//
// Match settings are still chosen HERE, before a match starts, and still by
// expanding a mode in place. Moving them into a bottom sheet was considered
// and rejected: the suites open a mode, pick a score and close it again by
// tapping the same control twice, which a sheet backdrop would swallow — and
// an accordion already withholds every mode's options until asked, which is
// the property that matters.
interface MainMenuProps {
  theme: ThemeConfig;
  settings: GameSettings;
  onUpdateSettings: (newSettings: Partial<GameSettings>) => void;
  profile: PlayerProfile | null;
  playerStatus: PlayerStatus;
  missions: DailyMission[];
  unclaimedMissionsCount: number;
  onStartSolo: () => void;
  onStartPractice: () => void;
  onStartSplit: () => void;
  onOpenMultiplayer: () => void;
  onOpenProfile: () => void;
  onOpenLeaderboard: () => void;
  onOpenAchievements: () => void;
  onOpenHistory: () => void;
  onOpenMissions: () => void;
  onOpenSettings: () => void;
  onOpenTutorial: () => void;
}

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-kicker px-0.5 text-ink-dim uppercase">{children}</span>
);

export const MainMenu: React.FC<MainMenuProps> = ({
  theme,
  settings,
  onUpdateSettings,
  profile,
  playerStatus,
  missions,
  unclaimedMissionsCount,
  onStartSolo,
  onStartPractice,
  onStartSplit,
  onOpenMultiplayer,
  onOpenProfile,
  onOpenLeaderboard,
  onOpenAchievements,
  onOpenHistory,
  onOpenMissions,
  onOpenSettings,
  onOpenTutorial,
}) => {
  const lang = settings.language || 'en';
  const [expandedMode, setExpandedMode] = useState<GameMode | null>(null);
  // Which gate the player tapped, so the reason a rung is shut is something
  // they can read rather than a tooltip no touch device will ever show.
  const [gateHint, setGateHint] = useState<Achievement | null>(null);
  const [queueInfoOpen, setQueueInfoOpen] = useState(false);
  const quickMatch = useQuickMatch();

  const modes: {
    id: GameMode;
    icon: React.ReactNode;
    labelKey: string;
    descKey: string;
    kicker: string;
  }[] = [
    // Mode identity is the icon plus a kicker, not a colour. This used to
    // hardcode four different accents that fought each other and the theme.
    { id: 'multiplayer', icon: <Smartphone className="h-5 w-5" />, labelKey: 'mode_multiplayer', descKey: 'menu_multiplayer_desc', kicker: 'FRIEND' },
    { id: 'solo', icon: <Bot className="h-5 w-5" />, labelKey: 'mode_solo', descKey: 'menu_solo_desc', kicker: 'VS AI' },
    { id: 'practice', icon: <Dumbbell className="h-5 w-5" />, labelKey: 'mode_practice', descKey: 'menu_practice_desc', kicker: 'DRILL' },
    { id: 'split', icon: <Users className="h-5 w-5" />, labelKey: 'mode_split', descKey: 'menu_split_desc', kicker: 'LOCAL' },
  ];

  const handleModeTap = (id: GameMode) => {
    if (id === 'multiplayer') {
      // The lobby IS the pre-match setup for 2-phone duels.
      onOpenMultiplayer();
      return;
    }
    setExpandedMode((cur) => (cur === id ? null : id));
  };

  const startExpanded = () => {
    if (expandedMode === 'solo') onStartSolo();
    else if (expandedMode === 'practice') onStartPractice();
    else if (expandedMode === 'split') onStartSplit();
  };

  // Hidden MMR drives every prediction on this screen (solo play moves it,
  // even though it can never move the visible tier).
  const myRating = { mu: profile?.mmrMu ?? 25, sigma: profile?.mmrSigma ?? 25 / 3 };
  const bestDifficulty = recommendedDifficulty(myRating);
  // The achievement tree gates the ladder: a difficulty or a match length is
  // something you earn your way into, so the menu shows what is still shut and
  // what opens it rather than silently offering everything.
  const earned = profile?.achievements || [];
  const opened = (kind: 'difficulty' | 'winningScore' | 'mode', value: string | number) =>
    hasUnlock(earned, kind, value);

  // xp is a running total and xpNext an absolute threshold, so the bar has to
  // be measured from the floor of the CURRENT level — same arithmetic the
  // profile card uses. Reading xp/xpNext directly understates it badly at
  // higher levels.
  const levelFloor = profile ? xpForLevel(profile.level) : 0;
  const xpIntoLevel = Math.max(0, (profile?.xp ?? 0) - levelFloor);
  const xpForThisLevel = Math.max(1, (profile?.xpNext ?? 1) - levelFloor);
  const xpFraction = Math.min(1, xpIntoLevel / xpForThisLevel);

  const tabs: { id: string; icon: React.ReactNode; labelKey: string; onClick?: () => void }[] = [
    { id: 'play', icon: <Play className="h-4 w-4" />, labelKey: 'menu_tab_play' },
    { id: 'leaderboard', icon: <Trophy className="h-4 w-4" />, labelKey: 'menu_tab_ranks', onClick: onOpenLeaderboard },
    { id: 'achievements', icon: <Award className="h-4 w-4" />, labelKey: 'achievements', onClick: onOpenAchievements },
    { id: 'history', icon: <History className="h-4 w-4" />, labelKey: 'history', onClick: onOpenHistory },
    { id: 'profile', icon: <User className="h-4 w-4" />, labelKey: 'profile', onClick: onOpenProfile },
  ];

  const railMissions = missions.filter((m) => !m.claimed).slice(0, 3);

  return (
    <div
      id="main-menu-screen"
      className="relative flex h-full w-full flex-col overflow-hidden bg-surface-1 text-ink select-none"
    >
      {/* The equipped court theme is FELT here and nowhere else in the shell:
          a wash at low alpha over the surface ramp, so twenty themes cannot
          turn the menu into twenty different designs. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(circle at 50% 14%, ${theme.accentColor}14 0%, transparent 60%)`,
        }}
      />

      <header className="relative z-10 flex shrink-0 items-center gap-2 px-safe pt-safe pb-2">
        <button
          id="menu-profile-pill"
          onClick={onOpenProfile}
          className="flex min-w-0 items-center gap-2 rounded-card border border-line bg-surface-2 p-1 pr-2.5 transition-colors active:scale-95 motion-reduce:active:scale-100"
        >
          <div className="relative shrink-0">
            <AvatarImage
              playerId={profile?.id}
              hasAvatar={profile?.hasAvatar}
              avatarVersion={profile?.avatarVersion}
              size={30}
              className="rounded-ctl border border-line-strong"
            />
            <span
              className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface-2 ${
                playerStatus === 'online'
                  ? 'bg-win'
                  : playerStatus === 'idle'
                    ? 'bg-warn'
                    : 'bg-locked'
              }`}
            />
          </div>
          <span className="max-w-[110px] truncate text-2xs text-ink">
            {profile?.username || 'Player'}
          </span>
          <span className="shrink-0 rounded-chip bg-xp px-1 text-2xs text-ink-on-accent">
            LV{profile?.level || 1}
          </span>
        </button>

        <span className="flex-1" />

        <button
          id="menu-nav-missions"
          onClick={onOpenMissions}
          aria-label={t('daily_missions', lang)}
          className="relative rounded-ctl border border-line bg-surface-2 p-2 text-accent transition-colors active:scale-95 motion-reduce:active:scale-100"
        >
          <Target className="h-4 w-4" />
          {unclaimedMissionsCount > 0 && (
            <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-surface-1 bg-loss px-1 text-2xs text-ink">
              {unclaimedMissionsCount}
            </span>
          )}
        </button>
        <button
          id="menu-nav-settings"
          onClick={onOpenSettings}
          aria-label={t('settings', lang)}
          className="rounded-ctl border border-line bg-surface-2 p-2 text-ink-muted transition-colors active:scale-95 motion-reduce:active:scale-100"
        >
          <Settings className="h-4 w-4" />
        </button>
      </header>

      <main className="scroll-y relative z-10 flex min-h-0 flex-1 flex-col gap-3 px-safe pb-3">
        {/* Rank is the hero: the ladder always shows its next rung. */}
        <Panel id="menu-rank-card" variant="raised" className="flex items-center gap-4">
          <RankBadge
            size="hero"
            tier={profile?.tier || 'unranked'}
            rankMu={profile?.rankMu ?? 25}
            rankedGames={profile?.rankedGames ?? 0}
            rankSigma={profile?.rankSigma ?? 25 / 3}
            language={lang}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-kicker text-ink-muted uppercase">
                {t('menu_level', lang)} {profile?.level || 1}
              </span>
              <span className="inline-flex items-center gap-0.5 rounded-chip border border-warn/30 bg-warn/15 px-1 text-2xs text-warn">
                <Flame className="h-2.5 w-2.5 fill-current" />
                {profile?.dailyStreak || 1}d
              </span>
            </div>
            <ProgressBar
              id="menu-xp-bar"
              value={xpFraction}
              tone="xp"
              ariaLabel={t('menu_level', lang)}
            />
          </div>
        </Panel>

        <SectionLabel>{t('menu_section_play', lang)}</SectionLabel>

        {/* The ranked queue's slot, held open and honest. It uses aria-disabled
            rather than disabled: a disabled button swallows the tap and reads
            as broken, where this can say what it is waiting for. */}
        <button
          id="menu-mode-quickmatch"
          data-stub="true"
          aria-disabled={!quickMatch.available}
          onClick={() => setQueueInfoOpen(true)}
          className="flex items-center gap-3 rounded-card border border-dashed border-line-strong bg-surface-2/60 p-3 text-left opacity-60 transition-colors"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-ctl border border-line-strong text-ink-muted">
            <Swords className="h-5 w-5" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-2xs text-ink">{t('menu_quickmatch', lang)}</span>
            <span className="text-2xs leading-tight font-normal tracking-normal text-ink-dim">
              {t('menu_quickmatch_desc', lang)}
            </span>
          </div>
          <span className="shrink-0 rounded-chip border border-warn/40 bg-warn/15 px-1.5 py-0.5 text-2xs text-warn uppercase">
            {t('menu_quickmatch_soon', lang)}
          </span>
        </button>

        {modes.map((m) => {
          const isExpanded = expandedMode === m.id;
          const isPrimary = m.id === 'multiplayer';
          return (
            <div
              key={m.id}
              className={`overflow-hidden rounded-card border transition-colors ${
                isExpanded || isPrimary
                  ? 'border-accent/40 bg-surface-2'
                  : 'border-line bg-surface-2/70'
              }`}
            >
              <button
                id={`menu-mode-${m.id}`}
                onClick={() => handleModeTap(m.id)}
                className="flex w-full items-center gap-3 p-3 text-left transition-transform active:scale-[0.99] motion-reduce:active:scale-100"
              >
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-ctl border ${
                    isPrimary
                      ? 'border-accent/50 bg-accent/15 text-accent'
                      : 'border-line-strong bg-surface-3 text-ink-muted'
                  }`}
                >
                  {m.icon}
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-2xs text-ink">{t(m.labelKey, lang)}</span>
                    <span className="shrink-0 text-2xs font-normal tracking-normal text-ink-dim">
                      {m.kicker}
                    </span>
                  </span>
                  <span className="truncate text-2xs leading-tight font-normal tracking-normal text-ink-muted">
                    {t(m.descKey, lang)}
                  </span>
                </div>
                {isPrimary ? (
                  <ChevronRight className="h-4 w-4 shrink-0 text-accent" />
                ) : (
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-ink-dim transition-transform ${
                      isExpanded ? 'rotate-180' : ''
                    }`}
                  />
                )}
              </button>

              {/* Pre-match setup — the ONLY place match settings change */}
              {isExpanded && (
                <div className="flex flex-col gap-3 border-t border-line px-3 pt-3 pb-3">
                  {m.id !== 'practice' && (
                    <SectionLabel>{t('match_settings', lang)}</SectionLabel>
                  )}

                  {m.id === 'solo' && (
                    <div className="flex flex-col gap-1.5">
                      <label className="flex items-center gap-1 text-2xs font-normal tracking-normal text-ink-muted">
                        <Shield className="h-3 w-3" />
                        {t('ai_difficulty', lang)}
                        <span className="ml-auto text-2xs text-ink-dim">
                          {t('win_chance', lang)}
                        </span>
                      </label>
                      <SegmentedControl
                        columns={3}
                        ariaLabel={t('ai_difficulty', lang)}
                        value={settings.difficulty}
                        onChange={(diff) => onUpdateSettings({ difficulty: diff })}
                        onLockTap={setGateHint}
                        options={AI_DIFFICULTIES.map((diff) => {
                          // Pre-match prediction from hidden MMR vs this AI
                          // anchor — the same number that scales match XP.
                          const chance = Math.round(
                            winProbability(myRating, aiRating(diff, myRating.mu)) * 100
                          );
                          return {
                            value: diff,
                            id: `menu-diff-${diff}`,
                            label: <span className="capitalize">{diff}</span>,
                            sublabel: `${chance}%`,
                            sublabelId: `menu-diff-${diff}-odds`,
                            sublabelTone:
                              chance >= 60 ? 'win' : chance >= 40 ? 'warn' : 'loss',
                            badge:
                              diff === bestDifficulty
                                ? { id: 'menu-diff-balanced', text: t('balanced', lang) }
                                : undefined,
                            lock: opened('difficulty', diff)
                              ? null
                              : unlockedBy('difficulty', diff) ?? null,
                            lockId: `menu-diff-${diff}-lock`,
                          };
                        })}
                      />
                    </div>
                  )}

                  {(m.id === 'solo' || m.id === 'split') && (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-2xs font-normal tracking-normal text-ink-muted">
                        {t('winning_score', lang)}
                      </label>
                      <SegmentedControl
                        columns={4}
                        ariaLabel={t('winning_score', lang)}
                        value={settings.winningScore}
                        onChange={(pts) => onUpdateSettings({ winningScore: pts })}
                        onLockTap={setGateHint}
                        options={[3, 5, 10, 15].map((pts) => ({
                          value: pts,
                          id: `menu-pts-${pts}`,
                          label: `${pts} pts`,
                          lock: opened('winningScore', pts)
                            ? null
                            : unlockedBy('winningScore', pts) ?? null,
                        }))}
                      />
                    </div>
                  )}

                  <MatchRulesPanel
                    rules={settings.rules}
                    onUpdateRules={(patch) =>
                      onUpdateSettings({ rules: normalizeRules({ ...settings.rules, ...patch }) })
                    }
                    lang={lang}
                    mode={m.id}
                  />

                  <Button
                    id={`menu-start-${m.id}`}
                    variant="primary"
                    size="lg"
                    block
                    icon={<Play className="h-4 w-4" />}
                    onClick={startExpanded}
                  >
                    {m.id === 'practice' ? t('start_training', lang) : t('start_match', lang)}
                  </Button>
                </div>
              )}
            </div>
          );
        })}

        {railMissions.length > 0 && (
          <>
            <SectionLabel>{t('menu_section_today', lang)}</SectionLabel>
            <div id="menu-daily-rail" className="scroll-x flex gap-2 pb-1">
              {railMissions.map((mi) => (
                <button
                  key={mi.id}
                  id={`menu-daily-${mi.id}`}
                  onClick={onOpenMissions}
                  className="flex w-40 shrink-0 flex-col gap-1.5 rounded-card border border-line bg-surface-2 p-2.5 text-left transition-colors active:scale-[0.99] motion-reduce:active:scale-100"
                >
                  <span className="truncate text-2xs text-ink">{t(mi.titleKey, lang)}</span>
                  <ProgressBar
                    height="sm"
                    value={mi.current / mi.target}
                    tone={mi.current >= mi.target ? 'win' : 'accent'}
                  />
                  <span className="text-2xs tnum font-normal tracking-normal text-ink-dim">
                    {mi.current}/{mi.target} · +{mi.xpReward} XP
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        <button
          id="menu-nav-tutorial"
          onClick={onOpenTutorial}
          className="flex items-center gap-2 rounded-card border border-line bg-surface-2/60 px-3 py-2.5 text-left text-ink-muted transition-colors active:scale-[0.99] motion-reduce:active:scale-100"
        >
          <BookOpen className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-2xs font-normal tracking-normal">
            {t('menu_how_to_play', lang)}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-ink-dim" />
        </button>
      </main>

      {/* A flex sibling, not position:fixed — dvh changes as mobile browser
          chrome collapses, and a fixed bar would jump mid-scroll. */}
      <nav
        id="menu-tabbar"
        className="relative z-10 grid shrink-0 grid-cols-5 border-t border-line bg-surface-2 px-safe pb-safe"
      >
        {tabs.map((tab) => {
          const current = !tab.onClick;
          return (
            <button
              key={tab.id}
              id={`menu-nav-${tab.id}`}
              onClick={tab.onClick}
              aria-current={current ? 'page' : undefined}
              className={`flex flex-col items-center gap-1 py-2.5 transition-colors ${
                current ? 'text-accent' : 'text-ink-muted'
              }`}
            >
              {tab.icon}
              <span className="max-w-full truncate text-2xs font-normal tracking-normal">
                {t(tab.labelKey, lang)}
              </span>
            </button>
          );
        })}
      </nav>

      <UnlockHintSheet
        achievement={gateHint}
        onClose={() => setGateHint(null)}
        closeLabel={t('close', lang)}
      />

      <Sheet
        id="quickmatch-info-sheet"
        isOpen={queueInfoOpen}
        onClose={() => setQueueInfoOpen(false)}
        size="xs"
        layer="over"
        accent="warn"
        closeLabel={t('close', lang)}
        icon={<Swords className="h-4 w-4" />}
        title={t('menu_quickmatch', lang)}
        footer={
          <Button
            variant="primary"
            block
            onClick={() => {
              setQueueInfoOpen(false);
              onOpenMultiplayer();
            }}
          >
            {t('menu_quickmatch_cta', lang)}
          </Button>
        }
      >
        <p className="text-2xs leading-relaxed font-normal tracking-normal text-ink-muted">
          {t('menu_quickmatch_body', lang)}
        </p>
      </Sheet>
    </div>
  );
};
