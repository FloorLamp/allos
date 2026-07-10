// Shared low-level helper for the migration runner and the per-boot tasks. Lives
// in this leaf module (no import cycle back into lib/db.ts) so both can use it.

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
// When called nested inside an already-open transaction — the runner wraps a
// migration's up() in IMMEDIATE, and a boot task may call runBootTx inside it —
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
