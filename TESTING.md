# TESTING.md — how Phong is tested, and why

This is the working guide to the test suite. When the tests and this file disagree, fix this file.

```bash
npm run lint           # tsc --noEmit
npm test               # vitest run — the fast layer, ~25s
npm run test:coverage  # the same suites plus the coverage floors CI enforces
npm run test:e2e       # browser suites; needs `npm run build` first
```

---

## 1. Two layers, deliberately

**`tests/*.test.ts` — vitest, seconds.** Pure logic, the SQLite store, and ten suites that
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
| `rating` `xp` `achievements` | TrueSkill, tiers, `tierProgress` (incl. the full top band), the per-rung solo caps, the arrow-count bands, the XP curve, solo momentum/fatigue, the achievement tree and the unlocks it gates |
| `ladderPosition` | The number the top rung renders instead of its name, that it AGREES with the leaderboard's own, and that the narrow rating read the relay pairs on says the same thing a whole profile would |
| `db` | The store: matches, idempotency, abandons, and the counters `recordMatch` derives |
| `matchHistory` | History reads: one row per player per match, the `ranked` column, mode/ranked filters, paging, per-player retention |
| `missions` | The dealt hand, rerolls, elite unlocks, Practice Wall XP |
| `physics` `spin` `transform` | Ball, collisions, spin, AI competence, the cross-net mirror |
| `streaks` | A rally streak: whose it is, what ends it, and what it carries into |
| `room` | The relay's room rules, the reaper, and the adversarial `match_sync` guards |
| `matchRules` | Ranked bands, normalization, `duelMatchKey` |
| `cosmetics` | All 20 cosmetics × every unlock route, the contrast floor, the distinctness floor, and the two meters the header capsule stacks |
| `color` | The colour maths both those floors stand on |
| `matchQueue` `sessionWatch` `staleBuild` `sessionMint` | The client networking layer |
| `protocolParity` `p2pParity` | That the relay and the P2P replica are the same game |
| `identity` `username` `avatar` `device` `bots` `qr` `i18n` | Identity, assets, the device gate, locales |
| `venues` | Buildings and rooms: the bracket predicate the menu and the relay share, and which rooms move the visible ladder |
| `gestures` | The swipe thresholds, the axis lock, the release velocity and the page-settle rule — the ONLY place these are stated (see §5) |
| `meterMemory` | Where a progress meter resumes from, and that a band change resets it — the ONLY place this is stated (see §5) |
| `ladderTone` | Which stop of the rank meter's fixed ramp a fill is at — the one tone in the app picked by a value rather than a meaning |
| `tableBrowser` | The table listing and the relay's bracket enforcement, against a real server |
| `spectators` | The four-seat table: watching, the fan-out, seat swapping, against a real server |
| `seatGate` | The bracket on the THIRD door into a playing seat, against a real server: a watcher cannot promote past a gate `spectate_room` never asked, one who passes it still can, a private table is not bracketed (an invitation is not a bracket), and a player already seated is not re-judged. Plus the ORDERING that makes a refusal free: a `VENUE_LOCKED` join leaves the machine in its chair, because `join_room`'s eviction used to run above the gate and a refused arrival took the CPU with it |
| `cpuTable` | A machine in a playing seat, against a real server: that Start needs no second person, that Play Again works with one voter, that the rung is clamped at BOTH doors, that a machine is never seated on top of a person, the four-clause vouch behind the watched-table ranked rule, and the `cpu_frame` fan-out against an **asymmetric** fixture (`watched_*` raw, `opponent_*` mirrored — identical at 0.5, which is why a centred fixture proves nothing). Plus the window: a joiner is refused at a machine table mid-match **with no `cpu_frame` ever sent**, which is the shape a watcher-gated stream makes ordinary and the pre-existing case could not reach, since it manufactures `inPlay` by hand. Plus the END of such a table: that its one player leaving deletes it and closes its watchers (a different `vacateSeat` path from the two-human one — the machine is not in `players`, so the FIRST leave empties both seats), that a terminal frame is what makes `spectator_sync` say `matchOver`, and that a rematch reaches the watchers and not just the host. Those three drive `cpu_frame` by HAND and so pin the wire, not the client — the client's half of all three had shipped broken with this file's relay assertions green, which is why `spectate` carries them too |
| `matchmaking` | Who the ranked queue pairs, and how hard it insists (pure) |
| `queue` | Joining, pairing, seating and starting, against a real server |
| `duelRecord` `deviceSession` `accountRecovery` `accountDeletion` `roomLifecycle` `spectators` `queue` `tableBrowser` `cpuTable` `seatGate` `p2pParity` `headers` | Twelve suites that boot the real server (see §4) |
| `db-wipe` `taskReset` `placementRescue` `rankedBackfill` `chaosRelabel` `shutoutRecount` | The one-shot migrations |
| `sigv4` | The request signing offsite backups upload with. Hand-rolled, so it is pinned against fixtures generated by **botocore** — the AWS CLI's own signer — with `canonicalRequest`, `stringToSign` and `signature` asserted SEPARATELY, since one `Authorization` comparison is one bit and says nothing about where it broke |
| `backupSchedule` | When a backup is due, whether it has anywhere to go, and whether `BACKUP_DIR` is on the same filesystem as `DATA_DIR` — the check that catches an unmounted volume, which a path comparison cannot |
| `backupTick` | The orchestration, with the child runner and the uploader injected: that a failed upload does not suppress the local success, that a rejecting child leaves the tick resolved, and that no logged path carries the secret |
| `s3Put` | The upload against a loopback `http.createServer`: what is signed, what is sent, and that a failure never reaches the caller as a rejection |
| `backupRun` | `scripts/backup.mjs` driven for real, and its **first CI guard ever** — `npm test` never touched `scripts/`, `tsc` does not read `.mjs`, and `lint:suites` polices only `e2e-*.mjs`, so it could have been broken for months exactly the way `scripts/load-test.mjs` was |

