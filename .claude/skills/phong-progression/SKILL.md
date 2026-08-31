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

**Adaptation is asymmetric on purpose** (`AI_ADAPT_STRENGTH` 0.6 up, `AI_ADAPT_DOWN_STRENGTH`
0.85 down, `:114`/`:126`), and it has been wrong in BOTH directions, so read the numbers before
touching it. At 0.6 the residual gap compounded below average — a player losing every match to
Pro fell to μ13 while Pro stalled at 18, odds 50% → 22%, each loss widening it. At a flat 1 the
gap closed to exactly zero at every depth, which pinned `P(win)` at 56.4% forever: the pre-match
odds, the XP surprise multiplier and `recommendedDifficulty` all key off that number, so a μ6
player was shown the same 56% as a μ25 player while the AI they faced fell to the competence
floor. It also flattened the BOTTOM of the ladder, putting Rookie and Pro on that same floor.

0.85 leaves a residual that **converges** — 2.0 μ at the deepest point, inside one 3 μ tier band
— rather than diverging, which is the distinction from the 0.6 spiral. **A falling player must
always have a winnable rung, and that rung is Rookie**; a harder rung staying harder is not the
bug. What this does NOT fix is recovery: climbing back from a collapsed μ takes 254 wins at 1.0
and 211 at 0.85, because the binding constraint is σ, not the adaptation — at σ2.54 a win moves
μ by 0.33 where at σ8.33 it moves 2.11. The player is confidently rated as bad and TrueSkill is
behaving correctly. Fixing that means σ inflation or an asymmetric `k`, and is its own design.

**The two placement conditions must agree.** `PLACEMENT_GAMES` is the promise the Profile modal
makes; `PLACEMENT_SIGMA` is what actually releases a tier. At the ordinary PvP shrink, σ does not
reach 4.0 until roughly the sixteenth game, so players saw "5/5" and stayed unranked with no way
to tell what was missing. `PLACEMENT_SIGMA_SCALE` (`:256`) is what makes the counter honest.

## Two ratings, and each rates against its own

`recordMatch` runs two updates and they take DIFFERENT opponents. The hidden estimator rates
against the opponent's `mmrMu/mmrSigma` (`RecordMatchContext.opponentRating`); the visible
ladder rates against their `rankMu/rankSigma` (`opponentRankRating`). `duelStartRatings`
samples both pairs per seat, cached on the room per `matchSeq`.

One pair used to stand in for both, and it was the hidden one. That is not a rounding error:
the two diverge by design — solo moves `mmrMu` and never `rankMu`, `SOLO_MU_CAPS` caps one
while `AI_ADAPT_BAND` moves the other, and a match that is `ranked` but not `ranksThisMatch`
(a Rookie solo, a Casual duel) moves the first and not the second — so the ladder step was
measured across two scales. Against a Legend-on-the-ladder, ordinary-in-MMR opponent an upset
win was worth 0.53 mu where it should be 1.21, better than a fifth of a tier band, always in
the same direction. **A fixture that sets both pairs equal cannot tell which one was used**;
`seedSplit` in `tests/duelRecord.test.ts` exists to pull them apart.

`rankMoveSize` (`src/rating.ts`) buckets the delta into the 1/2/3 arrows the winner overlay
draws. Bucketed SERVER-side and never sent as a number: `rankMu` reaching the client is the
one thing `RankBadge.tsx` forbids outright. The bands are measured, and 0.8 is chosen to clear
the whole `performanceWeight` clamp (0.5-1.5 scales an even settled duel to 0.245-0.734), so a
scoreline can never change the arrow count on its own.

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

**But the two meet, and the seam is where the ladder collapsed — at BOTH ends.**
`effectiveAiMu` takes its deviation from `START_MU`, so every anchor receives the IDENTICAL
offset — which means the anchors here decide only where each rung SITS on the competence curve
there, never how far apart they land. When that curve went flat above μ36 (Chaos's own anchor),
all five rungs slid into the flat section together and the top three became byte-identical
opponents from player μ30 upward. It went flat *below* μ12 in exactly the same way, so a player
under μ ~10.9 met a Rookie and a Pro pinned to one value — reachable by ordinary losing, since
rating has no floor of its own. So: **an anchor change is not a difficulty change unless the
curve has room at the place it lands**, and it has to have that room across the whole range
`effectiveAiMu` can produce, which is `20 - AI_ADAPT_DOWN_BAND` (0) to `36 + AI_ADAPT_BAND`
(43). Upward the room is capped by the 93% rule, which binds hard — the top rungs measure
91.0-91.2% at the suite's own sample and a clamp of 0.86 put them at 92.8%.

**A floor in the curve is not by itself a floor in the ladder.** `contactError` carried a
second one — a flat `0.6` output clamp that `0.085 × c^-0.7` reaches at c = 0.061, above where
both bottom rungs sat for those players — so extending the knots alone left the measured return
rates unmoved (43.7% against 44.1% at μ8.76, 2700 balls a cell). `MAX_CONTACT_ERROR` is now
derived from `MIN_AI_COMPETENCE`. **When you widen the competence range, grep the parameter
clamps in `paramsForCompetence` for one that binds inside the new range**; `bounceSkill` (0
below c 0.1) and `spinRead` (0 below c 0.08) are the other two, both deliberate.

The guard for this is in `tests/rating.test.ts`, asserting
`competenceForMu(effectiveAiMu(d, mu))` strictly increasing at eleven player ratings, four of
them below μ12 because that is where the second collapse lived and the loop originally stopped
one rating short of it.
**Never assert ladder ordering on return rate**: it saturates near the top and across seven
measured configurations never once ordered the top three, because the rally harness sees a
rung's aggression as missed balls and never as the sharper return the player has to chase.
