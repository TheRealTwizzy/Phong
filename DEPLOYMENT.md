# Deploying Phong

Phong is a single Node service: Express serves the built client, the `ws` relay shares the same port, and player data lives in a SQLite file. Any host that can run a **long-lived Node process with WebSockets** works. The primary target is a **self-managed VPS/KVM** (e.g. Hostinger) behind Caddy with automatic HTTPS; a Render blueprint is kept as an alternative.

Capacity note: the relay comfortably exceeds the "5 concurrent matches" requirement — the included load test (`node scripts/load-test.mjs`) drives 10 simultaneous matches (12,000+ messages over 20s) with 0% loss and ~1ms p95 relay latency on modest hardware.

> **One-time player wipe (`wipe_v1`)**: the first deploy of this version clears ALL existing player data on the volume — profiles, matches, avatars, and the auth secret (old device cookies are retired; everyone re-onboards and picks a unique username). This runs exactly once, flagged in the DB `meta` table; later deploys never wipe. For a manual reset, stop the server and run `DATA_DIR=/data npm run db:reset -- --yes` in the container.

**Pick your path by what already runs on the box:**

- The KVM already runs **Dokploy** (or any PaaS/proxy holding ports 80/443, e.g. Traefik, CloudPanel) → use [Deploying with Dokploy](#primary-path-deploying-with-dokploy) below. Do **not** run the bundled compose stack — its Caddy will fail with `Bind for :80 failed: port is already allocated` because the existing proxy owns those ports.
- The box is **bare** (nothing on 80/443) → use [Standalone compose stack](#alternative-standalone-compose-stack-bare-box).

## Primary path: Deploying with Dokploy

The too-many-coins.com KVM runs Dokploy, whose Traefik terminates TLS for every site on the box. Phong deploys like any other Dokploy application — Dokploy builds the repo's `Dockerfile`, wires the domain into Traefik, and issues the certificate. WebSocket upgrades work through Traefik out of the box.

1. **DNS** — A record `phong` → the KVM's public IPv4 (same panel as your other subdomains).

2. **In the Dokploy dashboard** (port 3000 on the box):
   - Create a project (e.g. `phong`) → **Application**.
   - **Source**: this GitHub repository, branch `main`. Build type: **Dockerfile**.
   - **Environment**: nothing required — the Dockerfile defaults `NODE_ENV=production`, `PORT=3000`, `DATA_DIR=/data`. (Add `TURN_URL`/`TURN_STATIC_SECRET` here later if you enable TURN.)
   - **Advanced → Mounts**: add a **Volume Mount**, name `phong-data`, mount path `/data`. **This is the step that keeps player data across deploys** — skip it and every deploy silently resets profiles, ELO, and history.
   - **Domains**: add `phong.too-many-coins.com`, container port **3000**, HTTPS on (Let's Encrypt).
   - **Deploy.** Optionally enable auto-deploy on push (Dokploy sets up the GitHub webhook).

3. **Verify** — `curl -s https://phong.too-many-coins.com/api/health` returns `{"status":"ok",...}`, then the real test: two phones, create a room, scan the QR, rally across the net. The in-game badge shows `P2P` when the phones connect directly, `RELAY` otherwise.

Updating = push to `main` (with auto-deploy) or click Deploy. Backups: the SQLite file lives in the `phong-data` volume — same `VACUUM INTO` technique as below, via the container's terminal in Dokploy.

The optional coturn TURN relay can still run alongside Dokploy (it uses UDP 3478 + 49160–49200, which Traefik doesn't touch): `docker compose --profile turn up -d coturn` with `TURN_STATIC_SECRET` in `.env`, then set the same values in the Dokploy app's environment.

## Alternative: standalone compose stack (bare box)

Everything runs from `docker-compose.yml` in the repo root:

| Service | Role |
|---|---|
| `phong` | The game server (client + relay + API + SQLite at `/data` on a named volume) |
| `caddy` | Ports 80/443, automatic Let's Encrypt certificates, proxies (incl. WebSockets) to the app |
| `coturn` | *Optional* TURN relay so P2P matches connect even behind strict NATs |

### One-time setup

1. **DNS** — in your DNS panel for `too-many-coins.com`, add an **A record**: `phong` → your KVM's public IPv4. (Add an AAAA record too if the box has IPv6.)

2. **Firewall** — allow inbound **22, 80, 443**. If you'll run TURN later, also **3478 (tcp+udp)** and **udp 49160–49200**.

3. **On the KVM** (Ubuntu/Debian assumed):

   ```bash
   # Docker (skip if present)
   curl -fsSL https://get.docker.com | sh

   git clone https://github.com/TheRealTwizzy/Phong.git
   cd Phong
   cp deploy/.env.example .env
   nano .env        # set PHONG_DOMAIN (already defaults to phong.too-many-coins.com)

   docker compose up -d --build
   ```

4. **Verify** — `curl -s https://phong.too-many-coins.com/api/health` returns `{"status":"ok",...}`. Open the URL on two phones, create a room, scan the QR, rally across the net. The in-game badge shows `P2P` when the phones are connected directly, `RELAY` otherwise.

Caddy obtains the certificate on first request — DNS must already point at the box, and ports 80/443 must be reachable, or issuance fails.

**Troubleshooting: `Bind for :80 failed: port is already allocated`** — something else owns 80/443. Identify it with `ss -tlnp | grep -E ':80 |:443 '` and `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`. If it's a preinstalled Apache/nginx you don't need: `systemctl disable --now apache2` (or `nginx`). If it's a Traefik/Dokploy/panel stack you *do* use, don't remove it — switch to the Dokploy path above and skip this compose stack's Caddy entirely.

### Updating

```bash
cd Phong && git pull && docker compose up -d --build
```

The app restarts in a few seconds. In-flight matches drop and clients auto-reconnect; player data is untouched (it lives on the `phong-data` volume, not in the container).

### Enabling the TURN relay (optional)

STUN-only P2P works on most home/mobile networks; when it can't connect, matches transparently stay on the relay — so TURN is an optimization, not a requirement. To enable it:

```bash
# in .env:
#   TURN_STATIC_SECRET=$(openssl rand -hex 32)
#   TURN_URL=turn:phong.too-many-coins.com:3478
docker compose --profile turn up -d
```

The app then mints time-limited TURN credentials per client via `/api/rtc-config`; the shared secret never leaves the server.

### Backups

All player data is one SQLite file on the `phong-data` volume. Online backup without stopping anything:

```bash
docker compose exec phong node -e \
  "new (require('node:sqlite').DatabaseSync)('/data/phong.db').exec(\"VACUUM INTO '/data/backup-$(date +%F).db'\")"
docker compose cp phong:/data/backup-$(date +%F).db ./
```

Restore = copy a backup to the volume as `/data/phong.db` and `docker compose restart phong`.

A server that ran the pre-SQLite build imports its old `game_database.json` automatically on first boot if it sits in `/data`.

### Logs & health

```bash
docker compose logs -f phong     # app logs
docker compose logs -f caddy     # cert issuance, proxy errors
curl -s localhost:3000/api/health  # from the box, bypassing Caddy
```

## Alternative: Render

`render.yaml` still provisions a paid single instance with a persistent disk at `/data` (free tier can't attach disks and sleeps after 15 idle minutes). Dashboard → New → Blueprint → this repo. Same operational caveats: stop-then-start deploys, single instance by design.

## Requirements for any other host

1. Long-lived process, WebSocket upgrades on the routed port.
2. `DATA_DIR` on storage that survives deploys — otherwise every deploy wipes profiles/ELO.
   `BUILD_ID` is optional: set it to the image tag or commit sha if you have one. Left unset, the
   server derives it from the built client, which is what makes every deploy retire the sessions
   still open in the field so each client reloads onto the new build. Device cookies are untouched,
   so nobody loses an account over it — and two restarts of the same build produce the same id, so
   a crash-loop does not log anyone out.
3. Single instance (rooms live in process memory).

## Local production run

```bash
npm run build
PORT=3000 DATA_DIR=./data NODE_ENV=production npm start
```

`SIGTERM` closes sockets (code 1001) and exits cleanly — this is what `docker compose` sends on restarts.