### Browser layer

`profiles` · `cosmetics` · `venues` · `menu` · `gameplay` · `rating` · `rules` ·
`achievements` · `elite` · `duel` · `invite` · `lobby` · `spectate` · `queue` · `split` ·
`streak` · `history` · `delete` · `report` · `eject` · `load` · `build-id`

`lobby` and `spectate` are where the CPU seat is driven through a real browser, because the
cost of it is on the CLIENT and `tsc` names none of the branches: `lobby` proves the picker
opens from the free chair, that Start is live with nobody opposite, and — the witness that
matters — that the court comes up with the HUD's **Reset** button, which is hidden in a duel,
so `mode` genuinely stayed `'solo'` at a relay seat. `spectate` proves a machine match is a
listed, watchable table whose scoreboard actually follows the play — and then drives it to the
whistle and out of it, which is the leg that only a browser can run: that the watcher is shown
the result, that Play Again carries them into the second match, and that the host walking out
closes the table on them and delists it. Every one of those three failed in the field while the
relay suite was green, because the relay's half of each was already right and nothing on the
client could produce the message that reached it.

Each gets its own free port, throwaway `DATA_DIR` and `node dist/server.cjs` — a shared
database would let one suite's players decide another suite's assertions. That isolation is
also what lets the runner hold several in flight at once: a bounded pool (`E2E_CONCURRENCY`,
default a quarter of the cores capped at 4 — a "suite" is a server plus a Chromium, the suites
assert real timings, and at half the cores the queue suite failed 2 of 3 runs beside duel and
history while passing solo, a starved timeout reading as a flake) shares nothing between
suites but the CPU, and `E2E_CONCURRENCY=1` is exactly the old one-at-a-time run.
`npm run build` is therefore a precondition. Chromium resolves from `CHROMIUM_PATH`, else a
Playwright download, else system Chrome.

## 3. Reading a coverage report honestly

V8 coverage measures **in-process execution only**. Two consequences that will mislead you:

- **`server.ts` is ABSENT from the report, not 0%.** It is a root file and matches no
  `include` glob, so it does not appear at all — which is a stronger version of the same
  trap, since a missing row reads as nothing to look at. It is not untested either: ten
  vitest suites spawn it and all twenty-one browser suites drive it. The instrumentation
  cannot see across a process
  boundary.
- **Every `.tsx` reads 0%,** for the same reason. Playwright covers them.
- **`scripts/backup.mjs` is absent too, and it is the best-tested file in that directory.**
  `tests/backupRun.test.ts` spawns it as a child process — which is how the server runs it,
  and deliberately: it is top-level code that `process.exit(1)`s on four paths, and
  `PRAGMA integrity_check` is synchronous. Coverage cannot follow it across the boundary, and
  `include` does not match `scripts/` in any case.

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

**A table with nobody in a playing seat does not exist.** `isRoomEmpty` asks only about live
PLAYERS, so two spectators and no player is empty and the reaper sweeps it within 15 seconds;
`vacateSeat` deletes the room outright and ejects the watchers when the last playing seat
empties. That was held from the relay side alone, and the gap it left is the shape to remember:
a machine table's host is in `'solo'` mode, so their Main Menu never sent `leave_room` at all —
the seat stayed held, `isRoomEmpty` saw a live player, and a spectator sat in front of a still
frame for half an hour. `tests/spectators.test.ts` and `tests/cpuTable.test.ts` hold the relay
half; `scripts/e2e-spectate.mjs` holds the half where the message has to be SENT, and it is the
only layer that can.

**A guard that skips must also MARK, when what it skips is keyed on a ref.** The
record effect returns early for a spectator, correctly — but `spectating` is in its
deps, so an unmarked ref let it re-run the moment a watcher took a playing seat, with
`winner` still set, filing a match this device only watched onto this account. The relay
permits that seat move at every step (`tests/spectators.test.ts` pins the sequence), and
the harm is permanent, so the premise is held at the relay and the behaviour is held in
the browser — the same split as the row above.

