#!/bin/sh
# Preserve running endpoint configuration before removing public defaults (spaceport#643).
# phase: before
# files: deploy/files/internal-endpoints.cjs
set -eu
. "$STEP_LIB"
[ "$STEP_HOST" = prod ] || exit 0
helper=$(cat "$STEP_FILES/deploy/files/internal-endpoints.cjs")
case "$1" in
  check) in_service allos node -e "$helper" check < .env ;;
  run)
    umask 077
    candidate=$(mktemp .env.endpoints.XXXXXX)
    trap 'rm -f "$candidate"' EXIT HUP INT TERM
    # The artifact channel belongs to the existing artifact host's route.
    channel=
    if ! env_has .env DECK_UI_CHANNEL; then
      channel=$(docker exec caddy caddy adapt --config /etc/caddy/Caddyfile 2>/dev/null |
      in_service allos node -e '
        const fs = require("node:fs");
        const config = JSON.parse(fs.readFileSync(0, "utf8"));
        const hosts = [];
        function visit(value) {
          if (!value || typeof value !== "object") return;
          if (Array.isArray(value.host)) hosts.push(...value.host);
          for (const child of Object.values(value)) visit(child);
        }
        visit(config);
        const host = hosts.find(h => /^hangar[.]/.test(h));
        if (!host) process.exit(1);
        process.stdout.write(`https://${host}/c/deck-ui/`);
      ')
    fi
    in_service allos env DECK_UI_CHANNEL="$channel" node -e "$helper" run < .env > "$candidate"
    install_file "$candidate" .env 600
    ;;
esac
