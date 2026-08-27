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

It derives a **floor** from evidence instead of memory: every `#id` each suite drives,
resolved back to the source files that define it. A rule selecting fewer suites than the
derivation found is reported, and the check exits non-zero. Run it whenever you touch `RULES` — CI will anyway.

It is a floor, not the map. It sees DOM coupling only, so a file a suite depends on
*behaviourally* never appears — that is what the reasoned `why` on each rule is for. Widening
past the floor is always fine; falling below it is the bug. Some rules are deliberately `'*'`
because no subset can be right: `src/App.tsx` and `server.ts` (each is a whole layer in one
file), `MainMenu.tsx` and `OnboardingModal.tsx` (every suite starts at the menu and onboards
before it can touch anything), and `src/components/ui/` (the primitives under every sheet).

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
