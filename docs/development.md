# Development guide

Use Node 24 (`.nvmrc`), applicable `AGENTS.md` and the [change policy](change-policy.md).
Reuse the existing owner; read the matching contract.

## Find the owner

| Task                            | Start in code                                                 | Read when changing the contract                                                                                      |
| ------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Authorization and profile scope | `lib/auth.ts`, `lib/cross-profile.ts`, `lib/queries/`         | `app/AGENTS.md`, `lib/AGENTS.md`, `lib/queries/AGENTS.md`                                                            |
| Dated readings or units         | `lib/reading-model.ts`, `lib/date.ts`, `lib/row-instants.ts`  | [Reading model](internals/reading-model.md), [time model](internals/time-model.md)                                   |
| Weekly frequency or stale data  | `lib/cadence.ts`, `lib/freshness.ts`                          | [Cadence](internals/cadence-ledger.md), [freshness](internals/freshness.md)                                          |
| Medication/supplement intake    | `lib/queries/intake/*`, `lib/intake-cadence.ts`               | [Intake](internals/supplements.md)                                                                                   |
| Notifications or attention      | `lib/notifications/`, `lib/queries/upcoming/`                 | [Notifications](internals/notifications.md), [findings](internals/findings.md)                                       |
| Connected sources and imports   | `lib/integrations/`, `app/(app)/data/`                        | [Sync](internals/integrations-sync.md), [import actions](internals/import-actions.md)                                |
| Action writes and refresh       | `app/`, `lib/revalidate.ts`                                   | [Refresh](internals/server-action-refresh.md); [deployment skew](internals/deploy-skew.md) for compatibility changes |
| Deletion and undo               | `lib/trash.ts`                                                | [Undo](internals/undo-contract.md), [trash](internals/trash.md)                                                      |
| Backups and restore             | `lib/restore.ts`, `lib/backup.ts`, `scripts/restore-check.ts` | [Backups](backups.md)                                                                                                |
| Database schema                 | `lib/migrations/`                                             | `lib/migrations/AGENTS.md`, [migrations](versioned-migrations-spec.md)                                               |
| Shared UI                       | `components/`, `components/quick-entry/`                      | `components/AGENTS.md` maps copy, layout, motion and overlay                                                         |
| Browser tests                   | `e2e/helpers.ts`, `e2e/fixtures.ts`                           | [E2E writing guide](internals/e2e-hygiene.md)                                                                        |
| CI failure                      | Failing test and its setup                                    | [E2E diagnosis](internals/e2e-diagnosis.md), [test timeouts](internals/test-tier-timeouts.md)                        |

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

Run narrow checks while developing, then `npm run check` (and `npm run
test:smoke` for frontend changes). Passing checks need no extra invented tests.

## Keep documentation usable

State contracts and owners; update rules.

`npm run docs:check` checks authored Git-visible Markdown, including untracked
files, excluding `public/deck-ui/*/` bundles. Keep generated reference
data separate:

- New and short files: at most 1,500 words; oversized files: at most their word
  count at the base.
- The total must not exceed the base's: new text displaces old.
- Base: the merge base with `origin/main`, or `-- --base <ref>`; unavailable
  fails.

The guard measures length, not usefulness. Do not compress code, split one rule
across arbitrary files, or cut important contracts to pass it; split by
independently useful topics. Review still checks rewrites preserve behavior.

## CI on Sortie

Jobs: [sortie-jobs.json](../sortie-jobs.json). Spaceport `repos/allos.json` keeps
`node_modules` between jobs (`sortie.keep`). Jobs use `scripts/ci-install.sh`:
reuse kept dependencies when the lockfile SHA-256 matches their stamp; otherwise
run `npm ci` and stamp success. The builder needs `build-essential` (`make`) for
native dependencies.
