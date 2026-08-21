import { MatchRules } from './types';

// Pre-match match rules, shared by client and server like profileRules.ts and
// rating.ts. Everything here is chosen on the MainMenu before a match starts
// and is fixed for its duration.
//
// Paddle width, ball size and ball speed were previously hard constants that
// could never be player-editable, for fairness. They are adjustable now, and
// the fairness rule is preserved a different way: a match whose PHYSICS rules
// differ from the defaults still awards XP but is **unranked** — it moves no
// rating and no tier. Presentation and convenience options (sonar, telemetry,
// quick chat, auto-serve) do not affect the ball, so they never unrank a match.

export interface RuleSpec {
  min: number;
  max: number;
  step: number;
  /** Multiplier applied to the engine constant, so 1 is always "stock". */
  default: number;
}

/** Rules that change the physics of the ball or paddle — these gate ranking. */
export const PHYSICS_RULES = {
  paddleScale: { min: 0.6, max: 1.6, step: 0.05, default: 1 },
  ballScale: { min: 0.6, max: 1.8, step: 0.05, default: 1 },
  ballSpeedMin: { min: 0.6, max: 1.4, step: 0.05, default: 1 },
  ballSpeedMax: { min: 1, max: 2, step: 0.05, default: 1 },
  serveAngleMax: { min: 0, max: 1.4, step: 0.05, default: 1 },
  servePowerMax: { min: 0.6, max: 1.5, step: 0.05, default: 1 },
} satisfies Record<string, RuleSpec>;

export type PhysicsRuleKey = keyof typeof PHYSICS_RULES;
export const PHYSICS_RULE_KEYS = Object.keys(PHYSICS_RULES) as PhysicsRuleKey[];

export const AUTO_SERVE_OPTIONS = [0, 1, 3, 5] as const;
export type AutoServeSeconds = (typeof AUTO_SERVE_OPTIONS)[number];

export const DEFAULT_MATCH_RULES: MatchRules = {
  paddleScale: 1,
  ballScale: 1,
  ballSpeedMin: 1,
  ballSpeedMax: 1,
  serveAngleMax: 1,
  servePowerMax: 1,
  opponentSonar: true,
  trackTelemetry: true,
  quickChat: true,
  autoServeSeconds: 0,
};

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Clamp one rule to its spec and snap it to the step grid. */
export function clampRule(key: PhysicsRuleKey, value: number): number {
  const spec = PHYSICS_RULES[key];
  if (!Number.isFinite(value)) return spec.default;
  const snapped = Math.round(value / spec.step) * spec.step;
  return Math.min(spec.max, Math.max(spec.min, Number(snapped.toFixed(4))));
}

/** Normalize anything arriving from a client or from storage. */
export function normalizeRules(input: Partial<MatchRules> | null | undefined): MatchRules {
  const raw = input || {};
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
  return rules;
}

/** True when the ball and paddle behave exactly as the engine intends. */
export function isStockPhysics(rules: Partial<MatchRules> | null | undefined): boolean {
  const r = normalizeRules(rules);
  return PHYSICS_RULE_KEYS.every((key) => near(r[key], PHYSICS_RULES[key].default));
}

/**
 * Whether a match played under these rules may move the player's rating.
 * Solo already never touches the rank; this is what keeps a widened paddle
 * out of the PvP tier ladder while still paying XP for the match.
 */
export const isRankedRules = isStockPhysics;

/** The physics rules that differ from stock, for display in the UI. */
export function alteredRuleKeys(rules: Partial<MatchRules> | null | undefined): PhysicsRuleKey[] {
  const r = normalizeRules(rules);
  return PHYSICS_RULE_KEYS.filter((key) => !near(r[key], PHYSICS_RULES[key].default));
}
