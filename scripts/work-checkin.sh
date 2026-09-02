#!/usr/bin/env bash
# Worker flight recorder + check-in preamble (see docs/work.md).
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
# timers die -> nothing polls -> the worker keeps merging as though
# nothing happened. A human asking "container died?" is what surfaced it.
#
# THE FIX IS TO STOP DETECTING BY LIVENESS AND START DETECTING BY STATE.
# Nothing in-process survives a restart, so restart detection must be:
#   (a) disk-persisted  — $SCRATCH/.boot_id, compared against the kernel's
#   (b) pull, not push  — read on demand, needing no surviving process
#   (c) self-describing — it must also say WHAT WAS RUNNING, because after a
#       restart the worker's own memory of the in-flight roster is the
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
# Usage:  bash scripts/work-checkin.sh [--relaunched]
# Run it as the FIRST action of every check-in, and after any gap in activity.
#
# --relaunched clears the sticky rescue flag described at RESCUE_FILE below. Pass
# it only AFTER every dirty tree has been rescued and every dead agent relaunched.

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then # the header IS the usage (usage.mjs is the JS twin)
  sed -n '2,${/^#/!q;s/^#[[:space:]]\{0,1\}//p;}' "$0"
  exit 0
fi

set -uo pipefail

# THE STAMP MUST SURVIVE A TRUNCATED READ, and this is not a hypothetical
# reader — it is the ordinary one. This script prints ~40 lines and stamps at
# the very END (deliberately: see the block down there). Reading it with
# `work-checkin.sh | head -30` — the natural way to look at a long
# recorder output, and what the runbook's own "first action of every check-in"
# invites — closes the pipe early, SIGPIPE kills the script mid-print, and the
# stamp NEVER RUNS.
#
# The next run then reads the stale boot-id, declares a restart that did not
# happen, and prints "DIRTY AND NO AGENT: RESCUE NOW" over live agents'
# worktrees. Measured 2026-08-21T05:42Z through 06:27Z: a real restart was
# handled correctly, four agents were rescued and relaunched, and then THREE
# consecutive check-ins kept reporting the same restart and kept flagging a
# live lane for rescue — because every one of those reads was piped through
# `head` and none of them could stamp. `--relaunched` cleared the sticky flag
# and did not help, because the flag was not the thing that was stale.
#
# So: ignore SIGPIPE. A closed stdout now costs the unread tail of the report
# and nothing else. The state writes are the load-bearing half and they are not
# stdout.
#
# This is the THIRD direction this recorder's alarm has been wrong — after
# soothing over dead agents (fixed by the sticky verdict) and screaming over
# live ones because the state dir did not exist (fixed by mkdir -p). All three
# share one root: THE RECORDER'S OUTPUT AND THE RECORDER'S STATE ARE DIFFERENT
# THINGS, and every failure came from something breaking the second while the
# first still looked fine.
trap '' PIPE

ACK_RELAUNCH=0
[ "${1:-}" = "--relaunched" ] && ACK_RELAUNCH=1

# One resolver for the state dir (scripts/work/host.mjs), shared with
# dispatch-brief.mjs so the roster and the ledger agree on every host (#3710).
# The inline fallback covers a shell with no node on PATH — the measured live
# container's own layout, so it resolves identically there.
STATE_DIR=${SCRATCH:-$(node "$(dirname "$0")/work/host.mjs" state-dir 2>/dev/null || echo /home/user/scratch)}
BOOT_FILE="$STATE_DIR/.boot_id"
SESSION_FILE="$STATE_DIR/.session_id"
ROSTER="$STATE_DIR/.roster"
# THE VERDICT MUST SURVIVE BEING READ. Detection is compare-then-stamp, so the
# first run consumes it: the second invocation in the same window sees UNCHANGED
# and prints the reassuring half over trees whose agents are still dead. That is
# not hypothetical and it is not rare — re-running the recorder is the ordinary
# way to re-read a section you truncated. Observed 2026-08-19T10:14Z: run 1
# printed *** RESTARTED *** for both boot-id and session; runs 2 and 3, seconds
# later, printed `wt-biomarker ... LIVE` and "(no rescue targets — every dirty
# tree belongs to a live agent)" over FIVE uncommitted files on a branch with no
# remote. The rescue happened only because a human still had run 1 on screen.
#
# This is the fourth time this detector has soothed over dead agents (04:38Z and
# 12:33Z on 2026-08-13 are in the comments below), and the first three fixes all
# widened WHAT counts as a restart. The remaining hole was never the detection —
# it was that the answer is destroyed by the act of reading it. So the verdict is
# now STICKY: a detected restart writes this file, every later run keeps treating
# the fleet as dead while it exists, and only an explicit --relaunched clears it.
# An worker that forgets to clear it loses nothing but a loud reminder; one
# that never sees it loses an agent's uncommitted work.
RESCUE_FILE="$STATE_DIR/.agents_dead"

