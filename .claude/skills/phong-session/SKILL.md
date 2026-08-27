---
name: phong-session
description: >-
  Phong's session and device-identity gates — which middleware a new route sits behind, and why
  a gameplay path needs the check in two places. Use this whenever you add or change a route in
  server.ts, touch requireActiveSession, blockReleasedDevice, requireRestorableSession or the WS
  upgrade, and whenever the user asks for a new endpoint, a new way to earn or spend, a sign-in
  or account-transfer path, or anything that reads a profile — and whenever accountRecovery,
  sessionMint, sessionWatch, deviceSession or staleBuild fails. The lazy mint in getProfile
  hands any id it does not recognise a brand-new account, so an ungated route does not fail
  loudly: it quietly issues a fresh profile to a device that was evicted, lets it play a whole
  match, and refuses the result at the final whistle.
---

# Adding a route, or a way in

Convention §8: **never widen what a device may do without a live session.** The device cookie
answers *who is this browser*; it cannot answer *is this browser still the one holding the
account*, and that gap was the reported exploit — a device whose account had been transferred
away was indistinguishable from one the server had never met, so it was issued a fresh profile
and allowed to play a whole match on it. Two devices, one account, two concurrent matches.

Several of these are counterintuitive, which is why they are written down rather than judged.

## The two gates, and which one a route needs

Both live in `server/auth.ts` and both are mounted in `server.ts`.

1. **`requireActiveSession` (`server/auth.ts:303`) — anything that spends, earns or changes.**
   `match/record`, `practice/record`, `missions/claim|reroll`, `profile/initialize|me|claim`,
   the avatar routes. If your route writes anything a player would be sad to lose or happy to
   gain twice, it goes here.
2. **`blockReleasedDevice` (`:325`) — anything that resolves a profile at all, including
   reads.** This is the one that is easy to skip because a read feels harmless. It is not: the
   lazy mint in `getProfile` is what a retired device reaches when nothing stops it, and being
   handed a new empty account is precisely how the exploit above began.
3. **`requireRestorableSession` (`:363`) — the way back, and only that.** It admits a
   *released* device so `POST /api/profile/claim` can bring an account home with its own
   recovery code. It grants nothing new — that device could already reach the same call by
   starting fresh first — it just stops the trip costing a device id and a release record.

## A gameplay path needs the check twice

**A new gameplay path needs the gate in `server.ts` and again at the WS upgrade.** Barred from
recording a solo match but not from opening a socket, an evicted device could still play a
duel — and the relay records a duel itself, from the score it owns, so the REST gate never sees
it. The upgrade resolves the device from the cookie header and refuses the socket outright.

Two more things hang off that, and both have already broken once:

- **Displacing a session closes the sockets it still holds** (`closeDisplacedSockets`). The
  upgrade check is a snapshot; without this a phone keeps scoring for the seconds until its
  next heartbeat.
- **`recordRoomMatch` re-checks each seat** with `seatStillHoldsAccount` (`server.ts:583`)
  rather than trusting the seat it was handed. That function had to learn about `device_links`
  when they arrived: a linked-but-not-holding device's row no longer exists under its own id,
  so "no owner" read as "not displaced" and eviction silently stopped working.

## What the client may not conclude for itself

`SessionGuard` is a wall, not a toast, because in these states nothing is recorded. It blocks
exactly `released`, `superseded` and `stale_build` — `BLOCKING_STATUSES` in
`src/net/session.ts:64`, enumerated so that adding a status has to be a decision about that
list.

- **`offline` is not an eviction.** A dropped heartbeat is a phone changing cells. Walling on
  it would take the game away from anyone in a lift.
- **`connecting`/`none` are not verdicts either.** They mean "we have not asked yet". Blocking
  on them put a network round trip in front of the first paint for every player on every load,
  and bought nothing: writes are gated server-side regardless.
- **`SESSION_STALE_BUILD` is never handled as "mint one and retry."** That is what
  `SESSION_REQUIRED` is for. Minting under the new build without reloading is exactly how an
  old bundle survives a deploy — the retry succeeds, the next heartbeat says `active`, and the
  client goes on speaking a protocol nobody serves.
- **A match refused as `DEVICE_RELEASED`/`SESSION_SUPERSEDED` is dropped, never queued.**
  Replaying it later credits whatever identity this browser ends up with for a match another
  account played. Every other failure keeps the match.

## Two rules about ordering and exits

**Never add a middleware order in which an `/api` call can be the first thing a browser does.**
`deviceIdentity` (`:85`) must run on the document navigation. Mounted on `/api` alone, the HTML
set no cookie and the booting client's concurrent calls each minted their own identity —
measured at three per page load at phone latency. A player who onboarded inside that window
locked their username to an identity the cookie was about to stop being, and their own name
came back taken, by themselves, seconds earlier.

**No state the app can reach may have a destructive action as its only way out.** The
`released` wall offered one button, "start as a new player", which minted a new device identity
and left the account behind reachable by nobody, its username unclaimable forever. A
full-screen wall with a single button is an instruction, not a choice.

## Verifying

```bash
npx vitest run tests/accountRecovery.test.ts tests/sessionMint.test.ts \
  tests/sessionWatch.test.ts tests/deviceSession.test.ts tests/staleBuild.test.ts
npm run build && node scripts/e2e-run.mjs invite eject
```

`tests/accountRecovery.test.ts` pins that the navigation sets exactly one cookie and a boot
burst carrying it mints none; `tests/deviceSession.test.ts` caught the eviction regression
above once already. When you add a gate, break it on purpose and watch the suite go red before
you trust it — a guard that cannot fail is not a guard, only a comment.
