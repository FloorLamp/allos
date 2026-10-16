# Multi-stage build for the Next.js app. glibc base (bookworm-slim), which is what
# better-sqlite3's `linux-*` prebuilt addons are built against — an Alpine/musl base
# would need the `linuxmusl-*` ones instead.
#
# Since better-sqlite3 v13 the addon is N-API and nothing here compiles it: the eight
# prebuilt binaries arrive inside the tarball itself and one is picked at require()
# time by platform+arch. `npm ci` still runs node-gyp over it, though — see the
# toolchain layer below for why that is not a contradiction. What it does mean is that
# there is no source build to fall back on in practice: an addon that doesn't load is
# a hard failure, not a slow install. The prune step below turns that into a
# build-time check.

# ---- builder ----
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS builder
WORKDIR /app

# node-gyp's prerequisites, needed by `npm ci` below and nothing else in this image.
#
# npm synthesizes the default `node-gyp rebuild` install script for any package that
# has a binding.gyp on disk. better-sqlite3 ships one (it is listed in the package's
# `files`), so `npm ci` — which extracts first and decides from the extracted tree —
# always runs it. `gypfile: false` and the absent install script only steer
# `npm install`, which decides from the packument before extracting. That asymmetry is
# the trap: a local `npm install` of the same lockfile looks entirely toolchain-free.
#
# What actually runs is a configure and a make, not a compile. binding.gyp shells out
# to `node lib/binding.js`, finds the host prebuild, and emits `type: none` for both
# of its targets — so this layer buys ~80KB of makefiles and stamps, and no .node.
# python3 and make are what node-gyp needs to get that far; g++ is for the case where
# the prebuild check comes back empty and a real compile is the only thing standing
# between us and an image that cannot open a database.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install deps first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci

# Build the standalone app and bundled runtime tools.
COPY . .
# Ensure public/ exists even if the repo ships no static assets — the runner
# stage COPYs it unconditionally and buildx errors on a missing source path.
#
# Also bundle the notification scheduler into one self-contained CJS file so the
# runtime can run it with plain `node` — the runner image omits tsx (a devDep),
# so `npm run notify` would not work there.
# better-sqlite3 stays external (native addon, resolved from node_modules at
# runtime). esbuild (via tsx) is available only in the builder.
# NODE_OPTIONS also reaches Next's TypeScript subprocess, unlike Node CLI flags.
RUN mkdir -p public \
  && NODE_OPTIONS=--max-old-space-size=4096 npm run build \
  && npx esbuild scripts/notify.ts --bundle --platform=node --target=node20 \
       --format=cjs --external:better-sqlite3 --alias:next/cache=./scripts/tool-cache.ts --outfile=dist/notify.cjs \
  && npx esbuild scripts/restore-check.ts --bundle --platform=node --target=node24 \
       --format=cjs --external:better-sqlite3 --alias:next/cache=./scripts/tool-cache.ts --outfile=dist/restore-check.cjs \
  && npx esbuild scripts/device-links.ts --bundle --platform=node --target=node24 \
       --format=cjs --external:better-sqlite3 --alias:next/cache=./scripts/tool-cache.ts --outfile=dist/device-links.cjs

# Trim better-sqlite3 to what this image actually runs: one of the eight prebuilt
# addons (~17MB the set), none of the SQLite amalgamation it no longer compiles
# (~10MB), and the empty build tree node-gyp left behind. 27MB -> ~2MB in the
# node_modules the runner stage copies. The target name is the same platform+arch
# rule the package's own subpath exports are keyed on.
#
# The require() is the point, not a flourish: with the source-build fallback gone, a
# prune that broke resolution would otherwise surface as a container that won't boot.
# Here it fails the build.
RUN BS3=/app/.next/standalone/node_modules/better-sqlite3 \
  && TARGET="$(node -p "(process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? 'linuxmusl' : process.platform) + '-' + process.arch")" \
  && test -f "$BS3/prebuilds/$TARGET.node" \
  && find "$BS3/prebuilds" -name '*.node' ! -name "$TARGET.node" -delete \
  && rm -rf "$BS3/deps" "$BS3/src" "$BS3/binding.gyp" "$BS3/build" \
  && node -e "new (require('/app/.next/standalone/node_modules/better-sqlite3'))(':memory:').prepare('select sqlite_version()').get()"

# ---- runner ----
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runner
WORKDIR /app
ENV NODE_ENV=production

# The commit the image was built from. `.git` is excluded from the build
# context (see .dockerignore), so the app can't read it at runtime — bake it in
# here from a build arg (the deploy workflow passes github.sha) and expose it as
# env vars the UI reads via lib/version.ts. Unset in a plain `docker build`,
# which is fine: the UI just shows "unknown".
ARG COMMIT_SHA=""
ENV COMMIT_SHA=$COMMIT_SHA
LABEL org.opencontainers.image.revision=$COMMIT_SHA
ARG COMMIT_MESSAGE=""
ENV COMMIT_MESSAGE=$COMMIT_MESSAGE

# gosu lets the entrypoint drop from root to the app user after fixing up the
# (bind-mounted) data dir's ownership.
# The standalone server and bundled tools run directly with Node.
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  /usr/local/lib/node_modules/npm /opt/yarn-* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx \
  /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Standalone contains only Next's traced runtime dependencies. The bundled tools
# resolve their external better-sqlite3 import from that same tree.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --chmod=755 docker-notify.sh /usr/local/bin/docker-notify.sh

# Bind mounts still get their ownership fixed by the entrypoint.
RUN mkdir -p /app/data && chown node:node /app/data

# Exercise every tool against synthetic data in the final runtime layout.
COPY scripts/check-image-tools.mjs /tmp/check-image-tools.mjs
RUN node /tmp/check-image-tools.mjs && rm /tmp/check-image-tools.mjs

# Standalone otherwise inherits the container hostname and may bind only to it.
ENV HOSTNAME=0.0.0.0
COPY deploy/steps /liftoff/deploy/steps
COPY deploy/files /liftoff/deploy/files
COPY deploy/allos.alloy /liftoff/deploy/allos.alloy

EXPOSE 3000 9830
# Runs as root only long enough to chown the data dir, then execs as node.
# The standalone server honors PORT; default 3000.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