**A relay message costs its sender only, or it is a bug.** "Gameplay is
client-authoritative" has always meant a client can lie about its *own* match. Four handlers
were outside that and each let one socket spend something belonging to somebody else — a
rating, a career-best rally, or the process. `paddle_move` forwarded an uncoerced `x`;
`transformBallForOpponent` coerced only `x`, so `{vy:'x'}` froze the opponent's point forever
and made quitting-as-abandon their only exit; `point_scored` and `ball_cross_net` ran past
`matchOver`, so post-whistle crossings wrote a permanent `highestRally`; and `match_sync` was
accepted on tables that never negotiated a DataChannel, where one frame moved two players'
ratings 8.4μ apart. `tests/transform.test.ts` holds the coercion at a 100% branch floor —
which is what caught the hardening arriving untested — `tests/room.test.ts` holds that a
snapshot stays absolute rather than step-limited, and `tests/duelRecord.test.ts` drives a
seated duel whose room sits at 0-0, so it fails if the vouching guard is ever widened from
"can this room vouch" to "has this room decided".

**A number in these files names the command that produces it.** `scripts/load-test.mjs`
stopped running when the lobby handshake landed — it awaited a `game_start` that no longer
follows a join — and nothing noticed, because `lint:suites` covers only `e2e-*.mjs`, `npm test`
never touches it, `tsc` does not check `.mjs`, and CI never invoked it. Its "10 concurrent
matches, 0% loss" went on being quoted in `CLAUDE.md` §10 and `DEPLOYMENT.md` the whole time:
**an unrunnable script is worse than no script, because its last output keeps being cited.**

It is repaired now, and the repair that mattered was not the handshake. It exports
`runLoadTest()` and `scripts/e2e-load.mjs` drives it at smoke scale (two rooms, three seconds)
as a REGISTERED suite, so the next protocol change that breaks it breaks a build. Real numbers
still come from running it directly at a scale worth quoting — `DEPLOYMENT.md` carries the
current one and names the box it was measured on.

**A presentation flag is free, except the one that is not.** Telemetry, quick chat and
auto-serve never touch the ball and never touch the rating. The **opponent sonar** draws the
half the whole game exists to hide, so it unranks the match — and `DEFAULT_MATCH_RULES` has to
ship with it OFF, or every stock match is unranked with its net indicators suppressed.
`tests/matchRules.test.ts` pins both halves and the default; `scripts/e2e-rules.mjs` drives the
badge through the real sheet, and `scripts/e2e-duel.mjs` has the host ask for it in the lobby.

**The pre-match badge answers the WHOLE question, not just the sliders.** It promised "counts
for rank" for a Rookie solo match the server was always going to refuse to rate, and for
Practice and Split Screen, which record no rating at all. `unrankedReasons` states mode,
**venue**, difficulty, sonar and physics in one ordered list so the sheet and the lobby cannot
drift; a badge that is wrong about the one thing it exists to say is worse than no badge. The
ORDER is part of it, because the strip renders `blockers[0]` alone: `'venue'` is above
`'sonar'` so a Casual table with the sonar on is not told that switching the sonar off
restores a ladder the room was never going to move. And the venue comes from `table_state`
— the TABLE — never from the room the player was browsing, or the badge is right for the host
and wrong for the guest who arrived on a key. `tests/matchRules.test.ts` pins the order and
the mutual exclusion; `scripts/e2e-venues.mjs` drives both sides of that divergence.

**A duel has exactly one winner, and a snapshot claiming two is refused rather than repaired.**
`isWinner` is `mine > theirs`, so a level score is false for BOTH seats — and `applyMatchSync`
clamped the two scores independently and decided on `>= cap ||`, so one `match_sync` of
[999, 999] became [cap, cap] and filed a real ranked LOSS against each player: two red
down-arrows, two rating losses, two loss rows, while each phone's own `score_update` showed
them both VICTORY. The whole snapshot is refused at the untrusted-peer boundary, before the
revision is bumped; `recordRoomMatch` records nothing on a level score behind it; and the REST
cross-check no longer overwrites a decided client claim from an undecided room, which was a
second and likelier route to the same two red arrows — in a P2P duel the winner's POST can
legitimately outrun the deciding sync. `tests/room.test.ts` holds the boundary and
`tests/duelRecord.test.ts` holds the outcome, which is a different assertion: a
`recordRoomMatch` that still ties passes the first and fails the second.

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

**No state the app can reach may have a destructive action as its only way out.** `released`
did: a full-screen wall whose single button minted a new device identity, leaving the account
behind reachable by nobody and its username unclaimable forever. A player follows an invitation
link into a browser that is not the one holding their account, restores there, comes back, and
presses the only thing offered. `tests/accountRecovery.test.ts` pins the way back — a released
device may restore with the account's own recovery code, and the release row survives a reset
so an abandoned account stays traceable. The matching browser assertions are in
`scripts/e2e-invite.mjs`.

**Onboarding ends on the sign-in code.** It is the only way back into an account from a
browser the current one cannot reach, so a player who was never shown it does not have it.
Every browser suite's onboarding helper clicks through that step; `e2e-profiles` is where it is
pinned rather than tolerated — the step appears, shows a well-formed code, and it is the
account's own.

