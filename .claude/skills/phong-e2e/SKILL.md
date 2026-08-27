---
name: phong-e2e
description: >-
  Writing a test for Phong — choosing the fast layer or the browser, and the mechanics a
  Playwright suite here needs that are not obvious. Use this whenever the work adds or changes a
  test, whenever a new feature needs pinning, whenever the user asks to cover a flow, prove a
  fix or add a suite, and whenever you are about to reach for the browser to assert something a
  unit test could state. A suite file that is not registered with the runner never executes —
  it reads as coverage in review, nothing else in the repo can notice, and the flow it claims to
  cover is unguarded. Reach for phong-ship-check to RUN the suites; this is about writing one.
---

# Pinning a flow

Two layers, deliberately. **`tests/*.test.ts` is vitest and takes seconds** — this is where a
rule goes when it can be stated as a rule. **`scripts/e2e-*.mjs` is a real Chromium driving the
production build against `node dist/server.cjs`, and takes minutes** — this is where a rule goes
when it is really a *flow*: a player following an invitation link, two phones agreeing on a
rematch, a socket dying mid-duel.

## Choose the layer before you write a line

**Put it in the fast layer if you can state it as a rule.** Reach for the browser when the thing
under test is a flow, a gesture, or a layout.

**Asserting a game rule through a browser is a last resort.** The rally-streak rule was
attempted that way and abandoned: it needs a real solo rally, a scripted paddle cannot be relied
on to produce one — a first-to-5 against Rookie goes 5-0 often enough to fail the suite for a
reason that is not the rule — and the fix was to move the rule somewhere it *could* be stated
(`src/game/streaks.ts`) rather than to loosen the assertion until it passed.

**When a browser cannot state a rule directly, look for the observable it can.** "Did the page
tell the server" is not a rally. `scripts/e2e-streak.mjs` knocks the stored run out of step
through the real route, presses Reset, and asserts the page put it back — which fails outright
when the report is removed, where an assertion on the streak readout alone passes on the bug.
**Reach for the side effect before loosening the assertion.**

## Three things every suite here does

1. **Open with the bug it exists for.** Nearly every suite in the repo does, then lists what it
   pins. That header is what tells the next person whether a failure is a regression or a rule
   that moved — and `scripts/e2e-spectate.mjs` shows the shape: *"The relay tests pin the wire.
   What only a browser can answer is…"*, then a numbered list.
2. **Prove it can fail.** A differential or source-scanning test that cannot go red is worse
   than none. `p2pParity` was checked by flipping the replica's serve rotation; `e2e-split` by
   breaking the pointer locking; `tests/tableBrowser.test.ts` by deleting the `visibility`
   filter. Break the thing on purpose, watch the red, put it back, and say so in the commit.
3. **Register it, or it does not run.** Add `{ name: '<suite>', ownsServer: false }` to `SUITES`
   in `scripts/e2e-run.mjs` — `ownsServer: true` if it kills or restarts the server itself
   (`e2e-eject` does, and that is the whole point of it), `needsBrowser: false` if it drives no
   page (`build-id` reads `/api/health`). `npm run lint:suites` is the only thing in the repo
   that can catch an unregistered file; `npm test` does not touch these, and `tsc` does not read
   them.

## Reuse the harnesses rather than rebuilding them

`tests/helpers/relay.ts` boots a real server: `freePort`, `startRelay`, a `Phone` socket
wrapper, cookie jars, and `seatDuel` for the whole lobby handshake through to the first serve.
Two details in it are scar tissue rather than style — the server is spawned **detached** and
killed by process *group*, because `npx tsx` is a tree and signalling the spawned pid alone left
a live server holding a port; and the kill is awaited before the temp directory is removed, so
the directory is never deleted out from under a running server.

For the client networking layer, the storage and fetch fakes at the top of
`tests/matchQueue.test.ts` and `tests/sessionWatch.test.ts` already exist.

Each browser suite gets its own free port, throwaway `DATA_DIR` and server — a shared database
would let one suite's players decide another's assertions — so **`npm run build` is a
precondition, not an errand.**

## Reaching the canvas, where nothing is in the DOM

Paddles are drawn from refs and appear in no element, so two mechanics cost real time to
discover:

- **Drive multi-touch through CDP `Input.dispatchTouchEvent`,** not synthetic `PointerEvent`s.
  `handlePointerDown` calls `setPointerCapture`, which throws on an untrusted pointer id, and
  CDP is the only route to two fingers at once — which the serving joystick needs, since one
  thumb aims while the other steers.
- **When sampling pixels, collect runs of matching ones and discard the short runs.** The court
  is drawn with a hairline frame in the same cyan as P1's paddle, so taking the first and last
  matching pixel puts every reading at dead centre regardless of where the paddle actually is.
- `#telemetry-paddle-pos` is the one place in the DOM that reports where the paddle is, and
  `scripts/e2e-rules.mjs` reads it rather than sampling.

## A bound is read off its own distribution

The AI rolls its reads per rally, so every measured return rate is a **sample**, and an
assertion on a *difference* between two of them carries both their noise. The ladder-spread
check flaked at roughly 3 runs in 400 until its sample was tripled and its threshold moved below
the tail rather than beside the mean — it surfaced as `expected 0.19999999999999996 to be
greater than 0.2` on a docs-only PR.

`tests/spin.test.ts` and `tests/physics.test.ts` deliberately carry **different** bounds for the
same rule, because `spin` drives an easier geometry and the same AI returns more balls there.
**Copying a bound between suites is reading one distribution's number off another's.** Measure
first. This is about *choosing* a bound as you write one; whether a red you are looking at is a
sample rather than a bug is `phong-ship-check`'s call, under "Reading a failure".

And when a rule changes, change its suite in the same commit — **a suite that asserts old
behaviour is deleted rather than read.**
