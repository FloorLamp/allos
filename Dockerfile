# Multi-stage build for the Next.js app. glibc base (bookworm-slim) — safer than
# Alpine/musl for the native better-sqlite3 module. The C toolchain lives only in
# the builder; the runtime image carries just the compiled output.

# ---- builder ----
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Build deps for better-sqlite3's native addon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install deps first (better layer caching); npm ci compiles better-sqlite3.
COPY package.json package-lock.json ./
RUN npm ci

# Build the app, then drop dev dependencies (keeps the compiled native binary).
COPY . .
# Ensure public/ exists even if the repo ships no static assets — the runner
# stage COPYs it unconditionally and buildx errors on a missing source path.
#
# Also bundle the notification scheduler into one self-contained CJS file so the
# runtime can run it with plain `node` — the runner image drops tsx (a devDep)
# and never copies scripts/lib source, so `npm run notify` wouldn't work there.
# better-sqlite3 stays external (native addon, resolved from node_modules at
# runtime). Must run before the prune, while esbuild (via tsx) is still present.
RUN mkdir -p public \
  && npm run build \
  && npx esbuild scripts/notify.ts --bundle --platform=node --target=node20 \
       --format=cjs --external:better-sqlite3 --outfile=dist/notify.cjs \
  && npm prune --omit=dev

# ---- runner ----
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# The commit the image was built from. `.git` is excluded from the build
# context (see .dockerignore), so the app can't read it at runtime — bake it in
# here from a build arg (the deploy workflow passes github.sha) and expose it as
# env vars the UI reads via lib/version.ts. Unset in a plain `docker build`,
# which is fine: the UI just shows "unknown".
ARG COMMIT_SHA=""
ENV COMMIT_SHA=$COMMIT_SHA
ARG COMMIT_MESSAGE=""
ENV COMMIT_MESSAGE=$COMMIT_MESSAGE

# gosu lets the entrypoint drop from root to the app user after fixing up the
# (bind-mounted) data dir's ownership.
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

# Copy the pruned production install + build output. Same base image/arch as the
# builder, so the compiled better-sqlite3 .node binary is ABI-compatible.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.js ./next.config.js
# The bundled notification scheduler (run by `node dist/notify.cjs`).
COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY docker-notify.sh /usr/local/bin/docker-notify.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-notify.sh

# Default ownership for the in-image dir; a bind mount's host ownership wins, so
# the entrypoint re-chowns it at startup before dropping to the node user.
RUN mkdir -p /app/data && chown -R node:node /app

EXPOSE 3000
# Runs as root only long enough to chown the data dir, then execs as node.
# next start honors PORT; default 3000.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
