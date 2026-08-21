# CLAUDE.md – Phong Project Guide

This document is the working guide to **Phong**, an arcade sports web app with a "blind half-court" mechanic and cross-device 2-phone multiplayer. It describes the code as it actually is — when the code and this file disagree, fix this file.

---

## 1. Project Overview & Core Concept

**Phong** reimagines Pong for mobile and desktop web. Each player sees only their own half of the court.

- **The Net Boundary**: the glowing top edge of the player's screen is the net.
- **Cross-Net Jump**: when the ball exits through the net, it leaves the player's screen and appears on the opponent's, travelling downward.
- **Opponent Radar**: a mini radar tracks the opponent's paddle and the ball while it is on their half.
- **Physical 2-Phone Duel**: two phones placed top-to-top, connected by a 4-letter room code over WebSockets; the ball physically transitions between screens.
- **Solo AI**: an adaptive AI opponent (Rookie / Pro / Cyber) on the hidden half. Each difficulty is a *rating*, not a fixed parameter set, and slides part-way toward the player's own skill — see §7.
- **Practice Wall**: fully solo drill mode — no opponent exists and the ball never leaves the player's screen; the net line acts as a *return line* that bounces every ball back. HUD shows current/best return streak. Records no match and moves no rating, but banks thin streak-scaled XP on exit (`practiceXp`, server-computed, capped per UTC day) so every mode is progression.
- **Split Screen**: local 2-player classic Pong on ONE device (`SplitScreenMatch`) — full court on a single screen, net across the middle, one player per half (multi-touch; each pointer is locked to the half it started in). No networking, no stats saved, unranked.

**Navigation**: the app opens on a **MainMenu** screen (`screen: 'menu' | 'game'` in `App.tsx`). Match settings — AI difficulty and winning score — are locked in on the menu **before** a solo match starts, and in the **lobby** before a duel (the host sets them, the guest reads them); neither is editable once play begins; the in-game Settings modal carries device/presentation preferences only. The in-match HUD keeps just sound/reset/settings/home; the winner overlay offers Play Again (or Rematch) and Main Menu.

**Player identity**: profiles are minted lazily from the device cookie in an *uninitialized* state and a blocking **OnboardingModal** gates everything until the player locks in a **unique username** (case-insensitive, 3–16 chars `[A-Za-z0-9][A-Za-z0-9_-]*`, `Paddle-` prefix reserved for placeholders; rules shared client/server via `src/profileRules.ts`). The username then can't change for **365 days** from initialization (and from each later change); a released name returns to the pool. Optional **avatars** are exactly 256×256 PNGs — the client center-crops/resizes any image (`src/media/avatar.ts`), the server validates dimensions dependency-free (`server/image.ts`). Tapping any username (leaderboard, match history, lobby, in-match opponent) opens the sanitized **PublicProfileModal** backed by `GET /api/profile/:id`. Uninitialized profiles can't record matches and never appear on the leaderboard.

## 2. Tech Stack

