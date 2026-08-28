import React, { useEffect, useState } from 'react';
import {
  Achievement,
  DailyMission,
  GameMode,
  GameSettings,
  PlayerProfile,
  PlayerStatus,
} from '../types';
import { Cosmetic } from '../game/cosmetics';
import { t } from '../i18n/translations';
import { AvatarImage } from './AvatarImage';
import {
  aiRating,
  winProbability,
  recommendedDifficulty,
  xpForLevel,
  TIER_LABEL_KEY,
} from '../rating';
import { normalizeRules } from '../matchRules';
import { hasUnlock, unlockedBy } from '../achievements';
import { MatchRulesPanel } from './MatchRulesPanel';
import { QuickMatch } from '../net/useQuickMatch';
import {
  BUILDINGS,
  BuildingId,
  DEFAULT_BUILDING,
  DEFAULT_VENUE_ROOM,
  EntryVerdict,
  RoomDef,
  roomEntryVerdict,
  roomsOf,
} from '../venues';
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
  Play,
  Shield,
  Flame,
  ChevronRight,
  Lock,
} from 'lucide-react';

// Out-of-match hub. Reads top-down as WHO YOU ARE → WHAT YOU PLAY → WHAT'S
// NEXT, which is the shape a competitive title's home screen takes.
//
// The shell does not scroll; exactly one region does. Header and tab bar are
// shrink-0 flex children of a full-height column rather than position:fixed,
// because dvh changes as mobile browser chrome collapses and a fixed bar
// would jump mid-scroll.
//
// EVERY mode opens the same pre-match surface. A duel has always had one —
// the lobby — and the other three used to expand INTO THE LIST instead, as an
// accordion. That was not merely a second flow, it was a broken one:
//
//   - The scroll region is a flex column, and the accordion card carried
//     `overflow-hidden`. A flex item whose overflow is not `visible` has an
//     automatic minimum size of ZERO, so the column had permission to squash
//     its children instead of overflowing. It took it. Nothing ever exceeded
//     the container, so `overflow-y: auto` had nothing to scroll and the menu
//     simply could not be scrolled.
//   - Everything in the list was crushed to fit whatever the open card
//     wanted: the other three mode rows collapsed to ~12px slivers, and the
//     open card was itself clipped to a fraction of its content — measured at
//     126px of a needed 772px with the rules panel open.
//   - The Start button, last in the clipped card, landed 160px BELOW the
//     viewport with no way to reach it. That is the "cannot start anything
//     but a duel" report: the button existed, and no gesture could get to it.
//
// So the fix is the same shape as the cure: pre-match setup is a Sheet, which
// caps itself against the visible viewport, scrolls its own body, and pins
// the Start CTA in a footer that cannot be scrolled away. Every child of the
// scroll region below is `shrink-0` so this class of collapse cannot return.
/**
 * How long a search runs before the menu offers a door that does not depend on
 * anybody else joining the queue. Long enough that a quick pairing never sees
 * it, short enough that a quiet evening is not a dead end.
 */
const QUEUE_BROWSE_AFTER_S = 45;

interface MainMenuProps {
  /**
   * The ranked queue. Owned by App, because the state machine is driven by
   * relay messages and App is where the socket is — the hook keeps the state,
   * the menu keeps the surface.
   */
  quickMatch: QuickMatch;
  theme: Cosmetic;
  settings: GameSettings;
  onUpdateSettings: (newSettings: Partial<GameSettings>) => void;
  profile: PlayerProfile | null;
  playerStatus: PlayerStatus;
  missions: DailyMission[];
  unclaimedMissionsCount: number;
  onStartSolo: () => void;
  onStartPractice: () => void;
  onStartSplit: () => void;
  /** `venue` is the PvP room walked in from, or undefined for the bare flow. */
  onOpenMultiplayer: (venue?: string) => void;
  onOpenProfile: () => void;
  onOpenLeaderboard: () => void;
  onOpenAchievements: () => void;
  onOpenHistory: () => void;
  onOpenMissions: () => void;
  onOpenSettings: () => void;
}

