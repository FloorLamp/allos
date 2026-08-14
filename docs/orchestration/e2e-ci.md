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
