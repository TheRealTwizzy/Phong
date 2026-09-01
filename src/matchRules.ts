import { AIDifficulty, GameMode, MatchRules, RoomMatchConfig } from './types';
import { AI_DIFFICULTIES, soloCountsForRank, soloMuCap } from './rating';
import { roomCountsForRank } from './venues';

// Pre-match match rules, shared by client and server like profileRules.ts and
// rating.ts. In a solo match these are chosen on the MainMenu; in a duel they
// belong to the ROOM — the host sets them in the lobby and both phones play
// the same ones (see RoomMatchConfig below).
//
// Paddle width, ball size and ball speed were once hard constants that could
// never be player-editable, for fairness. They are adjustable now, and
// fairness is kept a different way: every physics rule carries a RANKED BAND
// around stock. Inside the band the match rates normally — the ladder can
// absorb a slightly wider paddle the way it absorbs a slightly better phone.
// Outside it the match still pays XP but moves no rating and no tier: a 60%
// paddle against a 180% ball is a party match, not a ladder result.
// Telemetry, quick chat and auto-serve never touch the ball and never affect
// ranking. The OPPONENT SONAR is the exception, and deliberately so: the whole
// game is a blind half-court, so a live mini-map of the half you are not
// allowed to see is not a presentation preference, it is the hardest rule in
// the game turned off. It stays available, it still pays XP, and it costs the
// match its rating — which is what makes the two lightweight net indicators
// (opponent paddle, and the ball while it is over there) worth having, since
// those stay inside the ranked game.

export interface RuleSpec {
  min: number;
  max: number;
  step: number;
  /** Multiplier applied to the engine constant, so 1 is always "stock". */
  default: number;
  /** The window around stock inside which a match still counts for rating. */
  ranked: { min: number; max: number };
}

/** Rules that change the physics of the ball or paddle — these gate ranking. */
export const PHYSICS_RULES = {
  paddleScale: { min: 0.6, max: 1.6, step: 0.05, default: 1, ranked: { min: 0.85, max: 1.15 } },
  ballScale: { min: 0.6, max: 1.8, step: 0.05, default: 1, ranked: { min: 0.85, max: 1.15 } },
  ballSpeedMin: { min: 0.6, max: 1.4, step: 0.05, default: 1, ranked: { min: 0.9, max: 1.1 } },
  ballSpeedMax: { min: 1, max: 2, step: 0.05, default: 1, ranked: { min: 1, max: 1.2 } },
  serveAngleMax: { min: 0, max: 1.4, step: 0.05, default: 1, ranked: { min: 0.8, max: 1.2 } },
  servePowerMax: { min: 0.6, max: 1.5, step: 0.05, default: 1, ranked: { min: 0.85, max: 1.15 } },
} satisfies Record<string, RuleSpec>;

export type PhysicsRuleKey = keyof typeof PHYSICS_RULES;
export const PHYSICS_RULE_KEYS = Object.keys(PHYSICS_RULES) as PhysicsRuleKey[];

export const AUTO_SERVE_OPTIONS = [0, 1, 3, 5] as const;
export type AutoServeSeconds = (typeof AUTO_SERVE_OPTIONS)[number];

/**
 * The auto-serve timer a match falls back to: the shipped default, and what a
 * ranked duel is forced to when the host left it off. Declared here beside the
 * options rather than beside `normalizeRoomConfig`, because `DEFAULT_MATCH_RULES`
 * is now one of its callers.
 */
export const RANKED_AUTO_SERVE_SECONDS: AutoServeSeconds = 5;

/** The match lengths the menu and the lobby offer, gated by achievements. */
export const WINNING_SCORES = [3, 5, 10, 15] as const;
export const DEFAULT_WINNING_SCORE = 5;

/**
 * The shortest match that can be a shutout, and the one rule that says so.
 *
 * A shutout is a match LENGTH plus a clean sheet, which is why the floor lives
 * here beside WINNING_SCORES rather than in the achievement or mission files
 * that read it. What it exists to exclude is the 2-0 that was never played to
 * the end: the relay records an abandoned duel at the STANDING score (§5), so
 * without a floor, getting somebody to walk out early would pay like holding
 * them scoreless over a full match.
 *
 * The cost of the floor is that a first-to-3 match can never be a shutout —
 * every scoring path stops at `winningScore`, so a 3-0 IS the whole match and
 * still falls short of 5. That is a real and deliberate trade, and the reason
 * every description that depends on this states the length out loud: the rule
 * used to be three copy-pasted expressions with the number in none of the
 * copy, so a player winning 3-0 against Cyber over and over moved no shutout
 * counter, opened no Dominion branch, and had nothing on screen to say why.
 * `tests/achievements.test.ts` now fails if a description stops quoting it.
 */
