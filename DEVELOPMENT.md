# Developing Phong

## Setup

```bash
nvm use          # Node 22 (.nvmrc)
npm install
npm run dev      # http://localhost:3000
```

One process runs everything: `tsx watch server.ts` starts Express, attaches the `ws` WebSocket server at `/ws`, and mounts Vite as middleware for hot reload. Client and server share one origin and one port in dev and prod alike — there is no CORS configuration and no separate API base URL anywhere in the client.

## Fast multiplayer iteration

You do not need two devices for most multiplayer work:

- **Two browser windows** against `npm run dev`: create a room in one, join in the other. This exercises the real server path (room codes, paddle relay, net transform, scoring, rematch). With the lobby's "Direct connect (P2P)" toggle on (default), the two windows will also negotiate a real WebRTC DataChannel — watch the `P2P`/`RELAY` badge top-right.
- **Dual Court Simulator** (split mode in-app): both halves on one screen, no server involved — fastest way to iterate on physics and rendering.
- **Load**: `node scripts/load-test.mjs 10 20` runs 10 concurrent scripted matches against a local server and reports loss/latency.
- **Browser E2E**: `scripts/e2e-gameplay.mjs` drives two real Chromium pages through the full flow — room create/join, P2P DataChannel handshake, and two played points including the serve handoff to the player who missed. Needs `npm i --no-save playwright-core` and `CHROMIUM_PATH` pointing at a Chromium binary; target with `E2E_URL` (default `http://localhost:3000`). Run it after touching the serve/score/transport logic.

Note: desktop browsers render the game inside a centered phone frame automatically (no blocker) — resize or zoom freely; real phones in landscape get a rotate prompt.

## Testing on real phones

The two-phone mode leans on browser APIs that only exist in a **secure context**: fullscreen, screen-orientation lock, and vibration. Serving plain HTTP over your LAN (`vite --host`-style) will *silently* degrade exactly the features this game depends on — things just won't fire, with no errors you'd notice.

Use an HTTPS tunnel instead:

```bash
# either
cloudflared tunnel --url http://localhost:3000
# or
ngrok http 3000
```

Open the printed `https://` URL on both phones. WebSockets upgrade over the same tunnel (the client derives `wss://` from `window.location`), and the QR code in the lobby encodes the full room link, so the second phone just scans and lands in the room.

### Driving the game from a laptop

The app is gated to Android and iOS **phones** (`src/device.ts`): a desktop or tablet gets a QR code, not a court. Two ways past it while developing:

```bash
npm run dev            # then open http://localhost:3000/?desktop=1
```

`?desktop=1` works **only** under `import.meta.env.DEV`, so the branch is compiled out of a production bundle entirely — there is no flag to find on the deployed site. For a production build, use your browser's device emulation (a phone profile sets the user agent and touch points, which is all the gate reads) or a real phone over the tunnel above.

Two other things to expect on a dev laptop:

- **Sessions.** An account is held by one device at a time. Opening the game in a second tab or a second browser profile takes the account over, and the first one shows the "playing elsewhere" wall. That is the feature, not a bug — tap through on whichever one you want to drive.
- **Build ids.** Every restart of `npm run dev` mints a new build id when there is no `dist/index.html` to hash, which retires sessions from the previous run and reloads open tabs. Run `npm run build` once and the id becomes the digest of the built client, stable until you rebuild.

Tailwind note: this project uses **Tailwind CSS 4**, which is CSS-first — configuration lives in `src/index.css` via `@import "tailwindcss"`, and there is deliberately no `tailwind.config.js`. Follow Tailwind 4 docs, not v3 tutorials.

## Tests

```bash
npm test
```

Vitest covers the invariants that break silently:

- `tests/transform.test.ts` — the cross-net transform (`server/transform.ts`): mirror/negate/abs properties, court clamping, and that crossing twice is the identity on interior points.
- `tests/physics.test.ts` — paddle collision: offset clamping, the 62° rebound ceiling, the 4% speed-up capped at `MAX_BALL_SPEED`, no hits for upward-moving balls.
- `tests/db.test.ts` — the JSON store against a temp `DATA_DIR`: profile creation, multiplayer ELO deltas (+24 / −16) and the 800 floor, achievement unlock idempotency, 50-write bursts, leaderboard ordering.

`npm run lint` is a strict `tsc --noEmit` over the whole repo (client, server, tests). CI runs lint + test + build on every PR.

## Where things live

| Area | File(s) |
|---|---|
| Game loop, all client state, WS message handling | `src/App.tsx` |
| Ball/paddle physics + AI opponent | `src/game/physics.ts` |
| Court renderer (canvas, particles, shake) | `src/components/CourtCanvas.tsx` |
| WebSocket relay + REST API | `server.ts` |
| Cross-net transform (shared by tests) | `server/transform.ts` |
| Profiles, ELO, achievements, persistence | `server/db.ts` |
| Protocol message types (client ⇄ server) | `src/types.ts` (`WSClientMessage` / `WSServerMessage`) |

When you add or change a WebSocket message, update `WSClientMessage`/`WSServerMessage` in `src/types.ts` first — both sides import their shapes from there.