**One account, one live holder — however many browsers belong to it.** Signing in links a
browser to an account rather than transferring it away, so a player can reach their account from
any browser on their phone. That must never become two of them playing at once:
`seatStillHoldsAccount` and the WS upgrade both have to know about links, not just tombstones.
`tests/deviceSession.test.ts` caught exactly that regression once already — the eviction silently
stopped working because a linked device's row no longer exists under its own id.

**One page load mints exactly one device identity.** The device cookie is established by the
document navigation, not by whichever `/api` call lands first — concurrent cookieless calls
each mint their own, which at phone latency was three per load, and a player who onboarded
inside that window had their username locked to an identity the cookie was about to stop
being. `tests/accountRecovery.test.ts` pins the navigation; `tests/sessionMint.test.ts` pins
that a session read never overlaps a mint.

**One tab closing may not sign another out.** `phong_session` is an ORIGIN cookie, so two tabs
present the same value and the server cannot tell them apart; `POST /api/session/end` therefore
carries the session id the page was actually given and ends nothing else.

**The device gate reads the platform, never the window.** `tests/device.test.ts` scans
`src/device.ts` for viewport reads. A source check, because the failure mode is somebody
*adding* one for a plausible reason, and no fixture can catch a signal that is not in
`DeviceSignals` yet.

**A user-facing string ships in all seven locales.** `tests/i18n.test.ts` pins parity, no dead
keys, and no missing keys — note the second rule makes a test a poor place to name a key.

**An assertion on a DIFFERENCE needs a bigger sample than one on a value.** The AI rolls its
reads per rally, so a measured return rate is a sample and subtracting two of them adds both
their noise. The ladder-spread check flaked at roughly 3 runs in 400 until its sample was
tripled and its threshold moved below the tail rather than beside the mean — it surfaced as
`expected 0.19999999999999996 to be greater than 0.2` on a docs-only PR. Measure the
distribution before picking a bound; do not tune it until the red goes away.

**A rally streak belongs to one player, and only their own miss ends it.** It carries across
points and across matches, so the run is stored per mode rather than kept in a component.
The rule is written once and shared: `server/room.ts` for the relay, imported wholesale by
the P2P replica; `src/game/streaks.ts` for the client, which is the only authority in a solo
match. Pinned in `tests/room.test.ts`, `tests/streaks.test.ts`, `tests/p2pParity.test.ts` and
— the whole chain through a real server — `tests/duelRecord.test.ts`.

**Nothing is ever paid twice for one carried run.** Because a streak survives the match it
was built in, a match's peak is not a measure of what that match did, and paying on it makes
a farm out of simply not missing — at its worst, opening the Practice Wall on a carried run
and leaving without touching the ball. So every reward reads the from-zero figure
(`earnedStreak`/`earnedBests`) while the career best, the mode best and the achievements read
the true peak. Each half is asserted separately, because a test that only checks the peak
passes on the bug: `tests/streaks.test.ts` and `tests/room.test.ts` hold the client and relay
counters apart, `tests/db.test.ts` holds that a carried run is not paid for twice, and
`scripts/e2e-rules.mjs` closes the practice farm through a real server.

**Copy that quotes a threshold is checked against the threshold.** Requirement text is free
text sitting beside the structured fields it describes, and it drifts off them silently. It
first bit on a theme's unlock line, where the rally rescale moved the fields and left the copy
asking for a 10-hit rally to open something that opens at 7; `tests/themes.test.ts` held the
rule until the cosmetics rework deleted that file along with the `description` field it read,
and this paragraph went on claiming a suite that was not there. It lives in
`tests/achievements.test.ts` now, where the same failure had already happened twice over. A
gated rung's description is the ONLY channel its gate has — nothing in the app renders an
`AchievementGate`, and the tree draws `Requires {parent}`, which for a rung whose parent is
already earned names something with a green tick beside it — and five of them stated no gate at
all. The shutout family said "without conceding a point" while the code also demanded
`SHUTOUT_MIN_POINTS`, so at first-to-3, where the match caps at 3, the requirement was
unsatisfiable and unstated at once. So: every `gate` names its level or tier in its own
description, and every description that depends on the shutout floor quotes it. Rewording to
dodge it is not a fix; the numbers are the point.

**A rung that unlocks something is a win count, and it is never hidden.** The AI ladder is
walked, so each step has to be both reachable by playing the rung below and legible before it
is earned. `cyber_10` opens Chaos and satisfied neither: it hung off `cyber_shutout`, a hidden
clean-sheet feat that no first-to-3 match can produce, and was itself hidden while the solo room
list printed its title beside the locked room. Two tests passed throughout and neither could
have failed — the reachability walk appends ids to a list rather than playing for them, and the
"no dead ends" test asserted that `unlockedKeys(ancestorsOf(id).concat(id))` contained
`UNLOCKS[id]`, the entry it had just put there. **A test that cannot fail is worse than an
absent one**, because it reads as coverage. `tests/achievements.test.ts` now walks the whole
ladder to Chaos through real `recordMatch` calls with a point conceded in every match, so a feat
put back on the path goes red; the vacuous assertion is repaired against a stated `EARNED_ON`
map; and no id in `UNLOCKS` may be `hidden`.

