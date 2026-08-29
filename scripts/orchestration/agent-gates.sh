#!/usr/bin/env bash
# The dispatch template's gate sequence as one command, in the mandated order,
# so ordering stops being a memory item in every brief (docs/orchestration.md).
#
# Order is load-bearing:
#   - format runs LAST — a late edit after formatting is a known CI breaker
#     (two consecutive waves shipped a post-format spec commit that failed CI).
#   - the e2e-hygiene scan runs whenever anything under e2e/ changed vs the
#     merge-base with origin/main — the scan is 2 seconds; a CI round trip is
#     ~25 minutes.
#   - test:db runs whenever anything the DB+action tier can IMPORT changed
#     (`db_tier_paths` below), for the same reason in the other direction: it is
#     the expensive gate, and a diff confined to docs/, e2e/ or
#     scripts/orchestration/ cannot change its outcome (#2954).
#   - phi-scan runs here because the pre-commit hook does NOT fire in
#     worktrees.
#
# Run from the worktree root. Exits non-zero on the first failing gate, with
# the failing gate named on its own line — report the output VERBATIM.

set -uo pipefail

run_gate() {
  local name="$1"
  shift
  echo
  echo "=== GATE: ${name} ==="
  if "$@"; then
    echo "=== GATE ${name}: PASS ==="
  else
    local code=$?
    echo "=== GATE ${name}: FAIL (exit ${code}) ==="
    echo "Stopping here — report this verbatim; never report a green you did not see."
    exit "$code"
  fi
}

base="$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)"

# Did the diff touch any of these paths? THREE questions, because an agent runs
# gates mid-task: what is committed on the branch, what is in the tree (staged or
# not), and what is NEW — an untracked file is invisible to `git diff` entirely,
# which for a brand-new spec is exactly the case that most needs the gate. Any
# git failure (no HEAD, no origin/main) leaves --quiet non-zero and runs the
# gate: under-gating is the expensive mistake, so errors bias toward running.
paths_changed() {
  ! git diff --quiet "$base" HEAD -- "$@" 2>/dev/null ||
    ! git diff --quiet HEAD -- "$@" 2>/dev/null ||
    [ -n "$(git ls-files --others --exclude-standard -- "$@" 2>/dev/null)" ]
}

# The paths the DB+action tier's inputs live in — every file reachable from
# `vitest.db.config.ts`'s include set. VERIFIED, NEVER HAND-MAINTAINED: the
# import walk in lib/__tests__/db-gate-trigger-set.test.ts reads THIS array and
# fails when the tier reaches a file no entry covers, the discipline #2786
# established for CI's skip set one level up. A hand-list here would not fail
# when it went stale; it would quietly stop running the gate.
#
# `scripts/` is in because ~30 `lib/datasets/` modules import their generator's
# types from it; `scripts/orchestration/` is the one subtree the walk proves the
# tier never reaches, and it is what the orchestration agents edit. Entries are
# directories rather than files where the reach is broad, so the set over-runs
# the gate in places (a `scripts/*.sh` edit runs it) — that is the safe
# direction and the deliberate one.
db_tier_paths=(
  lib/
  app/
  components/
  middleware.ts
  scripts/
  ":(exclude)scripts/orchestration/"
  # The exact e2e fixture modules the DB+action tier imports. Named as individual
  # files, not as `e2e/`, so a diff confined to the browser suite still spares
  # this gate.
  e2e/video-fixture.ts
  # …and the seed's session mint plus the two modules it reaches, imported by
  # lib/__db_tests__/seed-auth-state.test.ts (#3948). Named as files for the same
  # reason as the line above: a diff confined to the browser suite still spares
  # this gate.
  e2e/seed/session.ts
  e2e/worker-env.ts
  e2e/sync-instants.ts
  # Profile-local fixture helpers imported by the date/zone invariant proofs.
  e2e/pinned-timezone.ts
  e2e/seed/profile-time-fixtures.ts
  vitest.db.config.ts
  vitest.isolation.ts
  vitest.timeouts.ts
  package.json
  package-lock.json
  tsconfig.json
)