# THE STATE DIR MUST EXIST BEFORE THE FIRST COMPARE, AND ITS ABSENCE MUST BE
# LOUD. Every fix above widened WHAT counts as a restart or made the verdict
# survive being read; none of them noticed that on a FRESH container
# $STATE_DIR does not exist at all. Then every stamp write fails with "No such
# file or directory", the next compare reads MISSING, and the recorder declares
# a restart that never happened — over a fleet that is alive.
#
# Measured 2026-08-21T01:46Z: the session's first check-in ran before the
# scratch directory existed. It printed *** RESTARTED *** for both boot-id and
# session, and 62 minutes later the follow-up check-in — still the same
# container, same boot-id, four subagents all `running` — printed
# "DIRTY AND NO AGENT: RESCUE NOW" over a LIVE agent's worktree. The rescue
# drill that verdict authorises is "commit whatever is in the tree and push";
# performed against a live lane it is the two-writers-on-one-worktree failure
# the runbook forbids everywhere else.
#
# This is the same defect shape as the sticky-verdict fix directly above, in
# the other direction: that one soothed over dead agents, this one screams over
# live ones. Both teach the same thing — a recorder whose alarm is wrong in
# EITHER direction stops being read. So: create the directory, and if it cannot
# be created, say so and exit non-zero rather than reporting a restart that is
# really a failed write. An inoperative flight recorder must not be mistaken
# for a flight recorder reporting bad news.
if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  echo "=== WORKER CHECK-IN: CANNOT CREATE STATE DIR ==="
  echo "  $STATE_DIR is not creatable, so restart detection CANNOT WORK."
  echo "  Every verdict this script would print is a failed write, not a finding."
  echo "  Fix the directory before trusting any check-in output."
  exit 1
fi

REPO=$(git rev-parse --show-toplevel 2>/dev/null || echo /home/user/allos)

echo "=== WORKER CHECK-IN  $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
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
  echo "  >>> Assume every subagent and in-process timer died with the old session."
  echo "  >>> The roster below records DISPATCH, not liveness — treat all of it as DEAD."
  echo "  >>> PRESERVE-FIRST DRILL applies to every dirty worktree before relaunching."
  echo "  >>> THEN CONFIRM WITH ListAgents BEFORE RELAUNCHING ANYTHING — see below."
  SESSION_NEW=1
fi

# ROLLBACK DETECTION, AND WHY THE BOOT-ID CANNOT DO IT.
#
# The boot-id and the session-id answer "did my process die". They cannot answer
# "is this the tree I left", and on 2026-08-22T17:25Z that gap cost a
# misdiagnosis: boot-id UNCHANGED + session RESTARTED printed as a RESTART with a
# CURRENT tree, while the checkout had actually been rolled back several hours —
# every commit of that session unreachable, a file set the worker did not
# recognise, and `docs/work/review-merge.md` reverted to a two-day-old
# copy. The tell that worked was reading `git log` and not recognising it, which
# is a human step this recorder exists to remove.
#
# So ask the ONE question the boot-id cannot: is the local branch behind its own
# remote? A rollback restores an old working copy while the remote keeps every
# pushed commit — that is the documented shape of all four so far — so
# local-behind-remote is the signature, and it is cheap to test.
#
# `git ls-remote` on purpose, NOT the remote-tracking ref: a rollback rewinds
# `.git/` too, so `origin/<branch>` is rolled back with everything else and
# comparing against it says the tree agrees with itself. That is exactly the
# reassuring answer the 17:25Z run gave.
BRANCH_NOW=$(git -C "$REPO" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
if [ -n "$BRANCH_NOW" ]; then
  head_local=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo "")
  head_remote=$(git -C "$REPO" ls-remote origin "refs/heads/$BRANCH_NOW" 2>/dev/null | awk '{print $1}')
  if [ -n "$head_remote" ] && [ -n "$head_local" ] && [ "$head_local" != "$head_remote" ]; then
    if git -C "$REPO" cat-file -e "$head_remote" 2>/dev/null &&
       git -C "$REPO" merge-base --is-ancestor "$head_local" "$head_remote" 2>/dev/null; then
      echo "checkout: *** LOCAL IS BEHIND THE REMOTE — THIS IS A ROLLBACK, NOT A RESTART ***"
      echo "  >>> local  $head_local"
      echo "  >>> remote $head_remote  (has commits this checkout has lost)"
      echo "  >>> git fetch --prune origin && git merge --ff-only origin/$BRANCH_NOW"
    else
      echo "checkout: local and remote DIVERGED, or the remote head is not local yet."
      echo "  >>> local  $head_local"
      echo "  >>> remote $head_remote"
      echo "  >>> git fetch --prune origin, then decide — do NOT assume the tree is current."
    fi
  fi
