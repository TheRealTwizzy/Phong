---
name: phong-progression
description: >-
  Changing what a Phong match pays or what it moves on the ladder — the XP curve, the level
  bands, achievement reward budgets, solo momentum and fatigue, the TrueSkill update, the AI
  rating anchors and the per-rung solo caps. Use this whenever the work touches src/rating.ts,
  matchXp, surpriseMultiplier, levelBand, ACHIEVEMENT_BAND_CAP, SOLO_MU_CAPS, effectiveAiMu or
  recordMatch's XP and rating arithmetic, and whenever the user asks to rebalance rewards, make
  a difficulty worth more, tune the ladder, add an achievement reward or change how fast anyone
  levels. XP and rating live in one file because they are wired together: matchXp takes winProb,
  so moving an AI anchor silently reprices every solo match in the game, and there is no
  per-difficulty XP table anywhere that would tell you it happened.
---

# Changing what a match is worth

Two currencies that never substitute for each other: **XP is the time-invested track and only
ever goes up; the skill tier is the how-good-are-you track and moves both ways.** Both are
computed in `src/rating.ts` and applied inside `recordMatch`, and every rule below has a suite
that fails, which makes this the cheapest territory in the repo to change confidently.

## Why the two halves are one skill

The coupling is arithmetic, not thematic, and it is invisible from either end.

1. **`matchXp` takes `winProb`**, and `surpriseMultiplier` is a pure function of it. Difficulty
   scaling is therefore implicit — *"there is no per-difficulty XP table anywhere"*
   (`src/rating.ts:434`). Move an AI anchor in `AI_RATINGS` and you have repriced every solo
   match in the game, with nothing in the diff to say so.
2. **`ACHIEVEMENT_BAND_CAP` is `0.6 × levelBand(level)`** (`:578`), so achievement rewards are
   denominated in the XP curve. Change `LEVEL_BASE`/`LEVEL_STEP` (`:563-564`) and every reward
   changes meaning.
3. **"Solo must never be the cheap way up" is held by both halves at once** — `SOLO_MU_CAPS` on
   the rating side, momentum and fatigue on the XP side. TESTING.md §5 states it as two rules
   holding one property; changing one without the other opens the gap the other was covering.

## What XP may never do

- **Never negative, and levels never regress.** `XP_FLOOR` (`:426`) is 45 and survives
  underneath everything, including fatigue: fatigue attacks the multiplier, never the floor.
  A loss used to pay the bare floor — about 25 losses to a level, which reads as nothing.
- **Never add a route that takes an XP amount from the client.** `phong-persistence` owns the
  write path and states this too; the reason is worth carrying here because it is the constraint
  that shapes every reward you might want to add. Missions were once claimed via a client-chosen
  `xpDelta` on `PUT /api/profile/me`, and the endpoint could be called in a loop — verified,
  level 1 to 15 in ten requests.
- **One `0.6 × band` budget covers everything a single match unlocks**, not each achievement
  separately. Rewards are flat constants while bands grow, so a mid-game value lands as a
  windfall early: `level_10` paid 750 into a 790-wide band. Several unlocks landing together was
  the other route to a free level, which is why the budget is per match.
- **A rally reward reads `earnedStreak`, never the peak.** See `phong-streaks` — that one is its
  call, not this skill's, and it is the difference between a reward and a farm.

## The caps are data, and the ladder never gets harder because you are losing

**`SOLO_MU_CAPS` (`:164`) is a table, not a formula, and it has been wrong twice in opposite
directions.** First it was the base anchor, which froze the early game: every player starts at
μ25, exactly Pro's anchor, so beating Pro moved nothing while losses moved freely down. Then it
was `anchor + AI_ADAPT_BAND` — right for three rungs, and at five it hands Elite, Cyber and
Chaos one identical ceiling, so farming the Master-tier rung would reach Legend as fast as
farming the hardest thing in the game. The values now sit 0.1 under a tier floor: rookie
`START_MU`, pro 30.9, elite 33.9, cyber and chaos 36.9. **Legend is the solo ceiling; Cyber
Overlord (37) is only ever reached through PvP.**

**Adaptation is asymmetric on purpose** (`AI_ADAPT_STRENGTH` 0.6 up, `AI_ADAPT_DOWN_STRENGTH` 1
down, `:114`/`:126`). Partial tracking leaves a residual gap that is fine above average and
compounds below it — a player losing every match to Pro fell to μ13 while Pro stalled at 18, so
their odds went 50% to 22% and every further loss widened it. **The ladder must never get harder
because you are losing.**

**The two placement conditions must agree.** `PLACEMENT_GAMES` is the promise the Profile modal
makes; `PLACEMENT_SIGMA` is what actually releases a tier. At the ordinary PvP shrink, σ does not
reach 4.0 until roughly the sixteenth game, so players saw "5/5" and stayed unranked with no way
to tell what was missing. `PLACEMENT_SIGMA_SCALE` (`:256`) is what makes the counter honest.

## Verifying

```bash
npx vitest run tests/xp.test.ts tests/rating.test.ts tests/achievements.test.ts tests/db.test.ts
```

`tests/rating.test.ts` pins every cap value-by-value and the below-the-next-floor property, so a
moved anchor cannot silently move what farming a rung is worth. `tests/achievements.test.ts`
holds the band cap across levels 1-30 and asserts no two-level gain above level 4 over 1440
simulated matches. `tests/db.test.ts` holds the plumbing: the win streak read *before* this
match's own bump, and the day tally riding `recordMatch`'s transaction and its idempotency.

## Where the AI's own error lives, and why it is not here

`MAX_AI_COMPETENCE`, the per-rally read, and the rule that **no difficulty may ever return ≥93%
of balls** are in `src/game/physics.ts` and pinned by `tests/physics.test.ts`. They decide how
well the opponent plays, not what the ladder is worth, and the bounds are measured rather than
chosen — `phong-ship-check` owns reading those failures, including why a bound on a sampled
value is read off its own suite's distribution and never copied from a neighbouring one. Change
an anchor here; change competence there.
