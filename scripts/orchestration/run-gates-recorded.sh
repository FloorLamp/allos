#!/usr/bin/env bash
# Run agent-gates.sh with its PID and exit code RECORDED ON DISK — the brief's
# waiting idiom as a script, so a lane cannot mis-paste it (#5385, #5366).
#
#   bash scripts/orchestration/run-gates-recorded.sh <branch>          # start, wait, report
#   bash scripts/orchestration/run-gates-recorded.sh <branch> --wait   # collect a run
#        this shell did not start: wait on the recorded PID while it is alive,
#        then report — marked REPLAY when there was nothing left to wait for
#
# Run from the worktree root (agent-gates.sh reads the diff there). Files land
# under the state dir host.mjs resolves — the one the brief's worktree lives in.
# EVERY RUN IS ITS OWN RECORD (#5712); nothing here rewrites a finished run:
#   gates-<branch>-<runid>.log       every line that run printed
#   gates-<branch>-<runid>.log.pid   the run's PID, captured from $! — the one
#                            fact no other process's command line can impersonate
#   gates-<branch>-<runid>.log.exit  the exit code, written by the run as it ends
#   gates-<branch>.log{,.pid,.exit}  symlinks to the newest run's three, so a
#                            reader who knows only the branch still finds it
# <runid> is the run's UTC start and the starting shell's PID. A branch name
# containing `/` puts a directory inside these paths, and `start` creates it
# (#5761).
#
# TWO FACES, AND `--wait` IS BOTH. The harness may detach the first call, so a
# lane collects the result later — usually from a run that has ALREADY
# finished. Re-reading a finished run is legitimate; believing it is current is
# not. Before #5712 that reading came back verbatim with nothing to tell the
# two apart, so a lane that fixed its code and re-collected read its own
# pre-fix FAILURE, and a lane that changed code after a PASS read a green for
# code no gate had seen — the direction that reaches main. A collection that
# waited on nothing now says REPLAY and how long ago that run ended, above the
# verdict it still prints.
#
# ONE RUN PER RECORD, FOR THE SAME REASON. The log used to be keyed on the
# branch alone, so a second `start` TRUNCATED the first run's log and removed
# its `.exit`. Observed on `stream-reveal-arrival-5040`: a lane reported its
# gates, the orchestrator re-ran them on the branch 82 minutes later, and the
# record that would have settled any disagreement was the one deleted.
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
# Per-run records accumulate, so `start` sweeps the ones IT named once they are
# a day old — the by-construction reclaim this tree already uses for walk trees
# (merge-gate-core.mjs) and temp dirs (lib/__tests__/tmp-dir.ts), because a run
# that was killed runs no teardown. It never takes a run whose PID is alive,
# the newest run of any branch, or a file this script did not name.
#
# Exit code: the gates' own (from the `.exit` file); 1 if the run died without
# writing one; 2 for a usage or state-dir failure before anything ran, and for a
# report with no log at all — nothing ran, which is not a killed run.

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] || [ -z "${1:-}" ]; then # the header IS the usage (usage.mjs is the JS twin)
  sed -n '2,${/^#/!q;s/^#[[:space:]]\{0,1\}//p;}' "$0"
  [ -n "${1:-}" ]
  exit $?
fi

set -uo pipefail

BRANCH=$1
MODE=${2:-start}
HELPERS=$(dirname "$0")
case "$MODE" in start | --wait) ;; *)
  echo "run-gates-recorded.sh: unknown mode $MODE — see --help" >&2
  exit 2 ;;
esac

# The state dir is the resolver's answer or nothing: a guessed one writes the
# .pid where no later shell will look, which is the defect this file replaces.
if ! STATE_DIR=$(node "$HELPERS/host.mjs" state-dir); then
  echo "=== GATES: STATE-DIR RESOLVER FAILED — node $HELPERS/host.mjs state-dir exited non-zero (its error is above); nothing ran ===" >&2
  exit 2
