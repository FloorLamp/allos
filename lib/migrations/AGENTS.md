# Migration instructions

These instructions apply to the migration runner and migrations.

- Shipped migrations are immutable. Never edit `001-baseline.ts` or another
  applied migration.
- Add schema changes as a final `YYYYMMDD-slug.ts` entry in `versions/index.ts`
  and add its SHA-256 to `manifest.json`. Name-keyed migrations have no numeric
  `id`.
- Use a rebuild migration to grow a `CHECK` enum or add a foreign key. Null
  dangling links before enforcing a new foreign key.
- Put one-shot data moves in migrations, not settings flags. Per-boot
  reconciliation belongs in `boot-tasks.ts`.
- A migration that deletes rows must declare and exercise non-cascading child
  links, and use `deleteRowsWithCascade()` for cascading children.
- Register child-link fixtures in the migration child-link DB tests. Unknown or
  unexercised pairs must fail the test tier.
- Migrations run individually with foreign keys temporarily disabled for safe
  SQLite rebuilds. Preserve the runner's post-migration foreign-key delta report.

Read `docs/versioned-migrations-spec.md` before changing migrations or the runner.
