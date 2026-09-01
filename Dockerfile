# ---- build stage: compile client bundle + server bundle ----
# The MAJOR is the pin, deliberately, and it is a considered choice rather
# than an oversight. Pinning the minor would stop this image picking up
# security patches within 22.x, which for a public-facing server is a worse
# trade than the reproducibility it buys; Node LTS minors are
# backwards-compatible, and `node:sqlite` — the one runtime API this depends
# on — is a 22.x feature. If byte-reproducibility ever matters more than
# patching, the answer is a digest pin (`node:22-alpine@sha256:...`) and a bot
# to bump it, not a minor tag that ages silently.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime stage: only production deps (express, ws) + dist ----
FROM node:22-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# The backup tool ships with the image, or the documented
# `docker compose exec phong node scripts/backup.mjs` has no file to run.
# It is dependency-free (node:sqlite + node:fs) so it needs nothing else.
COPY scripts/backup.mjs ./scripts/backup.mjs
# /backups exists in the IMAGE so that the named volume compose mounts there
# initializes writable: Docker seeds a fresh named volume from the image path,
# ownership included. Without it the documented
# `docker compose exec phong node scripts/backup.mjs --out /backups` died on
# `EACCES: permission denied, mkdir '/backups'` — the container runs as the
# unprivileged `node` user and / is root-owned — so an operator following the
# runbook got a stack trace and no backups.
RUN mkdir -p /data /backups && chown -R node:node /app /data /backups
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/server.cjs"]