fi

# WHICH WAY THIS VERDICT IS SAFE, AND WHICH WAY IT IS NOT.
#
# Both detectors above are PROXIES: they compare the identity of the machine and
# of the claude process, and infer the fleet from that. Snapshot-style resume
# breaks the inference in the direction the comments above never considered —
# both ids change while the process TREE IS RESTORED, so the recorder reports a
# restart over agents that are still running.
#
# Observed 2026-08-19T10:14Z, minutes after the sticky-flag fix above shipped for
# the opposite failure. boot-id changed, session changed, uptime reset — and
# `ListAgents` showed the two dispatched agents still RUNNING, 33 and 34 minutes
# in. Acting on the verdict, the worker relaunched both, putting TWO
# WRITERS ON ONE WORKTREE on two branches at once. One relaunch detected the
# collision and stood down with nothing written; the other ran full test tiers in
# a tree its sibling was editing, which is a phantom-failure generator even when
# it writes no source. Nothing was lost, and only because a subagent was careful.
#
# So the rule is asymmetric, and both halves matter:
#   RESCUE on the verdict — committing a dirty tree costs a junk commit if the
#     agent was alive, and saves unrepeatable work if it was not. Cheap either way.
#   RELAUNCH only after CONFIRMING with a source that actually knows liveness —
#     ListAgents, not this script. A relaunch onto a live agent is a second
#     writer, and the doctrine's own rule (never edit a live agent's worktree
#     without an acknowledgement) is violated by the relaunch itself.
# A proxy may raise the alarm. It may not authorise the destructive response.

# One flag for the one consequence. A machine reboot and a session restart differ
# in what else they take down (tmp dirs, dev servers, the port map) but agree
# completely on this: there is no live agent afterwards.
AGENTS_DEAD=0
[ "$RESTARTED" = "1" ] && AGENTS_DEAD=1
[ "$SESSION_NEW" = "1" ] && AGENTS_DEAD=1

# Sticky, per RESCUE_FILE's note: raise the flag on detection, and keep answering
# from it until the worker says the fleet is back. The clear is explicit
# and comes FIRST so that `--relaunched` on a run that ALSO detects a fresh
# restart still ends with the flag raised — the newer restart wins over an ack
# written for the older one.
if [ "$ACK_RELAUNCH" = "1" ] && [ -f "$RESCUE_FILE" ]; then
  echo "rescue flag CLEARED (was: $(head -1 "$RESCUE_FILE" 2>/dev/null))"
  rm -f "$RESCUE_FILE"
fi
if [ "$AGENTS_DEAD" = "1" ]; then
  [ -f "$RESCUE_FILE" ] || printf 'detected %s (boot RESTARTED=%s, session RESTARTED=%s)\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RESTARTED" "$SESSION_NEW" > "$RESCUE_FILE"
elif [ -f "$RESCUE_FILE" ]; then
  AGENTS_DEAD=1
  echo "agents:   *** STILL DEAD (sticky) *** — $(head -1 "$RESCUE_FILE" 2>/dev/null)"
  echo "  >>> This run detected no NEW restart; the flag from the earlier one stands."
  echo "  >>> Rescue every dirty tree and relaunch every rostered cluster, THEN run:"
  echo "  >>>   bash scripts/work-checkin.sh --relaunched"
