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
// The match stages open a REAL Solo Rookie match and freeze it mid-frame, so
// the ball, the net, the radar and the scoreboard being described are the ones
// the player is about to use.
//
// It grants nothing. The match it plays is not recorded, and finishing pays no
// XP, no missions and no achievements: the reward for learning the game is
// being able to play it.

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
  // Where you are.
  {
    id: 'welcome',
    stage: 'menu',
    titleKey: 'tour_welcome_title',
    bodyKey: 'tour_welcome_body',
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
    id: 'duel',
    stage: 'menu',
    anchor: 'menu-mode-multiplayer',
    titleKey: 'tour_duel_title',
    bodyKey: 'tour_duel_body',
  },
  {
    id: 'tasks_rail',
    stage: 'menu',
    anchor: 'menu-nav-missions',
    titleKey: 'tour_tasks_rail_title',
    bodyKey: 'tour_tasks_rail_body',
  },
  {
    id: 'tabs',
    stage: 'menu',
    anchor: 'menu-tabbar',
    titleKey: 'tour_tabs_title',
    bodyKey: 'tour_tabs_body',
  },

  // What you decide before a match.
  {
    id: 'prematch',
    stage: 'prematch',
    anchor: 'prematch-match-settings',
    titleKey: 'tour_prematch_title',
    bodyKey: 'tour_prematch_body',
  },
  {
    id: 'difficulty',
    stage: 'prematch',
    anchor: 'menu-diff-rookie',
    titleKey: 'tour_difficulty_title',
    bodyKey: 'tour_difficulty_body',
  },
  {
    id: 'odds',
    stage: 'prematch',
    anchor: 'menu-diff-rookie-odds',
    titleKey: 'tour_odds_title',
    bodyKey: 'tour_odds_body',
  },
  {
    id: 'score',
    stage: 'prematch',
    anchor: 'menu-pts-5',
    titleKey: 'tour_score_title',
    bodyKey: 'tour_score_body',
  },
  {
    id: 'rules',
    stage: 'prematch',
    anchor: 'prematch-match-settings',
    titleKey: 'tour_rules_title',
    bodyKey: 'tour_rules_body',
  },

  // The court, frozen.
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
    id: 'radar',
    stage: 'match',
    anchor: 'radar-preview-container',
    titleKey: 'tour_radar_title',
    bodyKey: 'tour_radar_body',
  },
  {
    id: 'score_hud',
    stage: 'match',
    anchor: 'scoreboard-header',
    titleKey: 'tour_score_hud_title',
    bodyKey: 'tour_score_hud_body',
  },
  {
    id: 'serve',
    stage: 'match',
    anchor: 'half-court-canvas',
    titleKey: 'tour_serve_title',
    bodyKey: 'tour_serve_body',
    // Long enough for the ball to leave the paddle and still be on this half.
    live: 620,
  },
  {
    id: 'spin',
    stage: 'match',
    anchor: 'half-court-canvas',
    titleKey: 'tour_spin_title',
    bodyKey: 'tour_spin_body',
  },
  {
    id: 'streak',
    stage: 'match',
    anchor: 'scoreboard-header',
    titleKey: 'tour_streak_title',
    bodyKey: 'tour_streak_body',
  },
  {
    id: 'hud',
    stage: 'match',
    anchor: 'btn-open-settings',
    titleKey: 'tour_hud_title',
    bodyKey: 'tour_hud_body',
  },

  // The rest of the app.
  {
    id: 'settings',
    stage: 'settings',
    anchor: 'settings-modal-overlay',
    titleKey: 'tour_settings_title',
    bodyKey: 'tour_settings_body',
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
    id: 'leaderboard',
    stage: 'leaderboard',
    anchor: 'leaderboard-modal-container',
    titleKey: 'tour_leaderboard_title',
    bodyKey: 'tour_leaderboard_body',
  },
  {
    id: 'tasks',
    stage: 'tasks',
    anchor: 'missions-modal-container',
    titleKey: 'tour_tasks_title',
    bodyKey: 'tour_tasks_body',
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
