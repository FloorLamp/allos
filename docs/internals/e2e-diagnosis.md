# Diagnosing E2E failures

Inspect the failure's actual assertion, fixture, setup, and Playwright
`error-context.md`. Record the tested commit, command, and exit code. A passing
rerun does not explain a failure. [CI ownership](../orchestration/e2e-ci.md) and
[environment access](../orchestration/environment.md) describe run ownership and
available log transports.

## Select a mechanism

| Evidence                                       | Investigate                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Tap has no effect before hydration             | Use the shared interaction helper; slow the suspected navigation to reproduce |
| Action completes but result is absent          | Separate POST completion from applied/rendered state                          |
| Stable wrong geometry appears intermittently   | Wait for real content before measuring, then compare base and branch          |
| Passes alone, fails beside another test        | Shared profile, settings, cwd, worker state, or delayed cleanup               |
| Fails only under heavy load                    | Memory/CPU pressure and the measured operation's timeout                      |
| Fails by start hour/date                       | Frozen-clock propagation, profile-local boundaries, fixture expiry            |
| Fails only in CI after a lookup                | Confirm whether local networking takes a different degraded branch            |
| Fails after a diagnostic mutation was restored | Rebuild; old mtimes can keep the mutated bundle in service                    |

## Shared state and shard composition

CI uses `scripts/e2e-shard-plan.ts` and recorded durations. Playwright's native
`--shard` chooses a different partition when the duration manifest exists. To
reproduce, check out the failing head and use that head's plan and job log:

```bash
mapfile -t shard_args < <(npx tsx scripts/e2e-shard-plan.ts 1 12)
npx playwright test "${shard_args[@]}" --retries=0
```

This recipe uses Bash. Match the failing run's shard number/count; do not assume
its plan matches today's main. Adding/removing a spec or refreshing durations can
change neighbors across the entire suite. Being behind main can do the same.
A partition change exposes shared-state bugs; it does not fix or excuse them.

Run the victim alone, then in the failing order with suspected writers on one
worker. Check asynchronous writes and cleanup between tests, not only `afterAll`.
For a reproducible concurrency window, hold it open deliberately rather than
increasing random repetitions. Use existing probes only when the observed failure
calls for them: `scripts/e2e-worker-leak-probe.mjs`, `scripts/tap-suppression-probe.mjs`.

## Time and hydration

Use `ALLOS_TEST_NOW` for branch/base comparisons at the same absolute instants.
A narrow daily window needs minute-level samples or deliberately chosen boundary
instants; moving only the hour can miss it entirely. Never bisect a clock-coupled
failure using an assumed good endpoint.

For pre-hydration failures, apply CDP CPU throttling across the suspect navigation
and compare the same interaction on the base. A longer presence timeout can
identify slow application; it cannot recover a swallowed click. A longer absence
poll can conceal a transient defect. Prefer a deterministic synchronization point
once the mechanism is known.

## Network and offline behavior

A credential-free integration can still take different branches locally and in
CI. RxNorm lookups are one example: inspect whether the actual pick/lookup returned
options before claiming a local run reproduced the failure. An empty degraded
response is not evidence about the populated branch.

Browser context offline mode alone does not prove service-worker behavior. Use
`readyForOffline`/`offlineChunksWarm` from `e2e/helpers.ts`, disconnect before
opening the form whose offline path is under test, and verify queued writes and
replay. Distinguish cached chunks, mounted online state, and persisted offline data.

## Finish the diagnosis

Fix the mechanism or remove a test whose remaining value does not justify its
cost. Use targeted repeats only to verify a specific timing fix. Keep useful
failure diagnostics; remove temporary mutation/probe state. Restore the exact
working file you backed up, refresh its mtime, and rebuild before the control run.
Report what failed, what changed, and what the verification can actually establish.
