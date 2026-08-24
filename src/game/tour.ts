// The onboarding tour, as a list.
//
// It replaces a four-slide "How to play" deck that taught none of the actual
// game: static CSS dioramas, a mini court that re-implemented physics inline
// (its own paddle width, its own spin maths, sharing nothing with
// src/game/physics.ts), never shown to a new player, and a finish button that
// promised "+50 XP" no code anywhere awarded.
//
// This one walks the real product. Each step names a `stage` — what the app
// has to be showing for the step to make sense — and App.tsx puts it there.
// The match stages open a REAL Solo Rookie match, first to three, and freeze
// it mid-frame, so the ball, the net, the radar and the scoreboard being
// described are the ones the player is about to use.
//
// It is in two halves, and the ORDER is the design. Play comes first: the
// rudiments, taught on a court. Only then the menu — what is on it and how to
// reach it. A player who has never hit a ball has nothing to hang a rank ring
// or a task list on, so a menu tour before a first rally is a tour of nouns.
//
// Duel is named on the menu half and not walked. It is the game's headline
// mode and a player should know it exists, but it needs a second phone and a
// second person, so a walkthrough of it is a walkthrough of something the
// player cannot do while holding this tour open.
//
// It grants nothing. The match it plays is not recorded, and finishing pays no
// XP, no missions and no achievements: the reward for learning the game is
// being able to play it.

/**
 * The terms the tour's own match is played on, and the reason they are here
 * rather than taken from the player's settings.
 *
 * Rookie because it is the only rung open from the first match, so the tour
 * can never be the thing that asks a new player for an unlock they do not
 * have — and because a REPLAY from Settings would otherwise drop a veteran's
 * stored Cyber difficulty into a walkthrough of the basics. First to three
 * because the match is a teaching aid: long enough to be a real match, short
 * enough that a player who carries on from the last step finishes it.
 *
 * Nothing here is recorded, so these terms never reach a profile.
 */
export const TOUR_DIFFICULTY = 'rookie' as const;
export const TOUR_WINNING_SCORE = 3;

export type TourStage =
  | 'menu'
  | 'prematch'
  | 'match'
  | 'settings'
  | 'profile'
  | 'leaderboard'
  | 'tasks';

export interface TourStep {
  id: string;
  /** Element id to spotlight. Absent = a centred card with no hole. */
  anchor?: string;
  stage: TourStage;
  titleKey: string;
  bodyKey: string;
  /**
   * Milliseconds of LIVE play before the court freezes again — for the steps
   * where a still frame is not the point. Reaching the serve step with the
   * ball sitting on the paddle explains nothing: the tour serves it, lets it
   * fly, and freezes on a ball in mid-air, which is the frame the next couple
   * of steps are actually about.
   */
  live?: number;
}

// Both keys are written out in full rather than built from the id.
// tests/i18n.test.ts finds a referenced key by looking for it QUOTED in the
// source, and its own comment says a template-literal key is a prompt to
// reconsider rather than to add an exception: a key nothing names literally is
// a key nothing can prove is alive.

