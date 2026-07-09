#!/usr/bin/env bash
# Launch the dev server on the Node version pinned in .nvmrc (Next 14 needs a
# newer Node than some systems default to). Selects it via nvm when available,
# which works regardless of where nvm is installed ($HOME/.nvm on every machine);
# falls back to whatever `npm` is already on PATH otherwise.
set -e
cd "$(dirname "$0")/.."

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use >/dev/null 2>&1 || true
fi

# Any extra args (e.g. -p <port>) are forwarded to `next dev`.
exec npm run dev -- "$@"
