# Phong

A blind half-court Pong for the web. You only see your own half — the glowing top edge of your screen is the net, and when the ball crosses it, it leaves your screen and appears on your opponent's. Put two phones top-to-top on a table, connect them with a 4-character code, and the ball physically travels across both screens.

**Smartphones only.** Two phones laid top-to-top is the game; a desktop cannot play it meaningfully and a tablet is the wrong shape, so the gate reads the platform the browser reports and turns everything else away with a QR code to carry the link to a phone.

## Where you play

The menu is a **place**, not a list of modes. You walk into a building, then pick a room inside it:

- **SOLO AI** — five rungs (Rookie, Pro, Elite, Cyber, Chaos), each one a rating anchor rather than a parameter set. Each slides part-way toward your own hidden skill, so Pro stays a genuine coin flip whatever your level while Rookie stays a warm-up. The ladder is walked, not jumped: Pro opens by beating Rookie, and Chaos by ten Cyber wins at Grandmaster.
- **PVP** — skill brackets, gated at **both** ends (a Legend may not drop into BEGINNER; a bracket with only a floor is one a veteran farms). Inside a room you sit at a **table**: four seats, two playing and two watching. Casual is ungated and deliberately does **not** move the visible ladder — play for the game, not the rank.
- **TRAINING** — the **Practice Wall** (the net becomes a return line and the ball never leaves your screen) and **Split Screen** (two players, one device, a full court with the net across the middle).

There is also a **ranked queue**: it holds a 45–55% win-chance target for the first thirty seconds and widens to 20–80 by three minutes, because "never match outside a fair band" and "always find somebody" cannot both be true on a small server.

## How a match works

Everything is computed in normalized `[0, 1]` court coordinates, so any two screens agree regardless of pixels. When the ball exits across the net the **server** applies one transform — mirror `x`, negate `vx`, send `vy` downward, flip spin — and delivers it to the other phone as `ball_incoming`, so the two clients can never disagree about it.

**The paddle is an instrument, not a wall.** Swing through the ball and its motion couples into the return — hardest off the edge, softest dead-centre — adding angle, pace and **spin**. Spin does not bend the flight: it rides the ball and spends itself on impacts, kicking off side walls and paddles at angles the mirror would not give you, and it survives the trip across the net. Serving is aimed: your first finger is the paddle, a second one is a joystick, and a pull is a slingshot — the ball goes where you aimed either way.

Private matches connect the two phones **directly over WebRTC**, with the relay as automatic fallback; the in-game badge shows `P2P` or `RELAY`.

## Progression

Two separate currencies that never substitute for each other. **XP and levels** come from every match — solo included — and never go down. **Skill tier** is a TrueSkill-style rating (μ with an uncertainty σ) shown as a badge rather than a number, moved by PvP and by solo at a difficulty you had to earn, and capped per rung so farming one converges and stops. The game predicts your odds before every match and scales XP by how surprising the result was.

Beyond that: daily tasks dealt as a hand of four, a branching tree of 56 achievements across eight lines of play (three of them concealed until you stumble into them), and twenty cosmetics that retheme the **whole app** rather than the court.

## Accounts

There is no login. The server issues each browser a signed cookie on first page load and mints a profile behind it; you pick a unique username once, and onboarding ends by showing you a **recovery code** — the only thing that reunites you with your account from a browser this one cannot reach. One account has one live device at a time. You can delete your account, completely, from the Profile modal.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000 — one process serves the app and the WebSocket relay
```

Open two browser windows, create a table in one, join with the code in the other.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload (Express + Vite middleware + `ws`, one port) |
| `npm run build` | Client bundle via Vite + server, admin and moderation bundles via esbuild, into `dist/` |
| `npm start` | Run the production build (`node dist/server.cjs`) |
| `npm run lint` | TypeScript typecheck (`tsc --noEmit`) |
| `npm test` | Vitest — physics, rating, the relay's room rules, the database, the protocol |
| `npm run test:e2e` | 22 browser suites against a production build (run `npm run build` first) |
| `npm run db:backup` | Consistent snapshot via `VACUUM INTO`, verified and pruned |
| `npm run admin` | Read-only support CLI (recovery codes) |
| `npm run moderate` | The one that writes: clear an avatar, rename an account, read reports |
| `node scripts/load-test.mjs 150 20 ws://127.0.0.1:3000/ws` | Load test: N concurrent matches against the relay |

Environment variables (see `.env.example`): `PORT` (default 3000), `DATA_DIR` (default `./data` — the SQLite database lives there), optional `BUILD_ID`, and optional `TURN_URL`/`TURN_STATIC_SECRET` for the P2P TURN relay.

## Deploying

One Node service, one port, WebSockets on the same listener, and **single-instance by design** — rooms and the matchmaking queue live in process memory. Primary path: a VPS/KVM via `docker-compose.yml` (the app, Caddy with automatic HTTPS, an optional TURN relay), or Dokploy building the `Dockerfile`. A `render.yaml` blueprint is included as an alternative.

Player data is one SQLite file, so **mounting a volume at `DATA_DIR` is mandatory** and backups are part of deploying. See [DEPLOYMENT.md](DEPLOYMENT.md) for the runbook and the current capacity measurement, and [DEVELOPMENT.md](DEVELOPMENT.md) for testing on real phones (HTTPS matters).

## Reading further

[CLAUDE.md](CLAUDE.md) is the working architecture guide — what the code does and, more usefully, why, including the bugs that shaped each decision. [TESTING.md](TESTING.md) covers the two test layers and the invariants they hold.
