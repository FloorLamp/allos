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
SESSION_FILE="$STATE_DIR/.session_id"
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

# 1b. Session restart: the boot-id's blind spot, and it is the COMMON case.
#
# THE AGENTS DIE WITH THE SESSION, NOT WITH THE MACHINE. Every subagent is a
# child of the one `claude` process, so replacing that process kills the whole
# fleet — and the box never reboots, so the boot-id it is compared against is
# unchanged and the machine's uptime keeps climbing. The detector above sees
# nothing at all.
#
# Observed 2026-08-13T12:33Z, and this is the SECOND time the recorder soothed
# over dead agents. The first (04:38Z) was a real reboot whose roster claim went
# unvoided, fixed by gating liveness on RESTARTED. This run printed
# "boot-id: UNCHANGED (up 482m)" and "no rescue targets — every dirty tree
# belongs to a live agent" over two trees whose agents had been dead for six
# minutes; one held 265 uncommitted lines of a fix that existed nowhere else.
# The previous fix was right about the mechanism and wrong about the scope: it
# asked whether the HOUSE had restarted when the question is whether the
# PROCESS HOLDING THE AGENTS had.
#
# The identity is pid + start-time, never pid alone: pids are recycled, and a
# recycled one would read as UNCHANGED — the reassuring direction again. Start
# time is in clock ticks since boot, so the pair is unique for as long as the
# comparison is meaningful. Walk up from this script rather than pattern-matching
# `ps`, because the ancestor chain is the thing that is actually true; a `pgrep`
# would find some other session's process just as happily.
SESSION_NEW=0
sid=""
p=$$
while [ -n "$p" ] && [ "$p" != "1" ]; do
  [ -r "/proc/$p/stat" ] || break
  if [ "$(cat "/proc/$p/comm" 2>/dev/null)" = "claude" ]; then
    sid="$p:$(awk '{print $22}' "/proc/$p/stat" 2>/dev/null)"
    break
  fi
  p=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null)
done
sid_stored=$(cat "$SESSION_FILE" 2>/dev/null || echo MISSING)
if [ -z "$sid" ]; then
  # Run from a plain shell with no claude ancestor. Say so — an unanswerable
  # question must not be reported as a clean answer.
  echo "session:  UNKNOWN (no claude ancestor — liveness below is unverified)"
elif [ "$sid" = "$sid_stored" ]; then
  echo "session:  UNCHANGED ($sid)"
else
  echo "session:  *** RESTARTED *** (was $sid_stored, now $sid)"
  echo "  >>> Every subagent and every in-process timer died with the old session."
  echo "  >>> The roster below records DISPATCH, not liveness — treat all of it as DEAD."
  echo "  >>> PRESERVE-FIRST DRILL applies to every dirty worktree before relaunching."
  SESSION_NEW=1
fi

# One flag for the one consequence. A machine reboot and a session restart differ
# in what else they take down (tmp dirs, dev servers, the port map) but agree
# completely on this: there is no live agent afterwards.
AGENTS_DEAD=0
[ "$RESTARTED" = "1" ] && AGENTS_DEAD=1
[ "$SESSION_NEW" = "1" ] && AGENTS_DEAD=1
echo

