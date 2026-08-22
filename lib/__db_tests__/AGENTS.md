# DB integration tier

Run with `npm run test:db` (`vitest.db.config.ts`). These tests open real
better-sqlite3 handles against a live schema.

## Getting a database

Most tests need the schema a fresh boot ends up with, and how you ask for it is
this tier's main cost.

- The app's own database, reseeded per file: `import { db } from "@/lib/db"`.
  The setup files do the rest.
- Your own handle at the current schema: `migratedDb()` from `./migrated-db`.
- The migration chain itself: `migrate()` or `runMigrations()` directly.

`migratedDb()` returns an in-memory database the caller owns and closes. It is a
byte copy of one migrated database built once per worker, so it costs ~1 ms
rather than replaying every migration (~710 ms, rising with each one merged).

Reach for `migrate()` or `runMigrations()` only when the chain is the question:
a migration's own `up()`, replay safety, a partial apply to some version, or
what a boot task does on a first boot. Those tests are why the chain still runs.

`./migrated-db-parity.test.ts` holds the snapshot to a real replay — same
schema, same version, same seeded rows — and proves the copies are independent.

## Isolation

The shared project runs with `isolate: false`: one module registry per worker,
each file reseeded from a pre-migrated template and the singleton rebound
(`setup-shared.ts`).

A file that calls `vi.mock()` or `process.chdir()`, or spies on an app module
through a namespace import, is routed to the isolated project automatically. See
`vitest.isolation.ts`; you do not maintain a list.
