import Database from "better-sqlite3";
import { migrate } from "@/lib/db";

// A MIGRATED DATABASE WITHOUT REPLAYING THE MIGRATION CHAIN (#3471).
//
// Most DB-tier tests that build their own database want ONE thing: the schema and
// seed data a fresh boot ends up with. They got it by calling `migrate(new
// Database(":memory:"))` per test, which replays every migration in
// `lib/migrations/versions` — 213 of them at the time of writing, and one more on
// most weeks this repo ships. Measured on a quiet 4-core box, 2026-08-22:
//
//   migrate() into a fresh :memory: ....... 710 ms   (grows with every migration)
//   db.serialize() of the result .............. 1 ms
//   new Database(<that buffer>) ............... 1 ms   (fixed — a page-array copy)
//
// So the chain is replayed ONCE per worker process and every caller after that
// gets a byte copy. `enum-parity.test.ts` alone spent 11.0 s of the tier's 91 s
// asking 15 questions about CHECK constraints, each behind its own full replay.
//
// USE THIS when your test needs the migrated END STATE. Do NOT use it when the
// test is about the CHAIN — a migration's own up(), replay safety, a partial apply
// to some version, or what a boot task does on a first boot. Those files
// (`migrate`, `migration-snapshot`, `install-marker`, `*-migration`) call
// `runMigrations`/`migrate` directly on purpose and must keep doing so.
//
// WHY NOT THE ON-DISK TEMPLATE the shared project already builds
// (./shared-template.ts, ./global-setup.ts)? It is the same end state and it would
// cost nothing to build. It cannot be deserialized: `global-setup` leaves the
// template at `journal_mode = WAL`, that setting is recorded in the file header,
// and an in-memory database cannot use WAL — SQLite answers `SQLITE_CANTOPEN`,
// verified on the template file and on `serialize()` of a read-only handle. Copying
// the template to a temp FILE instead is what `setup-shared.ts` already does for
// the singleton; the callers here want an in-process handle they own and close, so
// they take the cheaper in-memory route and pay one replay per worker for it.
let snapshot: Buffer | null = null;

/**
 * A fresh in-memory database at the current schema, with the boot tasks applied —
 * the same state `migrate()` leaves behind, without replaying the chain.
 *
 * The returned handle is the caller's: it owns no shared state, writes to it are
 * invisible to every other handle (the buffer is copied into the new database's
 * own pages), and the caller closes it.
 */
export function migratedDb(): Database.Database {
  snapshot ??= buildSnapshot();
  const db = new Database(snapshot);
  // Per-connection, so it does not survive in the snapshot and every caller must
  // re-arm it. Every call site this replaced set it.
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * The real replay: baseline + every migration + boot tasks, into a fresh
 * `:memory:` database. Exported so the equivalence guard
 * (`migrated-db-parity.test.ts`) compares the snapshot against the thing it
 * stands in for, rather than against a second copy of itself.
 */
export function replayedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function buildSnapshot(): Buffer {
  const db = replayedDb();
  try {
    return db.serialize();
  } finally {
    db.close();
  }
}
