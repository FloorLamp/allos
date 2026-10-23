#!/bin/sh
# Bind every declared secret in Allos's host scope from its .env and drop the unread `ai` binding (houston liftoff/allos/deploy-failed; #6113, #6110, #6186).
# area: habitat-read
# provides: secrets.habitat-url secrets.habitat-token secrets.deck-origin secrets.capcom-url secrets.deck-ui-channel secrets.allowed-dev-origins secrets.ai
set -eu
. "$STEP_LIB"
# Same binding shape as mothership's allos-habitat provisioning (FP-3314), which fills HABITAT_URL and HABITAT_TOKEN later.
bindings=$(jq -c '[.resources.secrets[] | {key:.name, value:{kind:"env", source:"/opt/compose/allos/.env", key:.env}}] | from_entries' liftoff.json)
case "$1" in
  check) jq -e --argjson b "$bindings" '.apps.allos.secrets == $b' "$STEP_RESOURCES" >/dev/null ;;
  run)
    umask 077
    jq --argjson b "$bindings" '.apps.allos.secrets = $b' "$STEP_RESOURCES" > "$STEP_RESOURCES.allos-tmp" &&
      mv "$STEP_RESOURCES.allos-tmp" "$STEP_RESOURCES"
    ;;
  *) exit 2 ;;
esac
