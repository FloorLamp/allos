#!/bin/sh
# Authorize shared resources for both services (houston liftoff/allos/deploy-failed).
# phase: before
set -eu
. "$STEP_LIB"
case "$1" in
  check)
    jq -e 'all(.resources.data[], .resources.secrets[]; .services == ["allos", "allos-notify"])' liftoff.json >/dev/null
    ;;
  run)
    candidate=$(mktemp liftoff.json.XXXXXX)
    trap 'rm -f "$candidate"' EXIT HUP INT TERM
    jq '(.resources.data[], .resources.secrets[]).services = ["allos", "allos-notify"]' liftoff.json > "$candidate"
    install_file "$candidate" liftoff.json
    ;;
esac