**A locked rung states its requirement, and `#room-{id}` stays on the disabled button.** The row
can only ever show the gating achievement's TITLE — `Machine Ender` is a trophy name, not
something to act on — so the reveal is a `LockBadge` overlay tapped for that achievement's own
description. The overlay is `absolute inset-0`, which means the button it covers must keep its
identity: `scripts/e2e-venues.mjs` reads `data-locked` off `#room-ai_pro` and
`scripts/e2e-achievements.mjs` reads `el.disabled`, and **`el.disabled` on a `<div>` is
`undefined`** — so an id that drifted onto the overlay's wrapper would make every "should be
locked" assertion in that second suite pass vacuously, which is the same hazard as the vacuous
`UNLOCKS` assertion above wearing different clothes. `e2e-venues` section 4 asserts the tag's
`disabled` is `=== true` rather than truthy, that the tap opens `#unlock-hint-sheet` and NOT
`#prematch-modal`, and that `#unlock-hint-desc` carries a digit — a non-empty check passes on a
bare trophy name, which is the bug this replaced. The digit is tested against the DESCRIPTION
and not the sheet, and that distinction is the invariant above applied to this suite's own
assertion: the reward chip renders `+800 XP`, so a sheet-wide digit test is satisfied by the
reward alone and would stay green with the requirement gone.

**A dealt task is one the player can play.** `elite_cyber_3` asks for three Cyber wins and pays
a permanent theme, and was dealt to players who had not opened Cyber, against one elite reroll a
day. `tests/missions.test.ts` sweeps a month of deals rather than one day — the hand comes from
a seeded shuffle of `(playerId, dayKey)`, so a single day proves nothing about a pool that still
holds the task — and asserts the opposite leg too, that a player who HAS climbed is still dealt
it, since a filter that removed everything would pass the first check alone.

**A rename is a rule about every table that keys off the name.** `moveAccount` renames
`players.id`, so any table keyed on it must move in the same transaction or be orphaned —
`tests/identity.test.ts` asserts the per-mode rows arrive and that nothing is left behind
under the old id. Add a playerId-keyed table and that suite is where it has to be claimed.

**A delete is that rule with nowhere for a missed row to go.** `deleteAccount` walks a
hand-written list, so `tests/identity.test.ts` reads the LIVE schema and fails when a
`playerId`-keyed table exists that `PLAYER_KEYED_TABLES` does not name — a source list checked
against the thing it claims to describe, because the failure mode is somebody adding a table
for a good reason and never looking here. The row that bites is `device_links`: outliving what
it points at, it resolves as `superseded`, which is a full-screen wall about an account that
exists nowhere. `matches` is the deliberate exception — a duel files one row per seat, so the
opponent's copy is theirs and keeps the game with the pointers scrubbed rather than losing it.
`tests/accountDeletion.test.ts` holds the HTTP seam (the username checked exactly, the session
spent, the browser back as a NEW player, the relay socket closed); `scripts/e2e-delete.mjs`
holds the flow, which is not a rule and cannot be: the section reachable at the bottom of a
scrolling sheet, a case-flipped name refused, exactly `DELETE` and `BACK` on the last step, and
`BACK` landing on the open Settings panel with the account intact.

**When a browser cannot state a rule directly, look for the observable it CAN state.** The
run-carry rules need a real miss to distinguish, which a scripted paddle cannot be relied on
to produce — but "did the page tell the server" does not. `scripts/e2e-streak.mjs` knocks the
stored run out of step through the real route, presses Reset, and asserts the page put it
back; that fails outright when the report is removed, where an assertion about the streak
readout alone passes on the bug. Reach for the side effect before loosening the assertion.

**Where two sources can answer the same question, the precedence is a rule too.** The run a
new match opens on has two: the profile (which survives a reload) and what this page last saw
its own match end on (which is fresher, because Play Again fires long before the match POST
returns). That precedence lives in `src/game/streaks.ts` as `CarryStore`, not in `App.tsx`,
for the reason below — and it is asserted in both directions, since a test that only checks
the fallback passes on the bug.

**Asserting a game RULE through a browser is a last resort, not a first one.** The streak
rule was attempted that way and abandoned: it needs a real solo rally, a scripted paddle
cannot be relied on to produce one (a first-to-5 against Rookie goes 5-0 often enough to fail
the suite for a reason that is not the rule), and the fix was to move the rule somewhere it
could be stated — `src/game/streaks.ts` — rather than to loosen the assertion until it
passed. `scripts/e2e-streak.mjs` keeps only what a browser can say without luck.

