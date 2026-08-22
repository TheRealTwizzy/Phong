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
- **Browser E2E**: `npm run test:e2e` runs every `scripts/e2e-*.mjs` suite — profiles, gameplay, rating, rules, achievements, elite, duel, invite, lobby, eject. `scripts/e2e-run.mjs` gives each one a free port, a throwaway `DATA_DIR` and its own `node dist/server.cjs`, because they mint profiles and read the leaderboard and would otherwise decide each other's assertions. Run `npm run build` first (the suites target the production entry, not the dev server), then `npm run test:e2e` for the lot or `npm run test:e2e duel invite` for a couple; `--list` names them. Chromium comes from `CHROMIUM_PATH`, else a Playwright download (`npx playwright-core install chromium`), else a system Chrome. The same job runs on every PR — see `.github/workflows/ci.yml`.

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