/** Buildings name their icon; the component owns the drawing. */
const BUILDING_ICONS: Record<BuildingId, React.ReactNode> = {
  pvp: <Smartphone className="h-5 w-5" />,
  solo: <Bot className="h-5 w-5" />,
  training: <Dumbbell className="h-5 w-5" />,
};

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-kicker shrink-0 px-0.5 text-ink-dim uppercase">{children}</span>
);

export const MainMenu: React.FC<MainMenuProps> = ({
  quickMatch,
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
}) => {
  const lang = settings.language || 'en';
  // Which mode's pre-match sheet is open. A duel's lives in App (the lobby
  // owns a room, not just a form), so this only ever holds the other three.
  const [prematchMode, setPrematchMode] = useState<GameMode | null>(null);
  const openPrematch = prematchMode;
  // Which gate the player tapped, so the reason a rung is shut is something
  // they can read rather than a tooltip no touch device will ever show.
  const [gateHint, setGateHint] = useState<Achievement | null>(null);
  const [queueInfoOpen, setQueueInfoOpen] = useState(false);
  const openGateHint = gateHint;
  const openQueueInfo = queueInfoOpen;
  const searching = quickMatch.state.status === 'searching';
  const since = quickMatch.state.status === 'searching' ? quickMatch.state.since : 0;
  // One second of state per second of searching, and only while searching:
  // a ticker that runs on an idle menu is a render per second for nothing.
  const [queueElapsed, setQueueElapsed] = useState(0);
  useEffect(() => {
    if (!searching) {
      setQueueElapsed(0);
      return;
    }
    const tick = () => setQueueElapsed(Math.max(0, Math.round((Date.now() - since) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [searching, since]);
  // Where in the building -> room walk this player is. MainMenu's own state,
  // like prematchMode: App owns a duel's lobby because a lobby owns a ROOM on
  // the relay, but navigating to one is just navigating.
  const [nav, setNav] = useState<{ building: BuildingId; room: string | null }>({
    building: DEFAULT_BUILDING,
    room: null,
  });
  const openNav = nav;
  /**
   * Whether the current building is also showing the rooms this player cannot
   * enter yet.
   *
   * Shut by default: a list is a list of places you can go, and five rows of
   * padlock is a wall rather than a menu. The rungs above you are still worth
   * SEEING — they are what the ladder is for — so the selected tab doubles as
   * the way to look: tap the tab you are already on and the locked rooms fold
   * out, tap it again (or move to another building) and they fold away.
   *
   * One flag rather than one per building, because switching buildings closes
   * it anyway: there is only ever one list on screen.
   */
  const [revealLocked, setRevealLocked] = useState(false);
  const revealed = revealLocked;

  const MODE_META: {
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

  /**
   * A room is where a match begins.
   *
   * A SOLO room IS a difficulty, so entering one sets it — the pre-match sheet
   * no longer asks, because the room already answered. A TRAINING room names
   * its mode. A PVP room opens the lobby, which is that mode's pre-match
   * surface plus a relay room.
   */
  const handleRoomTap = (room: RoomDef) => {
    setNav((n) => ({ ...n, room: room.id }));
    if (room.building === 'pvp') {
      onOpenMultiplayer(room.id);
      return;
    }
    if (room.difficulty) {
      onUpdateSettings({ difficulty: room.difficulty });
      setPrematchMode('solo');
      return;
    }
    if (room.mode) setPrematchMode(room.mode);
  };

  /** Why a bracketed room is shut, in words the player can act on. */
  const lockReason = (verdict: EntryVerdict): string => {
    if (verdict.ok) return '';
    if (verdict.reason === 'level') return t('room_locked_level', lang, { level: verdict.needLevel });
    if (verdict.reason === 'tier_low') {
      return t('room_locked_tier_low', lang, { tier: t(TIER_LABEL_KEY[verdict.needTier], lang) });
    }
    if (verdict.reason === 'tier_high') {
      return t('room_locked_tier_high', lang, { tier: t(TIER_LABEL_KEY[verdict.maxTier], lang) });
    }
    return '';
  };

  // The sheet closes on the way to the court, exactly as `game_start` closes
  // both lobbies: nobody is left holding a setup form over a live match.
  const startPrematch = () => {
    const id = prematchMode;
    setPrematchMode(null);
    if (id === 'solo') onStartSolo();
    else if (id === 'practice') onStartPractice();
    else if (id === 'split') onStartSplit();
  };

  const prematch = MODE_META.find((m) => m.id === openPrematch) ?? null;

  // Hidden MMR drives every prediction on this screen (solo play moves it,
  // even though it can never move the visible tier).
  const myRating = { mu: profile?.mmrMu ?? 25, sigma: profile?.mmrSigma ?? 25 / 3 };
  const bestDifficulty = recommendedDifficulty(myRating);
  // The odds against the rung the room picked — the same number that scales
  // this match's XP, shown where the player confirms the match rather than
  // where they chose the room.
  const soloChance = Math.round(
    winProbability(myRating, aiRating(settings.difficulty, myRating.mu)) * 100
  );
  // The achievement tree gates the ladder: a difficulty or a match length is
  // something you earn your way into, so the menu shows what is still shut and
  // what opens it rather than silently offering everything.
  const earned = profile?.achievements || [];
  const opened = (kind: 'difficulty' | 'winningScore' | 'mode', value: string | number) =>
    hasUnlock(earned, kind, value);

  /**
   * Why a room is shut, if it is. Two different gates, deliberately kept
   * apart: a SOLO room is a rung of the AI ladder, walked through the
   * achievement chain, and a PVP room is a skill bracket judged from level and
   * tier. A room answers to one or the other, never both.
   *
   * Hoisted out of the render so the list can be FILTERED on it and the rooms
   * it hides can be counted — a toggle nothing hints at is a toggle nobody
   * finds.
   */
  const roomLock = (room: RoomDef) => {
    const ladder =
      room.difficulty && !opened('difficulty', room.difficulty)
        ? unlockedBy('difficulty', room.difficulty) ?? null
        : null;
    const verdict = roomEntryVerdict(room, profile);
    return { ladder, verdict, locked: !!ladder || !verdict.ok };
  };

  const buildingRooms = roomsOf(openNav.building);
  const lockedRooms = buildingRooms.filter((room) => roomLock(room).locked);
  const visibleRooms = revealed ? buildingRooms : buildingRooms.filter((room) => !roomLock(room).locked);

  // xp is a running total and xpNext an absolute threshold, so the bar has to
  // be measured from the floor of the CURRENT level — same arithmetic the
  // profile card uses. Reading xp/xpNext directly understates it badly at
  // higher levels.
  const levelFloor = profile ? xpForLevel(profile.level) : 0;
  const xpIntoLevel = Math.max(0, (profile?.xp ?? 0) - levelFloor);
  const xpForThisLevel = Math.max(1, (profile?.xpNext ?? 1) - levelFloor);
  const xpFraction = Math.min(1, xpIntoLevel / xpForThisLevel);

  // The five destinations. SETTINGS holds the slot PROFILE used to, which is
  // now the header pill alone — a tab bar entry and a header button for the
  // same modal were two doors to one room, and the pill is the one every suite
  // and every player already reaches for.
  //
  // Two strings here are load-bearing in a way that looks like tidiness debt
  // and is not. `tests/i18n.test.ts` fails on a key nothing references, and it
  // decides "references" by looking for the key name quoted ANYWHERE in src —
  // so `id: 'leaderboard'` is the only thing keeping the `leaderboard` key
  // alive across all seven locales (the label rendered here is `menu_tab_ranks`),
  // and `labelKey: 'settings'` is now the only reference to `settings` at all,
  // since the header gear that used to carry it as an aria-label is gone.
  // Rename either and seven dictionaries lose an entry apiece.
  const tabs: { id: string; icon: React.ReactNode; labelKey: string; onClick?: () => void }[] = [
    { id: 'play', icon: <Play className="h-4 w-4" />, labelKey: 'menu_tab_play' },
    { id: 'leaderboard', icon: <Trophy className="h-4 w-4" />, labelKey: 'menu_tab_ranks', onClick: onOpenLeaderboard },
    { id: 'achievements', icon: <Award className="h-4 w-4" />, labelKey: 'achievements', onClick: onOpenAchievements },
    { id: 'history', icon: <History className="h-4 w-4" />, labelKey: 'history', onClick: onOpenHistory },
    { id: 'settings', icon: <Settings className="h-4 w-4" />, labelKey: 'settings', onClick: onOpenSettings },
  ];

  const railMissions = missions.filter((m) => !m.claimed).slice(0, 3);

  return (
    <div
      id="main-menu-screen"
      className="relative flex h-full w-full flex-col overflow-hidden bg-surface-1 text-ink select-none"
    >
      {/* This used to be the ONLY place the equipped theme reached the shell —
          "a wash at low alpha over the surface ramp, so twenty themes cannot
          turn the menu into twenty different designs". That restraint was right
          while a theme was loose colours with nothing checking them: twenty
          hand-authored shells would have been twenty designs to maintain, and
          the first to drift would have been an unreadable one.

          Both halves of that are now enforced rather than trusted. A cosmetic's
          shell is DERIVED from its own court palette (shellFrom), so it cannot
          become an unrelated design, and a measured contrast floor over all
          twenty means it cannot become an illegible one. So the menu takes the
          whole palette through the tokens, and this is just the accent bloom on
          top of it. */}
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
      </header>

      {/* The one scrolling region. Every direct child is `shrink-0`: this is a
          flex column, and a flex item is free to be squashed below its content
          the moment its own overflow is not `visible` (a card that clips, a
          rail that scrolls sideways). Squashed children never overflow, and a
          region with nothing to overflow does not scroll. */}
      <main className="scroll-y relative z-10 flex min-h-0 flex-1 flex-col gap-3 px-safe pb-3">
        {/* Rank is the hero: the ladder always shows its next rung. */}
        <Panel id="menu-rank-card" variant="raised" className="flex shrink-0 items-center gap-4">
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

        {/* The ranked queue. The slot was held open and honest through the
            build that had no relay behind it — dashed, aria-disabled, and
            saying what it was waiting for. It is a real row now, and nothing
            above this component changed to make it one: that was the point of
            settling the client contract before the server existed. */}
        <button
          id="menu-mode-quickmatch"
          data-searching={searching ? 'true' : 'false'}
          onClick={() => setQueueInfoOpen(true)}
          className={`flex shrink-0 items-center gap-3 rounded-card border p-3 text-left transition-colors active:scale-[0.99] motion-reduce:active:scale-100 ${
            searching ? 'border-accent/50 bg-accent/10' : 'border-line-strong bg-surface-2'
          }`}
        >
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-ctl border ${
              searching ? 'border-accent/50 text-accent' : 'border-line-strong text-ink-muted'
            }`}
          >
            <Swords className="h-5 w-5" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-2xs text-ink">{t('menu_quickmatch', lang)}</span>
            <span className="text-2xs leading-tight font-normal tracking-normal text-ink-dim">
              {searching
                ? t('queue_searching', lang, { s: queueElapsed })
                : t('menu_quickmatch_desc', lang)}
            </span>
          </div>
          {searching && (
            <span
              id="quickmatch-searching-chip"
              className="animate-ready-pulse shrink-0 rounded-chip border border-accent/40 bg-accent/15 px-1.5 py-0.5 text-2xs text-accent uppercase"
            >
              {queueElapsed}s
            </span>
          )}
        </button>

        {/* A PLACE, not a filter — and the buildings are a TAB STRIP rather
            than a drill-down, the same shape (and the same markup) as the
            Match History and Leaderboard filters. A strip means switching
            buildings is one tap instead of back-then-tap, and it means the
            menu has no navigation state that a surface opened over it can
            strand: there is nowhere to be that is not "in a building".
            Selection is exposed as `data-selected`, never as a class. */}
        <div
          id="menu-buildings"
          role="tablist"
          aria-label={t('menu_section_play', lang)}
          className="grid shrink-0 grid-cols-3 gap-1 rounded-card border border-line bg-surface-1 p-1"
        >
          {BUILDINGS.map((b) => {
            const current = openNav.building === b.id;
            return (
              <button
                key={b.id}
                id={`building-${b.id}`}
                role="tab"
                aria-selected={current}
                data-selected={current ? 'true' : 'false'}
                data-reveal={current && revealed ? 'true' : 'false'}
                onClick={() => {
                  // The tab you are on is the control for its own list; the
                  // tabs you are not on are still just tabs. Moving buildings
                  // always closes the locked rooms, so the list you land on is
                  // the plain one.
                  if (current) setRevealLocked((v) => !v);
                  else {
                    setNav({ building: b.id, room: null });
                    setRevealLocked(false);
                  }
                }}
                className={`flex items-center justify-center gap-1.5 rounded-ctl px-2 py-2 text-2xs transition-colors ${
                  current ? 'bg-accent text-ink-on-accent' : 'text-ink-muted'
                }`}
              >
                {BUILDING_ICONS[b.id]}
                <span className="truncate">{t(b.labelKey, lang)}</span>
                {/* The only hint that the tab does anything when you are
                    already on it. A toggle nothing points at is a toggle
                    nobody finds, and the count is the reason to press it:
                    "there are three more rooms here" is the whole message.
                    Shown on the selected tab only — an unselected one is
                    still just a tab. */}
                {current && lockedRooms.length > 0 && (
                  <span
                    id="building-locked-count"
                    className={`flex shrink-0 items-center gap-0.5 rounded-chip px-1 text-2xs tnum ${
                      revealed ? 'bg-ink-on-accent/25' : 'bg-ink-on-accent/15'
                    }`}
                  >
                    <Lock className="h-2.5 w-2.5" />
                    {lockedRooms.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* The rooms of the selected building. A room is where the match
            actually begins: Solo and Training rooms open the pre-match sheet
            directly (no host to wait for, no opponent to seat), a PvP room
            opens its lobby. Nothing expands in place, and every child of this
            scroll region is `shrink-0` — see the note above it for what
            happens when one is not. */}
        {visibleRooms.map((room) => {
          const { ladder: ladderLock, verdict, locked } = roomLock(room);
          const chance = room.difficulty
            ? Math.round(winProbability(myRating, aiRating(room.difficulty, myRating.mu)) * 100)
            : null;
          return (
            <button
              key={room.id}
              id={`room-${room.id}`}
              data-locked={locked ? 'true' : 'false'}
              disabled={locked}
              onClick={() => {
                if (locked) return;
                handleRoomTap(room);
              }}
              className={`flex shrink-0 items-center gap-3 rounded-card border p-3 text-left transition-transform active:scale-[0.99] motion-reduce:active:scale-100 ${
                locked ? 'border-line bg-surface-2/40 opacity-60' : 'border-line bg-surface-2/70'
              }`}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-2xs text-ink">{t(room.labelKey, lang)}</span>
                  {/* Shown even on a LOCKED rung, deliberately: "this is the
                      fair fight" is most worth saying about a rung the player
                      has not reached yet, and it reads beside the unlock line
                      rather than competing with it. */}
                  {room.difficulty === bestDifficulty && (
                    <span
                      id="room-balanced"
                      className="shrink-0 rounded-chip border border-accent/40 bg-accent/15 px-1.5 py-0.5 text-2xs text-accent uppercase"
                    >
                      {t('balanced', lang)}
                    </span>
                  )}
                </span>
                {room.descKey && (
                  <span className="truncate text-2xs leading-tight font-normal tracking-normal text-ink-muted">
                    {t(room.descKey, lang)}
                  </span>
                )}
                {locked && (
                  <span
                    id={`room-${room.id}-lock`}
                    className="mt-0.5 flex items-center gap-1 text-2xs font-normal tracking-normal text-warn"
                  >
                    <Lock className="h-3 w-3 shrink-0" />
                    {ladderLock ? ladderLock.title : lockReason(verdict)}
                  </span>
                )}
              </div>
              {chance !== null && (
                <span
                  id={`room-${room.id}-odds`}
                  className={`shrink-0 text-2xs tnum font-normal tracking-normal ${
                    chance >= 60 ? 'text-win' : chance >= 40 ? 'text-warn' : 'text-loss'
                  }`}
                >
                  {chance}%
                </span>
              )}
              {!locked && <ChevronRight className="h-4 w-4 shrink-0 text-ink-dim" />}
            </button>
          );
        })}

        {railMissions.length > 0 && (
          <>
            <SectionLabel>{t('menu_section_today', lang)}</SectionLabel>
            <div id="menu-daily-rail" className="scroll-x flex shrink-0 gap-2 pb-1">
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

      {/* Pre-match setup — the ONLY place match settings change, and now the
          same surface for all three of them that a duel has always had. Body
          scrolls, footer does not: the Start CTA is reachable at any content
          height, on any phone, with every rule expanded. */}
      <Sheet
        id="prematch-modal"
        cardId="prematch-modal-container"
        isOpen={prematch !== null}
        onClose={() => setPrematchMode(null)}
        size="md"
        accent="accent"
        closeId="btn-close-prematch"
        closeLabel={t('close', lang)}
        icon={prematch?.icon}
        title={prematch ? t(prematch.labelKey, lang) : ''}
        subtitle={prematch ? t(prematch.descKey, lang) : ''}
        bodyClassName="scroll-y p-4 flex flex-col gap-3"
        footer={
          prematch ? (
            <>
              <Button id="btn-prematch-back" variant="ghost" onClick={() => setPrematchMode(null)}>
                {t('close', lang)}
              </Button>
              <Button
                id={`menu-start-${prematch.id}`}
                variant="primary"
                block
                icon={<Play className="h-3.5 w-3.5 fill-current" />}
                onClick={startPrematch}
              >
                {prematch.id === 'practice' ? t('start_training', lang) : t('start_match', lang)}
              </Button>
            </>
          ) : undefined
        }
      >
        {prematch && (
          <>
            {/* Locked identity, exactly as the lobby states it — a match is
                always played under the profile username. */}
            <div
              id="prematch-playing-as"
              className="flex items-center gap-2 rounded-card border border-line bg-surface-1 px-3 py-2"
            >
              <User className="h-4 w-4 shrink-0 text-accent" />
              <span className="text-2xs font-normal tracking-normal text-ink-muted">
                {t('playing_as', lang)}
              </span>
              <span className="truncate text-2xs text-ink">{profile?.username || 'Player'}</span>
            </div>

            <div id="prematch-match-settings" className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-kicker text-ink-dim uppercase">
                  {t('match_settings', lang)}
                </span>
                <span
                  id="prematch-mode-kicker"
                  className="rounded-chip border border-accent/40 bg-accent/12 px-1.5 py-0.5 text-2xs text-accent"
                >
                  {prematch.kicker}
                </span>
              </div>

              {/* The room already chose the rung, so this states it rather
                  than asking again — one answer, given once, in the place the
                  player gave it. The picker that used to live here is now the
                  Solo building's room list. */}
              {prematch.id === 'solo' && (
                <div
                  id="prematch-difficulty"
                  className="flex items-center gap-2 rounded-card border border-line bg-surface-1 p-2.5"
                >
                  <Shield className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                  <span className="text-2xs font-normal tracking-normal text-ink-muted">
                    {t('ai_difficulty', lang)}
                  </span>
                  <span id="prematch-difficulty-name" className="ml-auto text-2xs text-ink capitalize">
                    {settings.difficulty}
                  </span>
                  <span
                    id="prematch-difficulty-odds"
                    className={`shrink-0 text-2xs tnum font-normal tracking-normal ${
                      soloChance >= 60 ? 'text-win' : soloChance >= 40 ? 'text-warn' : 'text-loss'
                    }`}
                  >
                    {soloChance}%
                  </span>
                </div>
              )}

              {(prematch.id === 'solo' || prematch.id === 'split') && (
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
                mode={prematch.id}
                // Already clamped to a rung this profile has earned (App.tsx
                // does that on every achievement change), so the badge judges
                // the difficulty the match will actually be played on.
                difficulty={settings.difficulty}
              />
            </div>
          </>
        )}
      </Sheet>

      <UnlockHintSheet
        achievement={openGateHint}
        onClose={() => setGateHint(null)}
        closeLabel={t('close', lang)}
      />

      {/* The searching surface. The terms are stated BEFORE the player joins,
          and that is load-bearing rather than decorative: a queue table has no
          host and no editable rules, which is the whole reason the relay can
          skip the guest-ready handshake and start the match itself. Queueing
          is the yes, so the yes has to be given to something disclosed. */}
      <Sheet
        id="quickmatch-info-sheet"
        closeId="btn-close-quickmatch"
        isOpen={openQueueInfo}
        onClose={() => setQueueInfoOpen(false)}
        size="xs"
        layer="over"
        accent={searching ? 'accent' : 'warn'}
        closeLabel={t('close', lang)}
        icon={<Swords className="h-4 w-4" />}
        title={t('menu_quickmatch', lang)}
        footer={
          searching ? (
            <Button
              id="btn-quickmatch-cancel"
              variant="secondary"
              block
              onClick={quickMatch.cancel}
            >
              {t('cancel', lang)}
            </Button>
          ) : (
            <Button
              id="btn-quickmatch-join"
              variant="primary"
              block
              onClick={quickMatch.join}
            >
              {t('menu_quickmatch_cta', lang)}
            </Button>
          )
        }
      >
        <p className="text-2xs leading-relaxed font-normal tracking-normal text-ink-muted">
          {t('menu_quickmatch_body', lang)}
        </p>
        {searching && (
          <div className="mt-3 flex flex-col gap-2">
            <p id="quickmatch-status" className="text-2xs text-accent">
              {t('queue_searching', lang, { s: queueElapsed })}
            </p>
            <p className="text-2xs leading-relaxed font-normal tracking-normal text-ink-dim">
              {t('queue_hint', lang)}
            </p>
            {/* After a long enough wait, a door that does not depend on
                anybody else being in the queue. The search keeps running
                underneath — leaving it on is the point. */}
            {queueElapsed >= QUEUE_BROWSE_AFTER_S && (
              <Button
                id="btn-quickmatch-browse"
                variant="secondary"
                size="sm"
                block
                onClick={() => {
                  setQueueInfoOpen(false);
                  onOpenMultiplayer(DEFAULT_VENUE_ROOM);
                }}
              >
                {t('queue_browse', lang)}
              </Button>
            )}
          </div>
        )}
        {quickMatch.state.status === 'found' && (
          <p id="quickmatch-found" className="mt-3 text-2xs text-win">
            {t('queue_found', lang)} — {quickMatch.state.opponent.username}
          </p>
        )}
      </Sheet>
    </div>
  );
};