**Some rules this environment cannot observe AT ALL, and the suite says so rather than
implying otherwise.** `touch-action` is enforced by the compositor's hit-test and CDP's
`Input.dispatchTouchEvent` injects downstream of it: a three-case probe — control, nested,
strict `none` — built precisely so a null result could not be mistaken for a broken harness,
scrolled a `touch-action: none` element 348px, and `Input.synthesizeScrollGesture` moved a
provably scrollable element zero pixels in either direction. So `scripts/e2e-menu.mjs` proves
the JS axis lock and the wiring, and NOT that the browser leaves the horizontal gesture alone;
its header says which, because a leg asserting "a vertical drag does not page" otherwise passes
VACUOUSLY — the hazard `scripts/e2e-rules.mjs` already warns about for a selector matching
nothing, one layer down. The thresholds live in `tests/gestures.test.ts`, the one layer that
can state them, and are deliberately not restated in the browser.

**A pointer gesture proven with a mouse is not proven.** Both defects in the menu pager were
invisible to `page.mouse` and fatal under a finger: `getCoalescedEvents()` returns `[]` rather
than nullish when nothing coalesced, so a `?? [native]` fallback never fires and the axis never
locks; and `setPointerCapture` on a touch pointer TRANSFERS the implicit capture it already
holds, firing a bubbling `lostpointercapture` that aborts the drag being claimed. Every mouse
leg passed through both. `scripts/e2e-menu.mjs` drives its cancel and vertical legs through CDP
touch for that reason — and its cancel leg asserts `data-dragging="true"` BEFORE cancelling,
because without that it passed with `onPointerCancel` deleted outright: `release` returns early
for a pointer it does not own, so a cancel aimed at the wrong id proves nothing. Verified the
way §6 asks, by breaking it and watching `FAIL: a cancelled drag committed to leaderboard`.

**A test bound on a SAMPLED value is set from the sample, not from the rule.** The AI rolls
its reads per rally, so every return rate is a draw. `tests/spin.test.ts` carried a `< 0.9`
bound chosen when the competence clamp was 0.66; raising it to 0.78 moved the population up
against that bound, and the suite passed locally and failed on CI reading `expected 0.9 to be
less than 0.9`. Two things came out of that. `tests/physics.test.ts` now measures each rung
ONCE at the larger sample and shares the result across every rule that reads it — cheaper than
re-sampling per assertion, and more coherent, since the rules then talk about one measurement
rather than independent draws that can disagree. And the two suites deliberately carry
DIFFERENT bounds: `spin` drives an easier geometry (one shallow entry angle, where `physics`
samples a fast bucket and a sharply angled one), so the same AI returns more balls there —
0.873-0.968 against 0.880-0.906 at the same mu. The binding ceiling rule lives beside the
harder sample; the easier one only catches a literal wall. Copying a bound between them would
be reading one distribution's number off another's.

**A private table must never appear in the listing.** `GET /api/rooms/:venue/tables` is an
unauthenticated read of live room state, so `visibility` is not a display preference — it is
the whole boundary protecting today's invite-code tables, whose 4-letter codes would otherwise
be harvestable by anyone who can call the endpoint. `tests/tableBrowser.test.ts` asserts the
absence across every venue, and was verified the way TESTING.md §6 asks: by deleting the
filter and watching it go red.

**The queue's band is a promise AND an expiry, and both halves need pinning.**
`tests/matchmaking.test.ts` holds the promise — a coin flip for 30 seconds, the brief's own
40-60 for the minute after — and the fact that it eventually gives, because a symmetric
`winProbability` means a strict band leaves a lone queuer in a queue nobody ever leaves. The
one test that matters most is the pair: the same two candidates are REFUSED early and PAIRED
late, which is the whole trade in one assertion. Two more guard the shape rather than the
numbers: the band only ever widens as the wait grows (a band that narrowed would strand
somebody who had already waited), and it never inverts. `findPair` judges on the more-waited
of the two on purpose — judging on the newcomer's own tight band would let a fresh arrival
veto the very pairing the wait was widening toward — and `tests/queue.test.ts` proves the rest
on a real relay: two sockets ask for a game and reach one court with no ready tap and no start
button, on terms `set_room_config` then refuses to change. That refusal is not a nicety: it is
what makes skipping the handshake sound, since queueing is the consent and consent given to
fixed terms does not need re-asking.

**A watcher must never move a player's record, and a symmetric fixture cannot tell.**
`tests/spectators.test.ts` holds three rules that are each one line away from a real loss on
somebody's profile. First, the fan-out's frames: `watched_paddle`/`watched_ball` are RAW,
because the watcher is drawing that player's own court in that player's own coordinates, while
`opponent_paddle` is pre-mirrored — and a paddle at 0.5 passes either way, so every position in
that suite is asymmetric (0.17, 0.31, 0.22/0.71). Second, `vacateSeat`'s spectator branch is an
early return placed BEFORE the abandon computation: `bothSeated && inPlay && !matchOver &&
currentPlayerId` is true of a watcher closing a tab mid-rally, so folded in as another `&&` it
writes a real ranked LOSS to a player who did nothing. Third, every gameplay message is refused
by `playerIndex() !== null` — a guard that was already there — and `match_sync` is the one that
matters, since it can decide a match outright. The second and third were verified the way §6
asks: by breaking the guard (folding the branch in; letting `playerIndex()` return a watching
slot) and watching the suite go red.

