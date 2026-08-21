# CLAUDE.md – Phong Project Guide

This document is the working guide to **Phong**, an arcade sports web app with a "blind half-court" mechanic and cross-device 2-phone multiplayer. It describes the code as it actually is — when the code and this file disagree, fix this file.

---

## 1. Project Overview & Core Concept

**Phong** reimagines Pong for mobile and desktop web. Each player sees only their own half of the court.

- **The Net Boundary**: the glowing top edge of the player's screen is the net.
- **Cross-Net Jump**: when the ball exits through the net, it leaves the player's screen and appears on the opponent's, travelling downward.
- **Opponent Radar**: a mini radar tracks the opponent's paddle and the ball while it is on their half.
- **Physical 2-Phone Duel**: two phones placed top-to-top, connected by a 4-letter room code over WebSockets; the ball physically transitions between screens.
- **Solo AI**: an adaptive AI opponent (Rookie / Pro / Cyber / Chaos) on the hidden half. Each difficulty is a *rating*, not a fixed parameter set, and slides part-way toward the player's own skill — see §7.
- **Practice Wall**: fully solo drill mode — no opponent exists and the ball never leaves the player's screen; the net line acts as a *return line* that bounces every ball back. HUD shows current/best return streak; nothing is recorded.
- **Split Screen**: local 2-player classic Pong on ONE device (`SplitScreenMatch`) — full court on a single screen, net across the middle, one player per half (multi-touch; each pointer is locked to the half it started in). No networking, no stats saved, unranked.

**Navigation**: the app opens on a **MainMenu** screen (`screen: 'menu' | 'game'` in `App.tsx`). Match settings — AI difficulty and winning score — are locked in on the menu **before** a match starts and are not editable mid-match; the in-game Settings modal carries device/presentation preferences only. The in-match HUD keeps just sound/reset/settings/home; the winner overlay offers Play Again (or Rematch) and Main Menu.

**Player identity**: profiles are minted lazily from the device cookie in an *uninitialized* state and a blocking **OnboardingModal** gates everything until the player locks in a **unique username** (case-insensitive, 3–16 chars `[A-Za-z0-9][A-Za-z0-9_-]*`, `Paddle-` prefix reserved for placeholders; rules shared client/server via `src/profileRules.ts`). The username then can't change for **365 days** from initialization (and from each later change); a released name returns to the pool. Optional **avatars** are exactly 256×256 PNGs — the client center-crops/resizes any image (`src/media/avatar.ts`), the server validates dimensions dependency-free (`server/image.ts`). Tapping any username (leaderboard, match history, lobby, in-match opponent) opens the sanitized **PublicProfileModal** backed by `GET /api/profile/:id`. Uninitialized profiles can't record matches and never appear on the leaderboard.

## 2. Tech Stack

- **Frontend**: React 19, TypeScript, Vite 6, Tailwind CSS 4 (CSS-first — configured in `src/index.css`, no `tailwind.config.js`), Motion (`motion/react`), Lucide React icons, Canvas Confetti.
- **Server**: Express 4 (`server.ts`) + **`ws`** for the WebSocket relay (no Socket.IO), Node 22. One process serves the client and the relay on one port, dev (Vite middleware) and prod (static `dist/`) alike. Runtime dependencies are only `express` + `ws`; everything else is dev tooling.
- **P2P mode**: private matches connect the two phones directly over **WebRTC DataChannels** (`src/net/p2p.ts`), with the relay as automatic fallback — see §5.
- **Audio**: procedural Web Audio API synthesis in `src/audio/soundEffects.ts` — zero audio assets.
- **Persistence**: **SQLite** via Node's built-in `node:sqlite` (no native deps) at `DATA_DIR/phong.db` (default `./data`), WAL mode, managed by `server/db.ts`. Avatars live in a separate `avatars` BLOB table (kept out of `SELECT *` hot paths). One-shot destructive migrations are flagged in the `meta` table: `wipe_v1` wiped all pre-launch player data (including `auth_secret`, retiring every old device cookie) exactly once; there is no legacy-JSON import and no automatic bot seeding (`db.insertBot()` is the seam for the future bot roster). `npm run db:reset -- --yes` is the manual full reset (server stopped first).

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
- **Paddle width (`PADDLE_WIDTH_RATIO` = 0.22) and base ball speed are fixed constants — they must NEVER become user-editable settings** (fairness rule; `SplitScreenMatch` scales them internally for its full-court geometry, still non-editable).

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
├── scripts/db-reset.mjs       # Manual full player-data reset (npm run db:reset -- --yes)
├── server/
│   ├── db.ts                  # SQLite store: profiles, ELO, XP, achievements, history, avatars
│   ├── image.ts               # Dep-free 256×256 PNG avatar validation
│   └── transform.ts           # Cross-net ball transform (unit-tested, shared with client)
├── tests/                     # Vitest: transform, physics, db invariants, legacy import
└── src/
    ├── main.tsx               # React bootstrap
    ├── App.tsx                # Game controller, loop, WS client, all state
    ├── types.ts               # Shared types incl. WSClientMessage/WSServerMessage
    ├── profileRules.ts        # Username/avatar rules shared by client & server
    ├── rating.ts              # TrueSkill-style rating, tiers, prediction & XP (shared)
    ├── index.css              # Tailwind 4 entry + base styles
    ├── net/p2p.ts             # WebRTC DataChannel link (P2P play + fallback)
    ├── media/avatar.ts        # Client avatar pipeline: crop → 256×256 → PNG → upload
    ├── audio/soundEffects.ts  # Procedural SFX, chiptune BGM, soundscapes
    ├── game/
    │   ├── physics.ts         # Ball movement, collisions, spin, AI opponent
    │   ├── themes.ts          # 10 visual themes + unlock requirements
    │   └── missions.ts        # Daily mission DEFINITIONS (shared client+server)
    ├── i18n/translations.ts   # 7-language dictionary (en es ja de fr pt zh) + t()
    └── components/            # MainMenu, CourtCanvas, ScoreBoard,
                               # MultiplayerLobby, SplitScreenMatch,
                               # RadarPreview, QuickChat, AvatarImage, TierBadge,
                               # Onboarding/PublicProfile/Profile/Leaderboard/
                               # MatchHistory/Missions/Achievements/Settings/
                               # Tutorial modals, etc.
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