- **Frontend**: React 19, TypeScript, Vite 6, Tailwind CSS 4 (CSS-first — configured in `src/index.css`, no `tailwind.config.js`), Motion (`motion/react`), Lucide React icons, Canvas Confetti.
- **Server**: Express 4 (`server.ts`) + **`ws`** for the WebSocket relay (no Socket.IO), Node 22. One process serves the client and the relay on one port, dev (Vite middleware) and prod (static `dist/`) alike. Runtime dependencies are only `express` + `ws`; everything else is dev tooling.
- **P2P mode**: private matches connect the two phones directly over **WebRTC DataChannels** (`src/net/p2p.ts`), with the relay as automatic fallback — see §5.
- **Audio**: procedural Web Audio API synthesis in `src/audio/soundEffects.ts` — zero audio assets.
- **Persistence**: **SQLite** via Node's built-in `node:sqlite` (no native deps) at `DATA_DIR/phong.db` (default `./data`), WAL mode with `synchronous = NORMAL` and a per-connection prepared-statement cache, managed by `server/db.ts` — recording a match compiles no SQL and fsyncs no log, which took the write from 0.93ms to 0.34ms. Avatars live in a separate `avatars` BLOB table (kept out of `SELECT *` hot paths). One-shot destructive migrations are flagged in the `meta` table (`wipe_v1`, `wipe_v2`); each wipes all player data including `auth_secret`, which retires every existing device cookie — the client detects the resulting `403 PROFILE_NOT_INITIALIZED`, re-syncs, re-opens onboarding, and keeps the unrecorded match queued; there is no legacy-JSON import and no automatic bot seeding (`db.insertBot()` is the seam for the future bot roster). `npm run db:reset -- --yes` is the manual full reset (server stopped first).

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
- **Paddle drive & spin** (`driveCoupling`): the paddle's own velocity is an input, not just its position. Contact point decides how much of that motion *couples* into the ball — head-on is a clean rebound carrying `HEAD_ON_COUPLING` (0.22), an edge carries nearly all of it — and paddle speed decides the magnitude. The coupling feeds three things at once: rebound angle (+`DRIVE_ANGLE_DEG`), pace (+`DRIVE_SPEED_GAIN`), and **spin**. A stationary paddle behaves exactly as it did before, so nothing was taken away.
- **Spin never bends the flight.** Between impacts the ball travels perfectly straight; spin is carried on the ball and *spends itself on surfaces*, changing **both the angle and the speed** the ball leaves every surface with — `SPIN_WALL_TILT_DEG` / `SPIN_REBOUND_DEG` for the angle, `SPIN_WALL_SPEED_GAIN` / `SPIN_PADDLE_SPEED_GAIN` for the pace, with spin reversed and damped each time (`SPIN_WALL_RETENTION`, `SPIN_PADDLE_CARRY`). The pace trade is signed by `spinPace()`: a ball spinning **with** the direction it leaves in skids on, one spinning **against** itself is scrubbed — so spin buys angle at a cost in pace, or the reverse, instead of being free. Mirroring the court flips both spin and `vx`, so the product is identical on either half and the two phones can never disagree about how fast the ball now is; every rebound is held inside the match's own speed band, so a ball cannot be spun faster and faster off alternating walls. A curving-in-flight model was built first and rejected: it makes the ball's path unreadable on a blind half-court, where the receiver never sees the stroke that caused it.
- **`predictLanding(ball, spinFactor)`** is the single source of truth for where a ball will cross the paddle line, folding wall rebounds under the same rules the ball obeys. `spinFactor` 1 is the true landing; lower values are what an AI that reads less of the spin expects instead.
- Until this was built, spin was **documented but fictional**: `BallState.spin` existed, `ball_cross_net` carried it, `server/transform.ts` mirrored it, and the client hardcoded `spin: 0`. `checkPaddleCollision` likewise took a `paddleVx` argument it never read.
- **Paddle width (`PADDLE_WIDTH_RATIO` = 0.22), ball radius and ball speed are the *stock* game**, adjustable per match via `src/matchRules.ts`. Fairness is kept by a **ranked band** around stock on every physics rule rather than by an all-or-nothing stock check: inside the band a tuned match rates normally (the ladder absorbs a 15% wider paddle the way it absorbs a better phone); past it the match still pays XP but moves no MMR, no rank and no tier. Bands are ±15% on paddle and ball size and on serve power, ±20% on serve angle, ±10% on the minimum speed and +20% on the maximum. `isRankedRules()` is re-derived server-side in `recordMatch` from the rules themselves; a client-set `ranked` flag is ignored. Presentation options (sonar, telemetry, quick chat, auto-serve) never affect ranking.
- **Serving is aimed**: a **push up** from the paddle sets direction and power (`serveVelocity`, bounded by `serveAngleMax`/`servePowerMax` and the match speed band); a plain tap still serves. The gesture pushes rather than pulls because the paddle sits at 90% of the court height — a pull-back had ~10% of screen below it and full power was unreachable. `autoServeSeconds` fires a held serve by itself so a PvP match can't stall.
- **The AI serves like it plays**: `aiServeDelay()` waits 0.6–1.15s scaled by competence and by `playerPressure()` (score gap + best rally this match), and `aiServeAim()` plays away from where the player is standing, committing harder and hitting harder as competence rises. Both replaced a flat 900ms timer with a random angle.

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
├── scripts/e2e-*.mjs          # Browser E2E (profiles, gameplay, rating, rules,
│                              #   achievements, elite, duel)
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
    ├── matchRules.ts          # Pre-match rules + what counts as ranked (shared)
    ├── achievements.ts        # Achievement tree + the unlocks it gates (shared)
    ├── net/matchRecord.ts     # Match POST with retry + on-device replay queue
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
| `create_room` | `playerId`, `config?` | Create a 4-letter room (unambiguous alphabet, no 0/O/1/I) on the host's terms |
| `set_room_config` | `config` | Host-only, and only before the first ball or after the last point |
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
| `room_config` | `config` | The room's terms: winning score + match rules, broadcast to both |
| `game_start` | `servingPlayer`, `config` | Match (re)start — clients fully reset on this |
| `opponent_paddle` | `x` | Pre-mirrored (`1 - x`) opponent paddle |
| `ball_incoming` | `ball` | Post-transform ball; receiving client takes ownership |
| `score_update` | `p1Score`, `p2Score`, `reason`, `nextServer` | Authoritative score |
| `rematch_state` | `votes: [bool, bool]` | Rematch votes so the UI can show "waiting" |
| `rtc_signal` | `payload`, `fromIdx` | Relayed signaling from the room peer |
| `quick_chat` | `text`, `senderName`, `senderIdx` | Relayed chat |
| `opponent_left` | — | Opponent disconnected |
| `pong` | `timestamp` | Latency reply |
| `error` | `message` | Join failures etc. |