# 2. Worktrees.
#
# THE ALARM ONLY WORKS IF IT IS SILENT WHEN NOTHING IS WRONG. The first version
# flagged every LIVE agent's worktree as "DIRTY: RESCUE BEFORE ANYTHING ELSE" —
# an agent mid-task has uncommitted work by definition — and every merged branch
# as "NO REMOTE BRANCH", because a branch is deleted on merge. Three of six rows
# screamed on two consecutive check-ins with nothing wrong. That is the canary's
# failure a second time: not absent, but IGNORABLE. A monitor nobody reads is a
# monitor nobody has.
#
# The missing input was already on disk. $ROSTER says which branches have a LIVE
# agent, and the same facts mean opposite things on either side of that line:
#
#   LIVE  (branch is on the roster) — dirty is EXPECTED, that is work in
#         progress; an absent remote is EXPECTED, it has not pushed yet.
#         Nothing here is actionable while the agent is running.
#   DONE  (not on the roster) — dirty is a RESCUE TARGET: nobody is coming back
#         for it. An absent remote is fine IF the branch WAS pushed and has since
#         been deleted upstream (merged), and ALARMING otherwise: unpushed work
#         whose author has exited.
#
# "Was it merged?" is NOT `merge-base --is-ancestor HEAD origin/main`. Everything
# here is SQUASH-merged, so the merged commit is a brand-new object with an
# unrelated parent and the branch head is never an ancestor of main. That test
# reads perfectly and can only ever answer "no" — the #2444 shape, a guard that
# covers nothing while still looking like a guard. Used as the sole test it
# flagged all three finished worktrees as unpushed on the very run that fixed the
# previous false alarm, trading one false alarm for another.
#
# The signal that separates the cases is whether the branch was ever PUSHED:
# tracking config survives the upstream branch's deletion, so upstream-configured
# plus remote-gone is the merged-and-tidied shape, while no upstream and no remote
# is work that exists nowhere else. `--is-ancestor` is kept only as a second
# sufficient witness, for the non-squash case.
#
# The roster's own "(done: ...)" trailer is not a live entry, so live matching is
# anchored to lines beginning "Cluster".
#
# WHERE the worktrees are is not this script's business to guess. The first version
# globbed "$STATE_DIR"/wt-* — the path every dispatch brief names — and on
# 2026-08-12 two live agents built theirs somewhere else entirely (under the
# harness scratchpad, because `$SCRATCH` was not set in their shell and their own
# instructions point temp work at that directory instead). Both were invisible
# here: the roster listed them, the worktree section did not, and a restart would
# have run the preserve-first drill over a list that silently omitted the two trees
# holding uncommitted work. A monitor that can only see the places you expected is
# the canary again — it reports confidently and its silence means nothing.
#
# `git worktree list` cannot have that failure. Git already knows every worktree
# attached to this checkout, wherever it sits, because it wrote the administrative
# file itself. Ask the authority rather than re-deriving its answer from a path
# convention that the next dispatch is free to ignore. The main checkout is skipped
# by path, not by name — it is the one entry that is not an agent's.
echo "--- worktrees ---"
git -C "$REPO" fetch origin main -q 2>/dev/null
live_branches=$(grep -E '^Cluster ' "$ROSTER" 2>/dev/null | awk '{print $3}')
found=0
alarms=0
while read -r d; do
  [ -n "$d" ] || continue
  [ "$d" = "$REPO" ] && continue
  [ -d "$d" ] || continue
  found=1
  b=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)
  h=$(git -C "$d" rev-parse HEAD 2>/dev/null)
  dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  r=$(git -C "$REPO" ls-remote --heads origin "$b" 2>/dev/null | cut -c1-7)
  # A RESTART VOIDS THE ROSTER'S LIVENESS CLAIM. The roster records DISPATCH,
  # not liveness — nothing writes to it when an agent dies, so "live" only ever
  # meant "was dispatched and not marked done". That reading is harmless while
  # the box is up and catastrophically wrong the one time it matters: a restart
  # kills every agent at once, so after a boot-id change there is no live agent
  # BY CONSTRUCTION, and every dirty tree is a rescue target.
  #
  # Observed 2026-08-13T04:38Z. The same run that printed *** RESTARTED *** and
  # the preserve-first drill also printed "no rescue targets — every dirty tree
  # belongs to a live agent", over two trees whose agents the restart had just
  # killed. The header shouted and the verdict soothed, in one screen; the
  # reassuring half is the one a tired reader believes. One tree held an
  # uncommitted spec edit that existed nowhere else.
  #
  # The gate is AGENTS_DEAD, not RESTARTED, because a session restart kills the
  # fleet without touching the boot-id — see 1b. Gating on the machine let the
  # same soothing line print again at 12:33Z with the header silent too.
  live=0
  if [ "$AGENTS_DEAD" = "0" ]; then
    printf '%s\n' "$live_branches" | grep -qx -- "$b" && live=1
  fi

  # THE READ-ONLY LANE IS NOT A RESCUE TARGET. The adversarial reviewer (#2626)
  # works in a throwaway worktree checked out at a PR's MERGE ref — detached, on
  # no branch, never pushed, deliberately disposable, and holding whatever scratch
  # its attacks wrote. Classified as an agent's branch it reads DIRTY AND NO AGENT
  # plus NEVER PUSHED, and the second of those is advice that cannot be followed:
  # a detached HEAD has no branch to push. An alarm you cannot act on is the
  # canary again, so name the lane instead of alarming on it.
  #
  # The exemption is the DECLARED lane only (`wt-refute*`, detached). A detached
  # worktree that is NOT the lane still gets said out loud, because commits made
  # there belong to no branch and are one `worktree remove` from gone — a
  # different problem from an unpushed branch, and not one to silence.
  #
  # The glob has no hyphen after `refute` because the first version did, and the
  # second refuter — a re-run on the same PR — got hand-named `wt-refute2-2634`,
  # which the pattern missed by one character. So the alarm fired on the very lane
  # it had just been taught to recognise. An exemption keyed on a name a human
  # types will drift from the name that human types next time; matching the prefix
  # rather than one spelling of it is the cheap half of the fix, and briefing the
  # lane to use `wt-refute-<pr>` is the other.
  case "$(basename "$d")" in
    wt-refute*)
      if [ "$b" = "HEAD" ]; then
        printf "  %-16s %-32s %-6s local=%s  (read-only refuter lane — nothing to rescue)\n" \
          "$(basename "$d")" "(detached)" "lane" "${h:0:7}"
        continue
      fi
      ;;
  esac
  # "Was this branch ever pushed?" — read the tracking CONFIG, not @{upstream}.
  #
  # The two are not the same thing and the difference is a false alarm. The
  # config entry `branch.<name>.remote` survives the upstream branch being
  # deleted at merge AND survives `git remote prune`; `@{upstream}` RESOLVES
  # `refs/remotes/origin/<branch>`, which prune deletes. So after an ordinary
  # `git remote prune origin` — routine hygiene after a few squash merges —
  # every merged worktree read as NEVER PUSHED and demanded rescue.
  #
  # Measured on wt-reach-am, whose work merged as #2617:
  #   branch.claude/notify-reach-am1.remote -> origin        (intact)
  #   claude/notify-reach-am1@{upstream}    -> fatal: unknown revision
  #
  # The original comment here already said "tracking config survives the
  # upstream branch's deletion", which is true — it was tested with the wrong
  # command. Third time this detector has cried wolf, and each time the fix was
  # to ask a question whose answer does not depend on a ref that gets cleaned up.
  pushed=0
  [ -n "$(git -C "$d" config --get "branch.$b.remote" 2>/dev/null)" ] && pushed=1
  git -C "$REPO" merge-base --is-ancestor "$h" origin/main 2>/dev/null && pushed=1

  state="LIVE"; flag=""
  if [ "$live" = "0" ]; then
    if [ "$dirty" = "0" ] && [ "$pushed" = "1" ]; then
      state="banked"
    else
      state="DONE"
      [ "$dirty" != "0" ] && { flag="$flag  <<< DIRTY AND NO AGENT: RESCUE NOW"; alarms=1; }
      # Say the ACTIONABLE thing. On a branch, "push it". Detached, there is no
      # branch to push and the rescue is `git branch -c` first — different advice,
      # and the generic line would send you to a command that cannot work.
      if [ "$pushed" = "0" ]; then
        if [ "$b" = "HEAD" ]; then
          flag="$flag  <<< DETACHED, NO AGENT: any commit here is on NO BRANCH — name one before removing this tree"
        else
          flag="$flag  <<< NEVER PUSHED, NO AGENT: PUSH NOW"
        fi
        alarms=1
      fi
    fi
  fi
  # An unpushed commit under a live agent is the near miss, not the accident:
  # worth saying, not worth shouting.
  [ -n "$r" ] && [ "${h:0:7}" != "$r" ] && flag="$flag  (local ahead of remote)"
  # A tree outside $STATE_DIR is findable HERE (git enumerates it) but not by
  # anything that globs the documented path — say where it actually is.
  case "$d" in "$STATE_DIR"/*) ;; *) flag="$flag  (outside \$SCRATCH: $d)" ;; esac
  printf "  %-16s %-32s %-6s local=%s remote=%-8s dirty=%s%s\n" \
    "$(basename "$d")" "$b" "$state" "${h:0:7}" "${r:-ABSENT}" "$dirty" "$flag"
done < <(git -C "$REPO" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')
[ "$found" = "0" ] && echo "  (none)"
if [ "$found" = "1" ] && [ "$alarms" = "0" ]; then
  # Same distinction one level up: after a restart the all-clear cannot be
  # "they belong to live agents", because there are none. It is the narrower
  # (and still good) news that nothing was left uncommitted when they died.
  if [ "$AGENTS_DEAD" = "1" ]; then
    echo "  (nothing to rescue — every tree was clean and pushed when the restart killed its agent;"
    echo "   the agents are still DEAD and must be relaunched)"
  else
    echo "  (no rescue targets — every dirty tree belongs to a live agent)"
  fi
fi
echo

# 3. The roster the orchestrator's own memory cannot be trusted to hold.
echo "--- in-flight roster (written at dispatch; the only copy that outlives you) ---"
if [ -s "$ROSTER" ]; then sed 's/^/  /' "$ROSTER"; else echo "  (empty)"; fi
echo

# 4. THE WAKE. Is anything scheduled to wake this session in the FUTURE?
#
# This is the gap that let the session go silent for 35 minutes on 2026-08-12
# and needed a human to notice. The runbook already required "send_later PLUS a
# backup background sleep, re-arm the pair before ending the turn" — the rule
# was right and got walked past, which is what prose does.
#
# The two are NOT redundancy, and reading them as redundancy is what made
# dropping one feel survivable:
#   • send_later is a SERVER-SIDE routine. It survives a container restart.
#   • a background `sleep` is IN-PROCESS. It dies with the container, exactly
#     like the canary and for exactly the same reason.
# So the sleep covers a send_later that silently fails (2026-08-01, 52 min),
# and send_later covers a restart. Drop send_later and the dominant failure
# mode — restart — has no wake mechanism at all, which is what happened.
#
# Detect by STATE, one level up from the boot-id: when you arm send_later,
# write its fire time here. This asks the only question that matters — is a
# wake scheduled in the future — and every answer is actionable:
#   absent  -> nothing will wake you. Arm one.
#   past    -> nothing FUTURE will wake you (you are awake handling it). Re-arm.
#   future  -> silent.
# If you armed but forgot to record it, this over-reports and you arm a second
# one. An extra check-in is the safe direction; silence is not.
echo "--- wake ---"
WAKE_FILE="$STATE_DIR/.wake"
if [ ! -s "$WAKE_FILE" ]; then
  echo "  *** NO DURABLE WAKE ARMED — arm send_later NOW and record it: ***"
  echo "      echo '<fire_at ISO> <trigger_id>' > $WAKE_FILE"
  alarms=1
else
  wake_at=$(awk '{print $1}' "$WAKE_FILE")
  wake_id=$(awk '{print $2}' "$WAKE_FILE")
  now_s=$(date -u +%s)
  wake_s=$(date -u -d "$wake_at" +%s 2>/dev/null || echo 0)
  if [ "$wake_s" -gt "$now_s" ]; then
    printf "  next: %s (in %dm) %s\n" "$wake_at" $(((wake_s - now_s) / 60)) "$wake_id"
  else
    echo "  *** WAKE IS IN THE PAST ($wake_at) — nothing future is armed. Re-arm send_later NOW. ***"
    alarms=1
  fi
fi
echo

# 5. Cheap environment facts a restart can change.
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
if [ -n "$sid" ] && [ "$SESSION_NEW" = "1" ]; then
  echo "$sid" > "$SESSION_FILE"
  echo "session stamped. Every subagent and in-process timer is DEAD - relaunch and re-arm now."
fi