**REST API** (same origin): `GET /api/health`, `GET /api/rtc-config` (STUN list + time-limited TURN creds when `TURN_URL`/`TURN_STATIC_SECRET` are set), `GET /api/room/:roomId`, `GET|PUT /api/profile/me` (PUT takes `{username}` only — 409 `USERNAME_TAKEN` / 403 `USERNAME_LOCKED {unlockAt}`; **XP is never accepted from the client**), `POST /api/profile/initialize` (one-shot onboarding username claim), `GET /api/username-check?u=`, `POST|DELETE /api/profile/me/avatar` (raw 256×256 PNG body, route-scoped 600kb limit), `GET /api/avatar/:playerId` (immutable-cached, `?v=avatarVersion` busts), `POST /api/profile/claim` (recovery-code transfer), `GET /api/profile/:id` (sanitized public profile — registered LAST so `me`/`claim` etc. match first), `POST /api/match/record` (403 for uninitialized profiles), `GET /api/leaderboard?sort=elo|level|rally|wins` (initialized profiles only), `GET /api/achievements`, `GET /api/missions`, `POST /api/missions/claim` (`{missionId}` — 404 `MISSION_UNKNOWN`, 409 `MISSION_INCOMPLETE`/`MISSION_CLAIMED`), `GET /api/matches/me`.

**Device identity** (`server/auth.ts`): the server issues each browser a signed HttpOnly cookie (`phong_device`) on first API contact — HMAC-SHA256 over a random device id, secret auto-generated and persisted in the DB `meta` table. All profile/match/achievement routes resolve the player from the verified cookie; client-sent player ids are never trusted, and the WS relay resolves display names from the cookie's profile (clients no longer send `playerName` at all). One cookie jar = one profile, which is as close to "one profile per device" as the web allows. Each profile carries a `recoveryCode` (shown only to its own device in the Profile modal); `POST /api/profile/claim` moves the profile — avatar included — to the claiming device and rotates the code.

**P2P mode** (`src/net/p2p.ts`): the host offers a WebRTC session when the guest joins (lobby toggle, default on); signaling rides `rtc_signal` over the relay. Gameplay starts relayed and hands over when the DataChannels open — "fast" (unordered, no retransmit) carries `paddle_move`, "game" (reliable ordered) carries everything else. Peers exchange the same client-message shapes and each side synthesizes the server-shaped equivalents locally, replicating the room rules (score, serve rotation, rematch votes) deterministically and reusing `server/transform.ts` for the net cross. If the link never opens or dies, play continues on the relay (the HUD badge shows `P2P` / `RELAY`). Adding a gameplay message means handling it in **both** `server.ts` and `src/net/p2p.ts`.

**Trust model — deliberate trade-off**: gameplay physics is client-authoritative (each client simulates its own half and reports `ball_cross_net` / `point_scored`; each phone records its own result via `/api/match/record` with `isWinner`). This keeps the local half at zero latency and is fine for friendly play, but a modified client can cheat. The server validates room membership, owns the shared score, caps chat length, and clamps the transformed ball into the court. Revisit only if public leaderboards attract abuse.

