# TESTING.md — how Phong is tested, and why

This is the working guide to the test suite. When the tests and this file disagree, fix this file.

```bash
npm run lint           # tsc --noEmit
npm test               # vitest run — the fast layer, ~7s
npm run test:coverage  # the same suites plus the coverage floors CI enforces
npm run test:e2e       # browser suites; needs `npm run build` first
```

---

## 1. Two layers, deliberately

**`tests/*.test.ts` — vitest, seconds.** Pure logic, the SQLite store, and two suites that
spawn a real server. This is where a rule goes when it can be stated as a rule.

**`scripts/e2e-*.mjs` — Playwright, minutes.** A real Chromium driving the production build
against `node dist/server.cjs`. This is where a rule goes when it is really a *flow* — a
player following an invitation link, two phones agreeing on a rematch, a socket dying
mid-duel.

CI (`.github/workflows/ci.yml`) runs them as two parallel jobs — `verify` (typecheck,
coverage, build) and `e2e` — so a red one names the broken flow instead of a broken build.

**The project bets on the browser for UI.** There is no jsdom, no testing-library, and no
component tests. That is a choice, not an omission: Phong is two phones laid top-to-top with
half the court hidden, and the failures that actually reach players are layout, gesture and
transport failures a DOM shim would not see. Do not add a component-test framework to chase a
coverage number.

## 2. What each suite owns

### Fast layer

| Suite | Owns |
|---|---|
| `rating` `xp` `achievements` | TrueSkill, tiers, XP curve, the achievement tree and the unlocks it gates |
| `db` | The store: matches, idempotency, abandons, and the counters `recordMatch` derives |
| `missions` | The dealt hand, rerolls, elite unlocks, Practice Wall XP |
| `physics` `spin` `transform` | Ball, collisions, spin, AI competence, the cross-net mirror |
| `room` | The relay's room rules, including the adversarial `match_sync` guards |
| `matchRules` | Ranked bands, normalization, `duelMatchKey` |
| `themes` | All 20 themes × every route that unlocks them |
| `matchQueue` `sessionWatch` `staleBuild` `sessionMint` | The client networking layer |
| `protocolParity` `p2pParity` | That the relay and the P2P replica are the same game |
| `identity` `username` `avatar` `device` `bots` `qr` `i18n` | Identity, assets, the device gate, locales |
| `duelRecord` `deviceSession` | Two suites that boot the real server (see §4) |
| `db-wipe` `taskReset` `placementRescue` | The one-shot migrations |

### Browser layer

`profiles` · `gameplay` · `rating` · `rules` · `achievements` · `elite` · `duel` · `invite` ·
`lobby` · `split` · `eject` · `build-id`

Each gets its own free port, throwaway `DATA_DIR` and `node dist/server.cjs` — a shared
database would let one suite's players decide another suite's assertions. `npm run build` is
therefore a precondition. Chromium resolves from `CHROMIUM_PATH`, else a Playwright download,
else system Chrome.

## 3. Reading a coverage report honestly

V8 coverage measures **in-process execution only**. Two consequences that will mislead you:

- **`server.ts` reads 0%.** It is not untested — `duelRecord` and `deviceSession` spawn it,
  and all twelve browser suites drive it. The instrumentation cannot see across a process
  boundary.
- **Every `.tsx` reads 0%,** for the same reason. Playwright covers them.

`npm run test:coverage` reports on `src/*.ts`, `src/game`, `src/media`, `src/net` and
`server/` — deliberately not `src/i18n` (2,600 lines of dictionary that would dominate the
total without saying anything about behaviour) and not the components.

### The floors

Per-module thresholds live in `vite.config.ts` with the reasoning beside them. There is
**no global threshold**: a single number would either fail on the Playwright bet above or be
set low enough to measure nothing.

Each floor sits a few points below where its module actually is, so the ratchet holds without
going red on the next honest refactor. Raise one when a module genuinely improves. Lower one
only with a reason in the commit message.

## 4. Suites that boot a real server

`tests/helpers/relay.ts` is the shared harness: a free port, a throwaway `DATA_DIR`, a
detached `npx tsx server.ts`, cookie jars, a `Phone` socket wrapper and `seatDuel` (the full
lobby handshake through to the first serve).

