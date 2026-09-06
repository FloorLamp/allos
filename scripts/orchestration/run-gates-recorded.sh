#!/usr/bin/env bash
# Run agent-gates.sh with its PID and exit code RECORDED ON DISK — the brief's
# waiting idiom as a script, so a lane cannot mis-paste it (#5385, #5366).
#
#   bash scripts/orchestration/run-gates-recorded.sh <branch>          # start, wait, report
#   bash scripts/orchestration/run-gates-recorded.sh <branch> --wait   # ONLY after the
#        harness detached the first call: wait on the recorded PID, then report
#
# Run from the worktree root (agent-gates.sh reads the diff there). Files land
# under the state dir host.mjs resolves — the one the brief's worktree lives in:
#   gates-<branch>.log       every line the gates printed
#   gates-<branch>.log.pid   the run's PID, captured from $! — the one fact no
#                            other process's command line can impersonate
#   gates-<branch>.log.exit  the exit code, written by the run itself as it ends
#
# WHY A SCRIPT. The idiom used to be four lines to copy. Two lanes on 2026-09-06
# folded them into one `cd … && L=… && { … } > "$L" 2>&1 & echo $! > "$L.pid"`
# command: an `&&` chain ending in `&` backgrounds the WHOLE chain, so `$L` was
# empty in the foreground, `.pid` landed in the main checkout's cwd, and a
# finished gate read as KILLED. Here the assignments and the `&` share one
# shell by construction. And it waits on the PID it captured plus the `.exit`
# file, never on a name: every lane runs the same agent-gates.sh, so a
# `pgrep -f agent-gates.sh` wait matches its siblings (#5366).
#
# Exit code: the gates' own (from the `.exit` file); 1 if the run died without
# writing one; 2 for a usage or state-dir failure before anything ran.

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] || [ -z "${1:-}" ]; then # the header IS the usage (usage.mjs is the JS twin)
  sed -n '2,${/^#/!q;s/^#[[:space:]]\{0,1\}//p;}' "$0"
  [ -n "${1:-}" ]
  exit $?
fi

set -uo pipefail

BRANCH=$1
MODE=${2:-start}
HELPERS=$(dirname "$0")

# The state dir is the resolver's answer or nothing: a guessed one writes the
# .pid where no later shell will look, which is the defect this file replaces.
if ! STATE_DIR=$(node "$HELPERS/host.mjs" state-dir); then
  echo "=== GATES: STATE-DIR RESOLVER FAILED — node $HELPERS/host.mjs state-dir exited non-zero (its error is above); nothing ran ===" >&2
  exit 2
fi
L="$STATE_DIR/gates-$BRANCH.log"

report() {
  local code
  if code=$(cat "$L.exit" 2>/dev/null); then
    echo "GATES EXIT=$code  (log: $L)"
  else
    echo "GATES EXIT=KILLED — no exit recorded in $L.exit"
    code=1
  fi
  tail -40 "$L"
  exit "$code"
}

case "$MODE" in
  start)
    rm -f "$L.exit"
    { bash "$HELPERS/agent-gates.sh"; echo $? > "$L.exit"; } > "$L" 2>&1 &
    echo $! > "$L.pid"
    echo "gates running as PID $(cat "$L.pid"); log $L"
    wait
    report
    ;;
  --wait)
    if ! pid=$(cat "$L.pid" 2>/dev/null); then
      echo "GATES: no PID recorded at $L.pid — nothing to wait on (was the run started with this script, for this branch?)" >&2
      exit 2
    fi
    # `kill -0` asks the KERNEL about that pid; it stops on ANY exit — pass,
    # fail or kill — and the `.exit` file then tells the three apart.
    while kill -0 "$pid" 2>/dev/null; do sleep 5; done
    report
    ;;
  *)
    echo "run-gates-recorded.sh: unknown mode $MODE — see --help" >&2
    exit 2
    ;;
esac