## 6. Audio Engine (`src/audio/soundEffects.ts`)

Entirely procedural Web Audio API:

- **Paddle impacts**: pitched oscillator bursts scaling with rally speed and hit offset.
- **Wall bounces & net crossing**: filtered sweeps and noise wooshes.
- **Chiptune BGM**: procedural arpeggiator, tempo scales with rally intensity.
- **Soundscapes**: `stadium` (crowd synthesis), `cyberpunk` (analog drone), `zen` (pentatonic chimes + wind), or `none`.

The `AudioContext` must be unlocked lazily from a user gesture — never play audio before `sound.unlock()`/`initCtx()` has run (iOS Safari silently discards it otherwise).

## 7. Progression, Skill Rating & Unlockables

**Two separate currencies.** XP/levels are the time-invested track; the skill tier is the how-good-are-you track. They never substitute for each other.

| | Experience / Level | Skill Tier |
|---|---|---|
| Driven by | XP | ranked μ |
| Earned from | **every** match (solo + PvP), quests, achievements | **PvP only** |
| Direction | monotonic — never decreases | up and down |

- **Rating** (`src/rating.ts`, shared client+server): TrueSkill-style Gaussian pairs, replacing the old fixed-delta ELO. Each profile carries **two**:
  - `mmrMu`/`mmrSigma` — hidden MMR, moved by *every* match including solo. Drives the pre-match win prediction, the XP surprise multiplier, and the recommended AI difficulty. Never rendered as a number; only ever sent to the profile's own device.
  - `rankMu`/`rankSigma`/`rankedGames` — moved by **PvP only**, drives the visible tier. Solo results can therefore never change a player's rank.
  - Prediction: `P(win) = Φ((μₐ − μᵦ) / √(2β² + σₐ² + σᵦ²))`, β = 4.1667, τ = 0.0833, start μ=25 σ=8.33, σ floor 0.6. `erf` is approximated in-module — **no new runtime deps**.