Two details in there are scar tissue, not style. The server is spawned **detached** and killed
by process *group*, because `npx tsx` is a tree and signalling only the spawned pid left a
live server holding a port and a deleted temp directory until CI reaped it. And the kill is
awaited before the temp directory is removed, so the directory is never deleted out from under
a running server.

## 5. Standing rules

These are invariants the suite exists to hold. Breaking one is not a style problem.

**A gameplay message is handled in BOTH `server.ts` and `src/net/p2p.ts`.** The replica
duplicates the relay's rules because a DataChannel match never reaches the server. That
duplication has drifted once already: every P2P duel was recorded 0-0 and *both* players filed
a loss. `tests/protocolParity.test.ts` reads the source and fails the moment a message is
added to one side only; `tests/p2pParity.test.ts` runs one identical script through both
transports and compares what each player is told.

**Never add a match-recording path without a `matchKey`.** A duel legitimately arrives up to
three times — the relay writes it for both seats, both clients POST it as a fallback, the
on-device queue may replay it — and `duelMatchKey()` is the only thing that says they are the
same match.

**A match refused as `DEVICE_RELEASED` or `SESSION_SUPERSEDED` is dropped, never queued.**
Replaying it would credit whatever identity the browser ends up with for a match another
account played. Every other failure mode keeps the match. `tests/matchQueue.test.ts` pins all
six.

**`offline` is not an eviction.** A dropped heartbeat is a phone changing cells. The states
that stop play are exactly `released`, `superseded` and `stale_build` — `BLOCKING_STATUSES` in
`src/net/session.ts`, enumerated in `tests/sessionWatch.test.ts` so adding a status has to be
a decision about that list.

**`SESSION_STALE_BUILD` is never handled as "mint one and retry."** The reload is the point;
minting under the new build is how an old bundle survives a deploy.

**The device gate reads the platform, never the window.** `tests/device.test.ts` scans
`src/device.ts` for viewport reads. A source check, because the failure mode is somebody
*adding* one for a plausible reason, and no fixture can catch a signal that is not in
`DeviceSignals` yet.

**A user-facing string ships in all seven locales.** `tests/i18n.test.ts` pins parity, no dead
keys, and no missing keys — note the second rule makes a test a poor place to name a key.

**A suite that asserts old behaviour is deleted rather than read.** When a rule changes, change
its suite in the same commit.

## 6. Writing a new test here

- **Put it in the fast layer if you can state it as a rule.** Reach for the browser when the
  thing under test is a flow, a gesture, or a layout.
- **Say what broke.** Nearly every suite in this repo opens with the bug it exists for. That
  header is what tells the next person whether a failure is a regression or a rule that moved.
- **Prove it can fail.** A differential or source-scanning test that cannot go red is worse
  than none. `p2pParity` was checked by flipping the replica's serve rotation; `e2e-split` by
  breaking the pointer locking. Do the same and say so in the commit.
- **A flaky test is worse than none.** `tests/sessionMint.test.ts` records this reasoning: an
  intermittent race was pinned as a unit invariant rather than as a browser assertion that
  would catch a regression only sometimes.
- **Reuse the harnesses.** `tests/helpers/relay.ts` for a real server; the storage/fetch fakes
  at the top of `matchQueue`/`sessionWatch` for client networking.

## 7. Reaching Split Screen and other canvas modes

Paddles are drawn to canvas from refs and appear nowhere in the DOM, so `scripts/e2e-split.mjs`
reads them back by sampling pixels on the scanline each paddle occupies. Two things that cost
time to discover:

- Drive multi-touch through **CDP `Input.dispatchTouchEvent`**, not synthetic `PointerEvent`s.
  `handlePointerDown` calls `setPointerCapture`, which throws on an untrusted pointer id, and
  CDP is the only route to two fingers at once.
- When sampling, collect **runs** of matching pixels and discard short ones. The court is drawn
  with a hairline frame in the same cyan as P1's paddle; taking the first and last matching
  pixel puts every reading at dead centre regardless of where the paddle is.