export const TOUR_STEPS: readonly TourStep[] = [
  // ---------------------------------------------------------------------
  // Part one: play. A real Solo Rookie match, first to three, frozen between
  // steps so the thing being explained is on screen while it is explained.
  //
  // The match comes FIRST on purpose. A player who has never hit a ball has
  // no use for a rank ring or a task list — those only mean something once
  // there is a game behind them. So the rudiments come first, and the tour of
  // the menu comes after, when the player has something to hang it on.
  // ---------------------------------------------------------------------
  {
    id: 'welcome',
    stage: 'menu',
    titleKey: 'tour_welcome_title',
    bodyKey: 'tour_welcome_body',
  },
  {
    id: 'court',
    stage: 'match',
    anchor: 'half-court-container',
    titleKey: 'tour_court_title',
    bodyKey: 'tour_court_body',
  },
  {
    id: 'net',
    stage: 'match',
    anchor: 'half-court-canvas',
    titleKey: 'tour_net_title',
    bodyKey: 'tour_net_body',
  },
  {
    id: 'serve',
    stage: 'match',
    anchor: 'half-court-canvas',
    // Long enough for the ball to leave the paddle and be somewhere worth
    // looking at. A court with the ball parked on the paddle explains nothing.
    live: 620,
    titleKey: 'tour_serve_title',
    bodyKey: 'tour_serve_body',
  },
  {
    id: 'spin',
    stage: 'match',
    anchor: 'half-court-canvas',
    titleKey: 'tour_spin_title',
    bodyKey: 'tour_spin_body',
  },
  {
    id: 'radar',
    stage: 'match',
    anchor: 'radar-preview-container',
    titleKey: 'tour_radar_title',
    bodyKey: 'tour_radar_body',
  },
  {
    id: 'streak',
    stage: 'match',
    anchor: 'scoreboard-header',
    titleKey: 'tour_streak_title',
    bodyKey: 'tour_streak_body',
  },
  {
    id: 'score_hud',
    stage: 'match',
    anchor: 'scoreboard-header',
    titleKey: 'tour_score_hud_title',
    bodyKey: 'tour_score_hud_body',
  },

  // ---------------------------------------------------------------------
  // Part two: the menu. What is here and how to reach it — no more than that.
  // Leaving the match stage quits the tour's match on its own (App.tsx), so
  // this half opens on the menu without a step having to say so.
  // ---------------------------------------------------------------------
  {
    id: 'menu_intro',
    stage: 'menu',
    titleKey: 'tour_menu_intro_title',
    bodyKey: 'tour_menu_intro_body',
  },
  {
    id: 'rank',
    stage: 'menu',
    anchor: 'menu-rank-card',
    titleKey: 'tour_rank_title',
    bodyKey: 'tour_rank_body',
  },
  {
    id: 'xp',
    stage: 'menu',
    anchor: 'menu-xp-bar',
    titleKey: 'tour_xp_title',
    bodyKey: 'tour_xp_body',
  },
  {
    id: 'modes',
    stage: 'menu',
    anchor: 'menu-mode-solo',
    titleKey: 'tour_modes_title',
    bodyKey: 'tour_modes_body',
  },
  {
    id: 'prematch',
    stage: 'prematch',
    anchor: 'prematch-match-settings',
    titleKey: 'tour_prematch_title',
    bodyKey: 'tour_prematch_body',
  },
  {
    id: 'tabs',
    stage: 'menu',
    anchor: 'menu-tabbar',
    titleKey: 'tour_tabs_title',
    bodyKey: 'tour_tabs_body',
  },
  {
    id: 'tasks',
    stage: 'tasks',
    anchor: 'missions-modal-container',
    titleKey: 'tour_tasks_title',
    bodyKey: 'tour_tasks_body',
  },
  {
    id: 'leaderboard',
    stage: 'leaderboard',
    anchor: 'leaderboard-modal-container',
    titleKey: 'tour_leaderboard_title',
    bodyKey: 'tour_leaderboard_body',
  },
  {
    id: 'profile',
    stage: 'profile',
    anchor: 'profile-modal-container',
    titleKey: 'tour_profile_title',
    bodyKey: 'tour_profile_body',
  },
  {
    id: 'recovery',
    stage: 'profile',
    anchor: 'recovery-card',
    titleKey: 'tour_recovery_title',
    bodyKey: 'tour_recovery_body',
  },
  {
    id: 'settings',
    stage: 'settings',
    anchor: 'settings-modal-overlay',
    titleKey: 'tour_settings_title',
    bodyKey: 'tour_settings_body',
  },
  {
    id: 'done',
    stage: 'menu',
    titleKey: 'tour_done_title',
    bodyKey: 'tour_done_body',
  },
] as const;

/** Every i18n key the tour quotes, so a locale check can see them all. */
export const TOUR_KEYS: readonly string[] = TOUR_STEPS.flatMap((s) => [
  s.titleKey,
  s.bodyKey,
]);
