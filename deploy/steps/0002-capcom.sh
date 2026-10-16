#!/bin/sh
# Route Allos AI through capcom without retained health content (#6075).
# phase: before
# files: deploy/files/capcom.cjs
# vault: allos-capcom-key
set -eu
. "$STEP_LIB"
[ "$STEP_HOST" = prod ] || exit 0
helper=$(cat "$STEP_FILES/deploy/files/capcom.cjs")
case "$1" in
  check)
    in_service allos node -e "$helper" check < .env
    docker exec -i capcom node --input-type=module -e '
      import {readFileSync} from "node:fs";
      import {tokens} from "./capcom/src/auth.mjs";
      const key = readFileSync(0, "utf8").match(/^CAPCOM_API_KEY=(capcom_[^\r\n]+)$/m)?.[1];
      const caller = tokens((process.env.CAPCOM_DATA ?? "/var/lib/capcom") + "/tokens.json").check(key);
      process.exit(caller?.name === "allos" && caller.role === "client" && caller.retention === "none" ? 0 : 1);
    ' < .env
    ;;
  run)
    umask 077
    candidate=$(mktemp .env.capcom.XXXXXX)
    trap 'rm -f "$candidate" "$candidate.out"' EXIT HUP INT TERM
    # Reuse a token saved by an interrupted run; never print it to the step log.
    if ! grep -q '^CAPCOM_API_KEY=capcom_' .env; then
      token=$(docker exec capcom node capcom/bin/capcom.mjs token add allos client --retention none)
      test -n "$token"
      { cat .env; printf '\nCAPCOM_API_KEY=%s\n' "$token"; } > "$candidate"
      install_file "$candidate" .env 600
    fi
    docker exec capcom node capcom/bin/capcom.mjs token retention allos none
    in_service allos node -e "$helper" run < .env > "$candidate.out"
    install_file "$candidate.out" .env 600
    ;;
esac
