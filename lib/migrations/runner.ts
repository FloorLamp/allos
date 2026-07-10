import type Database from "better-sqlite3";
import { runBootTx } from "./schema-utils";
import { MIGRATIONS } from "./versions";

// Versioned migration runner (issue #119). A minimal, zero-dependency runner over
// SQLite's built-in `PRAGMA user_version`. Migrations are ordered, append-only,
// synchronous TypeScript functions (see lib/migrations/versions/). The whole
// pre-runner `migrate()` body is migration 001 ("baseline"), frozen; every future
// schema change is a new numbered migration. This replaces the per-mechanism
// idempotency schemes (addColumnIfMissing registry, ENUM_CHECKS reconcile, settings
// flags, rename shims) with one structural guarantee: a version number.

export interface Migration {
  /** 1-based, contiguous, === position in the MIGRATIONS array. */
  id: number;
  /** Matches the file slug (e.g. "001-baseline"). */
  name: string;
  /** Synchronous; runs inside the runner's IMMEDIATE transaction. */
  up(db: Database.Database): void;
}

// The schema version this DB has been migrated to. 0 on a brand-new DB and on
// every DB deployed before the runner existed.
export function readVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

// Apply every migration whose id exceeds the DB's current `user_version`, each in
// its own `BEGIN IMMEDIATE` transaction (via runBootTx's bounded SQLITE_BUSY
// retry). Semantics:
//
//   • Downgrade guard: if the DB is at a version HIGHER than this build knows, a
//     newer release wrote it and we've rolled back to older code — fail the boot
//     with a clear error rather than limping until the old code hits a shape it
//     doesn't understand (see below).
//   • One IMMEDIATE transaction PER migration. `next build` runs several parallel
//     workers that all import lib/db.ts and race the boot path; IMMEDIATE takes the
//     write lock at BEGIN (waiting out a peer via busy_timeout), and the
//     IN-TRANSACTION re-read of user_version is the AUTHORITATIVE dedup — a worker
//     that lost the race sees the bumped version and no-ops. (PRAGMA user_version
//     writes are transactional in SQLite and roll back with the txn, but the in-txn
//     re-read, not the pragma's atomicity, is what guarantees exactly-once.)
//   • Fresh and upgraded DBs take the SAME path: a fresh DB is just user_version 0
//     replaying baseline + everything after it, so fresh/upgraded schema divergence
//     is impossible by construction.
export function runMigrations(db: Database.Database): void {
  assertContiguousIds();

  const current = readVersion(db);
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema version (user_version = ${current}) is NEWER than this ` +
        `build knows about (latest migration is ${MIGRATIONS.length}). A newer ` +
        `release wrote this database and the running code has been rolled back. ` +
        `Running old code against a newer schema is refused to avoid corruption — ` +
        `restore the backup that matches this build (see scripts/restore.ts), or ` +
        `redeploy the newer image.`
    );
  }

  for (const m of MIGRATIONS) {
    if (m.id <= current) continue;
    const tx = db.transaction(() => {
      // Authoritative in-txn dedup: a peer worker may have applied this migration
      // (and bumped user_version) between our pre-loop read and taking the write
      // lock. Re-read inside the transaction and no-op if it's already done.
      if (readVersion(db) >= m.id) return;
      m.up(db);
      db.pragma(`user_version = ${m.id}`);
    });
    runBootTx(tx);
  }
}

// Defensive invariant: migration ids must be 1-based, contiguous, and match their
// array position, so `user_version = N` unambiguously means "migrations 1..N have
// run". A gap or duplicate is a packaging bug (a mis-numbered new migration).
function assertContiguousIds(): void {
  MIGRATIONS.forEach((m, i) => {
    if (m.id !== i + 1) {
      throw new Error(
        `Migration ordering is broken: MIGRATIONS[${i}] has id ${m.id} ` +
          `(expected ${i + 1}, name "${m.name}"). Ids must be 1-based and ` +
          `contiguous — renumber the offending migration.`
      );
    }
  });
}
