# Deploying Phong

Phong is a single Node service: Express serves the built client, the `ws` relay shares the same port, and player data lives in a SQLite file. Any host that can run a **long-lived Node process with WebSockets** works. The primary target is a **self-managed VPS/KVM** (e.g. Hostinger) behind Caddy with automatic HTTPS; a Render blueprint is kept as an alternative.

Capacity note: **150 concurrent matches — 300 players — at 0% message loss, p50 2ms / p95 9ms relay round trip, 0 server errors.**

```
node scripts/load-test.mjs 150 20 ws://127.0.0.1:PORT/ws
```

Measured on a 4-core / 16GB Linux box against `NODE_ENV=production node dist/server.cjs`. Read it as a floor with two honest caveats, both of which make the real number lower rather than higher: the load generator runs on the SAME box and competes for the same four cores, and its sockets are **cookieless**, so they exercise the relay and never the profile writes a real match ends with. It is a relay throughput figure, not a "300 players will be happy" figure.

The script was broken for a while and this note used to say so. It is repaired, exports `runLoadTest()`, and is now covered by a registered smoke suite (`scripts/e2e-load.mjs`, two rooms and three seconds) so the next protocol change that breaks it breaks a build instead of a claim in a document.

> **One-time player wipes (`wipe_v1` … `wipe_v4`)**: each clears ALL existing player data on the volume once — profiles, matches, avatars, and the auth secret (old device cookies are retired; everyone re-onboards and picks a unique username). Each runs exactly once, flagged in the DB `meta` table; later deploys never wipe. A database that has already been stamped with all four — which is every deployment past the rally-streak rework — sees none of them. For a manual reset, stop the server and run `DATA_DIR=/data npm run db:reset -- --yes` in the container.

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
   - **Advanced → Mounts, a SECOND one**: name `phong-backups`, mount path `/backups`. Dokploy builds the `Dockerfile` and does **not** read `docker-compose.yml`, so the `phong-backups` volume that compose declares does not exist here — you have to add it. Skipping it is quieter than skipping `/data` and just as bad: the `Dockerfile` `mkdir`s `/backups` so it is *writable inside the image layer*, the scheduler runs, snapshots appear, and every deploy throws them away. The boot log says so — `[backup] WARNING: BACKUP_DIR is not a mounted volume — every snapshot is written inside the container and destroyed by the next deploy` — which is the only way to catch it, since the directory exists, is writable, and every snapshot verifies. A **bind mount** to a host path works just as well as a named volume here; what matters is that something is mounted at `/backups` at all. A separate `[backup] note:` line about sharing a filesystem with `DATA_DIR` is not that alarm — it is true of a perfectly good bind mount on the same disk, and it is saying that one disk loss takes both copies, which is what offsite covers.
   - **Domains**: add `phong.too-many-coins.com`, container port **3000**, HTTPS on (Let's Encrypt).
   - **Advanced → Replicas: leave it at 1.** This is not a performance
     preference, it is a correctness requirement, and Dokploy will happily let
     you raise it. Rooms, the matchmaking queue and every live socket live in
     **process memory** — the app is single-instance by design (CLAUDE.md §10)
     — so a second replica gets its own empty room map behind the same domain.
     Two phones typing the same 4-letter code land on different instances and
     the second is told "room not found"; a queued player is only ever paired
     with somebody the load balancer sent to the same process. Nothing crashes
     and nothing logs, which is what makes it worth writing down here.
   - **Deploy, and turn AUTO-DEPLOY ON** (Dokploy sets up the GitHub webhook). It is on for `phong.too-many-coins.com`, and CLAUDE.md convention §17 is built on that: a merge to `main` IS a release, which is why every pull request has to carry a `PATCH_NOTES` entry and a version bump. Leave it off and that rule silently becomes aspirational — the notes say a version shipped while the build in front of players is whatever was last deployed by hand.

3. **Verify** — `curl -s https://phong.too-many-coins.com/api/health` returns `{"status":"ok",...}`, then the real test: two phones, create a room, scan the QR, rally across the net. The in-game badge shows `P2P` when the phones connect directly, `RELAY` otherwise.

Updating = merge to `main`, which deploys. (Or click Deploy, if auto-deploy is ever off.) Backups: set `BACKUP_ENABLED=1` in the app's environment and add the `/backups` mount above; the server then snapshots itself daily and, with `BACKUP_S3_*` set, ships each one offsite. See [Backups](#backups) — it is the only setting in this runbook whose absence is unrecoverable.

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

The app restarts in a few seconds. In-flight matches drop and the players in them are returned to the menu with a notice — they do NOT auto-reconnect, and nothing in the client ever did; player data is untouched (it lives on the `phong-data` volume, not in the container).

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

**The server backs itself up**, and that is the whole of the schedule on the
Docker deployments — there is no cron to install. It is **off until you turn it
on**, deliberately: pasting credentials in to check them should not also start
uploading the player database.

```bash
BACKUP_ENABLED=1          # off unless set. the only required one
BACKUP_DIR=/backups       # already set in the Dockerfile. MUST NOT be inside DATA_DIR
BACKUP_KEEP=14            # LOCAL snapshots. not the offsite retention — see below
BACKUP_INTERVAL_HOURS=24
```

The boot log says what it is going to do, which is the point of printing it at
all — the day you discover the schedule was never armed must not be the day you
need a restore:

```
[backup] on: /backups, keep 14, every 24h. First check in 2m.
[backup] offsite: s3://my-bucket/phong/ @ https://s3.example.com (path-style, us-east-1)
[backup] last verified snapshot 3h ago; last offsite upload 3h ago.
```

`node /app/dist/admin.cjs backups` answers the same question later, from inside
the container. It is deliberately **not** on `/api/health`: that route is
unauthenticated and unmetered, and a bucket name plus the time of the last
backup is free reconnaissance.

Three things about the cadence are decisions rather than details:

- **The timer is not the schedule.** A `setInterval(…, 24h)` would very likely
  never fire once — this project force-refreshes every session on every
  deployment, deployments restart the process, and a daily timer restarted every
  few hours never elapses. So the schedule is persisted in the `meta` table
  (`backup_attempt_at`, `backup_ok_at`, `backup_upload_ok_at`) and the timer only
  asks whether it is due. Those rows live in `DATA_DIR`, on purpose: `BACKUP_DIR`
  is the thing that may be ephemeral, and a stamp that vanishes makes every boot
  "due", which on a crash-loop is a backup storm.
- **The attempt is stamped before the child runs**, which is also the log rate
  limit: a standing misconfiguration produces at most 24 failure lines a day
  rather than 96, and a container crash-looping every 30 seconds attempts at
  most hourly.
- **A snapshot that verified but did not upload is a successful local backup.**
  The two are stamped separately, so a broken bucket does not make the server
  re-run the vacuum hourly for a problem the vacuum cannot fix.

#### Offsite

**A backup that never leaves the host is not a backup**, because losing the host
is the likeliest thing you are recovering from — and a second Docker volume
survives a wiped `phong-data`, a changed mount and a full data disk, but not the
machine. With these set, each verified snapshot is `PUT` to an S3-compatible
bucket immediately after it is taken:

```bash
BACKUP_S3_ENDPOINT=https://s3.<region>.<provider>.com   # empty = offsite off
BACKUP_S3_BUCKET=my-phong-backups
BACKUP_S3_REGION=us-east-1
BACKUP_S3_PREFIX=phong/
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
```

Signing is SigV4 in-repo (`server/sigv4.ts`) rather than an SDK: the runtime
dependency list is exactly `express` and `ws`, the privacy notice's "no
third-party anything" is enforced against it by `tests/legal.test.ts`, and one
`PUT` does not justify spending that. Path-style addressing by default, so
MinIO, R2, B2, Garage, Wasabi and Spaces all work; set
`BACKUP_S3_VIRTUAL_HOST=1` only if your provider insists on `bucket.endpoint`.

Four things worth getting right:

- **Use a PutObject-only credential.** A key that can delete means an attacker
  who reaches this server can erase the backups — which is precisely the
  scenario offsite backup exists for. There is no `DeleteObject` and no list
  call anywhere in this codebase, and there must never be one.
- **`BACKUP_KEEP` is local retention only.** Nothing here ever deletes an
  object. Offsite retention is a **bucket lifecycle rule** you configure with
  your provider; without one the bucket grows forever, and if you assume the
  14 applies there you will be wrong in whichever direction hurts.
- **Objects are not encrypted by this server.** Whoever holds the bucket holds
  every player's username, avatar bytes and match history. That is an accepted
  trade for a private bucket and a write-only key — say so to yourself
  deliberately rather than discovering it later. `BACKUP_S3_SSE=AES256` turns on
  the provider's own at-rest encryption where it is offered.
- **There is no fallback to `AWS_ACCESS_KEY_ID`.** Ambient credentials on a
  build host must never silently begin shipping the player database somewhere.

A failed upload logs the HTTP status and the S3 error code and nothing else —
never the credential, never the `Authorization` header, never the response body
(gateways echo request headers into error pages):

```
[backup] offsite upload failed (403 SignatureDoesNotMatch) — snapshot is on disk at /backups/phong-2026-09-01T04-17-02-113Z.db
```

The second half of that line is the point: the local backup succeeded, and it
names the file so you can ship it by hand while you fix the bucket.

#### The script itself

`scripts/backup.mjs` is what the scheduler runs, in a child process, and it is
still the right thing to run by hand during an incident:

```bash
docker compose exec phong node scripts/backup.mjs --out /backups --keep 14
```

It is spawned rather than imported for three reasons, each sufficient: it is
top-level straight-line code that `process.exit(1)`s on four paths;
`PRAGMA integrity_check` is synchronous and walks the whole file, so in-process
it would stall every live match and get worse as the game succeeds; and
`server.ts` turns an unhandled rejection into a full shutdown. It also **ships
nothing anywhere** — the uploader lives beside it, not in it, so that
`npm run db:backup`, run inside a production container where the credentials are
live, cannot be the command that pushes an object somewhere by accident.

**`/backups` has to be mounted.** This command shipped once with nothing mounted
there and could not work at all: the container runs as the unprivileged `node`
user and `/` is root-owned, so it died on `EACCES: permission denied, mkdir
'/backups'` — a raw stack trace in a cron log, and an operator following this
runbook exactly ended up with no backups. `docker-compose.yml` mounts a **named
volume** (`phong-backups`) rather than a bind mount so this works with no
host-side setup; **Dokploy does not read that file**, which is why the setup
above adds the mount by hand.

To put backups on a host path instead — worth doing if you would rather ship
them with `rsync`/`restic`/`rclone` than to a bucket — swap the mount for
`- ./backups:/backups` and create it first, or Docker will make it root-owned
and you are back to `EACCES`:

```bash
mkdir -p backups && sudo chown 1000:1000 backups   # 1000 is the `node` user
```

It uses `VACUUM INTO`, which takes a read transaction — WAL readers never block
the writer, so this is safe against a live server and folds the WAL into the
copy. **`cp phong.db` is not equivalent**: it races the WAL and can produce a
file that opens fine and is missing the newest writes.

Four things it does that the old hand-rolled one-liner did not:

- **Writes outside `DATA_DIR`, and refuses not to** — `DATA_DIR` itself
  included, which the first version let through: it tested only for a path
  *below* the directory, so `--out $DATA_DIR`, the likeliest way to get this
  wrong by hand, wrote the snapshot straight beside `phong.db` and exited 0.
  The comparison is on REAL paths too, since `--out /backups` where `/backups`
  is a symlink into the data volume compares as somewhere else entirely while
  `VACUUM INTO` follows the link; a destination that does not exist yet is
  resolved through its nearest existing parent. A
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
- **Exits non-zero on any failure**, so a scheduler notices. That contract is
  what the in-process scheduler consumes, and `tests/backupRun.test.ts` drives
  the real script in CI — which it had never had before, since `npm test` does
  not touch `scripts/`, `tsc` does not read `.mjs`, and `lint:suites` polices
  only `e2e-*.mjs`.

#### A host cron, if you still want one

The in-process scheduler makes this optional, and mostly it is not worth the
second moving part. It has exactly one honest advantage, which is real: **it
runs while the app is crash-looping and the in-process scheduler does not.** A
container that boots, throws and restarts never reaches its first tick, and that
is a state you might sit in for a day.

```cron
17 4 * * * docker compose -f /path/to/docker-compose.yml exec -T phong \
  node scripts/backup.mjs --out /backups --keep 14 >> /var/log/phong-backup.log 2>&1
```

Running both is safe — the snapshots are timestamped to the millisecond and the
prune is oldest-first — but set `BACKUP_KEEP` high enough that a cron run does
not evict the day's scheduled one.

#### Restore

The only test that matters, and the one nobody has run when they need it.
**Practise it once, now, on a throwaway container.**

From a local snapshot:

```bash
# 1. verify the copy BEFORE you touch anything live
sqlite3 backups/phong-2026-09-01T04-17-02-113Z.db 'PRAGMA integrity_check'
# 2. stop the server
docker compose stop phong
# 3. put it in place, and clear the stale WAL beside it — a -wal/-shm left from
#    the old database is journal for a file that no longer exists
docker compose run --rm -v "$PWD/backups:/restore" phong sh -c \
  'cp /restore/phong-2026-09-01T04-17-02-113Z.db /data/phong.db && rm -f /data/phong.db-wal /data/phong.db-shm'
# 4. start, and read the boot line
docker compose start phong
docker compose logs phong | grep '\[db\]'
```

That last line is the confirmation: `[db] /data/phong.db — 412KB, 87 account(s),
95 row(s) incl. bots`. An account count of zero means you restored an empty
file.

From the bucket, which is the case that actually happens — the host is gone and
you are standing up a new one:

```bash
# any S3 client; the AWS CLI is easiest and is not a dependency of this project
aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 ls "s3://$BACKUP_S3_BUCKET/phong/"
aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 cp \
  "s3://$BACKUP_S3_BUCKET/phong/phong-2026-09-01T04-17-02-113Z.db" ./restore.db

# verify the DOWNLOADED copy, not the one in the bucket
sqlite3 ./restore.db 'PRAGMA integrity_check'
sqlite3 ./restore.db 'SELECT COUNT(*) FROM players'
```

...then step 2 onward above. Note that the credential in your environment is
PutObject-only if you followed the advice above, so **`ls` and `cp` will be
denied by it** — that is the point, and you use your own admin credential for a
restore. Check that you can, before you need to.

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