fi
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

  # A TREE BEING WRITTEN RIGHT NOW HAS SOMETHING ALIVE IN IT, whatever the flag
  # says. AGENTS_DEAD is inferred from boot-id and session-id, and snapshot-style
  # resume changes both while RESTORING the process tree — so the recorder reports
  # a restart over agents that never stopped. The note above already stated the
  # rule ("a proxy may raise the alarm, it may not authorise the destructive
  # response") and it was followed the first time and not the second: on
  # 2026-08-28 four lanes were relaunched onto four live agents, putting two
  # writers on every one of them for half an hour. Prose did not stop it.
  #
  # So ask the filesystem instead of the flag. A file modified in the last two
  # minutes means a process is working here — an editor, a build, a test run.
  # This cannot prove a tree is idle (an agent thinking writes nothing), so it
  # only ever CONTRADICTS a dead verdict; it never authorises one.
  writing=0
  if [ -n "$(find "$d" -xdev -newermt '-120 seconds' \
        -not -path '*/node_modules/*' -not -path '*/.git/*' \
        -not -path '*/.next/*' -print -quit 2>/dev/null)" ]; then
    writing=1
  fi

  # THE READ-ONLY LANE IS NOT A RESCUE TARGET. The adversarial reviewer (#2626)
  # works in a throwaway worktree checked out at a PR's MERGE ref — detached, on
  # no branch, never pushed, deliberately disposable, and holding whatever scratch
  # its attacks wrote. Classified as an agent's branch it reads DIRTY AND NO AGENT
  # plus NEVER PUSHED, and the second of those is advice that cannot be followed:
  # a detached HEAD has no branch to push. An alarm you cannot act on is the
  # canary again, so recognise the lane instead of alarming on it.
  #
  # This exemption was keyed on the lane's NAME twice, and drifted twice. First
  # `wt-refute-*`, which missed the hand-named `wt-refute2-2634` by one character
  # and alarmed on the very lane it had just been taught to recognise; then
  # `wt-refute*`, whose own comment predicted the next drift in as many words —
  # "an exemption keyed on a name a human types will drift from the name that
  # human types next time". It did. #2976 now tells every agent to build an
  # origin/main CONTROL worktree before calling a contended failure a regression,
  # so disposable checkouts arrive constantly and under whatever name the agent
  # picked: `wt-base-2978`, `wt-ctrl-2979`, `wt-control-fasting` and
  # `wt-navpend-base` all appeared within one session, and the two dirty ones
  # each raised RESCUE NOW over untracked probe files. A recurring false alarm on
  # the most common workflow in the session is the canary again.
  #
  # So stop guessing spellings and ask the question the name was standing in for:
  # WAS ANYTHING AUTHORED HERE? The rescuable thing in a detached worktree is a
  # COMMIT, because a commit on no branch is one `worktree remove` from gone.
  # Both lanes author none — they check out a ref that already exists on the
  # remote (`origin/main` for a control, `refs/pull/N/merge` for a refuter) and
  # write only probes on top. A worktree's HEAD reflog is worktree-local, so it
  # answers this directly and needs no network.
  #
  # Reachability was the tempting test and it is WRONG, measured rather than
  # assumed: a refuter at a fetched merge ref is not an ancestor of origin/main
  # and `for-each-ref --contains` finds nothing, because the merge ref lands in
  # FETCH_HEAD and never gets a named ref. Testing reachability would have
  # re-broken the exact lane this exemption was written for.
  #
  # The deliberate silence is a DIRTY detached worktree with no commits: that is
  # a lane's scratch. Real work arrives on a branch, because that is what the
  # dispatch procedure hands every agent — so detached-and-uncommitted is probes.
  #
  # The reflog is CAPTURED FIRST and matched without a pipeline, and that is
  # load-bearing under this script's `set -o pipefail` (line 39). Written as
  # `git … | grep -q`, grep closes the pipe at the first match, git takes SIGPIPE
  # and reports 141, pipefail promotes 141 to the pipeline's status, and the
  # leading `!` turns a MATCH into "nothing authored". It is a race, not a
  # constant: the first draft of this test printed the rescue alarm on runs 1 and
  # 3 and swallowed it on run 2, same tree, same commit, nothing changed between
  # them. A safety alarm that fires two times in three is worse than one that
  # never fires, because the two successes teach you to trust the silence.
  wt_reflog=$(git -C "$d" reflog show HEAD 2>/dev/null || true)
  if [ "$b" = "HEAD" ] &&
     ! grep -qE '\bcommit( \([a-z-]+\))?: ' <<<"$wt_reflog"; then
    # SAY WHAT IS ACTUALLY THERE. The decision above — a detached worktree with
    # no commits is a lane's scratch and its dirt is probes — is sound and stands.
    # The old wording for it, "nothing authored here", was not: four such trees
    # held 34 uncommitted probe files between them while this line claimed none.
    # A status line that overstates its own silence is the same defect this
    # session keeps finding in guards: the decision was right, the claim
    # licensing it was false, and only the claim is visible at 3am after a
    # restart. Print the count so the reader makes the call the recorder is
    # merely recommending.
    wt_probes=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    if [ "${wt_probes:-0}" -gt 0 ]; then
      wt_note="read-only lane, ${wt_probes} uncommitted probe file(s) — not rescued: no commits, so this is scratch"
    else
      wt_note="read-only lane, clean — nothing to rescue"
    fi
    printf "  %-16s %-32s %-6s local=%s  (%s)\n" \
      "$(basename "$d")" "(detached)" "lane" "${h:0:7}" "$wt_note"
    continue
  fi
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
  if [ "$live" = "0" ] && [ "$writing" = "1" ]; then
    state="WRITING"
    flag="$flag  <<< FLAG SAYS DEAD, THIS TREE SAYS OTHERWISE: written in the last 120s."
    flag="$flag CONFIRM WITH ListAgents BEFORE RELAUNCHING — a relaunch here is a SECOND WRITER."
    alarms=1
  fi
  if [ "$live" = "0" ] && [ "$writing" = "0" ]; then
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
  #
  # CLASSIFY it, do not just compare strings. This test used to be
  # `[ "${h:0:7}" != "$r" ]` printing "(local ahead of remote)", which fires on
  # ANY difference — so a worktree merely BEHIND its remote (harmless, the agent
  # just has not pulled) got the same words as one carrying unpushed work. The
  # alarm that matters is AHEAD, and a label that also fires on the harmless case
  # is a label you learn to skim. That is the same failure as an alarm that fires
  # two times in three, one level down.
  #
  # Measured on 2026-08-22: wt-hc-overlap read "local ahead of remote" while its
  # HEAD was an ANCESTOR of the remote tip — nothing unpushed at all.
  if [ -n "$r" ] && [ "${h:0:7}" != "$r" ]; then
    if git -C "$d" merge-base --is-ancestor "$h" "origin/$b" 2>/dev/null; then
      flag="$flag  (local BEHIND remote — stale checkout, nothing to rescue)"
    elif git -C "$d" merge-base --is-ancestor "origin/$b" "$h" 2>/dev/null; then
      flag="$flag  (local AHEAD of remote — UNPUSHED COMMITS HERE)"
    else
      flag="$flag  (local DIVERGED from remote — unpushed commits AND remote moved)"
    fi
  fi
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

