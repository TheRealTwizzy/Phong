---
name: phong-ship-check
description: >-
  Phong's pre-push gate — run the right checks in the right order, and work out which of the
  eighteen browser E2E suites this change actually needs instead of running all of them or none.
  Use this whenever you are about to commit, push or open a PR in the Phong repo, and whenever
  the user says "run the tests", "verify this", "check it works", "is this ready to ship" or asks
  what needs re-running after an edit. Reach for it even when the change looks small: `npm test`
  is seven seconds and covers none of the flows, and the suites that do cover them are the ones
  people skip.
---

# Shipping a change in Phong

`npm test` is the fast layer and it is genuinely fast, but it covers rules, not flows. The
flows live in eighteen Playwright suites that each boot their own server — minutes, not
seconds — which is why the real-world choice has been "run everything" or "run nothing and
hope". This skill removes that choice.

## The order, and why it is an order

```bash
npm run lint            # tsc --noEmit
npm run test:coverage   # the fast layer PLUS the per-module floors CI enforces
npm run build           # vite + esbuild → dist/
node scripts/e2e-run.mjs <suites>
```

Each step exists to fail before the expensive one:

- **`lint` first.** `strictNullChecks` is off here and `@types/react` is what makes `.tsx`
  checked at all — without it `tsc` silently skips every component, which is how a DOM event
  once occupied a `GameMode` parameter. A type error found in 10s is not worth finding in a
  browser 6 minutes later.
- **`test:coverage`, not bare `npm test`.** CI's `verify` job runs the coverage variant, so a
  module that slipped under its floor in `vite.config.ts` goes red there and not here. Same
  suites, same runtime, strictly more information.
- **`build` before any E2E.** The suites run `node dist/server.cjs`, the production entry.
  A stale `dist/` means you are testing the previous build and the result is meaningless — not
  wrong, *meaningless*, which is worse.

## Which suites

```bash
node .claude/skills/phong-ship-check/scripts/which-suites.mjs            # vs origin/main
node .claude/skills/phong-ship-check/scripts/which-suites.mjs <base-ref> # vs anything
node .claude/skills/phong-ship-check/scripts/which-suites.mjs --all
```

It reads the changed files (committed *and* uncommitted — the point is to run it before you
commit), maps them onto the flows they could break, and prints the command with a reason
beside every suite. A file no rule covers **widens to the full run** rather than narrowing to
none: being slow is a cost, being quiet about a broken flow is a bug. Editing a suite runs
that suite; a named base ref git cannot resolve is an error, not a silent fallback.

## Keeping the map honest

```bash
npm run lint:suites     # what CI runs; same as which-suites.mjs --verify
```

**CI runs this**, first in the `verify` job and before `npm ci`, so drift fails the build
rather than waiting to be noticed. If it goes red on your change, a rule you touched now
selects fewer suites than the derivation found — or you added a component a suite drives and
no rule covers it.

The map is a claim about this repo, and a hand-written claim about eighteen suites drifts —
this one drifted three times on its first day, always toward selecting too few, which is the
direction that lets a targeted run report success while skipping the broken flow.

It derives **two floors** from evidence instead of memory: every `#id` each suite drives,
resolved back to the source files that define it; and every `src/` module the **server**
imports, which must be `'*'`. A rule below either floor is reported and the check exits
non-zero. Run it whenever you touch `RULES` — CI will anyway.

The second floor exists because the first cannot see server behaviour: `rating.ts`,
`achievements.ts`, `missions.ts` and `matchRules.ts` render no ids at all, yet `recordMatch`
runs every one of them inside a single transaction on every match any suite plays, and
`venues.ts` gates every seat the relay hands out. Four review rounds found that class one file
at a time; the check now finds it in one pass — it caught `venues.ts` on its first run, before
anyone had reported it.

It is a floor, not the map. It sees DOM coupling only, so a file a suite depends on
*behaviourally* never appears — that is what the reasoned `why` on each rule is for. Widening
past the floor is always fine; falling below it is the bug.

**The shape the map settled into, after being wrong five times in a row:**

- **A shared layer is `'*'`.** `src/App.tsx`, `server.ts`, `server/db.ts`, `server/auth.ts`,
  `MainMenu.tsx`, `OnboardingModal.tsx`, `src/components/ui/`. Every suite starts at the menu,
  onboards, holds a device cookie and writes a profile before it does anything interesting, so
  a subset of suites for any of these is fiction. Every attempt to name one has been wrong.
- **A leaf rule module narrows honestly.** `rating.ts`, `matchRules.ts`, `venues.ts`,
  `physics.ts`, `themes.ts`, `transform.ts`, `room.ts`, `matchmaking.ts` — these are where the
  tool earns its keep, and not by accident: they are the modules stated as rules rather than
  reached through flows, which is the same property that made them cheap to unit-test.

If you find yourself adding a fourth suite to a rule, ask whether the file is really a shared
layer wearing a subset. That question has been answered "yes" every time so far.

**A stale rule fails closed.** Naming a suite that is not in `scripts/e2e-run.mjs` — what a
deleted suite leaves behind — fails `lint:suites`, and in advisory mode it says so and widens
to the full run rather than quietly printing a shorter command.

When a suite is added or removed, the script reads the list from `scripts/e2e-run.mjs` rather
than duplicating it, so a stale rule announces itself as a `map error` line instead of failing
later as "Unknown suite".

## Reading a failure

- **A red E2E suite names a flow.** Read the header comment at the top of the suite first —
  nearly every one opens with the bug it exists for. That header is what tells you whether
  you have a regression or a rule that moved.
- **A red assertion on a MEASURED value may be a sample, not a bug.** The AI rolls its reads
  per rally, so return rates are draws. `tests/spin.test.ts` and `tests/physics.test.ts`
  deliberately carry *different* bounds because they drive different geometries. Measure the
  distribution before touching a threshold, and never tune one until the red goes away.
- **A coverage floor failing is a decision, not an obstacle.** Raise a floor when a module
  genuinely improved; lower one only with the reason in the commit message.

## What "done" means here

A suite that asserts old behaviour gets **changed in the same commit as the rule**, never left
for later — a stale suite is one nobody reads, they just delete it. And if you added a test,
prove it can fail: break the thing on purpose, watch it go red, put it back, and say so in the
commit. `TESTING.md` §6 is the standing guide; read it before adding a suite.
