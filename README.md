# Phong

A blind half-court Pong for the web. Each player sees only their own half of the court — the glowing top edge of the screen is the net, and when the ball crosses it, it leaves your screen and appears on your opponent's. Place two phones top-to-top on a table, connect them with a 4-letter room code, and the ball physically travels across both screens.

The main menu offers four modes: **Solo AI** (adaptive Rookie → Chaos opponent on the hidden half), **Practice Wall** (fully solo — the net becomes a return line that bounces every ball back, ball never leaves your screen), **Split Screen** (2 players on one device, classic full court with the net across the middle — offline and unranked), and the **2-Phone Duel**. Match settings (difficulty, points to win) are locked in before each match starts.

Private matches connect the two phones **directly over WebRTC** (peer-to-peer DataChannels) with the server relay as automatic fallback — the in-game badge shows `P2P` or `RELAY`. Profiles, ELO, and match history persist in SQLite on the server, keyed to a **server-issued device identity** (signed cookie — one profile per device, no login) with a recovery code to move your profile to a new phone.

The AI ladder is **rating-based and adaptive**: each difficulty is an anchor rating that slides part-way (60%) toward your own hidden skill, so Pro stays a genuine coin flip whatever your level and Cyber stays a stretch that becomes reachable as you improve — while Rookie always stays a warm-up. Skill is tracked with a **TrueSkill-style rating** (skill μ + uncertainty σ): the game predicts your odds before every match, scales XP by how surprising the result was, and shows a **tier badge** rather than a raw number. Solo play levels your profile and moves your hidden rating, but only 2-phone matches move your rank.

Progression is server-owned: daily missions live in the database on a UTC day key and are claimed by id, and achievements that mean "you beat something" pay out scaled by the same prediction the match XP uses. Every player locks in a **unique username** on first arrival (case-insensitive, held for 365 days per change) and can upload an **avatar** (auto-cropped to 256×256). Tap any username — leaderboard, match history, lobby, or mid-match — to view that player's public profile.

> **Note:** the next deploy of this version performs a **one-time player wipe** (`wipe_v1`) — the game relaunches with 0 players; bots return later. `npm run db:reset -- --yes` (server stopped) is the manual equivalent.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000 — one process serves the app and the WebSocket relay
```

Open two browser windows, create a room in one (2-Phone mode), join with the code in the other.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload (Express + Vite middleware + `ws`, one port) |
| `npm run build` | Client bundle via Vite + server bundle via esbuild, both into `dist/` |
| `npm start` | Run the production build (`node dist/server.cjs`) |
| `npm run lint` | TypeScript typecheck (`tsc --noEmit`) |
| `npm test` | Vitest unit tests (physics, net transform, database) |
| `node scripts/load-test.mjs` | Load test: N concurrent matches against the relay |

Environment variables (see `.env.example`): `PORT` (default 3000), `DATA_DIR` (default `./data` — the SQLite database lives there), and optional `TURN_URL`/`TURN_STATIC_SECRET` for the P2P TURN relay.

## Deploying

Primary path: **your own VPS/KVM** via `docker-compose.yml` — the app, Caddy with automatic HTTPS for your domain, and an optional TURN relay, in three commands. A `render.yaml` blueprint for [Render](https://render.com) is included as an alternative. See [DEPLOYMENT.md](DEPLOYMENT.md) for the runbook (DNS, firewall, backups) and [DEVELOPMENT.md](DEVELOPMENT.md) for testing on real phones (HTTPS matters).

## How it works

Everything is computed in normalized `[0, 1]` court coordinates so any two screens agree. When the ball exits across the net, the server applies one transform — mirror `x`, negate `vx`, send `vy` downward, flip spin — and delivers it to the opponent as `ball_incoming`. Full architecture notes live in [CLAUDE.md](CLAUDE.md).