# 3. The roster the worker's own memory cannot be trusted to hold.
echo "--- in-flight roster (written at dispatch; the only copy that outlives you) ---"
if [ -s "$ROSTER" ]; then sed 's/^/  /' "$ROSTER"; else echo "  (empty)"; fi

# ROSTER vs LEDGER DIVERGENCE. They are two files kept in step by
# dispatch-brief.mjs, and ONLY by it: `new` appends to both, `done` closes both.
# Close a dispatch by editing the JSONL directly — which is tempting, because it
# is one append — and the roster keeps a `Cluster` line for a lane that is over.
# That line is not cosmetic. Live-vs-done classification above is anchored to
# `^Cluster` (see live_branches), so a stale entry makes a DEAD worktree read
# LIVE, and a LIVE tree is never a rescue target: after a rollback restored it,
# its dirty contents would be skipped as "belongs to a live agent". The
# divergence is silent in both files on their own; only the comparison shows it.
# Observed 2026-08-22 on card-mode-breakpoint. Always close with
# `dispatch-brief.mjs done <branch>`.
LEDGER="$STATE_DIR/allos-dispatch-ledger.jsonl"
if [ -s "$ROSTER" ] && [ -s "$LEDGER" ]; then
  roster_live=$(grep -E '^Cluster ' "$ROSTER" 2>/dev/null | awk '{print $3}' | sort -u)
  ledger_live=$(node "$(dirname "$0")/work/ledger.mjs" branches "$LEDGER" 2>/dev/null)
  only_roster=$(comm -23 <(echo "$roster_live") <(echo "$ledger_live") | grep -v '^$' || true)
  only_ledger=$(comm -13 <(echo "$roster_live") <(echo "$ledger_live") | grep -v '^$' || true)
  if [ -n "$only_roster" ] || [ -n "$only_ledger" ]; then
    echo "  *** ROSTER/LEDGER DIVERGENCE — they are kept in step by dispatch-brief.mjs alone ***"
    [ -n "$only_roster" ] && echo "$only_roster" | sed 's/^/      roster says LIVE, ledger says done: /'
    [ -n "$only_ledger" ] && echo "$only_ledger" | sed 's/^/      ledger says active, roster has no Cluster line: /'
    echo "      A stale Cluster line makes a DEAD worktree classify LIVE above, so it is"
    echo "      never a rescue target. Fix the roster by hand, then close via"
    echo "      dispatch-brief.mjs done <branch> from now on."
  fi
fi
echo