export const SHUTOUT_MIN_POINTS = 5;

/**
 * Whether a finished match is a clean sheet. The single definition — the
 * achievement triggers, the career counter and the daily tasks all ask this,
 * so the number cannot drift between them or between code and copy.
 */
export const isShutout = (result: {
  isWinner: boolean;
  playerScore: number;
  opponentScore: number;
}): boolean =>
  result.isWinner && result.opponentScore === 0 && result.playerScore >= SHUTOUT_MIN_POINTS;

export const DEFAULT_MATCH_RULES: MatchRules = {
  paddleScale: 1,
  ballScale: 1,
  ballSpeedMin: 1,
  ballSpeedMax: 1,
  serveAngleMax: 1,
  servePowerMax: 1,
  // Off by default: on, it unranks the match and suppresses the two net
  // indicators, so a shipped default of `true` would mean every stock match
  // was unranked with its indicators hidden.
  opponentSonar: false,
  trackTelemetry: true,
  quickChat: true,
  // On by default, because "off" is a match that can DEADLOCK. A serve needs
  // a second finger (the first one is the paddle — see the pointer-ranking
  // rule in `CourtCanvas`), the space bar, or this timer. A phone has no
  // space bar, so for a first-time player alone with one thumb this timer was
  // the only remaining way to start a rally, and it shipped switched off:
  // every solo and practice match opened on a ball that could not be put into
  // play, and everything downstream — XP, achievements, the ladder — is gated
  // behind a serve. A duel already forced this on whenever the rules were
  // ranked; this makes the same guarantee for the modes a player meets first.
  // Still a choice, just no longer a choice made silently on their behalf.
  autoServeSeconds: RANKED_AUTO_SERVE_SECONDS,
};

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
/** Inclusive with the same tolerance the step grid is snapped to. */
const within = (v: number, lo: number, hi: number) => v >= lo - 1e-6 && v <= hi + 1e-6;

/** Clamp one rule to its spec and snap it to the step grid. */
export function clampRule(key: PhysicsRuleKey, value: number): number {
  const spec = PHYSICS_RULES[key];
  if (!Number.isFinite(value)) return spec.default;
  const snapped = Math.round(value / spec.step) * spec.step;
  // Four decimal places, by arithmetic. This was `Number(snapped.toFixed(4))`,
  // which allocates a string per rule per call — and `normalizeRules` below is
  // called several times per FRAME while a ball is in play.
  return Math.min(spec.max, Math.max(spec.min, Math.round(snapped * 1e4) / 1e4));
}

/**
 * Everything `normalizeRules` has already answered, keyed on the object it was
 * asked about.
 *
 * The rules for a match are fixed once the first ball crosses the net and are
 * held in a ref, so the same object is asked about over and over: the physics
 * helpers alone (`paddleWidthFor`, `ballRadiusFor`, `minBallSpeedFor`,
 * `maxBallSpeedFor`) call this four times, `clampBallSpeed` calls it twice on
 * its own, and `predictLanding` calls it inside its integration loop —
 * measured at 12.6us with rules against 2.4us without, five times the cost of
 * the prediction itself. Each call rebuilt an eleven-field object and ran six
 * clamps to produce a value identical to the last one.
 *
 * A WeakMap rather than a cache with a size limit: the key IS the caller's own
 * object, so an entry lives exactly as long as the rules it describes and a
 * match that ends takes its entry with it. The result is frozen, because a
 * shared cached object that a caller could mutate would be a far worse bug
 * than the allocation this avoids.
 */
const NORMALIZED = new WeakMap<object, MatchRules>();
const DEFAULT_NORMALIZED: MatchRules = Object.freeze({ ...DEFAULT_MATCH_RULES }) as MatchRules;

