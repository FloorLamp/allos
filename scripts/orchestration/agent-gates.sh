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

run_gate "lint" npm run lint
run_gate "typecheck" npm run typecheck
run_gate "test (pure)" npm test
run_gate "test:db" npm run test:db

base="$(git merge-base origin/main HEAD 2>/dev/null || echo origin/main)"
if ! git diff --quiet "$base" HEAD -- e2e/ 2>/dev/null || ! git diff --quiet -- e2e/ 2>/dev/null; then
  run_gate "e2e-hygiene (e2e/ changed)" npx vitest run lib/__tests__/e2e-hygiene.test.ts
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

if [ "$prettier_would_rewrite" = "1" ]; then
  echo
  echo "NOTE: Prettier rewrote files after the test gates. Commit them NOW and do not"
  echo "edit anything afterwards — an edit after format is the known CI breaker this"
  echo "script exists to prevent. If you must edit, re-run this script from the top."
fi

echo
echo "ALL GATES PASSED (format included). Remember: run YOUR changed e2e specs at CI"
echo "parity on your assigned port range before opening the PR — this script does not"
echo "run Playwright."
