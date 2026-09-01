---
name: phong-feature
description: >-
  Designing and landing a new Phong feature or game mechanic — the questions that decide what it
  is before any code, the order the pieces have to be built in, and which of the other skills
  each answer hands off to. Use this whenever the user asks for a new mode, mechanic, screen,
  toggle, stat, room or way to play, whenever a change is going to touch more than one of
  src/types.ts, server.ts, src/App.tsx and server/db.ts, and whenever you are starting something
  and are not sure what it will touch. Features here run 10 to 71 files, and the expensive
  mistakes are all late discoveries of an early decision — a badge promising a rank the server
  was never going to grant, a Start button 160px below the viewport, a default difficulty the
  server answered 403.
---

# Before you build it

This skill owns two things and defers the rest: the **questions that classify a feature** and the
**order its pieces land in**. It holds no rules of its own — each answer hands off to its owner,
because a router restating its destinations is a twelfth silo that goes stale faster than any.

## Classify it first, and only once

Answer these before writing code. Each has a consequence and an owner; if an answer does not
change what you do next, you have asked the wrong question.

1. **Does it show the player any of the hidden half?** The blind half-court *is* the game, so
   this is a rating decision, not a presentation one — the sonar unranks a match, the net
   indicators are free. → `phong-match-rules`, which owns that whole split and what follows.
2. **Do the two phones have to agree about it?** Then it is protocol, and it has two
   implementations: the relay and the DataChannel replica. Only 1 of the last 9 feature PRs
   touched `src/net/p2p.ts`, which tells you which half gets forgotten. → `phong-protocol`.
3. **Does it store anything per player?** A `playerId`-keyed table must be claimed, or a sign-in
   orphans it and a match is silently paid twice. → `phong-persistence`.
4. **Does it pay XP or move the ladder?** Never take an XP amount from a client.
   → `phong-progression`.
5. **Does it read or write a rally run?** Three numbers, only one ever paid on. → `phong-streaks`.
6. **Does it add a route, a socket path, or a new way to earn?** It needs a gate — a gameplay
   path needs one twice. → `phong-session`.
7. **Does it put anything on the screen?** → `phong-ui`. **Does the player read any text?** Seven
   locales or it does not ship. → `phong-i18n`.

Two questions with no skill behind them, which is why they are spelled out here:

- **Is it reachable from a *live* match?** Quitting a solo match a point has been scored in is a
  recorded loss; a duel walked out of is a real loss and a real win. Anything navigating away from
  a live court routes through `exitConfirm`, or is a way to escape a losing record.
- **Does it gate anything?** The menu draws it and the **server enforces it** — the menu is the
  client. `roomEntryVerdict` is asked by both, as `DIFFICULTY_LOCKED` sits behind the record route.

## The spine, and the order it has to go in

Every shipped mechanic walks some prefix of this, and the ordering is not stylistic — each step
is depended on by the next.

1. **Classify** (above). Wrong here is a rewrite, not a refactor: it fixes the type, the storage,
   the editability window, and whether it reaches the pre-match badge.
2. **Prove any assumption the design rests on**, in the thing that will run it. Cosmetics turned
   on one claim about CSS custom properties, and the wrong spelling compiles, reviews fine and
   paints nothing — two minutes in a browser against forty-five files of rework. Keep the check.
3. **Declare the shape in `src/types.ts`**, then in the shared module that owns it — convention
   §4, and the only thing `tests/protocolParity.test.ts` can read.
4. **Default and normalizer in the same commit.** Every shared module has a `DEFAULT_*` and a
   `normalize*`, because values arrive from an untrusted client, from `localStorage`, *and* from
   a row written by an older build.
5. **Ranked consequence in `isRankedRules` *and* `unrankedReasons`, together** — the panel renders
   `blockers[0]`, so that ordering *is* the display priority; splitting them makes the badge lie.
6. **Wire every surface**, not the first. `MatchRulesPanel` renders in the menu *and* the lobby;
   a mode surfaces in `MainMenu`, `ScoreBoard`, `ProfileModal` and both history views.
7. **All seven locales**, then **mirror to the second implementation** — `src/net/p2p.ts`,
   `server/transform.ts`, or the relay, whichever applies.
8. **Persist and re-derive server-side**, and persist a derived verdict at *record* time:
   shipping the `ranked` column without a backfill made a live server's history render Un-Ranked.
9. **Pin it** → `phong-e2e`. **Write it down** → `phong-docs`, which also says which two parts
   of that paragraph are worth writing *before* the code and which one you cannot write yet.

## Many sites, no compiler, and why no map is offered

**Adding a `GameMode` is roughly 35 sites across 15 files, and nothing enforces it.** Every branch
is an `if/else if` chain — no exhaustive switch anywhere, so `tsc` names nothing you missed.
Measured: `'practice'` is at 33 sites in 12 files, `'split'` at 14 in 7, sharing only 6 of their
13 files. So the move is a grep against **every** sibling, never one:

```bash
grep -rn "'practice'\|'split'\|'solo'\|'multiplayer'" src server server.ts
```

Picking one sibling is what makes this dangerous: take `'split'` as the model for a new local
mode and the two files deciding whether it records a match at all — `server.ts` and `server/db.ts`
— never appear. That is the signature of the mapper `phong-ship-check` records as deleted: too
narrow in the direction that makes the work look finished. **No map is offered here, for that.**

The durable fix is a `tests/modeParity.test.ts` on the `protocolParity` pattern — a hand-written
list checked against the live union. It **lands with the mode**: sites cannot be pre-enumerated.

**The cheaper answer is usually not to add one, and the CPU seat is the worked example.** Playing
the AI at a relay table is a fourth state App had never had — solo physics at a seat — and adding
`'cpu'` to `GameMode` would have paid the full 35 sites. It stayed `mode: 'solo'` instead, with
"am I seated" carried on the axis the component already had (`roomId`/`tableState`), so the branch
that matters most falls out RIGHT for free: the duel countdown is gated on `mode !== 'multiplayer'`
and a machine match correctly gets none. The cost is that three sites which flip `mode` on seating
had to be re-answered by hand and `tsc` named none of them — and getting one wrong is not cosmetic:
the match records as an unranked duel against nobody, and `abandoningLiveSoloMatch` (which requires
`mode === 'solo'`) never fires, so quitting a losing machine match records nothing at all. Before
adding a mode, ask whether the new thing is a different GAME or the same game somewhere else.

The same shape arrives as a **sweep** — a rename or a migration across hundreds of call sites.
Categorise by **call site, never by the pattern you are matching**: the palette sweep found that
hue does not partition, because cyan is both the accent and the `vanguard` tier, so replacing by
colour silently recolours the tier badges.

## Knowing when it is done is not this skill's call

The spine is about *completeness* — the mirror landed, the locales landed, the suite registered.
Whether it is ready to PUSH has a different owner: **`phong-ship-check`**, which holds the
gauntlet. Two skills giving opposite release instructions is worse than either being wrong alone.
