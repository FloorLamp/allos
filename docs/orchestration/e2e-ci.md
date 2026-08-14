# E2E and CI

## Ownership

- The sharded CI E2E matrix is the full-suite authority. Local runs diagnose;
  they do not replace the merge gate.
- Agents run every spec they change at CI parity: `--repeat-each=3 --retries=0`
  using their assigned port range.
- Only the orchestrator runs a full local suite. Keep at most two agents in the
  E2E lane.
- A new navigation item requires updating `TOP_LEVEL_ORDER` in
  `e2e/nav-consolidation.spec.ts`.

## The first round in a new worktree

- A fresh worktree has no `.next`, and compiling one costs ~200 s before a single
  browser assertion (#2605). `ensureBuild` now takes an identical build from a
  sibling worktree instead: measured 199 s → 1.7 s, first round 242 s → 55 s.
- It is automatic. There is no dispatch step to add, because at worktree-creation
  time no sibling has built yet either — the first cluster of a wave still builds,
  and the rest inherit it.
- The licence is a content fingerprint over the build inputs
  (`e2e/build-inputs.mjs`), never a commit and never an mtime: the main checkout
  usually differs from `origin/main` only in `scripts/` and `docs/`, which the build
  does not read, and an identical commit with one uncommitted edit is a different
  bundle.
- A refusal is normal and always NAMED, one line per candidate. Refusals are the
  measure of this working; rounds-per-hour is the measure that cannot see it going
  wrong. `E2E_NO_SEED=1` opts out.
- `node scripts/orchestration/seed-next-build.mjs` does the same by hand (exit 3 =
  refused), and its `record` subcommand tags a `.next` that `npm run build` made
  outside the harness so other worktrees can take it.

## Merge bar

- Require every check green on the exact PR head.
- Check `mergeable_state` before diagnosing absent CI. Conflict-dirty PRs do not
  start checks.
- A green check describes the base used for that run. Re-merge current main and
  reverify branches that have sat or overlap recent shared changes.
- Stop merges when `CI (main)` is red. Fix main first.

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
- `next dev` and `next start` differ. Interaction fixes must work in both.

## Flake evidence

- Exonerating a flake requires a 3/3 local CI-parity pass of the exact spec and
  a stated mechanism.
- A second occurrence of the same spec creates a census issue with both CI runs.
- Clock-adjacent failures need forced-skew branch/main comparison with
  `ALLOS_TEST_NOW`; minutes-apart runs are insufficient.
- Repeated failures invalidate a “distinct one-offs” argument.
- Consult `docs/internals/e2e-hygiene.md` before diagnosing a known failure
  class.

## Local full suite

- Run it rarely, with nothing else active: build once, then invoke four
  sequential CI-mode shards.
- Kill manually started development servers first; they hold locks and consume
  memory.
