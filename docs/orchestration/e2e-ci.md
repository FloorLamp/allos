# E2E and CI

This guide owns browser-run responsibility and CI evidence. Use
[writing E2E tests](../internals/e2e-hygiene.md) for fixtures and assertions,
[diagnosis](../internals/e2e-diagnosis.md) for reproduction, and the
[change and test policy](../change-policy.md) to keep verification proportional.

## Ownership

Run authored or edited files once locally with `--retries=0`. For tests sharing
mutable profile or worker state, run the whole file with `--workers=1`. Repeats
need a specific timing question; new coverage needs a meaningful missing failure.

The PR's sharded CI matrix supplies full-suite evidence when it actually runs.
Only the orchestrator owns a full local run; [dispatch](dispatch.md) owns capacity
and its two-agent E2E cap. Banked branches run assigned local checks; the sole
landing candidate opens or refreshes its ready PR and consumes final CI. A blocked
local browser run is a reported limitation, not a reason to open a second PR.

## The first round in a new worktree

[Global setup](../../e2e/global-setup.ts) owns production build preparation:

- Locally, when no build exists, it attempts sibling reuse through
  [build-seed.mjs](../../e2e/build-seed.mjs). Reuse requires matching content under
  [the build-input model](../../e2e/build-inputs.mjs), not matching commit IDs or
  timestamps. Refused reuse falls back to building locally.
- An existing build uses the local freshness check; it is not replaced through
  sibling reuse. `E2E_NO_SEED=1` disables reuse. Preserve the distinction between
  reuse's content proof and the local rebuild check's timestamps.
- CI prepares its build through [the setup action](../../.github/actions/e2e-setup/action.yml).
  Global setup requires that build rather than compiling it again. An explicit
  build-skip override assumes the caller has already supplied a suitable build.

`seed-next-build.mjs` supports manual reuse (exit 0 seeded, 3 refused, 1 error).
Its `record` command records current input fingerprints beside a completed build;
use it only for the inputs that actually produced that build.

## Merge bar

[Review and merge](review-merge.md) owns exact-head checks, base movement, holds,
and merge decisions. Inspect the workflow's actual steps and artifacts before
calling its browser tier green:

| Workflow                                                       | Evidence and limits                                                                                                                           |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [PR CI](../../.github/workflows/ci.yml)                        | Twelve browser shards when the runtime-surface check selects them. A no-runtime PR can have successful jobs whose browser steps were skipped. |
| [CI on main](../../.github/workflows/ci-main.yml)              | Check, unit, and DB tiers; no browser verdict.                                                                                                |
| [E2E on main](../../.github/workflows/e2e-main.yml)            | Four browser shards. No-runtime pushes report skipped jobs; the nightly run covers main independently of that change filter.                  |
| [Periodic/on-demand E2E](../../.github/workflows/e2e-full.yml) | Repeated flake checks and optional forward-clock runs; inspect the selected inputs and clock.                                                 |

A queued or skipped run is not evidence that browser tests passed. A green run
also describes its tested base; use the merge procedure before relying on it
after other changes land. Check `mergeable_state` when expected PR CI is absent.
A confirmed red main takes priority over landing another candidate.

## Diagnosing a red

Read the failing assertion, fixture, setup, `error-context.md`, actual command,
and exit code. Reproduce on the failing head with that run's shard plan, worker
settings, and clock; the [diagnosis guide](../internals/e2e-diagnosis.md) owns the
commands and mechanism checklist.

The diagnosis guide covers shared-state leakage, resource pressure, populated
versus degraded lookup responses, time boundaries, and restoring diagnostic
mutations. RxNorm availability is environment-dependent; verify the branch reached
rather than declaring a provider universally unavailable locally.

Match the serving mode (`next dev` or `next start`). Compare allegedly unrelated
failures with the PR's base and relevant main-side browser evidence;
`main-red-history.mjs` helps locate recurrence. Several failing PRs still need
attribution rather than an automatic base-regression or flake verdict.

When local conditions cannot reproduce the failing state, report the limitation
and use CI artifacts or a controlled reproduction. Wait for a run to settle before
rerunning failed jobs; inspect setup, cleanup, and annotations as well as tests.

## Flake evidence

A passing retry does not fix a flake. Identify its mechanism, repair or remove the
test with a coverage rationale, then use focused repeats to verify a timing fix.
Attach recurrence to the existing cause rather than filing another census issue.

Use `ALLOS_TEST_NOW` for time-sensitive branch/base comparisons. The periodic
workflow tests clocks three and six months ahead and enables those runs on its
weekly schedule or through `forward_clock`. A future-clock failure is evidence
about that future state; inspect fixture expiry and real time-dependent behavior
before attributing it to a merge or changing an expectation.

## Local full suite

Run a full local suite only when that scope is needed, with competing work paused.
Stop only owned development servers after checking whether another task needs
them. Build once, then run four sequential CI-mode shards using the planner for
that checkout. To reproduce a particular CI failure, match its actual partition
instead; the diagnosis guide explains why native and duration-balanced shards
can have different neighbors.
