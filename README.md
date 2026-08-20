# Phong

A blind half-court Pong for the web. Each player sees only their own half of the court — the glowing top edge of the screen is the net, and when the ball crosses it, it leaves your screen and appears on your opponent's. Place two phones top-to-top on a table, connect them with a 4-letter room code, and the ball physically travels across both screens.

Also playable solo against an adaptive AI (Rookie → Chaos) and in a split-screen dual-court simulator on one device.

Private matches connect the two phones **directly over WebRTC** (peer-to-peer DataChannels) with the server relay as automatic fallback — the in-game badge shows `P2P` or `RELAY`. Profiles, ELO, and match history persist in SQLite on the server.

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