**REST API** (same origin): `GET /api/health`, `GET /api/rtc-config` (STUN list + time-limited TURN creds when `TURN_URL`/`TURN_STATIC_SECRET` are set), `GET /api/room/:roomId`, `GET|PUT /api/profile/me` (PUT takes `{username}` only — 409 `USERNAME_TAKEN` / 403 `USERNAME_LOCKED {unlockAt}`; **XP is never accepted from the client**), `POST /api/profile/initialize` (one-shot onboarding username claim), `GET /api/username-check?u=`, `POST|DELETE /api/profile/me/avatar` (raw 256×256 PNG body, route-scoped 600kb limit), `GET /api/avatar/:playerId` (immutable-cached, `?v=avatarVersion` busts), `POST /api/profile/claim` (recovery-code transfer), `GET /api/profile/:id` (sanitized public profile — registered LAST so `me`/`claim` etc. match first), `POST /api/match/record` (403 for uninitialized profiles), `GET /api/leaderboard?sort=elo|level|rally|wins` (initialized profiles with progress on the sorted metric only — `elo` needs a ranked game, `level` XP, `rally`/`wins` a nonzero best; a row of zeros is not "last place", it is not on the board; bots are a curated roster and exempt), `GET /api/achievements`, `POST /api/practice/record` (`{bestStreak}` — server computes the XP and holds a per-UTC-day cap), `GET /api/missions`, `POST /api/missions/claim` (`{missionId}` — 404 `MISSION_UNKNOWN`, 409 `MISSION_INCOMPLETE`/`MISSION_CLAIMED`), `GET /api/matches/me`.

**Device identity** (`server/auth.ts`): the server issues each browser a signed HttpOnly cookie (`phong_device`) on first API contact — HMAC-SHA256 over a random device id, secret auto-generated and persisted in the DB `meta` table. All profile/match/achievement routes resolve the player from the verified cookie; client-sent player ids are never trusted, and the WS relay resolves display names from the cookie's profile (clients no longer send `playerName` at all). One cookie jar = one profile, which is as close to "one profile per device" as the web allows. Each profile carries a `recoveryCode` (shown only to its own device in the Profile modal); `POST /api/profile/claim` moves the profile — avatar included — to the claiming device and rotates the code.