/** Normalize anything arriving from a client or from storage. */
export function normalizeRules(input: Partial<MatchRules> | null | undefined): MatchRules {
  if (input === null || input === undefined) return DEFAULT_NORMALIZED;
  // A WeakMap key must be an object, and `set` THROWS on anything else — so a
  // primitive here turned a value this function is supposed to normalize into
  // a crash. Reachable from a corrupted `half_pong_settings` at startup and
  // from an untyped `create_room`/`set_room_config` over the wire, where the
  // throw is swallowed by the outer logger and no response is sent at all, so
  // the client waits forever. The reads below already treat a primitive as
  // having no keys and fall through to the defaults, which is the right
  // answer; only the caching had to learn to sit it out.
  const cacheable = typeof input === 'object';
  const cached = cacheable ? NORMALIZED.get(input) : undefined;
  if (cached) return cached;
  const raw = input;
  const rules: MatchRules = { ...DEFAULT_MATCH_RULES };
  for (const key of PHYSICS_RULE_KEYS) {
    if (raw[key] !== undefined) rules[key] = clampRule(key, Number(raw[key]));
  }
  rules.opponentSonar = raw.opponentSonar ?? DEFAULT_MATCH_RULES.opponentSonar;
  rules.trackTelemetry = raw.trackTelemetry ?? DEFAULT_MATCH_RULES.trackTelemetry;
  rules.quickChat = raw.quickChat ?? DEFAULT_MATCH_RULES.quickChat;
  const secs = Number(raw.autoServeSeconds);
  rules.autoServeSeconds = (AUTO_SERVE_OPTIONS as readonly number[]).includes(secs)
    ? (secs as AutoServeSeconds)
    : DEFAULT_MATCH_RULES.autoServeSeconds;
  // A minimum above the maximum would make the speed clamp meaningless.
  if (rules.ballSpeedMin > rules.ballSpeedMax) rules.ballSpeedMin = rules.ballSpeedMax;
  Object.freeze(rules);
  if (cacheable) NORMALIZED.set(input, rules);
  return rules;
}

/** True when the ball and paddle behave exactly as the engine intends. */
export function isStockPhysics(rules: Partial<MatchRules> | null | undefined): boolean {
  const r = normalizeRules(rules);
  return PHYSICS_RULE_KEYS.every((key) => near(r[key], PHYSICS_RULES[key].default));
}

/** True when one rule sits inside the window that still rates. */
export function isRuleRanked(key: PhysicsRuleKey, value: number): boolean {
  const { ranked } = PHYSICS_RULES[key];
  return within(value, ranked.min, ranked.max);
}

/**
 * Whether a match played under these rules may move the player's rating.
 * Every physics rule has to sit inside its ranked band; one rule pushed past
 * its edge unranks the match on its own, because the ladder only means
 * something if a rated result was played on something close to stock.
 *
 * The opponent sonar unranks it too. It is not a physics rule and it is the
 * only non-physics rule here that counts — see the header: it hands the player
 * the half of the court the game exists to hide.
 */
export function isRankedRules(rules: Partial<MatchRules> | null | undefined): boolean {
  const r = normalizeRules(rules);
  if (r.opponentSonar) return false;
  return PHYSICS_RULE_KEYS.every((key) => isRuleRanked(key, r[key]));
}

/** The physics rules that differ from stock, for display in the UI. */
export function alteredRuleKeys(rules: Partial<MatchRules> | null | undefined): PhysicsRuleKey[] {
  const r = normalizeRules(rules);
  return PHYSICS_RULE_KEYS.filter((key) => !near(r[key], PHYSICS_RULES[key].default));
}

/** The rules that have been pushed past their ranked band — what costs the rating. */
export function unrankedRuleKeys(rules: Partial<MatchRules> | null | undefined): PhysicsRuleKey[] {
  const r = normalizeRules(rules);
  return PHYSICS_RULE_KEYS.filter((key) => !isRuleRanked(key, r[key]));
}

