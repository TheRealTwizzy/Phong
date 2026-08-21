# CLAUDE.md – Phong Project Guide

This document is the working guide to **Phong**, an arcade sports web app with a "blind half-court" mechanic and cross-device 2-phone multiplayer. It describes the code as it actually is — when the code and this file disagree, fix this file.

---

## 1. Project Overview & Core Concept

**Phong** reimagines Pong for mobile and desktop web. Each player sees only their own half of the court.

- **The Net Boundary**: the glowing top edge of the player's screen is the net.
- **Cross-Net Jump**: when the ball exits through the net, it leaves the player's screen and appears on the opponent's, travelling downward.
- **Opponent Radar**: a mini radar tracks the opponent's paddle and the ball while it is on their half.
- **Physical 2-Phone Duel**: two phones placed top-to-top, connected by a 4-letter room code over WebSockets; the ball physically transitions between screens.
- **Solo & Split**: an adaptive AI opponent (Rookie / Pro / Cyber / Chaos) and a split-screen Dual Court simulator on one device.

## 2. Tech Stack

- **Frontend**: React 19, TypeScript, Vite 6, Tailwind CSS 4 (CSS-first — configured in `src/index.css`, no `tailwind.config.js`), Motion (`motion/react`), Lucide React icons, Canvas Confetti.
- **Server**: Express 4 (`server.ts`) + **`ws`** for the WebSocket relay (no Socket.IO), Node 22. One process serves the client and the relay on one port, dev (Vite middleware) and prod (static `dist/`) alike. Runtime dependencies are only `express` + `ws`; everything else is dev tooling.
- **P2P mode**: private matches connect the two phones directly over **WebRTC DataChannels** (`src/net/p2p.ts`), with the relay as automatic fallback — see §5.
- **Audio**: procedural Web Audio API synthesis in `src/audio/soundEffects.ts` — zero audio assets.
- **Persistence**: **SQLite** via Node's built-in `node:sqlite` (no native deps) at `DATA_DIR/phong.db` (default `./data`), WAL mode, managed by `server/db.ts`. A legacy `game_database.json` in `DATA_DIR` is imported once on first boot. Client keeps a localStorage fallback for offline solo play.

## 3. Normalized Coordinate & Physics Model

All positions, velocities, and dimensions are normalized to `[0.0, 1.0]`.

```
                Opponent Court (remote / radar)
+-----------------------------------------------+  (opponent baseline y = 1.0)
|              [Opponent Paddle]                |
|                                               |
+===================== NET =====================+  (y = 0.0 for both players)
|                                               |
|                   (Ball)                      |
|                                               |
|               [Player Paddle]                 |
+-----------------------------------------------+  (player baseline y = 1.0)
```

### Cross-net transform (`server/transform.ts`, applied server-side)

When a client reports `ball_cross_net`, the server computes the opponent's view in one place so the two clients can never disagree:

- `x' = clamp(1 - x, 0.02, 0.98)` (horizontal mirror for head-to-head orientation)
- `vx' = -vx`
- `vy' = |vy|` (downward, into the opponent's half)
- `spin' = -spin` (mirrored court flips spin direction)
- `speedMultiplier` preserved

### Paddle deflection (`src/game/physics.ts`)

- Hit offset: `(ball.x - paddle.x) / (paddleWidth / 2)`, clamped to `[-1.1, 1.1]` (small edge forgiveness).
- Rebound angle: `offset × 62°` max.
- Each paddle hit speeds the ball up 4%, capped at `MAX_BALL_SPEED` (2.4 units/s).
- Spin modifies trajectory on wall rebounds.

## 4. Directory Structure

```
├── CLAUDE.md                  # This guide
├── README.md                  # Quickstart
├── DEVELOPMENT.md             # Dev workflows, phone testing over HTTPS
├── DEPLOYMENT.md              # KVM/docker-compose runbook (+ Render alternative)
├── Dockerfile                 # Multi-stage build → slim runtime (express+ws only)
├── docker-compose.yml         # phong + caddy (auto-HTTPS) + optional coturn
├── deploy/                    # Caddyfile, .env.example
├── render.yaml                # Render blueprint (alternative host)
├── scripts/load-test.mjs      # N-concurrent-matches relay load test
├── index.html                 # HTML entry
├── package.json               # npm scripts & deps (lockfile: package-lock.json)
├── server.ts                  # Express + ws relay + REST API + Vite middleware
├── tsconfig.json
├── vite.config.ts
├── server/
│   ├── db.ts                  # SQLite store: profiles, ELO, XP, achievements, history
│   └── transform.ts           # Cross-net ball transform (unit-tested, shared with client)
├── tests/                     # Vitest: transform, physics, db invariants, legacy import
└── src/
    ├── main.tsx               # React bootstrap
    ├── App.tsx                # Game controller, loop, WS client, all state
    ├── types.ts               # Shared types incl. WSClientMessage/WSServerMessage
    ├── index.css              # Tailwind 4 entry + base styles
    ├── net/p2p.ts             # WebRTC DataChannel link (P2P play + fallback)
    ├── audio/soundEffects.ts  # Procedural SFX, chiptune BGM, soundscapes
    ├── game/
    │   ├── physics.ts         # Ball movement, collisions, spin, AI opponent
    │   ├── themes.ts          # 10 visual themes + unlock requirements
    │   └── missions.ts        # Daily missions & progress
    ├── i18n/translations.ts   # 7-language dictionary (en es ja de fr pt zh) + t()
    └── components/            # CourtCanvas, ScoreBoard, MultiplayerLobby,
                               # DualCourtSimulator, RadarPreview, QuickChat,
                               # Profile/Leaderboard/MatchHistory/Missions/
                               # Achievements/Settings/Tutorial modals, etc.
```

## 5. Real-Time Protocol (`server.ts`, path `/ws`)

Plain JSON over `ws`. Message shapes are the source of truth in `src/types.ts` (`WSClientMessage`, `WSServerMessage`) — update those first when changing the protocol.

**Client → Server**

| Type | Payload | Purpose |
|---|---|---|
| `create_room` | `playerId`, `playerName?` | Create a 4-letter room (unambiguous alphabet, no 0/O/1/I) |
| `join_room` | `roomId`, `playerId`, `playerName?` | Join as guest; triggers `game_start` for both |
| `paddle_move` | `x` | Relay paddle position (sent throttled from the game loop) |
| `ball_cross_net` | `ball {x,vx,vy,spin,speedMultiplier}` | Ball left this screen; server transforms & forwards |
| `point_scored` | `scorer: 'p1'\|'p2'` | Report a point; server owns the score |
| `quick_chat` | `text`, `senderName?` | Chat bubble (server caps at 100 chars) |
| `rematch_request` | — | Vote for a rematch; two votes restart the match |
| `rtc_signal` | `payload {kind, sdp?, candidate?}` | WebRTC signaling, relayed verbatim to the room peer |
| `ping` | `timestamp` | Latency probe |
| `leave_room` | — | Leave explicitly (disconnect also handled) |

**Server → Client**

| Type | Payload | Purpose |
|---|---|---|
| `room_created` | `roomId`, `playerIndex` | Host confirmation |
| `room_joined` | `roomId`, `playerIndex`, `opponentName`, `opponentId` | Guest confirmation |
| `opponent_joined` | `opponentName`, `opponentId` | Told to the host |
| `game_start` | `servingPlayer` | Match (re)start — clients fully reset on this |
| `opponent_paddle` | `x` | Pre-mirrored (`1 - x`) opponent paddle |
| `ball_incoming` | `ball` | Post-transform ball; receiving client takes ownership |
| `score_update` | `p1Score`, `p2Score`, `reason`, `nextServer` | Authoritative score |
| `rematch_state` | `votes: [bool, bool]` | Rematch votes so the UI can show "waiting" |
| `rtc_signal` | `payload`, `fromIdx` | Relayed signaling from the room peer |
| `quick_chat` | `text`, `senderName`, `senderIdx` | Relayed chat |
| `opponent_left` | — | Opponent disconnected |
| `pong` | `timestamp` | Latency reply |
| `error` | `message` | Join failures etc. |

**REST API** (same origin): `GET /api/health`, `GET /api/rtc-config` (STUN list + time-limited TURN creds when `TURN_URL`/`TURN_STATIC_SECRET` are set), `GET /api/room/:roomId`, `GET|PUT /api/profile/me`, `POST /api/profile/claim` (recovery-code transfer), `POST /api/match/record`, `GET /api/leaderboard?sort=elo|level|rally|wins`, `GET /api/achievements`, `GET /api/matches/me`.

**Device identity** (`server/auth.ts`): the server issues each browser a signed HttpOnly cookie (`phong_device`) on first API contact — HMAC-SHA256 over a random device id, secret auto-generated and persisted in the DB `meta` table. All profile/match/achievement routes resolve the player from the verified cookie; client-sent player ids are never trusted (the WS relay also prefers the cookie identity). One cookie jar = one profile, which is as close to "one profile per device" as the web allows. Each profile carries a `recoveryCode` (shown only to its own device in the Profile modal); `POST /api/profile/claim` moves the profile to the claiming device and rotates the code.

**P2P mode** (`src/net/p2p.ts`): the host offers a WebRTC session when the guest joins (lobby toggle, default on); signaling rides `rtc_signal` over the relay. Gameplay starts relayed and hands over when the DataChannels open — "fast" (unordered, no retransmit) carries `paddle_move`, "game" (reliable ordered) carries everything else. Peers exchange the same client-message shapes and each side synthesizes the server-shaped equivalents locally, replicating the room rules (score, serve rotation, rematch votes) deterministically and reusing `server/transform.ts` for the net cross. If the link never opens or dies, play continues on the relay (the HUD badge shows `P2P` / `RELAY`). Adding a gameplay message means handling it in **both** `server.ts` and `src/net/p2p.ts`.

**Trust model — deliberate trade-off**: gameplay physics is client-authoritative (each client simulates its own half and reports `ball_cross_net` / `point_scored`; each phone records its own result via `/api/match/record` with `isWinner`). This keeps the local half at zero latency and is fine for friendly play, but a modified client can cheat. The server validates room membership, owns the shared score, caps chat length, and clamps the transformed ball into the court. Revisit only if public leaderboards attract abuse.

## 6. Audio Engine (`src/audio/soundEffects.ts`)

Entirely procedural Web Audio API:

- **Paddle impacts**: pitched oscillator bursts scaling with rally speed and hit offset.
- **Wall bounces & net crossing**: filtered sweeps and noise wooshes.
- **Chiptune BGM**: procedural arpeggiator, tempo scales with rally intensity.
- **Soundscapes**: `stadium` (crowd synthesis), `cyberpunk` (analog drone), `zen` (pentatonic chimes + wind), or `none`.

The `AudioContext` must be unlocked lazily from a user gesture — never play audio before `sound.unlock()`/`initCtx()` has run (iOS Safari silently discards it otherwise).

## 7. Progression, ELO & Unlockables

- **ELO** (`server/db.ts`): fixed deltas, not a FIDE expected-score formula. Multiplayer: **+24 win / −16 loss**. Solo: difficulty-scaled (rookie 8, pro 16, cyber 24, chaos 32 for a win; half that, rounded, for a loss). Floor at **800**. New players start at 1200.
- **XP**: points×15 + maxRally×6 + 60 win bonus; multipliers for cyber/chaos difficulty and multiplayer; minimum 20 per match. Levels derive from cumulative XP.
- **Daily streak**: consecutive active days tracked on the profile.
- **Themes** (`src/game/themes.ts`) — unlocked by default: `neon`, `retro-crt`, `midnight`, `cyberpunk`, `tennis`. Earned: `emerald-matrix` (first cross-net volley), `solar-flare` (10+ rally), `hyper-violet` (first match win), `monochrome-noir` (level 5), `quantum-gold` (25+ rally or 1400+ ELO).
- **Achievements**: defined in `ALL_ACHIEVEMENTS` (`server/db.ts`); awarded once, never re-awarded, XP rewards attached.

## 8. Commands

```bash
npm run dev      # tsx watch server.ts — app + relay with hot reload on :3000
npm run build    # vite build (client) + esbuild bundle (server) → dist/
npm start        # node dist/server.cjs (production)
npm run lint     # tsc --noEmit
npm test         # vitest run (tests/)
```

Environment: `PORT` (default 3000), `DATA_DIR` (default `./data`). See `.env.example`.

## 9. Conventions

1. **Server-side logic lives in `server.ts` / `server/`**; no keys or secrets in client code (the app currently needs none at all).
2. **Strictly normalized coordinates**: all court physics in `[0,1]` floats so every device agrees regardless of pixels or aspect ratio.
3. **Audio only after a user gesture** (see §6).
4. **Protocol changes start in `src/types.ts`** — both client and server import their message shapes from there.
5. **Icons**: lucide-react. **Styling**: Tailwind utility classes; inline styles only for dynamic canvas/theme color bindings.
6. **Keep the client origin-relative**: derive WS and API URLs from `window.location` (this is what makes dev, tunnels, and production work unchanged).

## 10. Deployment

One Node service, one port, WebSockets on the same listener; **single-instance by design** (rooms live in process memory). Primary target: the **too-many-coins.com KVM via Dokploy** — Dokploy builds the `Dockerfile`, mounts a `phong-data` volume at `/data` (mandatory, or deploys wipe player data), and routes `phong.too-many-coins.com` through its Traefik with Let's Encrypt. The repo's `docker-compose.yml` (app + Caddy + optional coturn TURN relay, `--profile turn`) serves bare boxes without an existing proxy; the app mints time-limited TURN credentials from `TURN_STATIC_SECRET`. `render.yaml` remains as an alternative host. Env: `PORT`, `DATA_DIR`, `TURN_URL`, `TURN_STATIC_SECRET`. `SIGTERM` closes sockets (code 1001) and exits cleanly; deploys drop in-flight matches and clients auto-reconnect. Capacity: `scripts/load-test.mjs` demonstrates 10 concurrent matches with 0% loss. Full runbook: `DEPLOYMENT.md`; phone testing needs HTTPS (tunnel) — see `DEVELOPMENT.md`.