**P2P mode** (`src/net/p2p.ts`): the host offers a WebRTC session when the guest joins (lobby toggle, default on); signaling rides `rtc_signal` over the relay. Gameplay starts relayed and hands over when the DataChannels open — "fast" (unordered, no retransmit) carries `paddle_move`, "game" (reliable ordered) carries everything else. Peers exchange the same client-message shapes and each side synthesizes the server-shaped equivalents locally, replicating the room rules (score, serve rotation, rematch votes) deterministically and reusing `server/transform.ts` for the net cross. If the link never opens or dies, play continues on the relay (the HUD badge shows `P2P` / `RELAY`). Adding a gameplay message means handling it in **both** `server.ts` and `src/net/p2p.ts`.

**The room owns the match, not either phone** (`RoomMatchConfig` in `src/types.ts`). The winning score and every physics rule live on the room: the host sets them in the lobby while waiting, the server normalizes and broadcasts them, and `game_start` carries them again so no phone can begin a match on terms it was not told. Before this, each phone applied its own `settings.winningScore` and `settings.rules` — picked in the **Solo** panel, the only place the controls ever appeared — so a duel could be two different matches, and the shorter one ending first left the other player stuck mid-rally with a live court and no way forward. The server also tracks `inPlay` (a ball has crossed) and `matchOver` (the authoritative score reached the room's winning score): settings are editable only outside a live match, and a `rematch_request` is ignored unless the room agrees the match is finished, so a vote can never be banked mid-rally. `src/net/p2p.ts` replicates all three rules exactly.

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
- **AI anchors**: the three difficulties are rating anchors (Rookie μ18, Pro μ25, Cyber μ29, σ=0.5) rather than parameter sets. This is why *no per-difficulty XP or rating table exists anywhere* — difficulty is encoded in the anchor, and surprise falls out of the math.
- **Adaptive difficulty** (`effectiveAiMu`) is **asymmetric**. Upward it tracks `AI_ADAPT_STRENGTH` = 0.6, bounded to +`AI_ADAPT_BAND` (7 μ), so a strong player genuinely outgrows the low rungs. Downward it tracks **fully** (`AI_ADAPT_DOWN_STRENGTH` = 1, band 20). Partial tracking leaves a residual gap of `(1 − strength) × deviation`, which is fine above average and compounding below it: a player losing every match to Pro fell to μ13 while Pro stalled at the band edge of 18, so their odds went **50% → 22%** and each further loss widened it. **The ladder must never get harder because you are losing.** The spread (Cyber − Rookie = 11 μ) is preserved exactly at every skill level either way. The **effective** μ is what prediction and XP key off — it is the strength actually faced, so the odds shown are honest — while the solo μ cap stays pinned to the **base** anchor (capping at a target that rises with the player would be circular and let solo farming lift μ without limit).
- **AI competence** (`competenceForMu` in `game/physics.ts`): the effective μ collapses to one scalar `c ∈ [0.05, `MAX_AI_COMPETENCE` = 0.66]` driving every AI parameter (reaction time, paddle speed, aim error, wall-bounce reads, lapses), so difficulties are monotonic by construction. The dominant term is `contactError` — the aim error still present at the moment of contact — because the paddle catches anything within ~0.147 of its centre. **Per-rally, not per-tick**: the AI decides how it reads a ball once, as the ball crosses the net, and lives with that read. Re-rolling error every tick averages out to a perfect aim over a long flight, which is precisely how the pre-rewrite AI became unbeatable (Pro, Chaos and Cyber returned **100%** of balls; solo above Rookie was mathematically unwinnable). Measured AI return rates for an average player are Rookie ~56%, Pro ~76%, Cyber ~82%, giving first-to-5 match win rates of roughly 88% / 53% / 28%. The **ceiling** matters as much as the ladder: the clamp was 0.9, which let an adapted Cyber return 93% of balls — close enough to a wall that the top rung became a lottery on the AI's own error. At 0.66 nothing in the game returns more than ~85%, however good the player gets. `tests/physics.test.ts` simulates rallies through the real collision code to guard this; **no difficulty may ever return ≥88% of balls**.
- **Spin reading** (`spinRead`, capped at `MAX_SPIN_READ` = 0.85 so nobody is exempt): the AI feeds its own read into `predictLanding`, so a weak AI expects the plain mirror angle off a wall and a strong one expects the kick. Rolled **per rally** like every other read. Note the honest limitation of the impact-only model: spin only moves the AI's prediction *when a wall is actually struck*, so it is a narrower lever than a flight-curve model would be, and whether a given mis-read helps or hurts the player depends on the geometry. It is tested as prediction error (`predictLanding(ball, read)` vs the truth), which is geometry-independent, rather than as a return-rate penalty.
- **Difficulty styles** (`AI_STYLES`): strength is `c`; *style* is volatility (competence swing between rallies) and aggression (how hard it plays for the corners). `chaos` was retired — it sat between Pro and Cyber in rating but was defined by volatility rather than strength, so the ladder read as four rungs with three real difficulties. `normalizeDifficulty()` maps a stored `'chaos'` to `cyber`.
- **Mode asymmetry** (PvP is always heavier than AI): solo uses a 0.35× μ step, half the σ shrink, and a **cap** — a solo win can never push μ past the anchor it beat, so farming a weak difficulty converges on it and stops.
- **TrueSkill-2 signals** are applied to PvP only and only from data the relay owns (`room.scores`, `room.maxRallyInMatch`): margin of victory and rally quality, bounded to a 0.5–1.5 weight. Solo stats are self-reported (client-authoritative physics) and feed XP only — never rating.
- **Tiers**: `unranked` until **5 ranked games and σ ≤ 4.0**, then keyed on `rankMu` — Rookie <19 · Contender 19 · Vanguard 22 · Ace 25 · Master 28 · Grandmaster 31 · Legend 34 · Cyber Overlord ≥37. Deliberately **not** μ−3σ: a conservative rating drifts an average player two tiers upward as σ shrinks, with no change in skill.
- **XP**: `points×12 + maxRally×4 + 40 win bonus`, scaled by the surprise multiplier (win `0.6 + 1.4×(1−P)`, loss `0.20 + 0.55×(1−P)`), ×1.5 for PvP, floor 15. **Never negative — levels cannot regress.**
- **Level curve**: `band(L) = 250 + 60×(L−1)` (~2–4 matches per level). The old `120 × L^1.6` had a 120 XP first band that a single match overshot outright.
- **Match rules** (`src/matchRules.ts`, shared client+server): six physics multipliers (paddle/ball size, min/max ball speed, serve angle/power — 1 is stock) plus four presentation flags (sonar, telemetry, quick chat, auto-serve seconds). Chosen on the MainMenu for a solo match and **in the lobby for a duel**, fixed once the first ball crosses the net. Each physics rule carries a `ranked` band; tuning inside it keeps the match rated, pushing past it pays XP only. `normalizeRules()` clamps and snaps everything arriving from a client or from storage, and pins `ballSpeedMin` under `ballSpeedMax`; `normalizeRoomConfig()` does the same for a duel's terms.
- **Every match is progression.** `matchXp` carries an `XP_PLAY_BONUS` paid for finishing a match at all, the loss multiplier floors at 0.40 (was 0.20) and `XP_FLOOR` is 45 (was 15). A loss used to pay the bare floor — about 25 losses to a level, which reads as nothing. It is now 6–8.
- **Daily streak**: consecutive active days tracked on the profile.
- **Daily missions** are a **dealt hand, not a fixed list** (`src/game/missions.ts`, shared client+server). Each UTC day a player is dealt 5 from a 12-strong regular pool plus **1 from a 6-strong elite pool**, chosen by a seeded shuffle of `(playerId, dayKey)` — deterministic, so it survives a restart without being stored, and two players get different hands. State is server-owned across three day-keyed tables: `daily_mission_slots` (what you hold), `daily_missions` (progress and claims), `daily_rerolls` (what you have spent). Progress advances only inside `recordMatch`, and only for the missions actually held — advancing the whole pool would let a rerolled-away mission come back half-done. `POST /api/missions/claim` stamps `claimedAt` before paying; the primary key makes a replay a no-op. This replaced localStorage missions claimed via a client-chosen `xpDelta` on `PUT /api/profile/me`: clearing site data re-armed them all, and the endpoint could be called in a loop (verified: level 1 → 15 in ten requests). **Never add a route that takes an XP amount from the client.**
- **Rerolls**: 5 regular and 1 elite per UTC day, spent independently per tier, swapping a mission for the next one along in that player's deal order. A completed mission cannot be *paid*-rerolled — nothing to gain, a reward to lose. **Claiming one auto-rerolls its slot for free**, unlimited and charged to neither allowance: the allowances exist for missions you did not want, and finishing one is the opposite of that — every free reroll had to be earned. `fillSlot()` is shared by both paths and skips anything already held or already finished today, so a claimed mission can never be dealt back; the pool is finite, so an unusually productive day runs it dry and the claimed mission simply stays put. Both allowances live in a `dayKey`-keyed row, which *is* the expiry mechanism: a new day means a new row, so unused rerolls never bank up and a partly-spent day never carries over.
- **Elite missions are the permanent-unlock track.** Their XP is a daily reward like any other, but the first time one is ever completed it banks a row in `elite_completions` — deliberately **not** day-keyed — which unlocks a theme for good. Repeating it later pays the XP again and grants nothing further. `profile.eliteUnlocks` carries these to the client, where `isThemeUnlocked` reads them.
- **Themes** (`src/game/themes.ts`) — unlocked by default: `neon`, `retro-crt`, `midnight`, `cyberpunk`, `tennis`. Earned: `emerald-matrix` (first cross-net volley), `solar-flare` (10+ rally), `hyper-violet` (first match win), `monochrome-noir` (level 5), `quantum-gold` (25+ rally or Master tier).
- **Achievements are a branching tree AND the progression gate** (`src/achievements.ts`, shared client+server). **Eight branches, 50 nodes.** Five are open from the first match — Foundation, Rally, Ladder, Duel, Craft — and **three are concealed trees the player discovers**: Ascent (the ranked tiers; opens on a first duel), Dominion (streaks and shutouts; opens on a first shutout), Devotion (the long haul; opens at level 5). A concealed branch's tab is a lock with a hint (`BranchDef.gate`/`gateHintKey`); everything inside it is invisible until it opens — the branch itself is the silhouette. Beyond the parent rule, deep rungs can carry an `AchievementGate` — a minimum profile **level** and/or visible **tier** (`ai_pro_10` needs level 10, `cyber_10` needs Ace, `points_2000` needs level 25) — checked in `isUnlockable(id, earned, ctx)`, whose `ProgressContext` argument is deliberately required: an optional one would fail open. Gating is **strict**: a parent is never granted implicitly, because auto-granting ancestors handed out `ai_rookie` for beating Pro, a difficulty the player had never beaten. Where one result genuinely satisfies a chain (a 50-hit rally is also a 25 and a 10) the triggers fire in order and each rung opens the next. Deep rungs are `hidden` — a silhouette until their parent is earned. The counters the new rungs measure (`winStreak`/`bestWinStreak`, `shutoutsWon`, `rookieWins`/`proWins`/`cyberWins`) are **computed only inside `recordMatch`** from the result the server just accepted — a client reports a match, never a total. Achievements marked `scaled: true` — `first_win`, `shutout`, `cyber_slayer`, `duel_shutout`, `multiplayer_champ` — pay `xpReward × surpriseMultiplier`, the same multiplier the match XP uses, because the AI adapts to the player and a flat reward would pay a μ40 player the same for a Cyber win they take often as a μ25 player for one they rarely take. The award lands on `Achievement.awardedXp`. **Rally achievements stay flat on purpose**: a stronger AI returns *more* balls, so long rallies get easier as difficulty rises and scaling them would run backwards.
- **The tree gates the game** (`UNLOCKS`, `hasUnlock`): Pro is locked until you beat Rookie; **Cyber until `ai_pro_10` — ten Pro wins at level 10+**. A single Pro win used to open Cyber, which handed a first-session player the hardest opponent in the game before they had any feel for the middle rung; simulated at real win rates the climb now lands around match 21 at level 11 instead of match 2. First-to-10 is behind a first win, first-to-15 behind 10 matches. The ladder is walked, not jumped — which also means the win odds on the menu are odds the player has a basis to judge. Enforced **server-side** in `/api/match/record` (403 `DIFFICULTY_LOCKED`), not just hidden in the menu, since the menu is the client. `tests/achievements.test.ts` asserts no gate is ever locked behind something that needs it — a dead end would be unrecoverable.
- **`ACHIEVEMENT_BAND_CAP` (0.6) is what keeps progression legible.** Rewards are flat constants but level bands grow, so a value sized for the mid game lands as a windfall early — `level_10` used to pay 750 into a 790-wide band, awarding almost the whole of the level it was celebrating, and a scaled unlock times a 1.9 surprise could beat that. One budget of `0.6 × band` covers **everything a single match unlocks**, since several achievements landing together was the other route to a free level; it is measured against the level reached *after* that match's own XP applies. Level-milestone rewards are additionally held under 40% of the band they celebrate, or they feed back into themselves. Over 1440 simulated matches the only remaining two-level gains sit at levels 1–4, where the bands are narrowest; `tests/achievements.test.ts` asserts they never happen above that.

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
7. **Match settings are pre-match only, and in a duel they belong to the ROOM**: a solo match takes them from the MainMenu; a duel takes them from `RoomMatchConfig`, set by the host in the lobby and broadcast to both phones. The in-game Settings modal is device preferences only, and the HUD reset button is hidden in a duel — the score belongs to the room, so a local reset could only desync. Never read `settings.winningScore` or `settings.rules` in match code; read the derived `activeConfig`, or a phone will quietly play its own match (see §5).
8. **Username & avatar rules live in `src/profileRules.ts`** and nowhere else — both sides import them. Usernames enter the system only through `initializeProfile`/`changeUsername` (never via query params, match payloads, or WS messages).

## 10. Deployment

One Node service, one port, WebSockets on the same listener; **single-instance by design** (rooms live in process memory). Primary target: the **too-many-coins.com KVM via Dokploy** — Dokploy builds the `Dockerfile`, mounts a `phong-data` volume at `/data` (mandatory, or deploys wipe player data), and routes `phong.too-many-coins.com` through its Traefik with Let's Encrypt. The repo's `docker-compose.yml` (app + Caddy + optional coturn TURN relay, `--profile turn`) serves bare boxes without an existing proxy; the app mints time-limited TURN credentials from `TURN_STATIC_SECRET`. `render.yaml` remains as an alternative host. Env: `PORT`, `DATA_DIR`, `TURN_URL`, `TURN_STATIC_SECRET`. `SIGTERM` closes sockets (code 1001) and exits cleanly; deploys drop in-flight matches and clients auto-reconnect. Capacity: `scripts/load-test.mjs` demonstrates 10 concurrent matches with 0% loss. Full runbook: `DEPLOYMENT.md`; phone testing needs HTTPS (tunnel) — see `DEVELOPMENT.md`.
