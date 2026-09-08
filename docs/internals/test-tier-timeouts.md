# Diagnosing Vitest timeouts

A timeout says the test or setup exceeded its wall-clock allowance. It does not
identify the cause. Use the [development guide](../development.md#choose-local-checks)
to choose a tier and the [change policy](../change-policy.md#tests-that-earn-their-cost)
to decide whether coverage needs changing. Browser failures have a separate
[diagnosis guide](e2e-diagnosis.md).

## Owners and limits

[vitest.timeouts.ts](../../vitest.timeouts.ts) owns the non-browser limits used by
both [unit/component](../../vitest.config.ts) and [DB/action](../../vitest.db.config.ts)
configurations:

| Setting                           | Behavior                                                          |
| --------------------------------- | ----------------------------------------------------------------- |
| Default test timeout              | 15,000 ms.                                                        |
| Default hook timeout              | Twice the resolved test timeout.                                  |
| `ALLOS_VITEST_TIMEOUT_MS`         | A finite positive local override; invalid values use the default. |
| Truthy `CI` environment variable  | Ignores that override and keeps the default.                      |
| `perTestCeiling(multiple, basis)` | Rounds the resolved test timeout times the multiple.              |

The orchestration gate script defaults the local override to 60,000 ms for a
shared development machine. This does not change CI's default. A literal timeout
on an individual test or hook does not scale with the override.

`perTestCeiling` requires a measurement basis: `"worst"` for the slowest observed
run, or `"green"` when only a passing-run reading is available. The basis documents
evidence; it does not change the arithmetic. Keep the reading and reason beside
the exceptional test rather than maintaining a second inventory here.

## Read the failure before changing a limit

[vitest.timeout-report.ts](../../vitest.timeout-report.ts) records wall time and
worker event-loop utilization around each test. It emits a diagnostic when the
first reported error starts with `Test timed out in`. It does not diagnose hook
timeouts, every possible error ordering, or a worker that cannot finish reporting.

- **Idle loop** (utilization below 0.25): inspect unresolved promises, external I/O,
  child processes, and fake timers combined with real-time waits. Legitimate
  waiting can also produce this reading.
- **Busy loop**: inspect synchronous work, growing fixtures or scans, and CPU
  contention. Utilization is not a CPU-usage measurement and cannot distinguish
  expensive work from a descheduled worker by itself.
- **Hook timeout**: inspect fixture construction and teardown separately from the
  test body. A fast assertion does not make its database setup cheap.

Read all reported errors and the failing test's setup. A timeout diagnostic does
not prove that an assertion could not also fail.

## Reproduce and measure

Run the affected existing file in its own tier. Record the commit, command,
worker settings, and whether other suites were running. Compare the individual
test or hook duration with its actual limit; whole-file and whole-job durations
cannot establish per-test headroom.

If contention is suspected, compare an isolated diagnostic run with the failing
suite's worker configuration and CI logs. Files share workers dynamically, so
running a file alone can hide both contention and shared-state leakage. A passing
rerun is evidence about those conditions, not a fix.

Both configurations use `sequence.groupOrder` to finish the shared threads group
before starting isolated forks. This avoids simultaneous pool groups each using
the runner's CPU allocation, but does not eliminate contention within a group or
between separate processes. The DB tier also uses
[dbWorkerCount](../../lib/__db_tests__/worker-count.ts), capped at 12 and reduced
on smaller hosts. Do not assume a fixed worker count from the runner label.

[Isolation routing](../../vitest.isolation.ts) puts specs with module mocking,
namespace-import spies, working-directory changes, or timezone assignments into
the isolated project. Prefer its existing routing over a hand-maintained list.
If a test passes alone but fails in the tier, inspect leaked state and routing
before treating the failure as a timeout-budget problem.

## Fix the cause, then justify any exception

Remove redundant scans, repeated fixture construction, and unnecessary whole-tree
or migration work before increasing a limit. Preserve the failure the test is
supposed to detect. Do not add another scanner or test just to assert timeout
configuration; execute the configuration and affected coverage.

A per-test timeout is a coarse hang detector. Use repeated comparable whole-tier
measurements for gradual suite slowdown, and individual measurements for an
exceptional test. The existing exceptional ceilings aim for roughly four times
the observed worst CI duration; a quiet local run or a single green CI reading is
weaker evidence. Diagnose growth instead of raising every test's allowance.

When an exception is necessary, use `perTestCeiling` and record the measurement
basis at that call site. Keep inner waits below their enclosing hook or test
budget. Run the affected coverage under the normal configuration after the fix;
a permissive diagnostic run does not prove the normal limit is sufficient.
