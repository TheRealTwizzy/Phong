import { describe, expect, it } from 'vitest';
import { BotMatch } from '../server/botMatch';
import { DEFAULT_MATCH_RULES } from '../src/matchRules';

// The play-bot simulation, with no socket, no room and no clock of its own.
//
// The point of these is not that the physics is right — `tests/physics.test.ts`
// owns that — but that a match between two bots actually TERMINATES, that the
// stronger bot wins more often than the weaker one, and that the three rally
// numbers keep their separate meanings. A simulation that stalls is a bot that
// never frees its seat, which is the account-bound rule failing silently.

/** Run a whole match at a fixed step and report how it went. */
function play(
  muA: number,
  muB: number,
  winningScore = 5,
  opts: { maxSeconds?: number } = {}
) {
  const m = new BotMatch({
    difficulties: ['pro', 'pro'],
    trueSkillMu: [muA, muB],
    winningScore,
    rules: DEFAULT_MATCH_RULES,
  });
  const dt = 1 / 60;
  const maxTicks = Math.round((opts.maxSeconds ?? 600) / dt);
  let ticks = 0;
  let crossings = 0;
  let returns = 0;
  while (!m.matchOver && ticks < maxTicks) {
    const ev = m.tick(dt);
    if (ev.crossedTo !== null) crossings++;
    if (ev.returnedBy !== null) returns++;
    ticks++;
  }
  return { m, ticks, seconds: ticks * dt, crossings, returns };
}

describe('BotMatch', () => {
  it('plays a match to the winning score and stops', () => {
    const { m, seconds } = play(25, 25, 5);
    expect(m.matchOver).toBe(true);
    expect(m.winner()).not.toBeNull();
    expect(Math.max(...m.scores)).toBe(5);
    // A first-to-5 between two mid bots is minutes, not hours. The real
    // guard is that it terminated at all; this catches a stall that only
    // shows up as "the suite got slower".
    expect(seconds).toBeLessThan(600);
  });

  it('produces real rallies rather than an unbroken run of aces', () => {
    const { m, crossings, returns } = play(25, 25, 5);
    // Every point involves at least the serve crossing, so crossings alone
    // proves nothing. Returns are what say the ball is being played back.
    expect(returns).toBeGreaterThan(0);
    expect(crossings).toBeGreaterThan(returns);
    expect(m.bestRally).toBeGreaterThan(0);
  });

  it('keeps the current run and its peak apart', () => {
    const { m } = play(25, 25, 5);
    for (const seat of [0, 1] as const) {
      // The peak can never be below where the run currently stands: a run of
      // N is at least N. Reading the wrong one of these is the documented way
      // to pay for work nobody did.
      expect(m.bestStreaks[seat]).toBeGreaterThanOrEqual(m.streaks[seat]);
    }
    expect(Math.max(...m.bestStreaks)).toBeGreaterThan(0);
  });

  it('lets the stronger true skill win more often', () => {
    // Skill is a property of the BOT, fixed for its lifetime — that is what
    // gives the population a spread instead of everyone converging. A wide
    // gap so the signal clears the noise in a small sample.
    let strongWins = 0;
    const N = 24;
    for (let i = 0; i < N; i++) {
      const { m } = play(33, 20, 5);
      if (m.winner() === 0) strongWins++;
    }
    expect(strongWins).toBeGreaterThan(N * 0.65);
  });

  it('awards the point to the scorer and hands them the serve', () => {
    const m = new BotMatch({
      difficulties: ['pro', 'pro'],
      trueSkillMu: [25, 25],
      winningScore: 5,
      rules: DEFAULT_MATCH_RULES,
    });
    const dt = 1 / 60;
    let scorer: 0 | 1 | null = null;
    for (let i = 0; i < 60 * 600 && scorer === null; i++) {
      const ev = m.tick(dt);
      if (ev.scoredBy !== null) scorer = ev.scoredBy;
    }
    expect(scorer).not.toBeNull();
    expect(m.scores[scorer!]).toBe(1);
    // The scorer serves next — the same convention `score_update.nextServer`
    // carries for a human duel.
    expect(m.servingPlayer).toBe(scorer);
  });

  it('reports nothing once the match is over', () => {
    const { m } = play(33, 18, 3);
    expect(m.matchOver).toBe(true);
    const before = [...m.scores];
    for (let i = 0; i < 600; i++) m.tick(1 / 60);
    // Nothing is counted after the final whistle — the relay learned this the
    // hard way with point_scored and ball_cross_net (CLAUDE.md §5).
    expect(m.scores).toEqual(before);
  });
});