**A bracket the menu draws is a bracket the server enforces.** The menu is the client, so
`roomEntryVerdict` in `src/venues.ts` is written once and asked by both — the same reasoning
that put `DIFFICULTY_LOCKED` behind `/api/match/record` rather than trusting the picker.
`tests/venues.test.ts` pins the shape of that predicate, including the two cases a bracket
gets wrong on its own: a ceiling as well as a floor (a Legend must not drop into the
new-player room), and an UNPLACED player — who is below every floor and must not *also* be
refused by a ceiling, or they would have nowhere to play. It also asserts the property that
matters more than any individual bound: over every tier and a spread of levels, **some** PvP
room is always open. A ladder with a hole in it is unrecoverable.

**Solo must never be the cheap way up.** Two rules hold it, and both are pinned rather than
remembered. The per-rung `SOLO_MU_CAPS` are DATA, each sitting under a tier floor, because the
`anchor + AI_ADAPT_BAND` formula they replaced collapses at five rungs — it hands Elite, Cyber
and Chaos one identical ceiling, so farming the Master-tier rung would reach Legend as fast as
farming the hardest thing in the game; `tests/rating.test.ts` pins every value and the
below-the-next-floor property. And solo XP carries momentum and fatigue, so a win streak is
what pays rather than volume; `tests/xp.test.ts` pins the shape (ramp, diminishing increments,
the constant cap, a loss on a long run paying more than an early one, harder-always-pays-more)
and `tests/db.test.ts` pins the plumbing — the streak read BEFORE the match's own bump, and the
day tally riding recordMatch's transaction and its idempotency.

**A refetch never blanks what is already on screen.** `isLoading && list.length === 0`, never a
bare `isLoading` — the rule `MatchHistoryList` carried alone until the pager made it load-bearing
for the other two. The menu's window mounts three pages, so a page that stays mounted refetches
whenever it becomes current, and against a bare `isLoading` that swapped the board for a spinner
on *every* arrival: staleness traded for a flash, which is the worse half of the trade. It costs
nothing to hold and it fixes the category and bots toggles flashing too. `scripts/e2e-menu.mjs`
holds it — one leg counts `/api/leaderboard` calls across two separate arrivals on a page that
never unmounts, and the next holds the response open with `page.route` and asserts the rows are
still in the DOM while the request is in flight. That second leg is the one to read before
copying: intercepting proves the request LEFT, not that React has painted the loading state, and
sampled immediately it reads the pre-refresh paint and goes green however the branch is written.
It was measured exactly that way. The wait after interception is what makes it a test.

**A progression meter is not fresh on arrival, and only the fast layer can say so.** A page
that leaves the pager's three-slot window unmounts and resets, which is right for a page and
wrong for a meter: a bar that refills from empty on the way back from a match reads as the XP
being earned a second time. Both meters therefore live in the header, outside `#menu-pager`,
and `ProgressBar`'s `resumeKey` carries the remaining case — `AnimatePresence` unmounting the
whole menu for the length of a match. `scripts/e2e-menu.mjs` holds the STRUCTURE (both bars in
the header and not inside the pager; both still in the document while PLAY is unmounted; the
header still inside the `pt-safe-bar` offset the toast stack clears it by, measured off the
utility rather than hardcoded). It cannot hold the RESUME: no browser suite plays a match and
samples a meter on the way back, so `tests/meterMemory.test.ts` is the only place the store's
rules are stated — that an unseen band resumes empty, that a level-up or a promotion IS a new
band, and that two keys cannot write each other. The manual check that proved it is worth
repeating rather than automating badly: sample the XP fill's `scaleX` on the first frame back
from a match against a mission bar's, which has no `resumeKey` — same mount, same frame, same
primitive, and the only difference is the store. Measured 0.66 against 0.00.

**The header's height is a budget with nothing in it.** `pt-safe-bar` is `pt-safe + 48px` and
the menu header is exactly that, so anything added to the capsule silently puts every toast
over the bar the offset exists to clear — no build error, no red test, nothing to see but a
notice covering the controls it is about. The `e2e-menu` leg above is the only thing that
catches it. What that leg does NOT cover, stated so nobody reads more into a green run: its
player is UNRANKED with a short username, so its overflow check never meets "Cyber Overlord"
(128px at `text-2xs`) or a 16-character name — the case the capsule's `max-w` and `truncate`
exist for, and one to re-measure by hand when that row changes.

