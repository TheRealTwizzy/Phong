# Deploying Phong

Phong is a single Node service: Express serves the built client, the `ws` relay shares the same port, and player data lives in a SQLite file. Any host that can run a **long-lived Node process with WebSockets** works. The primary target is a **self-managed VPS/KVM** (e.g. Hostinger) behind Caddy with automatic HTTPS; a Render blueprint is kept as an alternative.

Capacity note: the relay comfortably exceeds the "5 concurrent matches" requirement — the included load test (`node scripts/load-test.mjs`) drives 10 simultaneous matches (12,000+ messages over 20s) with 0% loss and ~1ms p95 relay latency on modest hardware.

## Primary path: your KVM at phong.too-many-coins.com

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
3. Single instance (rooms live in process memory).

## Local production run

```bash
npm run build
PORT=3000 DATA_DIR=./data NODE_ENV=production npm start
```

`SIGTERM` closes sockets (code 1001) and exits cleanly — this is what `docker compose` sends on restarts.
