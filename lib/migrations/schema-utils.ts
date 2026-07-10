import type Database from "better-sqlite3";

// Low-level schema helpers shared by the migration runner, the frozen baseline,
// the per-boot tasks, and the extracted migration modules under lib/migrations/.
// Lives here (rather than in lib/db.ts) so those modules can use it without an
// import cycle back into lib/db.ts.

// The column names of a table. The table name is interpolated (not bound) so the
// profile-scoping source scanner sees a variable, not an owned-table literal, in
// this PRAGMA — which legitimately touches any table without a profile_id filter.
export function tableColumns(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((c) => c.name);
}

// Run a one-time boot/migration transaction with the write lock taken at BEGIN
// (IMMEDIATE) and a bounded retry on SQLITE_BUSY. `next build` collects page data
// with several parallel workers, each importing lib/db.ts and running the boot
// path against the same file; a DEFERRED transaction that reads before writing
// hits SQLITE_BUSY on its snapshot upgrade — thrown immediately, NOT covered by
// busy_timeout. IMMEDIATE takes the write lock at BEGIN (waiting out a competing
// worker via busy_timeout), the bounded retry is the backstop, and every boot step
// is idempotent under serialization (in-txn guards / upserts / no-op re-reads), so
// a worker that loses the race re-runs as a clean no-op.
//
// Lives in this leaf module (no import cycle) so the migration runner, the frozen
// baseline, and the per-boot tasks share one implementation. When called nested
// inside an already-open transaction — the runner wraps a migration's up() in
// IMMEDIATE, and the baseline body calls runBootTx again for its sub-rebuilds —
// better-sqlite3 turns the inner transaction into a SAVEPOINT and ignores the
// access mode, so this is safe at either the top level or nested.
export function runBootTx(
  tx: { immediate: () => unknown },
  attempts = 5
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      tx.immediate();
      return;
    } catch (err) {
      if (attempt < attempts && /SQLITE_BUSY/i.test(String(err))) continue;
      throw err;
    }
  }
}
