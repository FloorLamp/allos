# E2E and CI

## Ownership

- The sharded CI E2E matrix is the full-suite authority. Local runs diagnose;
  they do not replace the merge gate.
- Run authored or edited specs once locally at `--retries=0`. When tests share
  a profile or worker state, run the whole file with `--workers=1` for leaks (#3653).
  Use repeats when diagnosing a timing failure, not as a routine merge step.
- CI runs the full browser suite once. The duplicate `e2e-changed` job and its
  required-check entry are removed. All 12 E2E shard checks remain required.
  The weekly and on-demand `e2e-full.yml` workflow owns repeated flake detection.
- Only the orchestrator runs a full local suite. Keep at most two agents in the
  E2E lane.
- A new navigation item requires updating `TOP_LEVEL_ORDER` in
  `e2e/nav-consolidation.spec.ts`.
- What earns a new spec, scan or guard: `what-earns-a-guard.md`.

## The first round in a new worktree

- The first run automatically reuses an identical production build from a
  sibling worktree, or builds locally if none matches (#2605).
- Reuse requires a content fingerprint of `e2e/build-inputs.mjs` inputs;
  matching commits or mtimes are insufficient. See `e2e-hygiene.md`.
- Refusals name each candidate and reason. `E2E_NO_SEED=1` disables reuse.
- `node scripts/orchestration/seed-next-build.mjs` attempts reuse manually
  (exit 3 = refused). Its `record` subcommand tags a build made by
  `npm run build` so other worktrees can reuse it.

## Merge bar

- Require every check green on the exact PR head.
- Only the landing candidate opens or refreshes a PR and runs full CI. Banked
  branches run authored/edited specs and local gates; non-authored blast radius
  waits for candidate CI. Report a blocked browser run; do not open another PR.
- Check `mergeable_state` before diagnosing absent CI. Conflict-dirty PRs do not
  start checks.
- A green check describes the base used for that run. Re-merge current main and
  reverify branches that have sat or overlap recent shared changes.
- Stop merges when `CI (main)` or `E2E (main)` is red. Fix main first.
- A green names its tier and nothing more. `CI (main)` covers `check`,
  `test-unit`, `test-db` — it cannot see e2e. `E2E (main)` is the post-merge
  browser run and the only main-side evidence about the browser tier.
- `E2E (main)` skips a push with no runtime surface, and a skip is not a green:
  its four shards report `skipped`, the run summary says nothing ran, and the
  merge gate prints "ran NOTHING" rather than a shard count. Its nightly run
  (00:41 UTC) is unconditional and is what covers main between code pushes.

## Diagnosing a red

- Reproduce locally before pushing a fix. Preserve and inspect Playwright's
  `error-context.md`.
- Run failures in failing order and use one orchestrator when investigating shared
  state or cross-spec poisoning.
- Check the actual command exit code; pipelines can hide it.
- For mass failures, check memory pressure, then run failures individually.
  Passing alone suggests starvation; failing alone suggests a defect.
- Before calling a PR's e2e red unrelated, compare with clean main: `E2E (main)`
  on the PR's base, and `main-red-history.mjs` over `e2e-main`'s heads (#5160).
  Several PRs failing the same untouched specs is a base regression until that
  run says otherwise — not a coincidence of flakes (#2791).
- `next dev` and `next start` differ. Interaction fixes must work in both.
- Verify a separation claim on the branch merged with main — e2e-hygiene.md.
- After restoring a planted mutation, BUMP THE FILE'S MTIME. `cp -a` from a
  backup keeps the original timestamp, the harness's staleness check is
  mtime-based, and it goes on serving the mutated build — so the restored tree
  reports the planted red and the control reads as a real failure.

## Flake evidence

- A passing rerun alone does not exonerate a failure. Identify the mechanism,
  fix or remove the flaky test, and use targeted repeats to verify a timing fix.
- A second occurrence of the same spec attaches both CI runs to the owning
  mechanism/root-cause issue or to the matching failure-class entry; recurrence
  alone is not a reason to mint a new census issue.
- Clock-adjacent failures need forced-skew branch/main comparison with
  `ALLOS_TEST_NOW`; minutes-apart runs are insufficient.
- The weekly census also runs the suite at `ALLOS_TEST_NOW` +3 and +6 months
  (`e2e-forward-clock`). A red there is a fuse, not a regression on main — fix
  the fixture, do not revert a merge. Dispatch it on demand with the
  `forward_clock` input.
- Repeated failures invalidate a “distinct one-offs” argument.
- Consult `docs/internals/e2e-hygiene.md` before diagnosing a known failure
  class.

## Local full suite

- Run it rarely, with nothing else active: build once, then invoke four
  sequential CI-mode shards.
- Kill manually started development servers first; they hold locks and consume
  memory.