# THE VITEST PER-TEST CEILING, RAISED FOR THIS BOX ONLY (#3436).
#
# Up to five agents share four cores here. Measured 2026-08-21, the DB tier on
# the identical tree:
#
#   load 0.78-6.03 (tier alone)   161 s wall, worst single test  3 407 ms
#   load 18.1 (four lanes + tier) 862 s wall, worst single test 16 308 ms
#
# 5.35x on wall time, 5.7x at the per-test p99 — the "about six times slower"
# the environment runbook already states, now with a measurement behind it. Both
# runs passed 6489/6489 once the ceiling allowed for the slowdown.
#
# 60 000 ms = 3.7x the worst test measured at load 18.1, which covers the load
# 22 this box has been seen at (16 308 ms x 22/18.1 = ~20 000 ms) with room for
# a burst this measurement did not sample. It is deliberately NOT a slowdown
# detector — CI is, at the strict 15 000 ms default in vitest.timeouts.ts, where
# the derivation lives. Read it there before changing either number.
#
# ONE variable covers BOTH tiers because both are vitest on the same four cores.
# The pure tier is not the cheap one it looks: its worst test measured 3 863 ms
# alone, THINNER against 5 000 ms than the DB tier's 3 407 ms, and this gate has
# been observed losing four pure tests to `Test timed out in 5000ms` at load 16
# on a diff that touches no pure-tier input.
#
# A timeout at THIS ceiling is not contention any more: 60 s is 3.7x the worst
# thing a fully loaded box has been measured to do. Treat it as a real hang.
#
# AND CONTENTION DOES NOT ONLY COST TIME, which #3436 believed and this lane
# disproved. The DB tier at the stock 5000 ms ceiling, load average 21.6, lost 92
# tests: 77 reported `Test timed out in 5000ms`, and ONE reported a WRONG VALUE —
# `AssertionError: expected [ 7, 8 ] to deeply equal [ 7 ]` in
# document-sync-provenance, the test that runs directly after a timed-out sibling
# and reads the row that sibling abandoned mid-write. A timeout aborts a test
# between its writes and its cleanup, so the next test inherits the debris. That
# failure is indistinguishable from a real regression by inspection, in a file
# the diff never touched. Raising the ceiling removes the abort that causes it.
#
# What this canNOT rescue is a test that measures elapsed time and asserts on it:
# boot-lock-race.test.ts compares two writes against a same-runner baseline and
# still fails under load. Re-run that file alone — see environment.md.
# Copying this export into a CI job would do nothing: vitest.timeouts.ts ignores
# the variable whenever `CI` is set, and lib/__tests__/vitest-timeouts.test.ts
# holds that shut. The permitter cannot become the detector by accident.
export ALLOS_VITEST_TIMEOUT_MS="${ALLOS_VITEST_TIMEOUT_MS:-60000}"

run_gate "lint" npm run lint
run_gate "typecheck" npm run typecheck
run_gate "test (pure, per-test ceiling ${ALLOS_VITEST_TIMEOUT_MS} ms)" npm test

if paths_changed "${db_tier_paths[@]}"; then
  run_gate "test:db (per-test ceiling ${ALLOS_VITEST_TIMEOUT_MS} ms)" npm run test:db
else
  echo
  echo "=== GATE test:db: SKIPPED (nothing the DB tier imports changed vs ${base:0:12}) ==="
fi

ran_e2e_hygiene=0
if paths_changed e2e/; then
  run_gate "e2e-hygiene (e2e/ changed)" npx vitest run lib/__tests__/e2e-hygiene.test.ts
  ran_e2e_hygiene=1
else
  echo
  echo "=== GATE e2e-hygiene: SKIPPED (nothing under e2e/ changed vs ${base:0:12}) ==="
fi

run_gate "phi-scan" npm run phi-scan