/**
 * Everything that can stop a match counting for rank, in the order a player
 * should hear about it.
 *
 * The rules are only half the question and the pre-match sheet used to ask
 * only that half: it promised "counts for rank" for a Rookie solo match the
 * server then refuses to rate (a solo result rates only at an EARNED
 * difficulty), and for Practice and Split Screen, which record no rating at
 * all. A badge that is wrong about the thing it exists to say is worse than no
 * badge. This is the whole verdict in one place, so the sheet, the lobby and
 * anything added later cannot each answer it differently.
 *
 * The SERVER still derives its own half from `isRankedRules(payload.rules)`,
 * `soloCountsForRank(difficulty)` and `roomCountsForRank(venueRoomId)` — the
 * last read from the live room and never from a request; this does not
 * replace that and is never trusted by it. It is the same rule stated once
 * for display.
 */
export type UnrankedReason =
  | 'mode'
  | 'venue'
  | 'difficulty'
  | 'outgrown'
  | 'sonar'
  | PhysicsRuleKey;

export interface RankedMatchContext {
  rules: Partial<MatchRules> | null | undefined;
  mode: GameMode;
  /** Solo only. */
  difficulty?: AIDifficulty;
  /**
   * Duel only, and only when this phone actually KNOWS it.
   *
   * A duel used to rate on its rules alone; it now also depends on the room
   * the table sits in, because Casual does not move the ladder. Absent reports
   * nothing rather than guessing — a badge that invents a venue is worse than
   * one that stays quiet about it, and the server derives its own half from
   * the live room either way.
   */
  venueRoomId?: string | null;
  /**
   * Solo only, and only when this phone knows it: the player's VISIBLE ladder
   * rating. Above a rung's own ceiling that rung moves no rating at all, so
   * the badge has to stop promising one. Absent reports nothing rather than
   * guessing, exactly as `venueRoomId` above does.
   */
  rankMu?: number;
}

/** Modes that never write a rating for anybody, whatever the rules say. */
const UNRATED_MODES: readonly GameMode[] = ['practice', 'split'];

export function unrankedReasons(ctx: RankedMatchContext): UnrankedReason[] {
  const reasons: UnrankedReason[] = [];
  if (UNRATED_MODES.includes(ctx.mode)) reasons.push('mode');
  // Second, and above the sonar deliberately. The panel renders blockers[0]
  // alone, so this order IS the display priority — and on a Casual table with
  // the sonar on, naming the sonar tells the host that switching it off
  // restores the ladder, which is a lie. The venue cannot be changed from the
  // lobby; the sonar can.
  //
  // Guarded on the mode because unrankedReasons is pure and anyone may call
  // it: a stray venueRoomId on a solo context must not unrank a solo match.
  if (ctx.mode === 'multiplayer' && ctx.venueRoomId && !roomCountsForRank(ctx.venueRoomId)) {
    reasons.push('venue');
  }
  if (ctx.mode === 'solo' && ctx.difficulty && !soloCountsForRank(ctx.difficulty)) {
    reasons.push('difficulty');
  } else if (
    ctx.mode === 'solo' &&
    ctx.difficulty &&
    ctx.rankMu !== undefined &&
    ctx.rankMu > soloMuCap(ctx.difficulty)
  ) {
    // Every solo rung has a ceiling it converges on, and above that ceiling
    // the match moves no rating at all. Said out loud here, because the badge
    // otherwise promises a ladder move for a match that cannot make one — the
    // same lie the Rookie case above exists to prevent, one rung up.
    reasons.push('outgrown');
  }
  const r = normalizeRules(ctx.rules);
  if (r.opponentSonar) reasons.push('sonar');
  reasons.push(...unrankedRuleKeys(r));
  return reasons;
}

/** True when nothing at all stands between this match and the ladder. */
export const isRankedMatch = (ctx: RankedMatchContext): boolean =>
  unrankedReasons(ctx).length === 0;

export function normalizeWinningScore(value: unknown): number {
  const n = Number(value);
  return (WINNING_SCORES as readonly number[]).includes(n) ? n : DEFAULT_WINNING_SCORE;
}

/** How long both phones count down before a duel's first serve can happen. */
export const MATCH_START_COUNTDOWN_SECONDS = 3;

export const DEFAULT_ROOM_CONFIG: RoomMatchConfig = {
  winningScore: DEFAULT_WINNING_SCORE,
  rules: DEFAULT_MATCH_RULES,
  // Off by default: a table nobody asked to be watched is not watched, and
  // a create_room from an old bundle or the invite flow says nothing here.
  spectators: false,
  // No CPU by default, which is what keeps every existing caller — the invite
  // flow, the queue, an older bundle, the test harness — making exactly the
  // table it made before.
  cpu: null,
};

