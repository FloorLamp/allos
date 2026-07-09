#!/bin/sh
# The data dir is typically a host bind mount, whose ownership overrides the
# image's. A non-root container then can't create/open the SQLite DB
# ("unable to open database file"). So start as root, make the data dir owned by
# the app user, then drop privileges. chown is shallow-cheap and idempotent.
set -e

DATA_DIR=/app/data
mkdir -p "$DATA_DIR"
chown node:node "$DATA_DIR"

exec gosu node "$@"
