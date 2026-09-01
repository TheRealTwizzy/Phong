---
name: phong-ship-check
description: >-
  Phong's pre-push gate — the checks to run before committing, in the order that fails
  cheapest first, and how to read what comes back. Use this whenever you are about to commit,
  push or open a PR in the Phong repo, and whenever the user says "run the tests", "verify
  this", "check it works", "is this ready to ship" or asks what needs re-running after an
  edit. Reach for it even when the change looks small: `npm test` is seven seconds and covers
  none of the flows, and the twenty-one browser suites that do cover them are the ones people
  skip.
---

# Shipping a change in Phong

`npm test` is the fast layer and it is genuinely fast, but it covers rules, not flows. The
flows live in twenty-one Playwright suites that each boot their own server — minutes, not
seconds.

## The order, and why it is an order

```bash
npm run lint            # tsc --noEmit
npm run lint:suites     # every browser suite is registered with the runner
npm run test:coverage   # the fast layer PLUS the per-module floors CI enforces
npm run build           # vite + esbuild → dist/
npm run test:e2e        # the browser suites, against the production build
```

Each step exists to fail before the expensive one:

- **`lint` first.** `strictNullChecks` is off here and `@types/react` is what makes `.tsx`
  checked at all — without it `tsc` silently skips every component, which is how a DOM event
  once occupied a `GameMode` parameter. A type error found in 10s is not worth finding in a
  browser six minutes later.
- **`lint:suites`** costs milliseconds and needs no dependencies. A file named
  `scripts/e2e-<name>.mjs` missing from `e2e-run.mjs`'s `SUITES` is not a skipped test, it is
  a test nobody knows is not running — it reads as coverage in review and never executes.
  Nothing else can notice: `npm test` does not touch those files, `tsc` does not read them,
  and the runner cannot report a suite it was never told about.
- **`test:coverage`, not bare `npm test`.** CI's `verify` job runs the coverage variant, so a
  module that slipped under its floor in `vite.config.ts` goes red there and not here. Same
  suites, same runtime, strictly more information.
- **`build` before any E2E.** The suites run `node dist/server.cjs`, the production entry. A
  stale `dist/` means you are testing the previous build and the result is not wrong, it is
  *meaningless*, which is worse.

## Which suites to run

**Run all of them.** `npm run test:e2e` is the answer, and a named subset
(`node scripts/e2e-run.mjs duel lobby`) is for iterating on one flow you are actively
debugging — not for deciding what a change needs before you push.

That is a deliberate conclusion, not laziness, and it is worth knowing why so nobody spends
another day rediscovering it. **A file→suite map was built for exactly this and deleted.** It
mapped each changed file to the suites that could break, so a small change ran three suites
instead of nineteen. Over six review rounds every rule that anybody actually checked turned
out to be wrong, and always in the same direction — naming too few suites, which is the
direction that lets a targeted run report success while skipping the flow the change broke:

- `server.ts` omitted every route-driven suite, though `e2e-elite` drives `/api/missions/reroll`.
- `MainMenu.tsx` named 3 suites; 18 of 19 drive an id it defines, because every suite starts
  at the menu.
- `server/transform.ts` named `gameplay` — whose relay scenario asserts the badge reads
  `RELAY` and never crosses the net. The one suite that could not catch a broken mirror.
- `src/game/physics.ts` named 3; **twelve** suites play a match.

Two of those were caught by derivation rather than by a reviewer, and that is the point: the
coupling that matters — *which suites play a match, or a relayed point* — is not derivable
from ids, imports, or anything else static. It is behavioural. A hand-written map of it is a
claim that looks precise, is trusted because it looks precise, and is wrong.

Nineteen suites cost minutes. Being quiet about a broken flow costs a release. If you are
tempted to rebuild the map, the honest version of it is this section.

## Reading a failure

- **A red E2E suite names a flow.** Read the header comment at the top of the suite first —
  nearly every one opens with the bug it exists for. That header tells you whether you have a
  regression or a rule that moved.
- **A red assertion on a MEASURED value may be a sample, not a bug.** The AI rolls its reads
  per rally, so return rates are draws. `tests/spin.test.ts` and `tests/physics.test.ts`
  deliberately carry *different* bounds because they drive different geometries. Measure the
  distribution before touching a threshold, and never tune one until the red goes away.
- **A coverage floor failing is a decision, not an obstacle.** Raise a floor when a module
  genuinely improved; lower one only with the reason in the commit message.

## What "done" means here

A suite that asserts old behaviour gets **changed in the same commit as the rule**, never left
for later — a stale suite is one nobody reads, they just delete it. And if you added a check,
prove it can fail: break the thing on purpose, watch it go red, put it back, and say so in the
commit. `TESTING.md` §6 is the standing guide; read it before adding a suite.

The converse is the one that gets skipped. **A green run is not coverage for a change nothing
asserts on.** A mechanical sweep — a rename, a palette migration — has no test behind most of
its sites, so the diff *is* the check: read your own, hunk by hunk, before pushing. The palette
sweep passed all nineteen suites with eight shadows silently turned into glows, because one
regex had collapsed a near-black tint and a bright accent onto the same token.
