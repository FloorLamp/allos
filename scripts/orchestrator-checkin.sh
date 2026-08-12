#!/usr/bin/env bash
# Orchestrator flight recorder + check-in preamble (see docs/orchestration.md).
#
# WHY THIS EXISTS, and why the thing it replaces could never have worked:
#
# The old restart detector was a "canary" — a `while true; do sleep 3600; done`
# background process whose DEATH was supposed to signal a container restart. It
# cannot work, by construction: a container restart kills the harness that would
# deliver the canary's death notification along with the canary itself. It is a
# smoke alarm wired to the same fuse as the house. One ran for a whole session
# on 2026-08-12, died at 14:08, and said nothing.
#
# Worse, the same restart killed BOTH check-in timers (they are `sleep` loops in
# the same process tree), so the boot-id comparison that DOES work correctly
# never ran again. The failure chain was: restart -> canary dies unheard ->
# timers die -> nothing polls -> the orchestrator keeps merging as though
# nothing happened. A human asking "container died?" is what surfaced it.
#
# THE FIX IS TO STOP DETECTING BY LIVENESS AND START DETECTING BY STATE.
# Nothing in-process survives a restart, so restart detection must be:
#   (a) disk-persisted  — $SCRATCH/.boot_id, compared against the kernel's
#   (b) pull, not push  — read on demand, needing no surviving process
#   (c) self-describing — it must also say WHAT WAS RUNNING, because after a
#       restart the orchestrator's own memory of the in-flight roster is the
#       other thing that is gone.
#
# (c) is the part the canary never had. Knowing "a restart happened" is useless
# without knowing which agents to rescue and relaunch. That roster lives in
# $SCRATCH/.roster, written at dispatch time, and it is what makes this a flight
# recorder rather than an alarm.
#
# This script lives in the REPO, not in scratch. The first version was written
# to $SCRATCH and would have died in the next restart — the same mistake one
# level up.
#
# Usage:  bash scripts/orchestrator-checkin.sh
# Run it as the FIRST action of every check-in, and after any gap in activity.

set -uo pipefail

STATE_DIR=${SCRATCH:-/home/user/scratch}
BOOT_FILE="$STATE_DIR/.boot_id"
ROSTER="$STATE_DIR/.roster"
REPO=$(git rev-parse --show-toplevel 2>/dev/null || echo /home/user/allos)

echo "=== ORCHESTRATOR CHECK-IN  $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo

# 1. Restart detection: state, not liveness.
CUR=$(cat /proc/sys/kernel/random/boot_id)
STORED=$(cat "$BOOT_FILE" 2>/dev/null || echo MISSING)
UP=$(awk '{printf "%dm", $1/60}' /proc/uptime)
if [ "$CUR" = "$STORED" ]; then
  echo "boot-id: UNCHANGED (up ${UP})"
  RESTARTED=0
else
  echo "boot-id: *** RESTARTED *** (up ${UP})"
  echo "  was: $STORED"
  echo "  now: $CUR"
  echo
  echo "  >>> PRESERVE-FIRST DRILL, before diagnosing or reporting anything:"
  echo "  >>> every dirty worktree below holds work that exists NOWHERE else."
  echo "  >>> Commit each as 'WIP RESCUE - no gate has been run', push, THEN relaunch."
  RESTARTED=1
fi
echo

# 2. Worktrees: dirty ones are rescue targets, unpushed ones are the near miss.
echo "--- worktrees ---"
shopt -s nullglob
found=0
for d in "$STATE_DIR"/wt-*; do
  [ -d "$d" ] || continue
  found=1
  b=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)
  h=$(git -C "$d" rev-parse HEAD 2>/dev/null | cut -c1-7)
  dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  r=$(git -C "$REPO" ls-remote --heads origin "$b" 2>/dev/null | cut -c1-7)
  flag=""
  [ "$dirty" != "0" ] && flag="$flag  <<< DIRTY: RESCUE BEFORE ANYTHING ELSE"
  [ -n "$r" ] && [ "$h" != "$r" ] && flag="$flag  <<< LOCAL AHEAD OF REMOTE: PUSH"
  [ -z "$r" ] && flag="$flag  <<< NO REMOTE BRANCH"
  printf "  %-16s %-32s local=%s remote=%-8s dirty=%s%s\n" \
    "$(basename "$d")" "$b" "$h" "${r:-ABSENT}" "$dirty" "$flag"
done
[ "$found" = "0" ] && echo "  (none)"
echo

# 3. The roster the orchestrator's own memory cannot be trusted to hold.
echo "--- in-flight roster (written at dispatch; the only copy that outlives you) ---"
if [ -s "$ROSTER" ]; then sed 's/^/  /' "$ROSTER"; else echo "  (empty)"; fi
echo

# 4. Cheap environment facts a restart can change.
echo "--- environment ---"
df -h / | awk 'NR==2 {print "  disk: " $4 " free (" $5 " used)"}'
shared=$(find /tmp -maxdepth 1 -type d -name 'allos-db-shared-*' 2>/dev/null | wc -l | tr -d ' ')
takeout=$(find /tmp -maxdepth 1 -name 'allos-takeout-*' 2>/dev/null | wc -l | tr -d ' ')
echo "  tmp: allos-db-shared=$shared allos-takeout=$takeout"
if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "  GH_TOKEN: present"
else
  echo "  GH_TOKEN: *** MISSING - see the credential-loss section of the runbook ***"
fi
node24=$(ls -d /opt/nvm/versions/node/v24* 2>/dev/null | head -1)
echo "  node24: ${node24:-ABSENT - nvm install 24}"
echo "  main:   $(git -C "$REPO" ls-remote origin main 2>/dev/null | cut -c1-7)"
echo

# Stamp LAST, so a crash mid-check-in still reports the restart next time.
if [ "$RESTARTED" = "1" ]; then
  echo "$CUR" > "$BOOT_FILE"
  echo "boot-id stamped. Timers and any canary are DEAD - re-arm them now."
fi
