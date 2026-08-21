import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { MatchEndPayload, MatchRules } from '../src/types';
import {
  DEFAULT_MATCH_RULES,
  PHYSICS_RULES,
  PHYSICS_RULE_KEYS,
  alteredRuleKeys,
  clampRule,
  isRankedRules,
  isRuleRanked,
  unrankedRuleKeys,
  normalizeRules,
} from '../src/matchRules';
import {
  PADDLE_WIDTH_RATIO,
  BALL_BASE_RADIUS,
  MAX_BALL_SPEED,
  SERVE_MAX_ANGLE_DEG,
  ballRadiusFor,
  clampBallSpeed,
  maxBallSpeedFor,
  minBallSpeedFor,
  paddleWidthFor,
  serveVelocity,
} from '../src/game/physics';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-rules-test-'));
process.env.DATA_DIR = TMP;

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;
beforeAll(async () => {
  ({ db } = await import('../server/db'));
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('match rules', () => {
  it('defaults to exactly the engine constants', () => {
    expect(paddleWidthFor(DEFAULT_MATCH_RULES)).toBeCloseTo(PADDLE_WIDTH_RATIO, 10);
    expect(ballRadiusFor(DEFAULT_MATCH_RULES)).toBeCloseTo(BALL_BASE_RADIUS, 10);
    expect(maxBallSpeedFor(DEFAULT_MATCH_RULES)).toBeCloseTo(MAX_BALL_SPEED, 10);
    expect(isRankedRules(DEFAULT_MATCH_RULES)).toBe(true);
    expect(alteredRuleKeys(DEFAULT_MATCH_RULES)).toEqual([]);
  });

  it('treats undefined and empty rules as stock', () => {
    expect(isRankedRules(undefined)).toBe(true);
    expect(isRankedRules(null)).toBe(true);
    expect(isRankedRules({})).toBe(true);
  });

  it('clamps and snaps every slider to its own spec', () => {
    for (const key of PHYSICS_RULE_KEYS) {
      const spec = PHYSICS_RULES[key];
      expect(clampRule(key, -999)).toBeCloseTo(spec.min, 6);
      expect(clampRule(key, 999)).toBeCloseTo(spec.max, 6);
      expect(clampRule(key, Number.NaN)).toBeCloseTo(spec.default, 6);
    }
  });

  it('refuses a minimum speed above the maximum', () => {
    const r = normalizeRules({ ballSpeedMin: 1.4, ballSpeedMax: 1 });
    expect(r.ballSpeedMin).toBeLessThanOrEqual(r.ballSpeedMax);
  });

  it('lets every slider be tuned inside its band and still rate', () => {
    // The whole point of the bands: these are adjustments a player can
    // actually use. A rule moved anywhere inside its window is still altered
    // — the UI says so — but the match keeps counting for rank.
    for (const key of PHYSICS_RULE_KEYS) {
      const { ranked } = PHYSICS_RULES[key];
      for (const edge of [ranked.min, ranked.max]) {
        const tuned = normalizeRules({ ...DEFAULT_MATCH_RULES, [key]: edge });
        expect(isRuleRanked(key, tuned[key])).toBe(true);
        expect(isRankedRules(tuned)).toBe(true);
      }
    }
  });

  it('unranks a match once a slider is pushed past its band', () => {
    for (const key of PHYSICS_RULE_KEYS) {
      const spec = PHYSICS_RULES[key];
      // Step outside whichever edge the spec has room beyond.
      const beyond =
        spec.ranked.min - spec.step >= spec.min
          ? spec.ranked.min - spec.step
          : spec.ranked.max + spec.step;
      const pushed = normalizeRules({ ...DEFAULT_MATCH_RULES, [key]: beyond });
      expect(isRuleRanked(key, pushed[key])).toBe(false);
      expect(isRankedRules(pushed)).toBe(false);
      expect(unrankedRuleKeys(pushed)).toEqual([key]);
      expect(alteredRuleKeys(pushed)).toEqual([key]);
    }
  });

  it('never unranks a match on a presentation option', () => {
    for (const key of ['opponentSonar', 'trackTelemetry', 'quickChat'] as const) {
      expect(isRankedRules({ ...DEFAULT_MATCH_RULES, [key]: false })).toBe(true);
    }
    expect(isRankedRules({ ...DEFAULT_MATCH_RULES, autoServeSeconds: 3 })).toBe(true);
  });

  it('keeps every ranked band a real window that contains stock', () => {
    for (const key of PHYSICS_RULE_KEYS) {
      const spec = PHYSICS_RULES[key];
      expect(spec.ranked.min).toBeLessThanOrEqual(spec.default);
      expect(spec.ranked.max).toBeGreaterThanOrEqual(spec.default);
      expect(spec.ranked.max).toBeGreaterThan(spec.ranked.min);
      // A band that swallowed the whole slider would make "unranked"
      // unreachable, which is the opposite failure to the one we fixed.
      expect(spec.ranked.min > spec.min || spec.ranked.max < spec.max).toBe(true);
    }
  });

  it('scales the paddle and ball it is asked to', () => {
    expect(paddleWidthFor({ paddleScale: 1.5 })).toBeCloseTo(PADDLE_WIDTH_RATIO * 1.5, 10);
    expect(ballRadiusFor({ ballScale: 0.6 })).toBeCloseTo(BALL_BASE_RADIUS * 0.6, 10);
  });

  it('holds rally speed inside the configured band', () => {
    const rules = normalizeRules({ ballSpeedMin: 1.2, ballSpeedMax: 1.2 });
    const lo = minBallSpeedFor(rules);
    const hi = maxBallSpeedFor(rules);
    expect(clampBallSpeed(0.01, rules)).toBeCloseTo(lo, 10);
    expect(clampBallSpeed(99, rules)).toBeCloseTo(hi, 10);
    expect(clampBallSpeed((lo + hi) / 2, rules)).toBeCloseTo((lo + hi) / 2, 10);
  });
});

describe('serve aiming', () => {
  it('always sends the ball toward the net', () => {
    for (const angle of [-1, -0.5, 0, 0.5, 1]) {
      for (const power of [0, 0.5, 1]) {
        expect(serveVelocity({ angle, power }).vy).toBeLessThan(0);
      }
    }
  });

  it('turns aim into direction: left is left, right is right, centre is straight', () => {
    expect(serveVelocity({ angle: -1, power: 0.5 }).vx).toBeLessThan(0);
    expect(serveVelocity({ angle: 1, power: 0.5 }).vx).toBeGreaterThan(0);
    expect(serveVelocity({ angle: 0, power: 0.5 }).vx).toBeCloseTo(0, 10);
  });

  it('turns pull into power', () => {
    const soft = serveVelocity({ angle: 0, power: 0 });
    const hard = serveVelocity({ angle: 0, power: 1 });
    expect(Math.hypot(hard.vx, hard.vy)).toBeGreaterThan(Math.hypot(soft.vx, soft.vy));
  });

  it('never exceeds the angle the rules allow', () => {
    const narrow = normalizeRules({ serveAngleMax: PHYSICS_RULES.serveAngleMax.min });
    const v = serveVelocity({ angle: 1, power: 1 }, narrow);
    const deg = (Math.atan2(v.vx, -v.vy) * 180) / Math.PI;
    expect(Math.abs(deg)).toBeLessThanOrEqual(SERVE_MAX_ANGLE_DEG * narrow.serveAngleMax + 1e-6);
  });

  it('respects the match speed band even at full power', () => {
    const capped = normalizeRules({ ballSpeedMax: 1, servePowerMax: 1.5 });
    const v = serveVelocity({ angle: 0, power: 1 }, capped);
    expect(Math.hypot(v.vx, v.vy)).toBeLessThanOrEqual(maxBallSpeedFor(capped) + 1e-9);
  });

  it('falls back to a sane serve when no aim is given', () => {
    const v = serveVelocity(undefined);
    expect(v.vy).toBeLessThan(0);
    expect(Number.isFinite(v.vx)).toBe(true);
  });
});

describe('custom rules cost the rating, never the XP', () => {
  const match = (playerId: string, rules?: Partial<MatchRules>): MatchEndPayload => ({
    playerId,
    username: 'Ruler',
    playerScore: 5,
    opponentScore: 1,
    maxRally: 9,
    mode: 'multiplayer',
    isWinner: true,
    rules,
  });

  const init = (id: string, username: string) => {
    db.getProfile(id);
    const r = db.initializeProfile(id, username);
    if (!r.ok) throw new Error(r.code);
  };

  it('pays XP but moves no rating when the physics were changed', () => {
    init('r_custom', 'CustomRules');
    const before = db.getProfile('r_custom');
    const res = db.recordMatch(match('r_custom', { paddleScale: 1.5 }));
    expect(res.earnedXp).toBeGreaterThan(0);
    expect(res.ranked).toBe(false);
    expect(res.profile.xp).toBeGreaterThan(before.xp);
    // The whole point: a wider paddle cannot climb the tier ladder.
    expect(res.profile.rankMu).toBe(before.rankMu);
    expect(res.profile.rankedGames).toBe(before.rankedGames);
    expect(res.profile.mmrMu).toBe(before.mmrMu);
  });

  it('still counts the match in the played/won record', () => {
    init('r_counted', 'CountedRules');
    const before = db.getProfile('r_counted');
    db.recordMatch(match('r_counted', { ballScale: 1.4 }));
    const after = db.getProfile('r_counted');
    expect(after.matchesPlayed).toBe(before.matchesPlayed + 1);
    expect(after.matchesWon).toBe(before.matchesWon + 1);
  });

  it('ranks a match played on presentation changes alone', () => {
    init('r_pres', 'PresentationOnly');
    const res = db.recordMatch(
      match('r_pres', { opponentSonar: false, quickChat: false, autoServeSeconds: 3 })
    );
    expect(res.ranked).toBe(true);
    expect(res.profile.rankedGames).toBe(1);
  });

  it('cannot be talked into ranking a custom match by the payload', () => {
    init('r_liar', 'LiarRules');
    const before = db.getProfile('r_liar');
    // A client that sets `ranked` itself gets ignored — it is re-derived.
    const res = db.recordMatch({
      ...match('r_liar', { paddleScale: 1.6, ballSpeedMax: 2 }),
      ranked: true,
    } as MatchEndPayload);
    expect(res.ranked).toBe(false);
    expect(res.profile.rankMu).toBe(before.rankMu);
  });
});
