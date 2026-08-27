---
name: phong-match-rules
description: >-
  Deciding whether a new Phong feature is a free device preference or a match rule that costs
  the rating, and wiring it correctly either way. Use this whenever the work adds or changes
  anything a player can toggle — an indicator, an overlay, a radar or sonar, an assist, a
  physics multiplier, a serve or paddle tweak, an accessibility aid — and whenever it touches
  src/matchRules.ts, MatchRules, GameSettings, isRankedRules, unrankedReasons, the ranked bands
  or the pre-match ranked/unranked badge. The blind half-court IS the game, so this is a design
  decision with a rating consequence, not a place to pick whichever type is convenient.
---

# Is it a preference, or is it a rule?

Convention §12: **anything that shows the player the half they are not meant to see is a match
RULE, and it costs the rating.** Not a presentation preference, however it is spelled.

The line is already drawn by two shipped features, and they are the calibration:

- **The net indicators** — a chevron following the opponent's paddle, a marker while the ball
  is on their half — say *where they are*. That is what a player on the other side of a real
  table can see anyway. Device preferences (`showOpponentIndicator`/`showBallIndicator`), on
  by default, **ranked-legal, free**.
- **The opponent sonar** draws their half outright: their paddle and the live ball. That is a
  live mini-map of the half you are not allowed to see. A `MatchRule` (`opponentSonar`), off
  by default, and switching it on **unranks the match** — it still pays XP, it costs the
  ladder.

So the question for anything new is not "is this a toggle" but **"how much of the hidden half
does it hand over"**. Answer it deliberately.

## If it is a preference

It lives in `GameSettings`, on the device, in the in-game Settings modal. Nothing else to do —
except to notice whether the sonar should suppress it. Both indicators are suppressed while
the sonar is on, and that suppression is **derived per match, never written**: the stored
preferences come back by themselves next time the sonar is off, and Settings shows those rows
off and disabled *with the reason*, rather than reading as on while nothing is drawn.

## If it is a rule

Then all of this, in one commit — the pieces are load-bearing together and a half-done rule
makes the badge lie:

1. **`MatchRules` in `src/types.ts`**, and a default in `DEFAULT_MATCH_RULES`. A physics
   multiplier also needs a `RuleSpec` in `PHYSICS_RULES` with its **ranked band** — fairness
   here is a band around stock, not an all-or-nothing stock check, so a tuned match inside the
   band rates normally (the ladder absorbs a 15% wider paddle the way it absorbs a better
   phone) and past it pays XP but moves nothing.
2. **`isRankedRules()`** — the server re-derives this in `recordMatch` from the rules
   themselves. A client-set `ranked` flag is ignored, always.
3. **`unrankedReasons()`** — the whole verdict in one ordered list: mode, then difficulty,
   then sonar, then the physics keys. This is a **display** predicate; the server still
   derives its own half from `isRankedRules` plus `soloCountsForRank` and never trusts it.
4. **`normalizeRules()`** — clamp and snap it, because it arrives from a client and from
   storage.
5. **`MatchRulesPanel`** so it can be set, in the pre-match sheet *and* the duel lobby (same
   component, both places).
6. **The P2P replica**, if it changes what the ball does. `src/net/p2p.ts` runs the rules
   itself during a DataChannel match.
7. **All seven locales** for any label — see the `phong-i18n` skill.

## The badge answers the whole question, not just the sliders

`unrankedReasons` exists because the pre-match badge used to ask only half of it: it promised
"counts for rank" for a Rookie solo match the server was always going to refuse to rate (a
solo result rates only at an **earned** difficulty), and for Practice and Split Screen, which
record no rating at all. **A badge that is wrong about the one thing it exists to say is worse
than no badge.**

So a new rule goes into `isRankedRules` **and** `unrankedReasons` in the same commit, or the
badge starts lying. The exit-confirmation dialog reads the same verdict, so a Rookie or sonar
match is not threatened with a rank it was never going to move.

## What never costs the rating

Telemetry, quick chat and auto-serve. They do not touch the ball and they do not touch the
hidden half. The sonar is the **only** non-physics rule that unranks — if you are adding a
second one, that is a deliberate change to the shape of the rule set, not a detail.

## Verifying

```bash
npx vitest run tests/matchRules.test.ts tests/themes.test.ts
npm run build && node scripts/e2e-run.mjs rules duel
```

`tests/matchRules.test.ts` pins the bands, the sonar and the default — `DEFAULT_MATCH_RULES`
must ship with the sonar **off**, or every stock match is unranked with its indicators
suppressed. `e2e-rules` drives the badge through the real sheet; `e2e-duel` has the host ask
for the sonar in the lobby.

## Where rules are read

Never read `settings.winningScore` or `settings.rules` in match code (convention §7). A solo
match takes its terms from the pre-match sheet; a duel takes them from `RoomMatchConfig`, set
by the host and broadcast to both phones. Read the derived `activeConfig`, or a phone quietly
plays its own match — which is precisely how a duel used to end for one player while the
other was still mid-rally.