# 3c. LANE SATURATION — the refill posture, printed where it cannot be walked
# past. Two measured drifts (owner, 2026-08-30): after a few merges the session
# sits at one lane; after a recovery it announces "the lanes are empty" and
# stops. Both misread the roster. An empty or thin roster with holds clear is a
# DISPATCH ORDER (the refill rule: dispatch continuously while viable work
# exists, without asking), and "empty" is only an honest terminal state next to
# the enumerated list of why each remaining issue cannot dispatch.
# THE COUNT IS PER AXIS (owner, 2026-08-31), because a live session read "both
# e2e slots full" as "the queue is thin" — a capacity limit substituted for a
# queue fact — while roughly three non-e2e slots sat open. The caps are
# separate: 2 e2e lanes, ~5 lanes total, ~3 unreviewed PRs, and only the axis
# that is actually full is allowed to say so.
lanes=$(grep -cE '^Cluster ' "$ROSTER" 2>/dev/null || true)
lanes=${lanes:-0}
e2e_lanes=$(node "$(dirname "$0")/work/ledger.mjs" e2e-count "$LEDGER" 2>/dev/null || echo "?")
if [ "$e2e_lanes" = "?" ]; then other_lanes="?"; else other_lanes=$((lanes - e2e_lanes)); fi

# THE QUEUE IS WRITTEN DOWN (owner, 2026-08-31): candidates forgotten one at a
# time — a reconcile never looked for, small issues never paired, self-filed
# items mentally reclassified as backlog — cannot be forgotten from a file.
# queue-snapshot.mjs sweeps open issues into $STATE_DIR/.queue; the recorder
# refreshes it on the 4h cadence, and prints its own header line below so
# every check-in states the dispatchable count next to the lane count.
QUEUE_FILE="$STATE_DIR/.queue"
QUEUE_DUE_SECS=$((4 * 3600))
queue_age_s=""
if [ -f "$QUEUE_FILE" ]; then
  queue_mtime=$(date -u -r "$QUEUE_FILE" +%s 2>/dev/null || stat -c %Y "$QUEUE_FILE" 2>/dev/null || echo "")
  [ -n "$queue_mtime" ] && queue_age_s=$(($(date -u +%s) - queue_mtime))
fi
if [ -z "$queue_age_s" ] || [ "$queue_age_s" -ge "$QUEUE_DUE_SECS" ]; then
  node "$(dirname "$0")/work/queue-snapshot.mjs" >/dev/null 2>&1 ||
    echo "  *** queue snapshot FAILED (needs a read token) — $QUEUE_FILE may be stale ***"
fi
queue_header=$(head -1 "$QUEUE_FILE" 2>/dev/null || echo "UNWRITTEN — run queue-snapshot.mjs")

echo "--- lanes ---"
if [ "$lanes" -eq 0 ]; then
  echo "  0 active — *** AN EMPTY ROSTER IS A DISPATCH ORDER, NOT A REPORT ***"
  echo "      Rescue done? Then unless a hold above or an owner wind-down governs,"
  echo "      triage and dispatch NOW (dispatch.md §Dispatch). 'The lanes are empty'"
  echo "      is only honest beside the list of why every remaining issue is"
  echo "      blocked, owner-gated, or dependency-bound."
elif [ "$lanes" -lt 3 ]; then
  echo "  $lanes active (e2e $e2e_lanes/2, other $other_lanes) — UNDER-SATURATED. A full e2e"
  echo "      lane is NOT a thin queue: the caps are separate axes (2 e2e, ~5 lanes,"
  echo "      ~3 unreviewed PRs). Before calling the queue thin, check the candidate"
  echo "      classes that get skipped: PAIR small issues into one cluster, source"
  echo "      self-filed P3s (back of the queue is still IN the queue), and do the"
  echo "      standing work (reconcile pass, release-notes batch). 'Thin' must"
  echo "      answer $QUEUE_FILE line by line — the queue is written down."
else
  echo "  $lanes active (e2e $e2e_lanes/2)"
