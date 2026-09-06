# E2E and CI

## What earns a guard, a scan, or a spec

Owner direction, 2026-09-06: **reduce guards, scans, and low-value or flaky
e2e specs.** Measured that day on `main`: 671k lines of tests against 649k
lines of product code, of which 245 test files (69k lines) read the source
tree as text, and 480 e2e specs run 125k lines. The suite had grown past the
thing it protects.

- **Subtraction beats addition.** When a finding could be answered by a new
  guard or by removing what made the defect expressible, take the removal. A
  lane that ends with one fewer scan and the same coverage has done the work.
- **A source-text scan is the LAST resort**, in this order: a type that makes
  the fact unstateable, then an ESLint rule on the parse ESLint already runs
  (#5347's shape), then a scan. Adding one needs a named defect it would have
  caught — not a class it might.
- **An e2e spec earns its place by covering a user journey no cheaper tier
  can.** A spec that asserts a formatter, a class name, or a pixel is a unit
  test wearing a browser; move it down a tier or delete it.
- **A flaky spec is fixed or deleted, never re-run.** "Flake" names a
  mechanism to remove, not a verdict to record — and shard packing, worker
  state and poll-versus-assert races are mechanisms, not bad luck.
- **Deleting a dead guard or spec needs no issue of its own.** The PR states
  what it protected, what protects it now, and how the deletion was measured —
  the same bar as adding one.
- **A TEST OR GUARD ON DEV CONFIG IS STRICTLY FORBIDDEN** (owner, 2026-09-06).
  No test asserts on `eslint.config.mjs`, `vitest.config*`, `vitest.timeouts`,
  `tsconfig`, `package.json`, `.nvmrc`, `.github/workflows/**`, the gate
  scripts' trigger and skip sets, or Node flags. There is no exception and no
  allowlist: a config that is wrong fails the first time it runs, and a guard
  that restates it is a second copy of the config that can disagree with it.
  Existing ones are deleted, not converted — this outranks the conversion work
  in `#5346`, and the cost is accepted with open eyes: a wrong CI skip-set or
  gate-trigger entry will fail silently rather than red, which is the trade the
  owner made when the guards outgrew the thing they guard.
- **Two RATCHETS are the only survivors** (owner, 2026-09-06, on the census
  below): `ci-skip-set` and `db-gate-trigger-set` keep a count and nothing
  else, because a silently growing skip set stops CI running for whole diffs.
  A ratchet is `expect(entries.length).toBeLessThanOrEqual(N)` — one number, no
  allowlist, no per-file registry, no import graph, about 20 lines. **N may only
  be LOWERED**, and lowering it belongs to the PR that removes the entry. An
  allowlist of names is how a ratchet becomes the second copy of the config this
  section forbids. What the ratchet no longer catches, stated: a WRONG entry,
  as opposed to a new one.
- **What was kept, and what died, on 2026-09-06.** All fourteen files below were
  written on 4-5 September, ~6,700 lines in 48 hours, none old enough to have
  caught anything. Kept: `strip-comments` (767, a unit test of the function every
  census reads source through — a stripper that deletes too much makes findings
  disappear while the guards stay green), the five-PR regression core of
  `adversarial-consult-tier` (~250 of 1,353), `pager-idiom` as a ratchet (~30 of
  205), and the two ratchets above (~40 of 923). Deleted: `merge-gate-script`
  1622, `script-env-bootstrap` 493, `next-build-seed` 374,
  `eslint-config-composition` 338, `base-moved-gate` 178, `vitest-timeouts` 133,
  `type-verdict` 117, `merge-gate-workflow` 63, `node-heap-scripts` 47, and the
  1,100 lines of vocabulary-pinning around the regression core.
- **The verification slice ranks its queue by NET LINES** (owner, 2026-09-06):
  subtractive work first, neutral next, additive last and only for a named
  defect or a security gap. A conversion PR states its own `+/-` in the body
  and is net ≤ 0, or says in one line why not.
- **A conversion that does not delete has not converted.** Measured the day the
  rule was set: #5392 moved fifty import scanners onto ESLint and came out
  **+306** — two scan files deleted, a 302-line test added to guard the ESLint
  config itself; #5414 made the export guard a type at **+149**, deleting
  nothing. A guard replaced by a guard about the replacement is the failure
  mode this section exists to name.

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
- Run failures in failing order and use one orchestrator when investigating shared
  state or cross-spec poisoning.
- Check the actual command exit code; pipelines can hide it.
- For mass failures, check memory pressure, then run failures individually.
  Passing alone suggests starvation; failing alone suggests a defect.
- Compare with clean main under the same conditions to identify pre-existing
  failures — `main-red-history.mjs` reads `e2e-main`'s run of heads (#5160).
- Before calling a PR's e2e red unrelated, check `E2E (main)` on the PR's base.
  Several PRs failing the same untouched specs is a base regression until that
  run says otherwise — not a coincidence of flakes (#2791).
- `next dev` and `next start` differ. Interaction fixes must work in both.
- Verify a separation claim on the branch merged with main — e2e-hygiene.md.
- After restoring a planted mutation, BUMP THE FILE'S MTIME. `cp -a` from a
  backup keeps the original timestamp, the harness's staleness check is
  mtime-based, and it goes on serving the mutated build — so the restored tree
  reports the planted red and the control reads as a real failure.

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
