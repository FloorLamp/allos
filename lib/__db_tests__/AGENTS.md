# DB integration tier

Run with `npm run test:db` (`vitest.db.config.ts`). These tests open real
better-sqlite3 handles against a live schema.

## Getting a database

Most tests need the schema a fresh boot ends up with. Two ways to get it, and
picking the wrong one is the tier's main cost:

| You need                                              | Use                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| The app's own database, seeded per file                | `import { db } from "@/lib/db"` — the setup files handle it   |
| Your own handle at the current schema                  | `migratedDb()` from `./migrated-db`                           |
| The migration chain itself                             | `migrate()` / `runMigrations()` directly                      |

`migratedDb()` returns an in-memory database the caller owns and closes. It is a
byte copy of one migrated database built once per worker, so it costs ~1 ms
instead of replaying every migration (~710 ms, and rising with each one merged).

Reach for `migrate()` or `runMigrations()` only when the chain is the question: a
migration's own `up()`, replay safety, a partial apply to some version, or what a
boot task does on a first boot. Those tests are why the chain still runs.

`./migrated-db-parity.test.ts` holds the snapshot to a real replay — same schema,
same version, same seeded rows — and proves the copies are independent of each
other.

## Isolation

The shared project runs with `isolate: false`: one module registry per worker,
with each file reseeded from a pre-migrated template and the singleton rebound
(`setup-shared.ts`). A file that calls `vi.mock()`, `process.chdir()`, or spies on
an app module through a namespace import is routed to the isolated project
automatically — see `vitest.isolation.ts`. You do not maintain a list.
