# ---- build stage: compile client bundle + server bundle ----
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
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/server.cjs"]