**The apex number must be the number the board prints.** Cyber Overlord reads as a ladder
position (`#1`..`#100`) rather than a name, and `getLeaderboard`'s `rank` is not a count — it is
a dense JS counter over a filtered, ordered scan. So a badge computed any other way disagrees
with the Ranks page for the same player, which is worse than no badge, and only one assertion
catches it: `tests/ladderPosition.test.ts` reads both and compares them player for player. The
fixture puts two bots ABOVE the apex on purpose, because bots are pre-placed and a count that
forgets them pushes every human down by the whole roster; it seats a rated player with no
ranked game and an uninitialized one, each of which would take #1 from a gate that read the
rating alone; and it seats one four games into placement rated above every Overlord, because
the board lists that player and sorts them UNDER the placed rows, so a count on rating alone
put every Overlord one position lower than the Ranks page did. A separate leg records a LOSS
and checks the returned position against the board, since `recordMatch` reports before it
persists and the stale higher self was being counted as standing above the player. Each of
those was verified by reverting the fix and watching the leg go red — a fixture this dense is
exactly where a vacuous pass hides. Reaching Overlord is still `rankMu >= 37` and nothing else — the headcount is a
display, never a definition — so no test here may make one player's tier depend on another's.

**A duel moves two of them, so both seats have to be numbered against the ladder they BOTH
left behind.** `recordRoomMatch` writes seat 0 first, so a position derived inside that loop
answers for a table where the opponent still holds their pre-match row — and it is wrong in
exactly one band, when the winner's new rating lands between the loser's new one and the
loser's old one. Then both seats are told they are #2 and the board shows nobody at #1.
`tests/duelRecord.test.ts` plays it through the real relay, seeding two Overlords straight into
the database because μ37 is only ever reached through PvP and manufacturing one otherwise
means dozens of duels for one assertion. Three things about that fixture are load-bearing and
all three were learned by watching it pass against a broken server. The winner must be SEAT 0,
since the loser's stale row is only ever too high and a stale read for seat 1 cannot differ.
The sigmas must be ASYMMETRIC — a confident winner and an uncertain loser — or the winner
clears the loser's old rating outright and the band is empty. And the band itself is asserted
rather than assumed, because a retune of the rank step would slide the fixture out of it and
the test would go quiet instead of red.

**A field derived from the whole table must not ride a profile onto a hot path.** The count is
gated on the top rung, and that gate is about correctness rather than cost: `queueCandidate` runs
for every queued entry N+1 times per two-second sweep, and a queued Overlord is precisely the
account the gate does not spare. So the relay pairs and predicts on `db.matchmakingRating` — two
floats, one statement — and the suite pins that it reports exactly what `getProfile` would, which
is what makes the substitution faithful rather than merely faster. That it IS faster is not
something an assertion states better than the absent call does; `queue` and `duel` cover that
pairing still works.

**The capsule is the one place two meters stack, and neither may follow the cosmetic.** The rank
meter sits directly over the XP meter, 4px each, and `--color-xp` is the token contract's fixed
level-and-XP gold that the `LV` chip beside them also wears. Two answers failed. `warn` is two
shades of one amber with `xp` — 0.044 apart in OKLab, against the 0.08 `tests/cosmetics.test.ts`
asks of two whole themes. `accent` is PER-COSMETIC while `xp` is fixed, so a gold-accented theme
put them back on one colour whatever the distance was elsewhere. **That is why the assertion is
uniformity and not a floor**: a distance floor is exactly what `accent` passed on seventeen
cosmetics and failed on three, so the suite asserts that `cosmeticVars` returns the SAME value on
every cosmetic of a mode, then checks the ramp's stops against `xp`, against each other, and
against `win`/`loss`/`warn`/`rank-steady` so a meter can never be read as a verdict.
`tests/ladderTone.test.ts` holds the stop arithmetic, including that a non-finite fill reads as
empty rather than as no stop at all — the failure there is an unpainted, invisible bar, not a
visibly wrong one.

**Neither of those can see which tone the component actually passes**, because it lives in a
`.tsx` and importing it would drag React and `motion/react` into a `node` suite. Reverting
`RankBadge` to `tone="accent"` reddens nothing in the fast layer — verified. So `e2e-cosmetics`
equips `retro-crt`, the gold-accented free theme, and asserts the shell accent moved while the
meter's computed fill did not; and `e2e-menu` asserts that fill is painted at all, which is the
other browser-only failure: if Tailwind stops generating `bg-ladder-mid` from the token, the bar
renders with no background and every fast test still passes.

**A suite that asserts old behaviour is deleted rather than read.** When a rule changes, change
its suite in the same commit. The five-rung ladder deleted one outright: `physics` had a test
pinning `competenceForMu` bit-for-bit at and above the old Cyber anchor, written when the floor
was raised on the explicit condition that the ceiling did not move. Raising the ceiling IS this
change, so the test was not updated but removed, and the hard bound it protected (`no
difficulty may ever return ≥88%`) restated at the new ceiling as `≥93%`.

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
  CDP is the only route to two fingers at once. `scripts/e2e-rules.mjs` needs it too now, for
  the serving joystick: one thumb aims while the other steers, and there is no way to state
  that without two fingers. It reads the paddle off `#telemetry-paddle-pos` rather than by
  sampling pixels — the telemetry panel is the one place in the DOM that reports where the
  paddle is.
- When sampling, collect **runs** of matching pixels and discard short ones. The court is drawn
  with a hairline frame in the same cyan as P1's paddle; taking the first and last matching
  pixel puts every reading at dead centre regardless of where the paddle is.
