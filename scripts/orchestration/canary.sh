#!/usr/bin/env bash
# Container-restart detection, checked in instead of re-hand-rolled from the
# runbook's prose each session (docs/orchestration.md, "Container-restart
# resilience"). Managed containers restart without warning, killing every
# background task and in-flight agent call; a restart's own bookkeeping
# touches file mtimes, so file evidence lies — the two honest signals are the
# kernel boot id and a background process that dies with the container.
#
# Usage:
#   scripts/orchestration/canary.sh stamp   # record the current boot id
#   scripts/orchestration/canary.sh check   # compare; exit 1 on mismatch
#   scripts/orchestration/canary.sh start   # launch the canary sleep loop
#
# `check` at EVERY check-in. On mismatch: run the restart drill (assume every
# agent is dead; snapshot each worktree; resume via SendMessage; restamp;
# restart the canary).

set -euo pipefail

STAMP_DIR="${SCRATCH:-/tmp}"
STAMP_FILE="${STAMP_DIR}/.boot_id"
BOOT_ID_SRC="/proc/sys/kernel/random/boot_id"

case "${1:-}" in
  stamp)
    cat "$BOOT_ID_SRC" >"$STAMP_FILE"
    echo "stamped $(cat "$STAMP_FILE") -> ${STAMP_FILE}"
    ;;
  check)
    if [[ ! -f "$STAMP_FILE" ]]; then
      echo "NO STAMP at ${STAMP_FILE} — either first run or the scratch volume was wiped."
      echo "Treat as a restart: run the drill, then '$0 stamp'."
      exit 1
    fi
    current="$(cat "$BOOT_ID_SRC")"
    stamped="$(cat "$STAMP_FILE")"
    if [[ "$current" != "$stamped" ]]; then
      echo "BOOT ID MISMATCH — the container restarted since the last stamp."
      echo "  stamped: ${stamped}"
      echo "  current: ${current}"
      echo "Run the restart drill: every agent is dead until proven otherwise; snapshot"
      echo "each worktree (git log -3 / status / local-vs-origin), resume via SendMessage,"
      echo "then '$0 stamp' and '$0 start'."
      exit 1
    fi
    echo "boot id unchanged (${current})"
    ;;
  start)
    nohup bash -c 'while true; do sleep 3600; done' >/dev/null 2>&1 &
    echo "canary started (pid $!) — its death notification is the restart alarm."
    ;;
  *)
    echo "usage: $0 stamp | check | start" >&2
    exit 2
    ;;
esac
