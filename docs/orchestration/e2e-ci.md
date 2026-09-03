# E2E and CI

## Ownership

- The sharded CI E2E matrix is the full-suite authority. Local runs diagnose;
  they do not replace the merge gate.
- Run every changed spec with `--repeat-each=3 --retries=0`. When tests share a
  profile or worker state, also run the whole file with `--workers=1
--repeat-each=1 --retries=0` for leaks (#3653). Use the assigned port.
- Only the orchestrator runs a full local suite. Keep at most two agents in the
  E2E lane.
- A new navigation item requires updating `TOP_LEVEL_ORDER` in
  `e2e/nav-consolidation.spec.ts`.

## The first round in a new worktree

- A fresh worktree has no `.next`, and compiling one costs ~200 s before a single
  browser assertion (#2605). `ensureBuild` now takes an identical build from a
  sibling worktree instead: measured 199 s → 1.7 s, first round 242 s → 55 s.
- It is automatic, with no dispatch step to add: at worktree-creation time no
  sibling has built either, so the first cluster of a wave builds and the rest
  inherit it.
- The licence is a content fingerprint over the build inputs
  (`e2e/build-inputs.mjs`), never a commit and never an mtime. Commit equality is
  neither necessary nor sufficient — see `docs/internals/e2e-hygiene.md`.
- A refusal is normal and always NAMED, one line per candidate. Refusals are the
  measure of this working; rounds-per-hour is the measure that cannot see it going
  wrong. `E2E_NO_SEED=1` opts out.
- `node scripts/orchestration/seed-next-build.mjs` does the same by hand (exit 3 =
  refused), and its `record` subcommand tags a `.next` that `npm run build` made
  outside the harness so other worktrees can take it.

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
- Run failures in failing order and use one worker when investigating shared
  state or cross-spec poisoning.
- Check the actual command exit code; pipelines can hide it.
- For mass failures, check memory pressure, then run failures individually.
  Passing alone suggests starvation; failing alone suggests a defect.
- Compare with clean main under the same conditions to identify pre-existing
  failures.
- Before calling a PR's e2e red unrelated, check `E2E (main)` on the PR's base.
  Several PRs failing the same untouched specs is a base regression until that
  run says otherwise — not a coincidence of flakes (#2791).
- `next dev` and `next start` differ. Interaction fixes must work in both.

## Flake evidence

- Exonerating a flake requires a 3/3 local CI-parity pass of the exact spec and
  a stated mechanism.
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
