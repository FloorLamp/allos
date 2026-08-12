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
run_gate "format (LAST)" npm run format

if ! git diff --quiet; then
  echo
  echo "NOTE: Prettier rewrote files after the test gates. Commit them NOW and do not"
  echo "edit anything afterwards — an edit after format is the known CI breaker this"
  echo "script exists to prevent. If you must edit, re-run this script from the top."
fi

echo
echo "ALL GATES PASSED (format included). Remember: run YOUR changed e2e specs at CI"
echo "parity on your assigned port range before opening the PR — this script does not"
echo "run Playwright."
