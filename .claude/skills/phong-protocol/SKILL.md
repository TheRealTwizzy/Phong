---
name: phong-protocol
description: >-
  How to add or change a WebSocket message in Phong without breaking P2P duels. Use this
  whenever the work touches src/types.ts WSClientMessage/WSServerMessage, the relay's message
  handling in server.ts, the DataChannel replica in src/net/p2p.ts, or App.tsx's socket
  handlers — and whenever the user asks to add a message, a new gameplay event, a lobby
  action, a spectator frame or anything the two phones have to agree about. The relay and the
  replica are two implementations of one protocol and they have already drifted once, so treat
  any protocol edit as a multi-file change even when it looks like one line.
---

# Changing the protocol

A private duel does not necessarily go through the server. When the WebRTC DataChannels open,
`src/net/p2p.ts` becomes the game: it replicates the room's rules — score, serve rotation,
rematch votes, the cross-net transform — and the relay hears nothing until `match_sync`. So
the protocol has **two implementations**, and the cost of them disagreeing is not a crash.
It is silent and it reaches players: every P2P duel was once recorded 0-0 with **both**
players filing a loss, and winning one never completed "win a match".

## The order to touch things

**1. `src/types.ts` first.** Convention §4: the message shapes are the source of truth and
both sides import them. Add the member to `WSClientMessage` or `WSServerMessage`. Doing this
first means the compiler tells you where the gaps are instead of you remembering.

**2. `server.ts` — the relay.** Dispatch is `msg.type === 'x'`. Ask, before writing the
handler:

- **Does the sender hold a seat that may send this?** `playerIndex()` returns null for a
  spectator, and that one guard is what already closes `paddle_move`, `point_scored`,
  `start_match`, `set_room_config` and `match_sync` to watchers for free. A new gameplay
  message inherits it only if it goes through the same check.
- **Is it host-only?** `start_match` and `set_room_config` are refused to anyone but seat 0.
- **Can it decide a match?** Then it must be idempotent by `matchKey`, and it must not trust
  a client's numbers where the room owns them.

**3. `src/net/p2p.ts` — the replica.** Two halves, and both are asserted:
`handlePeerMessage`'s `case 'x'` (what it accepts) and `sendGame` (what it transmits). A
message accepted but never sent can only ever arrive over the relay — the same drift pointing
the other way.

**4. `src/App.tsx`.** A server message App ignores is a feature that silently does nothing.

**5. The tests, in the same commit.**

## The one decision that matters: is it gameplay?

`tests/protocolParity.test.ts` holds a list, `GAMEPLAY_MESSAGES`, and asserts the replica
handles **exactly** it — not a subset, not a superset:

```
ball_cross_net · ball_pos · paddle_move · point_scored · quick_chat · rematch_request
```

Everything else — joining, readying, starting, config, `rtc_signal`, `ping`, `match_sync` —
stays on the WebSocket even during a P2P match, and the replica must **not** answer it. This
is a security property, not tidiness: a peer that could answer `set_room_config` would be a
peer that could rewrite the match its opponent is playing, with nothing on the server able to
see it. So when you add a message, decide deliberately which side of that line it falls on,
and put it in the list or leave it out **on purpose**.

Three more things that suite pins, worth knowing before you write code that trips them:

- Every gameplay message must also be a relay message. P2P is an optimisation over the relay,
  never a separate protocol.
- Nothing branches on a type the union does not declare — a relay branch on an unsendable type
  is dead code, a client branch on one is a typo that never fires.
- `duel:` is never string-built by hand anywhere. `duelMatchKey()` is the idempotency key
  behind "every match is recorded once"; a hand-rolled one is the copy that drifts, and the
  match gets paid twice.

## Coerce every field you read off the wire

The relay reads client JSON, so **a field is whatever the sender typed until you make it a
number.** `Math.abs(undefined)`, `-'x'` and `1 - 'abc'` are all `NaN`, and `NaN` does not throw
— it propagates into somebody else's court and makes every comparison there false.

`paddle_move` was the one gameplay message forwarded raw, fifteen lines above `ball_pos`, which
clamps properly. `transformBallForOpponent` coerced `x` and let the four velocity and spin
fields through. A single `{ vy: 'x' }` froze the receiving player's point permanently — no
bounce, no crossing, no score, and auto-serve never arms because `isServing` is false — so
their only way out was quitting, which is recorded as an abandon and a real ranked loss.

When you add a message:

- **Clamp position-like fields to `[0,1]`** and velocity-like fields to a sanity bound. The
  bound is protection from a hostile payload, not a game rule — the rules-aware clamp belongs
  on the receiving client.
- **Gate anything that scores, counts or records on `room.matchOver`.** `point_scored` and
  `ball_cross_net` were not, and post-whistle crossings wrote a permanent `highestRally`
  through `startMatchStreaks` into `recordRoomMatch`.
- **Ask what this message is the ACCOUNT of, and refuse it where that thing cannot exist.**
  `match_sync` is a replica's report, and a replica only exists once a DataChannel was
  negotiated — so it is refused on a table where no `rtc_signal` was ever relayed
  (`room.p2pOffered`). Without that, one frame on a relayed table decided a ranked duel.
- **Never bound a snapshot by arithmetic instead.** Step-limiting `match_sync`'s score looked
  like the cheaper guard and is wrong: a snapshot is absolute, applied as a maximum by design,
  because a P2P relay never sees the intervening points. `tests/room.test.ts` fails loudly if
  you try.

## Verifying

```bash
npx vitest run tests/protocolParity.test.ts tests/p2pParity.test.ts
```

`protocolParity` reads the source and fails the moment a message exists on one side only —
cheap, and it fails at the moment the drift is free to fix. `p2pParity` runs one identical
script through both transports and compares what each player is told, which is the part a
source scan cannot see.

Then the flows, which are where a real DataChannel actually comes up:

```bash
npm run build && node scripts/e2e-run.mjs gameplay duel
```

**Prove your parity test can fail.** `p2pParity` was checked by flipping the replica's serve
rotation. A differential test that cannot go red is worse than none, because it reads as
coverage.