- **AI anchors**: the four difficulties are rating anchors (Rookie μ18, Pro μ25, Chaos μ32, Cyber μ35, σ=0.5) rather than parameter sets. This is why *no per-difficulty XP or rating table exists anywhere* — difficulty is encoded in the anchor, and surprise falls out of the math.
- **Adaptive difficulty** (`effectiveAiMu`, `AI_ADAPT_STRENGTH = 0.6`): each anchor slides 60% of the way toward the player's hidden μ, bounded to ±`AI_ADAPT_BAND` (7 μ points). Partial, so the rungs keep distinct absolute identities and never collapse into one rubber-banded opponent; the ladder's spread (Cyber − Rookie = 17 μ) is preserved exactly at every skill level. The **effective** μ is what prediction and XP key off — it is the strength actually faced, so the odds shown are honest — while the solo μ cap stays pinned to the **base** anchor (capping at a target that rises with the player would be circular and let solo farming lift μ without limit).
- **AI competence** (`competenceForMu` in `game/physics.ts`): the effective μ collapses to one scalar `c ∈ [0.05, 0.9]` driving every AI parameter (reaction time, paddle speed, aim error, wall-bounce reads, lapses), so difficulties are monotonic by construction. The dominant term is `contactError` — the aim error still present at the moment of contact — because the paddle catches anything within ~0.147 of its centre. **Per-rally, not per-tick**: the AI decides how it reads a ball once, as the ball crosses the net, and lives with that read. Re-rolling error every tick averages out to a perfect aim over a long flight, which is precisely how the pre-rewrite AI became unbeatable (Pro, Chaos and Cyber returned **100%** of balls; solo above Rookie was mathematically unwinnable). Measured AI return rates for an average player are now Rookie ~57%, Pro ~74%, Chaos ~87%, Cyber ~89%, giving first-to-5 match win rates of roughly 83% / 50% / 16% / 8% — and 98% / 90% / 70% / 60% once the player reaches μ40. `tests/physics.test.ts` simulates rallies through the real collision code to guard this; **no difficulty may ever return ≥95% of balls**.
- **Difficulty styles** (`AI_STYLES`): strength is `c`; *style* is volatility (Chaos swings ±0.22 in competence between rallies) and aggression (how hard it plays for the corners). This is what keeps Chaos and Cyber distinct despite adjacent ratings.
- **Mode asymmetry** (PvP is always heavier than AI): solo uses a 0.35× μ step, half the σ shrink, and a **cap** — a solo win can never push μ past the anchor it beat, so farming a weak difficulty converges on it and stops.
- **TrueSkill-2 signals** are applied to PvP only and only from data the relay owns (`room.scores`, `room.maxRallyInMatch`): margin of victory and rally quality, bounded to a 0.5–1.5 weight. Solo stats are self-reported (client-authoritative physics) and feed XP only — never rating.
- **Tiers**: `unranked` until **5 ranked games and σ ≤ 4.0**, then keyed on `rankMu` — Rookie <19 · Contender 19 · Vanguard 22 · Ace 25 · Master 28 · Grandmaster 31 · Legend 34 · Cyber Overlord ≥37. Deliberately **not** μ−3σ: a conservative rating drifts an average player two tiers upward as σ shrinks, with no change in skill.
- **XP**: `points×12 + maxRally×4 + 40 win bonus`, scaled by the surprise multiplier (win `0.6 + 1.4×(1−P)`, loss `0.20 + 0.55×(1−P)`), ×1.5 for PvP, floor 15. **Never negative — levels cannot regress.**
- **Level curve**: `band(L) = 250 + 60×(L−1)` (~2–4 matches per level). The old `120 × L^1.6` had a 120 XP first band that a single match overshot outright.
- **Daily streak**: consecutive active days tracked on the profile.
- **Daily missions**: definitions in `src/game/missions.ts` (shared client+server, like `profileRules.ts`); **state is server-owned** in the `daily_missions` table, keyed `(playerId, dayKey, missionId)` on a **UTC** day. Progress advances only inside `recordMatch`, so a mission can't be reported independently of a real game, and `POST /api/missions/claim` stamps `claimedAt` before paying — the reward comes from the definition table and the primary key makes a replay a no-op. This replaced localStorage missions claimed via a client-chosen `xpDelta` on `PUT /api/profile/me`: clearing site data re-armed all five, and the endpoint could be called in a loop (verified: level 1 → 15 in ten requests). **Never add a route that takes an XP amount from the client.** Practice Wall and Split Screen record no match, so they still can't feed missions. Mission progress no longer ticks mid-match — it lands when the match is recorded.
- **Themes** (`src/game/themes.ts`) — unlocked by default: `neon`, `retro-crt`, `midnight`, `cyberpunk`, `tennis`. Earned: `emerald-matrix` (first cross-net volley), `solar-flare` (10+ rally), `hyper-violet` (first match win), `monochrome-noir` (level 5), `quantum-gold` (25+ rally or Master tier).
- **Achievements**: defined in `ALL_ACHIEVEMENTS` (`server/db.ts`); awarded once, never re-awarded. First-session values are deliberately small so match 1 can't skip levels. Achievements marked `scaled: true` — `first_win`, `shutout`, `cyber_slayer`, `multiplayer_champ` — pay `xpReward × surpriseMultiplier`, the same multiplier the match XP uses, because the AI adapts to the player and a flat reward would pay a μ40 player the same for a Cyber win they take often as a μ25 player for one they rarely take. The award lands on `Achievement.awardedXp`. **Rally achievements stay flat on purpose**: a stronger AI returns *more* balls, so long rallies get easier as difficulty rises and scaling them would run backwards.

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
7. **Match settings are pre-match only**: mode, AI difficulty, and winning score are chosen on the MainMenu before play; the in-game Settings modal is device preferences only. Paddle width and ball speed are engine constants, never settings (see §3).
8. **Username & avatar rules live in `src/profileRules.ts`** and nowhere else — both sides import them. Usernames enter the system only through `initializeProfile`/`changeUsername` (never via query params, match payloads, or WS messages).

## 10. Deployment

One Node service, one port, WebSockets on the same listener; **single-instance by design** (rooms live in process memory). Primary target: the **too-many-coins.com KVM via Dokploy** — Dokploy builds the `Dockerfile`, mounts a `phong-data` volume at `/data` (mandatory, or deploys wipe player data), and routes `phong.too-many-coins.com` through its Traefik with Let's Encrypt. The repo's `docker-compose.yml` (app + Caddy + optional coturn TURN relay, `--profile turn`) serves bare boxes without an existing proxy; the app mints time-limited TURN credentials from `TURN_STATIC_SECRET`. `render.yaml` remains as an alternative host. Env: `PORT`, `DATA_DIR`, `TURN_URL`, `TURN_STATIC_SECRET`. `SIGTERM` closes sockets (code 1001) and exits cleanly; deploys drop in-flight matches and clients auto-reconnect. Capacity: `scripts/load-test.mjs` demonstrates 10 concurrent matches with 0% loss. Full runbook: `DEPLOYMENT.md`; phone testing needs HTTPS (tunnel) — see `DEVELOPMENT.md`.
