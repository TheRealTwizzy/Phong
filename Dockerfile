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
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/server.cjs"]