/**
 * The terms of a duel, normalized. Both phones read these off the room rather
 * than off their own device: a match where each side applied its own winning
 * score was two private matches that happened to share a ball, and the shorter
 * one ending first left the other player stranded mid-rally.
 */
/**
 * Whether the auto-serve timer is forced ON, i.e. whether "Off" is a real
 * choice or a setting the server is about to overwrite.
 *
 * Two conditions, and leaving either out makes the control lie in a different
 * direction. `normalizeRoomConfig` is the only thing that forces the timer and
 * it runs for a ROOM and nowhere else — solo, Practice and Split Screen reach
 * `normalizeRules` alone — so the mode is half the question. The other half is
 * the rules ALONE and not the whole ranked verdict: on a Casual table the
 * venue unranks the match, so the full verdict said "not ranked", so "Off" was
 * offered and then silently overwritten with 5s. A Casual duel is still two
 * humans on ranked-legal rules, which is exactly the stall the floor exists
 * for.
 *
 * Asking `isRankedRules` alone was the swing back too far: it disabled "Off"
 * in Practice and Split, which are unranked always and pass through no room
 * normalization at all, and on unranked solo rungs like Rookie.
 */
export function autoServeForced(mode: GameMode, rules: Partial<MatchRules> | null | undefined): boolean {
  return mode === 'multiplayer' && isRankedRules(normalizeRules(rules));
}

export function normalizeRoomConfig(
  input: Partial<RoomMatchConfig> | null | undefined
): RoomMatchConfig {
  const raw = input || {};
  const normalized = normalizeRules(raw.rules);
  // Ranked play MUST carry an auto-serve timer. With rating on the line,
  // "off" would let a losing player stall the match indefinitely by simply
  // never serving; the timer is what makes a ranked result something the
  // other player can always reach. An unranked party match may still stall —
  // nothing is at stake there.
  //
  // A COPY, never a write into `normalized`: that object is shared (see the
  // cache above `normalizeRules`) and frozen, so mutating it would have
  // rewritten the rules for everyone else holding the same input. Harmless
  // while every call built a fresh object, and a real bug the moment one did
  // not — which is what the freeze is there to make impossible rather than
  // merely unlikely.
  const rules: MatchRules =
    isRankedRules(normalized) && normalized.autoServeSeconds === 0
      ? { ...normalized, autoServeSeconds: RANKED_AUTO_SERVE_SECONDS }
      : normalized;
  return {
    winningScore: normalizeWinningScore(raw.winningScore),
    rules,
    // Strict `=== true`, so anything a client sends that is not the word yes
    // is no. The relay narrows it further: a venue that forbids watching
    // forces this false whatever the host asked for.
    spectators: raw.spectators === true,
    // Whitelisted against the real rungs rather than coerced, for the reason
    // `spectate_room`'s seat argument is strict enum membership and
    // deliberately not `clampInt`: turning junk into the first legal value
    // would seat a Rookie for a client that sent nonsense, and a match against
    // an opponent nobody chose is worse than a refused config.
    //
    // `normalizeDifficulty` is not used here on purpose — it answers 'pro' for
    // anything it does not recognise, which is right for a stored device
    // setting (there must always be SOME difficulty) and wrong for a table,
    // where "no CPU" is the ordinary state and has to survive a round trip.
    cpu: AI_DIFFICULTIES.includes(raw.cpu as AIDifficulty) ? (raw.cpu as AIDifficulty) : null,
  };
}

/**
 * The identity of one played match, used to record it exactly once.
 *
 * A duel's key is derived, not minted, because the relay and the client both
 * have to arrive at the same string without talking to each other: the relay
 * records a finished duel for BOTH players from the score it owns, and each
 * phone also POSTs its own copy. Whichever lands first does the work; the
 * other is recognised and paid nothing.
 *
 * `matchSeq` is what makes a room's matches distinguishable — a room is reused
 * for every rematch, so the room code alone would fold a best-of-five evening
 * into a single key.
 */
export const duelMatchKey = (roomId: string, matchSeq: number): string =>
  `duel:${String(roomId).toUpperCase()}:${matchSeq}`;
