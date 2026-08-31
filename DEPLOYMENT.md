# Deploying Phong

Phong is a single Node service: Express serves the built client, the `ws` relay shares the same port, and player data lives in a SQLite file. Any host that can run a **long-lived Node process with WebSockets** works. The primary target is a **self-managed VPS/KVM** (e.g. Hostinger) behind Caddy with automatic HTTPS; a Render blueprint is kept as an alternative.

Capacity note: **there is no current measurement.** This line used to cite `node scripts/load-test.mjs` for "10 simultaneous matches, 0% loss, ~1ms p95". That script stopped working when the lobby handshake landed — it waits for a `game_start` that no longer follows a join, having never sent `player_ready` or `start_match` — so it dies on the first pair, and nothing in CI or the test suites covers it. The figure is removed rather than left standing; repair the script before quoting a number from it.

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

**Every account, rating, level, achievement and match in Phong is one SQLite
file.** Losing it is unrecoverable and nothing else in this runbook matters as
much, so treat the schedule below as part of deploying rather than as an
afterthought.

`scripts/backup.mjs` takes a consistent snapshot of a running server, verifies
it, and prunes old ones:

```bash
docker compose exec phong node scripts/backup.mjs --out /backups --keep 14
```

It uses `VACUUM INTO`, which takes a read transaction — WAL readers never block
the writer, so this is safe against a live server and folds the WAL into the
copy. **`cp phong.db` is not equivalent**: it races the WAL and can produce a
file that opens fine and is missing the newest writes.

Three things it does that the old hand-rolled one-liner did not:

- **Writes outside `DATA_DIR`, and refuses not to** — `DATA_DIR` itself
  included, which the first version let through: it tested only for a path
  *below* the directory, so `--out $DATA_DIR`, the likeliest way to get this
  wrong by hand, wrote the snapshot straight beside `phong.db` and exited 0. A
  backup on the volume it protects is lost with that volume, which is the exact
  failure it exists for. On Render that disk is also 1GB with no retention, so
  snapshots accumulating beside the database eventually take the live database
  down too.
- **Prunes only files it made itself.** The pattern is the exact timestamp shape
  it writes, not `phong-*.db`: a hand-made `phong-before-upgrade.db` in the same
  directory used to count toward `--keep` and sort *after* every ISO stamp, so
  it took the newest slot and real backups were deleted in its place — three
  backups at `--keep 2` left one. Put your own snapshots there safely.
- **Opens the snapshot and runs `PRAGMA integrity_check`** before reporting
  success, and prints the row count. A backup nobody has opened is a backup
  nobody knows is good.
- **Exits non-zero on any failure**, so a scheduler notices.

It deliberately does not ship the file anywhere — where backups belong is a
deployment decision. Mount a host directory at `/backups` and copy it offsite,
or wrap it in `restic`/`rclone`. **A backup that never leaves the host is not a
backup**, because the most likely thing you are recovering from is losing the
host.

Schedule it. On the Dokploy KVM, a nightly cron on the host:

```cron
17 4 * * * docker compose -f /path/to/docker-compose.yml exec -T phong \
  node scripts/backup.mjs --out /backups --keep 14 >> /var/log/phong-backup.log 2>&1
```

**Restore**: stop the server, copy a snapshot to the volume as
`/data/phong.db`, remove any stale `phong.db-wal` / `phong.db-shm` beside it,
and start again. The boot log names the file it opened and counts the accounts
in it (`[db] /data/phong.db — …, N account(s)`), which is how you confirm the
restore took. Practise this once before you need it.

## Support: an account somebody can't get back into

Identity is bound to the browser's device cookie, so "I lost my account" is a
standing category of support request rather than a bug that gets fixed once — a
cleared cookie jar, a new phone, an invitation link opened in a chat app's
webview. The account is intact and merely unreachable, and its **recovery code**
is what reunites them. A read-only CLI ships in the image:

```bash
# in the container's terminal (Dokploy → the app → Terminal)
node /app/dist/admin.cjs whois WeinerSmasher420   # recovery code, history, verdict
node /app/dist/admin.cjs orphans                  # accounts that look unreachable
```

Two things about that shell, both of which look like the tool is broken and
are not. Pick **`/bin/sh`**, not Bash: the runtime stage is `node:22-alpine`
and there is no bash in it (`exec: "bash": executable file not found`). And
use the **absolute path**: the Dockerfile's `WORKDIR /app` applies to the
container's own process, not to an exec'd shell, which starts at `/` — so a
relative `node dist/admin.cjs` looks for `/dist/admin.cjs` and reports
`MODULE_NOT_FOUND`. If `ls /app/dist` shows no `admin.cjs` at all, the
running image predates the CLI and needs a redeploy.

The player enters the code under *"Have a recovery code from another device?"*
in onboarding, and the account moves onto the browser they are using now.

Three things to know before handing one over:

- **A recovery code transfers the account to whoever types it.** Treat it like a
  password: confirm who you are talking to, and send it over a channel you trust.
- **Claiming deletes the claiming device's current profile row.** A player who
  has since built up a replacement account loses it, so sequence deliberately.
- **`orphans` is circumstantial.** A player who onboarded and never came back
  looks identical to one whose browser lost the cookie; the server cannot see
  which cookie a browser holds. Confirm with the player.

The tool opens the database `readOnly` and has no write path — safe against a
live server, since WAL readers never block the writer. It deliberately does not
import `server/db.ts`, whose constructor would run migrations and seed the bot
roster as a side effect of answering a question.

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
   server derives it from the built artifacts — the client's `index.html` and the server bundle
   together, so a server-only deploy moves it too — which is what makes every deploy retire the
   sessions still open in the field so each client reloads onto the new build. Device cookies are untouched,
   so nobody loses an account over it — and two restarts of the same build produce the same id, so
   a crash-loop does not log anyone out.
3. Single instance (rooms live in process memory).

## Local production run

```bash
npm run build
PORT=3000 DATA_DIR=./data NODE_ENV=production npm start
```

`SIGTERM` closes sockets (code 1001) and exits cleanly — this is what `docker compose` sends on restarts.