# ASK PRETTIER, don't infer from the tree.
#
# The first cluster to use this script (#2622) hit a false positive: the note
# fired on a run where Prettier rewrote nothing — every file logged
# `(unchanged)` — because a bare `git diff --quiet` tests the WHOLE working
# tree, and an agent running gates mid-task always has uncommitted work. It
# fired on the normal case and stayed silent only on the rare clean one, which
# is exactly backwards. A note that fires when nothing happened teaches its
# reader to skip it, and this one guards the known CI breaker.
#
# Snapshotting `git status --porcelain` around the format step does NOT fix it,
# which I found by testing the fix rather than shipping it: porcelain reports
# status CODES, not content. A tracked file already ` M` that Prettier rewrites
# again produces a byte-identical line, and an untracked file stays `??`
# whatever happens to it — so the snapshot misses both the common case and the
# new-file case.
#
# `format:check` answers the actual question and cannot drift from `format`,
# because both run the same Prettier over the same file set. Cost is one extra
# scan, seconds, and only when the tree is already going to be formatted.
if npm run --silent format:check >/dev/null 2>&1; then
  prettier_would_rewrite=0
else
  prettier_would_rewrite=1
fi
run_gate "format (LAST)" npm run format

# FORMATTING IS NOT SEMANTICALLY INERT, so a rewrite INVALIDATES the gates above.
#
# The note here used to just say "commit them NOW", which assumed the only hazard
# was an agent editing afterwards. A dispatch proved otherwise: the agent wrote a
# `@ts-expect-error` on the line directly above its erroring call, typecheck
# passed on exactly that, and then Prettier — running LAST, by design — rewrapped
# the call across three lines and slid it out from under the directive. The push
# was red on `TS2578: Unused '@ts-expect-error' directive` plus the now-unsuppressed
# error, after a gate block that legitimately read PASS. Nobody edited anything.
#
# The gates that can break this way are the ones reading LINE-POSITIONED comment
# directives: `@ts-expect-error` (typecheck), `eslint-disable-next-line` (lint),
# and the `-ok` pragmas the e2e-hygiene scan pairs with the line beneath them. The
# test tiers cannot — a rewrap changes no runtime behavior — which is why they are
# not re-run here and the cost stays seconds rather than a second full suite.
if [ "$prettier_would_rewrite" = "1" ]; then
  echo
  echo "Prettier rewrote files AFTER the gates above ran, so the gates that read"
  echo "line-positioned directives are now stale. Re-verifying them against the"
  echo "formatted tree — this is the check, not a warning."
  run_gate "lint (re-verify after format)" npm run lint
  run_gate "typecheck (re-verify after format)" npm run typecheck
  if [ "$ran_e2e_hygiene" = "1" ]; then
    run_gate "e2e-hygiene (re-verify after format)" npx vitest run lib/__tests__/e2e-hygiene.test.ts
  fi

  echo
  echo "NOTE: Prettier rewrote files. Commit them NOW and do not edit anything"
  echo "afterwards — an edit after format is the known CI breaker this script exists"
  echo "to prevent. If you must edit, re-run this script from the top."
fi

echo
echo "ALL GATES PASSED (format included). This script does not run Playwright."
echo
echo "E2E SPLITS IN TWO (policy changed 2026-08-21):"
echo "  - specs you AUTHORED or EDITED: run locally with repeat scrutiny on your port range,"
echo "    --repeat-each=3 --retries=0. That is where you can introduce a flake."
echo "    If tests in one changed file share a profile or worker-scoped mutable state,"
echo "    ALSO run that whole file with --workers=1 --repeat-each=1 --retries=0."
echo "    Repeat scrutiny and shared-fixture parity answer different questions (#3653)."
echo "  - the blast radius — specs you did not edit: DO NOT run them locally. Push"
echo "    and read CI. It runs all 438 across 12 shards in 4-5 min; a local batch"
echo "    sweep is ~30 min on four contended cores for less coverage."
echo "  Repeating a blast-radius spec locally re-rolls a die CI does not throw: the"
echo "  failures it would catch are co-residency effects, and an ordinary local run"
echo "  does not reproduce shard composition."
echo "  To DIAGNOSE a specific red you can reproduce it: e2e-shard-plan.ts <n> 12 is"
echo "  deterministic but balanced from RECORDED durations, so recompute it AT THE"
echo "  HEAD THAT RAN. On main it names the wrong neighbours (#3400)."
echo
echo "OPEN THE PR EARLY. CI triggers on pull_request only, never on a branch push,"
echo "so until it exists you have no CI. cancel-in-progress is keyed per ref, so a"
echo "second push cancels your own earlier run rather than queueing."