fi
# The branch's name is a POINTER to its newest run, never a record itself.
L="$STATE_DIR/gates-$BRANCH.log"

# How long a superseded run stays readable. The disagreement this keeps
# settleable took 82 minutes to surface (#5712), so the walk trees' hour is too
# short; a day covers a lane's whole life and the promotion that follows it.
RETAIN_MIN=1440

# What a pointer points at, as a path in the pointer's own directory — spelled
# from `readlink` and `dirname` rather than `readlink -f` so it composes the
# same string the globs below produce. A canonicalised state dir would match
# none of them, and the sweep would stop recognising the runs it must keep.
link_target() {
  local t
  t=$(readlink "$1" 2>/dev/null) && [ -n "$t" ] || return 1
  case "$t" in
    /*) printf '%s\n' "$t" ;;
    *) printf '%s\n' "$(dirname "$1")/$t" ;;
  esac
}

mtime() { date -u -r "$1" +%s 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }
stamp() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "an unrecorded time"; }
# How long ago, in the unit a reader compares against "when did I last edit":
# seconds under two minutes, then minutes, then hours and minutes.
age_of() {
  local t s
  t=$(mtime "$1") || return 1
  s=$(($(date -u +%s) - t))
  if [ "$s" -lt 120 ]; then printf '%ds\n' "$s"
  elif [ "$s" -lt 7200 ]; then printf '%dm\n' "$((s / 60))"
  else printf '%dh%dm\n' "$((s / 3600))" "$(((s % 3600) / 60))"; fi
}

# The `<runid>` tail of a run's own log path, for saying WHICH run is reported.
run_id_of() {
  local b=${1##*/} pid ts
  b=${b%.log}
  pid=${b##*-}
  b=${b%-*}
  ts=${b##*-}
  printf '%s-%s\n' "$ts" "$pid"
}

# Reclaim the per-run records this script named, at CREATION time: a run that
# was killed — the normal way one ends on this box — runs no teardown, so the
# only reclaim that holds is the one the next run performs.
sweep_named_runs() {
  local f t pid cutoff keep=""
  shopt -s nullglob
  # Three levels: the flat name, plus the directories a branch name with one or
  # two `/` in it adds. A deeper branch is simply never swept; a sweep that
  # cannot see a file must not guess at it.
  local runs=("$STATE_DIR"/gates-*.log "$STATE_DIR"/gates-*/*.log "$STATE_DIR"/gates-*/*/*.log)
  shopt -u nullglob
  for f in "${runs[@]}"; do
    [ -L "$f" ] && keep="$keep$(link_target "$f")"$'\n'
  done
  cutoff=$(($(date -u +%s) - RETAIN_MIN * 60))
  for f in "${runs[@]}"; do
    [ -L "$f" ] && continue
    # Only the names this script composes — `…-<UTC stamp>Z-<pid>.log`. A flat
    # log from before run ids, and anything else a session keeps here, is not
    # ours to remove.
    case "$f" in
      *-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-[0-9]*.log) ;;
      *) continue ;;
    esac
    # The newest run of some branch: its pointer must keep resolving, however
    # old it is. It is also the record a disagreement is settled from.
    printf '%s\n' "$keep" | grep -qxF -- "$f" && continue
    t=$(mtime "$f") || continue
    [ "$t" -lt "$cutoff" ] || continue
    # Another lane may still be writing it; ask the kernel, not the clock.
    pid=$(cat "$f.pid" 2>/dev/null) && kill -0 "$pid" 2>/dev/null && continue
    rm -f -- "$f" "$f.pid" "$f.exit"
  done
}

# Reports ONE run, named by its own log path — never the branch pointer, so
# what comes back is an identified run and not "whatever this branch last
# wrote".
report() {
  local rl=$1 code
  if code=$(cat "$rl.exit" 2>/dev/null); then
    echo "GATES EXIT=$code  (run $(run_id_of "$rl"), finished $(stamp "$rl.exit"), $(age_of "$rl.exit") ago; log: $rl)"
  elif [ ! -f "$rl" ]; then
    # NOTHING RAN is not a killed run (#5761). The redirection creates the log
    # as its first act, so a missing log means agent-gates.sh was never
    # invoked. Saying KILLED there names a cause that did not happen — a
    # session limit, an OOM, a lost container — and the reader re-runs into
    # the same wall instead of looking at the path.
    echo "=== GATES: NOTHING RAN — no log at $rl, so the run never started; is $(dirname "$rl") writable? ===" >&2
    exit 2
  else
    echo "GATES EXIT=KILLED — no exit recorded in $rl.exit (run $(run_id_of "$rl") last wrote $(stamp "$rl"), $(age_of "$rl") ago)"
    code=1
  fi
  tail -40 "$rl"
  exit "$code"
}

case "$MODE" in
  start)
    # `$L` interpolates the branch, so every `codex/…` name puts a DIRECTORY
    # component in the path (#5761). Nothing else creates it, and without it
    # both the `> "$RL"` redirection and the `.pid` write fail before
    # agent-gates.sh is invoked — no gate runs at all. Creating the parent
    # keeps the path an exact image of the branch name; flattening the name
    # instead would map `codex/foo` and `codex-foo` onto one pointer, so two
    # lanes could read each other's verdict.
    if ! mkdir -p "$(dirname "$L")"; then
      echo "=== GATES: CANNOT CREATE $(dirname "$L") for the log of branch $BRANCH; nothing ran ===" >&2
      exit 2
    fi
    RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
    RL="$STATE_DIR/gates-$BRANCH-$RUN_ID.log"
    # Point the branch at this run BEFORE it starts. If this shell dies in
    # between, `--wait` says which run has no PID rather than collecting the
    # previous run's verdict as if it were this one's.
    ln -sfn "$(basename "$RL")" "$L"
    ln -sfn "$(basename "$RL").pid" "$L.pid"
    ln -sfn "$(basename "$RL").exit" "$L.exit"
    sweep_named_runs
    { bash "$HELPERS/agent-gates.sh"; echo $? > "$RL.exit"; } > "$RL" 2>&1 &
    echo $! > "$RL.pid"
    echo "gates running as PID $(cat "$RL.pid") (run $RUN_ID); log $RL"
    wait
    report "$RL"
    ;;
  --wait)
    if ! RL=$(link_target "$L"); then
      echo "GATES: no run recorded for $BRANCH — $L does not point at a run of this script (was the run started with it, for this branch?)" >&2
      exit 2
    fi
    if ! pid=$(cat "$RL.pid" 2>/dev/null); then
      echo "GATES: no PID recorded at $RL.pid — nothing to wait on (was the run started with this script, for this branch?)" >&2
      exit 2
    fi
    # `kill -0` asks the KERNEL about that pid; it stops on ANY exit — pass,
    # fail or kill — and the `.exit` file then tells the three apart.
    if kill -0 "$pid" 2>/dev/null; then
      while kill -0 "$pid" 2>/dev/null; do sleep 5; done
    elif [ -f "$RL" ]; then
      # NOTHING WAS WAITED FOR, so no gate ran in this call (#5712). Said out
      # loud, with the age, because the reader's question is never "what did
      # this run say" but "does it still describe my code".
      if [ -f "$RL.exit" ]; then
        ended="finished $(stamp "$RL.exit") ($(age_of "$RL.exit") ago)"
      else
        ended="died without an exit code, last writing its log $(stamp "$RL") ($(age_of "$RL") ago)"
      fi
      echo "=== GATES: REPLAY — no gate ran just now: run $(run_id_of "$RL") $ended, and this is that record. Anything changed since is UNGATED — re-run run-gates-recorded.sh $BRANCH to gate it. ==="
    fi
    report "$RL"
    ;;
esac
