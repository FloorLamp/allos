// Shared low-level helper for the migration runner and the per-boot tasks. Lives
// in this leaf module (no import cycle back into lib/db.ts) so both can use it.

import Database from "better-sqlite3";

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

// ---------------------------------------------------------------------------
// Cross-process boot serialization (issue #581, residual — see PR #582's fix
// first: busy_timeout-first + runBootTx).
//
// Those made each individual lock acquisition on the boot path busy-tolerant,
// but the residual failure mode is QUEUE STARVATION: N parallel `next build`
// workers each perform ~30 sequential IMMEDIATE acquisitions (one per migration
// + the boot tasks) against the same cold file, and SQLite's busy handler is an
// unfair poll — a waiter can keep missing the free window while peers barge in.
// busy_timeout bounds ONE acquisition, not the total time a worker spends queued
// behind every peer's whole boot, so on a CPU-starved CI runner an unlucky
// worker's single wait can exceed any reasonable timeout and surface a raw
// "database is locked" (the recurrence on PR #586).
//
// The fix takes the contention out of SQLite entirely: an ADVISORY BOOT LOCK —
// a sidecar SQLite database (`<dbPath>.boot-lock`) held under BEGIN EXCLUSIVE
// for the duration of migrations + boot tasks. SQLite's own file locking gives
// exactly the advisory-flock semantics wanted, with two properties a hand-rolled
// lockfile lacks:
//   • BLOCKING with timeout — a waiter parks in the busy handler (up to
//     BOOT_LOCK_TIMEOUT_MS) instead of spin-polling;
//   • CRASH-SAFE — it is an OS file lock, released automatically when the
//     holding process dies, so a SIGKILLed build worker can never leave a stale
//     lock behind (the classic lockfile failure mode).
// The first worker in does the whole boot (~0.5s) while every peer waits on the
// sidecar file; each peer then finds user_version current and replays the boot
// as a no-op with near-zero write-lock contention on the main DB.
//
// The lock is deliberately ADVISORY and FAIL-OPEN: if it cannot be acquired
// (timeout, unwritable directory), boot proceeds unserialized — exactly the
// pre-lock behavior, still protected by busy_timeout + runBootTx — rather than
// turning a lock hiccup into a boot failure. ":memory:" databases are
// single-connection by definition and skip the lock.

// How long a booting process waits for a peer's boot to finish. Generous on
// purpose: a cold boot is a one-time cost, and on a slow CI runner waiting beats
// dying. (A peer that genuinely wedges releases the lock when its process exits.)
export const BOOT_LOCK_TIMEOUT_MS = 60_000;

export type BootLock = { release(): void };

export function acquireBootLock(dbPath: string): BootLock | null {
  if (dbPath === ":memory:") return null;
  let lock: InstanceType<typeof Database> | undefined;
  try {
    lock = new Database(`${dbPath}.boot-lock`);
    lock.pragma(`busy_timeout = ${BOOT_LOCK_TIMEOUT_MS}`);
    // BEGIN EXCLUSIVE takes the sidecar file's exclusive lock AT BEGIN, blocking
    // (via the busy handler) until the current holder releases it or dies.
    lock.exec("BEGIN EXCLUSIVE");
    const held = lock;
    return {
      release() {
        try {
          held.exec("ROLLBACK");
        } catch {
          /* already rolled back / closed — release must never throw */
        }
        try {
          held.close();
        } catch {
          /* ignore */
        }
      },
    };
  } catch (err) {
    try {
      lock?.close();
    } catch {
      /* ignore */
    }
    // Fail open: an advisory lock must never break a boot that could otherwise
    // succeed. The unserialized path is still busy-tolerant (busy_timeout +
    // runBootTx) — this is a liveness fallback, not the normal path.
    // eslint-disable-next-line no-console
    console.warn(
      `[allos] boot lock unavailable (${String(err)}) — booting unserialized`
    );
    return null;
  }
}
