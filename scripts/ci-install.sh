#!/bin/sh
set -eu

stamp=node_modules/.allos-package-lock.sha256
lock_hash=$(sha256sum package-lock.json | cut -d ' ' -f 1)
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$lock_hash" ]; then
  echo 'Dependencies match package-lock.json; skipping npm ci'
  exit 0
fi

# A failed install must not leave a valid stamp behind.
rm -f "$stamp"
npm ci --no-audit --no-fund
printf '%s\n' "$lock_hash" > "$stamp"