fi
echo "  queue: ${queue_header%% —*} — full list in $QUEUE_FILE"
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
# 3b. OWNER HOLDS — the one input no script can derive.
#
# Everything else this recorder prints is recoverable: worktrees from git, the
# roster from disk, CI from the API. A HOLD is different — "do not dispatch
# training until #2953 merges" exists only because the owner said so, and until
# now it lived only in the worker's context, which a restart or a
# compaction erases. That is the canary failure aimed at the one fact whose loss
# is unrecoverable: the others fail loudly, a forgotten hold fails by an agent
# quietly doing fenced work.
#
# Conditional holds are the sharp case and the reason this is a file rather than
# a habit: a release condition ("when PR #2953 merges") has to survive long
# enough to be NOTICED, and the noticing happens here, at the next check-in.
# Format is deliberately prose after the scope — a human writes it, this only
# has to hand it back, and a parser would be a second thing to keep in step.
echo "--- owner holds ---"
HOLDS_FILE="$STATE_DIR/.holds"
# Branch on REAL holds, not on file size. A file holding only its header comment
# is non-empty, so `-s` sent it down the has-holds path: no hold lines printed
# and the "check your conditions" footer fired anyway, telling the reader to
# check nothing. Caught by running the control rather than by reading the code.
#
# A `#` FOLLOWED BY A DIGIT IS A HOLD, NOT A COMMENT. Every hold is about issues,
# so the natural way to write one starts `#2870 and #3009 are the owner's` — and
# under a bare `^#` comment rule that line is stripped, silently, leaving the
# check-in printing "none recorded" for a hold that was just written. Measured
# here on 2026-08-16 with exactly that text. It is the worst possible failure for
# this file specifically: the header above says a forgotten hold "fails by an
# agent quietly doing fenced work", and a hold silently swallowed at write time
# is indistinguishable from one never written. Prose comments still start `#`
# plus a space or a letter, which is how every comment in this file is already
# written, so nothing existing changes meaning.
holds=$(grep -vE '^[[:space:]]*(#([^0-9]|$)|$)' "$HOLDS_FILE" 2>/dev/null)
if [ -n "$holds" ]; then
  # Per LINE, not per string: `printf '%s' "$holds"` passes a multi-line value as
  # ONE argument, so a second hold printed without its own marker and read as
  # continuation prose of the first. A hold that does not look like a hold is a
  # hold that gets skimmed.
  while IFS= read -r hold; do
    echo "  *** HELD: ${hold}"
  done <<EOF
$holds
EOF
  echo "  Check each release condition NOW — a hold whose condition has fired is"
  echo "  work you are wrongly refusing. Clear it by editing $HOLDS_FILE."
else
  echo "  none recorded"
fi
echo

echo "--- wake ---"
WAKE_FILE="$STATE_DIR/.wake"
if [ ! -s "$WAKE_FILE" ]; then
  echo "  *** NO DURABLE WAKE ARMED — arm send_later NOW and record it: ***"
  echo "      echo '<fire_at ISO> <trigger_id>' > $WAKE_FILE"
  alarms=1
else
  # Tolerate a leading `next:` label, because the check-in PRINTS the armed wake
  # as "next: <ISO> <id>" and an worker copying its own output back into
  # the file is the obvious mistake — one that made this alarm lie for a whole
  # session (2026-08-16). `awk '{print $1}'` read "next:", `date -d` refused it,
  # `|| echo 0` turned that refusal into epoch 0, and 0 is in the past — so a
  # correctly-armed wake reported as lapsed at every check-in. Three redundant
  # one-shot triggers were armed chasing it.
  wake_at=$(awk '{ if ($1 == "next:") print $2; else print $1 }' "$WAKE_FILE")
  wake_id=$(awk '{ if ($1 == "next:") print $3; else print $2 }' "$WAKE_FILE")
  now_s=$(date -u +%s)
  # MALFORMED IS NOT PAST. Collapsing an unparseable timestamp into "past" is the
  # ignorable-alarm failure this script exists to avoid: both answers say "re-arm",
  # but re-arming cannot fix a format the reader cannot parse, so the alarm repeats
  # after the fix and teaches its reader to skip it. Keep the two distinguishable.
  if wake_s=$(date -u -d "$wake_at" +%s 2>/dev/null); then
    if [ "$wake_s" -gt "$now_s" ]; then
      printf "  next: %s (in %dm) %s\n" "$wake_at" $(((wake_s - now_s) / 60)) "$wake_id"
    else
      echo "  *** WAKE IS IN THE PAST ($wake_at) — nothing future is armed. Re-arm send_later NOW. ***"
      # AND RECORD IT — arming without recording is why this alarm fired three
      # check-ins running on 2026-08-29 while two wakes were in fact armed. The
      # absent-file branch above prints this command; this branch used to say only
      # "re-arm", so an worker that re-armed correctly still saw the same
      # alarm next time and had no way to tell a lapse from an unrecorded arm.
      # Both branches say it now, because the step that gets skipped is the write.
      echo "      echo '<fire_at ISO> <trigger_id>' > $WAKE_FILE"
      alarms=1
    fi
  else
    echo "  *** WAKE FILE IS MALFORMED — cannot tell whether anything is armed. ***"
    echo "      unparseable as a date: '$wake_at'"
    echo "      expected: <fire_at ISO> <trigger_id>   (a leading 'next:' is also accepted)"
    echo "      found:    $(head -c 120 "$WAKE_FILE")"
    alarms=1
  fi
fi
echo

