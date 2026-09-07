# Development guide

Use Node 24 (`.nvmrc`). Follow the root and applicable nested `AGENTS.md`, then
read the [change and test policy](change-policy.md). Find the existing owner
before editing; read only the contract matching the task.

## Find the owner

| Task                            | Start in code                                                | Read when changing the contract                                                                                      |
| ------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Authorization and profile scope | `lib/auth.ts`, `lib/cross-profile.ts`, `lib/queries/`        | `app/AGENTS.md`, `lib/AGENTS.md`, `lib/queries/AGENTS.md`                                                            |
| Dated readings or units         | `lib/reading-model.ts`, `lib/date.ts`, `lib/row-instants.ts` | [Reading model](internals/reading-model.md), [time model](internals/time-model.md)                                   |
| Weekly frequency or stale data  | `lib/cadence.ts`, `lib/freshness.ts`                         | [Cadence](internals/cadence-ledger.md), [freshness](internals/freshness.md)                                          |
| Medication/supplement intake    | `lib/queries/intake/adherence.ts`, `lib/intake-cadence.ts`   | [Intake](internals/supplements.md)                                                                                   |
| Notifications or attention      | `lib/notifications/`, `lib/queries/upcoming/`                | [Notifications](internals/notifications.md), [findings](internals/findings.md)                                       |
| Connected sources and imports   | `lib/integrations/`, `app/(app)/data/`                       | [Sync](internals/integrations-sync.md), [import actions](internals/import-actions.md)                                |
| Action writes and refresh       | `app/`, `lib/revalidate.ts`                                  | [Refresh](internals/server-action-refresh.md); [deployment skew](internals/deploy-skew.md) for compatibility changes |
| Deletion and undo               | `lib/trash.ts`                                               | [Undo](internals/undo-contract.md), [trash](internals/trash.md)                                                      |
| Database schema                 | `lib/migrations/`                                            | `lib/migrations/AGENTS.md`, [migrations](versioned-migrations-spec.md)                                               |
| Shared UI                       | `components/`                                                | `components/AGENTS.md` maps copy, layout, motion, and overlay tasks                                                  |
| Browser tests                   | `e2e/helpers.ts`, `e2e/fixtures.ts`                          | [E2E writing guide](internals/e2e-hygiene.md)                                                                        |
| CI failure                      | Failing test and its setup                                   | [E2E diagnosis](internals/e2e-diagnosis.md), [test timeouts](internals/test-tier-timeouts.md)                        |
| Agent dispatch/review           | `scripts/orchestration/`                                     | [Orchestration](orchestration.md), only for an assigned orchestration role                                           |

For product behavior, use [Features](features.md). User setup guides live directly
under `docs/`; internal contracts live under `docs/internals/`.

## Choose local checks

| Change                                     | Start with                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Documentation                              | `npm run docs:check`; Prettier on changed files; check links                                           |
| Pure logic                                 | `npm test -- lib/__tests__/name.test.ts`                                                               |
| DOM or hook behavior                       | `npm test -- components/__tests__/name.test.tsx`; [component guide](internals/component-tests.md)      |
| SQL, request authorization, Server Actions | `npm run test:db -- path/to/existing.test.ts`; [DB fixtures](../lib/__db_tests__/AGENTS.md)            |
| UI behavior that needs a browser           | `npm run test:e2e -- e2e/name.spec.ts --retries=0`                                                     |
| CSS or copy                                | Inspect affected states/viewports; run relevant existing tests; do not automatically change assertions |
| TypeScript                                 | Focused ESLint and `npm run typecheck` (includes Next type generation)                                 |
| Build/runtime wiring                       | `npm run build` plus the affected test tier                                                            |

Run the narrow checks while developing. Expand when the changed surface, a
failure, or required CI checks justify it. Passing checks do not require another
round of invented tests. An assigned orchestration lane runs its final gates
through `scripts/orchestration/run-gates-recorded.sh`; CI owns the full browser
matrix. See [E2E/CI ownership](orchestration/e2e-ci.md).

## Keep documentation usable

State the current contract, its owner, and the few tradeoffs needed to change it.
Remove war stories, superseded instructions, issue-by-issue histories, and stale
measurements. Git and PRs retain the history. Update an existing rule instead of
appending another version. Link to code for implementation detail.

`npm run docs:check` checks all Git-visible Markdown (including agent/skill docs)
and dispatch/brief source files. New and short files have a 1,500-word limit;
existing oversized files cannot exceed their word count at the comparison base.
This applies to generated Markdown too: keep generated reference data separate
from growing prose. Rewritten files inherit the smaller ceiling after merging.
The check includes untracked files and fails if the comparison base is unavailable.
Use `npm run docs:check -- --base <ref>` for an explicit base; the default is the
merge base with `origin/main`. CI supplies its event's base commit.

The guard measures length, not usefulness. Do not compress code, split a single
rule across arbitrary files, or remove important contracts just to pass it.
Split by independently useful topics when needed. Review still checks that
rewrites preserve behavior and remove duplication.
