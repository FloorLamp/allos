# Multi-stage build for the Next.js app. glibc base (bookworm-slim), which is what
# better-sqlite3's `linux-*` prebuilt addons are built against — an Alpine/musl base
# would need the `linuxmusl-*` ones instead.
#
# Since better-sqlite3 v13 the addon is N-API and nothing here compiles it: the
# package declares `gypfile: false` and ships no install script, so npm neither runs
# node-gyp nor downloads anything. The eight prebuilt binaries arrive inside the
# tarball itself and one is picked at require() time by platform+arch. That means
# there is no source-build fallback: an addon that doesn't load is a hard failure,
# not a slow install. The prune step below turns that into a build-time check.

# ---- builder ----
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Install deps first (better layer caching). No toolchain needed — see above.
COPY package.json package-lock.json ./
RUN npm ci

# Build the app, then drop dev dependencies (keeps the native addon).
COPY . .
# Ensure public/ exists even if the repo ships no static assets — the runner
# stage COPYs it unconditionally and buildx errors on a missing source path.
#
# Also bundle the notification scheduler into one self-contained CJS file so the
# runtime can run it with plain `node` — the runner image drops tsx (a devDep)
# and never copies scripts/lib source, so `npm run notify` wouldn't work there.
# better-sqlite3 stays external (native addon, resolved from node_modules at
# runtime). Must run before `npm prune --omit=dev`, while esbuild (via tsx) is
# still present.
RUN mkdir -p public \
  && npm run build \
  && npx esbuild scripts/notify.ts --bundle --platform=node --target=node20 \
       --format=cjs --external:better-sqlite3 --outfile=dist/notify.cjs \
  && npm prune --omit=dev

# Trim better-sqlite3 to what this image actually runs: one of the eight prebuilt
# addons (~17MB the set), and none of the SQLite amalgamation it no longer compiles
# (~10MB). 27MB -> ~2MB in the node_modules the runner stage copies. The target name
# is the same platform+arch rule the package's own subpath exports are keyed on.
#
# The require() is the point, not a flourish: with the source-build fallback gone, a
# prune that broke resolution would otherwise surface as a container that won't boot.
# Here it fails the build.
RUN BS3=/app/node_modules/better-sqlite3 \
  && TARGET="$(node -p "(process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? 'linuxmusl' : process.platform) + '-' + process.arch")" \
  && test -f "$BS3/prebuilds/$TARGET.node" \
  && find "$BS3/prebuilds" -name '*.node' ! -name "$TARGET.node" -delete \
  && rm -rf "$BS3/deps" "$BS3/src" "$BS3/binding.gyp" \
  && node -e "new (require('better-sqlite3'))(':memory:').prepare('select sqlite_version()').get()"

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
# builder, so the one better-sqlite3 prebuild left in node_modules is the one this
# stage resolves — and being N-API, it is ABI-stable across Node versions besides.
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