# 5. Cheap environment facts a restart can change.
echo "--- environment ---"
df -h / | awk 'NR==2 {print "  disk: " $4 " free (" $5 " used)"}'
# EVERY prefix, with a per-prefix breakdown of the worst offenders — not the two
# hand-picked counters this used to print. #3248 was diagnosed on a container whose
# backlog was 76% `allos-db-shared-*`; by the time it was re-measured that prefix was
# 0.4% and the leak had moved entirely to per-spec temp dirs nothing counted. Two
# named counters cannot see a leak move, and #3248's author lost the A/B that would
# have named the new leaker because nothing had ever recorded the shape. Anything
# older than an hour is stranded by definition — lib/__tests__/tmp-dir.ts sweeps at
# that threshold, so a non-zero count here means either a very recent kill or a temp
# path that is not going through makeTmpDir.
stale=$(find /tmp -maxdepth 1 -name 'allos-*' -mmin +60 2>/dev/null | wc -l | tr -d ' ')
echo "  tmp: $stale stranded /tmp/allos-* (older than 60 min)"
if [ "$stale" -gt 0 ]; then
  find /tmp -maxdepth 1 -name 'allos-*' -mmin +60 -printf '%f\n' 2>/dev/null |
    sed -E 's/-[A-Za-z0-9]{6}$//; s/-[0-9]+\.zip$//' |
    sort | uniq -c | sort -rn | head -5 |
    awk '{print "        " $1 " x " $2 "-*"}'
fi
if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "  GH_TOKEN: present"
elif command -v gh >/dev/null 2>&1 && gh auth token >/dev/null 2>&1; then
  echo "  GH_TOKEN: unset, gh auth present - reads OK, writes need the variable"
else
  echo "  GH_TOKEN: *** MISSING - see the credential-loss section of the runbook ***"
fi
nodebin=$(node "$(dirname "$0")/work/host.mjs" node-bin 2>/dev/null)
echo "  node(.nvmrc): ${nodebin:-ABSENT - install the .nvmrc major with your version manager}"
echo "  main:   $(git -C "$REPO" ls-remote origin main 2>/dev/null | cut -c1-7)"
echo

# 6. Catch-up gate. The digest (catchup-digest.sh) was designed to wrap this
# recorder, but the runbook routes every wake HERE, so the digest only ran
# when a prompt happened to name it (owner, 2026-08-30) — the MCP-by-default
# drift class: a tool that waits to be remembered is a tool that isn't run.
# So the recorder ROUTES: anchor >= 4h stale (the queue-sweep cadence, or
# unparseable — BSD date lands here and the digest's own 24h fallback takes
# over) runs the digest right now, and a check-in cannot skip catching up.
echo "--- catch-up ---"
CATCHUP_DUE_SECS=$((4 * 3600))
catchup_anchor=$(cat "$STATE_DIR/.last_catchup" 2>/dev/null || true)
catchup_anchor_s=$(date -u -d "$catchup_anchor" +%s 2>/dev/null || echo "")
now_s=$(date -u +%s)
if [ -n "$catchup_anchor_s" ] && [ $((now_s - catchup_anchor_s)) -lt "$CATCHUP_DUE_SECS" ]; then
  echo "  digest anchor $(((now_s - catchup_anchor_s) / 60))m old — due at 4h; \`catchup-digest.sh --peek\` any time"
else
  echo "  digest DUE (anchor: ${catchup_anchor:-none}) — running it now:"
  echo
  CATCHUP_SKIP_RECORDER=1 bash "$(dirname "$0")/work/catchup-digest.sh" ||
    echo "  *** digest FAILED — run scripts/work/catchup-digest.sh by hand ***"
fi
echo

# Stamp LAST, so a crash mid-check-in still reports the restart next time.
#
# A FAILED STAMP IS A FUTURE FALSE RESTART, so it is announced rather than
# swallowed. mkdir -p succeeding does not prove these writes succeed — a full
# disk or a read-only mount fails here and nowhere else — and the cost is paid
# by the NEXT run, which reads MISSING and cries restart at a live fleet.
stamp() {
  local file="$1" value="$2" ok="$3"
  if echo "$value" > "$file" 2>/dev/null; then
    echo "$ok"
  else
    echo "*** STAMP FAILED: could not write $file ***"
    echo "    The NEXT check-in will read this as MISSING and report a restart"
    echo "    that did not happen. Fix the write before trusting that verdict."
  fi
}
if [ "$RESTARTED" = "1" ]; then
  stamp "$BOOT_FILE" "$CUR" \
    "boot-id stamped. Timers and any canary are DEAD - re-arm them now."
fi
if [ -n "$sid" ] && [ "$SESSION_NEW" = "1" ]; then
  stamp "$SESSION_FILE" "$sid" \
    "session stamped. Every subagent and in-process timer is DEAD - relaunch and re-arm now."
fi
