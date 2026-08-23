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
  isStockPhysics,
  duelMatchKey,
  unrankedRuleKeys,
  normalizeRules,
  normalizeRoomConfig,
  RANKED_AUTO_SERVE_SECONDS,
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

  it('forces an auto-serve timer onto a ranked duel', () => {
    // Ranked play MUST carry the timer: "off" would let a losing player
    // stall a rated match forever by never serving.
    const forced = normalizeRoomConfig({
      winningScore: 5,
      rules: { ...DEFAULT_MATCH_RULES, autoServeSeconds: 0 },
    });
    expect(isRankedRules(forced.rules)).toBe(true);
    expect(forced.rules.autoServeSeconds).toBe(RANKED_AUTO_SERVE_SECONDS);

    // A chosen timer is respected — the mandate only fills in "off".
    const chosen = normalizeRoomConfig({
      winningScore: 5,
      rules: { ...DEFAULT_MATCH_RULES, autoServeSeconds: 1 },
    });
    expect(chosen.rules.autoServeSeconds).toBe(1);

    // An unranked party match may stall — nothing is at stake.
    const party = normalizeRoomConfig({
      winningScore: 5,
      rules: { ...DEFAULT_MATCH_RULES, paddleScale: 1.6, autoServeSeconds: 0 },
    });
    expect(isRankedRules(party.rules)).toBe(false);
    expect(party.rules.autoServeSeconds).toBe(0);
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

// The idempotency key behind "every match is recorded, once, on every profile
// it belongs to". A duel legitimately arrives up to three times — the relay
// writes it for both seats, both clients POST it as a fallback, and the
// on-device queue may replay it — and this is the only thing that tells the
// server they are all the same match.
//
// It is derived independently in three places that must agree: the relay
// (server.ts, from room state), the record route's cross-check (server.ts,
// from the client's payload) and the client (App.tsx, from the room it
// joined). The EFFECT is well covered by tests/duelRecord.test.ts — a match is
// paid once — but the key's own shape was not, so the case-folding that lets a
// client holding a lowercase room code agree with the relay was unpinned.
describe('duelMatchKey', () => {
  it('does not care what case the room code is written in', () => {
    // The relay stores codes uppercase; a client can hold whatever the player
    // typed or an invitation link carried. If these disagreed, the same match
    // would be recorded twice under two keys and paid twice.
    expect(duelMatchKey('abcd', 3)).toBe(duelMatchKey('ABCD', 3));
    expect(duelMatchKey('aBcD', 3)).toBe(duelMatchKey('AbCd', 3));
  });

  it('tells one match in a room from the next', () => {
    // A room is reused by every rematch, so the code alone would fold a
    // best-of-five evening into a single key and pay only the first match.
    expect(duelMatchKey('ABCD', 1)).not.toBe(duelMatchKey('ABCD', 2));
  });

  it('tells one room from another', () => {
    expect(duelMatchKey('ABCD', 1)).not.toBe(duelMatchKey('WXYZ', 1));
  });

  it('is stable, and namespaced away from a solo key', () => {
    expect(duelMatchKey('ABCD', 7)).toBe('duel:ABCD:7');
    expect(duelMatchKey('ABCD', 7)).toBe(duelMatchKey('ABCD', 7));
  });
});

describe('isStockPhysics', () => {
  it('is true for the shipped rules and for nothing else', () => {
    expect(isStockPhysics(null)).toBe(true);
    expect(isStockPhysics({})).toBe(true);
    expect(isStockPhysics(DEFAULT_MATCH_RULES)).toBe(true);
    for (const key of PHYSICS_RULE_KEYS) {
      const { default: def, min, max } = PHYSICS_RULES[key];
      // Move each rule within its OWN range, downward by preference: raising
      // ballSpeedMin alone is pinned straight back (see below), while
      // ballSpeedMax is the one rule with no room beneath stock.
      const altered = min < def ? Math.max(min, def - 0.3) : Math.min(max, def + 0.3);
      expect(altered, `${key} has no room to move`).not.toBe(def);
      expect(isStockPhysics({ [key]: altered }), key).toBe(false);
    }
  });

  it('is unmoved by a minimum speed that normalization refuses', () => {
    // normalizeRules pins ballSpeedMin under ballSpeedMax, and both ship at 1,
    // so raising the floor alone cannot take effect — the match is still
    // stock. Raising the ceiling with it is what actually changes the game.
    expect(isStockPhysics({ ballSpeedMin: 1.3 })).toBe(true);
    expect(isStockPhysics({ ballSpeedMin: 1.3, ballSpeedMax: 1.5 })).toBe(false);
    expect(normalizeRules({ ballSpeedMin: 1.3 }).ballSpeedMin).toBe(1);
  });

  it('is a stricter question than whether a match is ranked', () => {
    // The ranked band is deliberately wider than stock: a match tuned inside
    // it still rates. Conflating the two is what the band exists to avoid.
    const nudged = { paddleScale: 1.1 };
    expect(isStockPhysics(nudged)).toBe(false);
    expect(isRankedRules(normalizeRules(nudged))).toBe(true);
  });
});
