# Deploying Phong

Phong is a single Node service: Express serves the built client, and the `ws` WebSocket relay shares the same HTTP server and port. Any host that can run a **long-lived Node process with WebSockets** works; static hosts (GitHub Pages, plain Netlify) and serverless-only platforms do not. The repo ships a blueprint for **Render**, chosen because a persistent disk plus single instance matches this app's design exactly.

## Render (recommended path)

`render.yaml` in the repo root defines everything:

- **Web service `phong`**, Node runtime, `npm ci && npm run build` → `npm start`.
- **Starter (paid) plan** — persistent disks require a paid instance.
- **1 GB disk mounted at `/data`**, with `DATA_DIR=/data` so `game_database.json` (profiles, ELO, match history, achievements) survives every deploy.
- **Health check** on `/api/health`.

### First deploy

1. Merge to `main` on GitHub.
2. In the Render dashboard: **New → Blueprint**, pick this repository, confirm. Render reads `render.yaml` and provisions the service and disk.
3. That's it — there are no secrets to configure. The service needs no API keys.
4. Open the service URL on two phones, create a room on one, scan the QR with the other.

Subsequent pushes to `main` auto-deploy.

### Operational facts worth knowing

- **A deploy restarts the service** (stop-then-start, not zero-downtime): Render never runs two instances against one disk, which protects the database but means **in-flight matches drop on deploy**. Clients reconnect automatically; the room is gone. Deploy when nobody's mid-match.
- **Single instance is by design.** Rooms live in server memory, so the service must not scale horizontally. The disk enforces this — Render refuses to scale a disk-backed service past one instance. If Phong ever needs more, rooms move to Redis and the JSON store moves to a real database first.
- **PORT is injected by Render** and the server binds `0.0.0.0:$PORT`. WebSocket upgrades ride the same port — no extra configuration.
- **The client needs no environment at all**: it derives `wss://…/ws` and all API paths from `window.location`.

### Backing up the database

The whole game state is one file. From the Render shell tab:

```bash
cat /data/game_database.json
```

Copy it somewhere safe (or add a cron job that POSTs it to storage). Restoring = writing the file back and restarting. Writes are atomic (`.tmp` + rename), so the file on disk is never half-written.

### Verifying a deploy did not lose data

After any deploy: `GET /api/leaderboard` should show the same players as before. If it ever comes back as just the seeded bots, the service is writing to the container filesystem instead of the disk — check that `DATA_DIR=/data` is set and the disk is attached.

## Other hosts

The app is host-agnostic as long as three requirements hold:

1. **Long-lived process** with WebSocket support on the routed port.
2. **`DATA_DIR` pointing at storage that survives deploys** — otherwise every deploy silently wipes all player progress.
3. **Single instance** (or sticky routing plus shared room state, which this codebase does not implement).

Fly.io (volume + `min_machines_running=1`) and Railway (volume) both fit. Cloud Run does not fit well: it wants to scale horizontally and to zero, both of which break in-memory rooms; forcing it into shape costs more than it saves.

## Local production run

```bash
npm run build
PORT=3000 DATA_DIR=./data NODE_ENV=production npm start
```

`GET /api/health` → `{"status":"ok","activeRooms":0}` confirms the service is up. The server shuts down cleanly on SIGTERM (closes sockets with code 1001, stops the listener), which is what Render sends on deploys.
