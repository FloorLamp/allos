# Migration instructions

These instructions apply to the migration runner and migrations.

- Shipped migrations are immutable. Never edit `001-baseline.ts` or another
  applied migration.
- Add schema changes as a final `YYYYMMDD-slug.ts` entry in `versions/index.ts`.
  Name-keyed migrations have no numeric `id`.
- Run `npm run gen:migration-manifest` to write the hash. Never type one by hand.
- After a migration merge conflict, keep BOTH sides of `index.ts` and re-run it.
  It refuses a tree where `index.ts` and `versions/` disagree, and refuses to
  rewrite an already-shipped hash — that is an edited migration, not a stale
  manifest. Use `--allow-rehash` only to restore a file to its shipped bytes.
- `manifest.json` conflicts on EVERY two-migration merge — both sides append to
  the same tail, so git has nothing to interleave. Resolve it with
  `git checkout --ours -- lib/migrations/manifest.json` and re-run the generator;
  it recomputes every entry, so either side is a fine starting point. Never
  delete it — a missing manifest is not a clean slate.
- Use a rebuild migration to grow a `CHECK` enum or add a foreign key. Null
  dangling links before enforcing a new foreign key.
- Put one-shot data moves in migrations, not settings flags. Per-boot
  reconciliation belongs in `boot-tasks.ts`.
- A migration that deletes rows must declare and exercise non-cascading child
  links, and use `deleteRowsWithCascade()` for cascading children.
- Register child-link fixtures in the migration child-link DB tests. Unknown or
  unexercised pairs must fail the test tier.
- Spell every `CHILD_LINKS` entry as a `{ table: "…", column: "…" }` literal. The
  shared scan fails on a registry it cannot read rather than reporting no pairs.
- Migrations run individually with foreign keys temporarily disabled for safe
  SQLite rebuilds. Preserve the runner's post-migration foreign-key delta
  report.
- The runner copies the database aside before applying anything, triggered on
  the pending set being non-empty — never on a per-migration declaration, which
  #2444 forgot and #2703 proved a scan cannot complete. Do not narrow that
  trigger or move the call out of autocommit.
- A copy that cannot be taken refuses the boot, which is correct only because
  nothing has been applied yet. Every later failure in this runner reports
  instead.
- `ALLOS_MIGRATION_SNAPSHOT=off` skips the copy for every upgrade;
  `off:<migration name>` scopes it to one pending set and expires by itself.
- Boot tasks run after the copy is taken, so their deletes have none behind
  them. Register every one in the boot-task delete census with its row class.
- A migration body may be RE-ENTERED by `runBootTx`'s `SQLITE_BUSY` retry. Keep
  every effect inside the `db` handle you were given — a second connection, a
  file write or a module-level accumulator survives the rollback and applies
  twice (`docs/internals/migration-reentry.md`).

Read `docs/versioned-migrations-spec.md` before changing migrations or the
runner, and `docs/internals/migration-snapshot.md` before changing the snapshot.
