// DB INTEGRATION TIER — the concurrency mechanism behind issue #581.
//
// Parallel `next build` workers each import lib/db.ts and race the cold-boot path
// against the SAME on-disk file. The observed failure was a transient
// `SqliteError: database is locked` during page-data collection. The fix landed in
// two rounds:
//
// ROUND 1 (PR #582): a boot statement issued BEFORE `busy_timeout` was installed
// on that connection did not wait on a competing worker's lock — it threw a raw
// SQLITE_BUSY to the caller and failed the build.
//   1. lib/db.ts sets `busy_timeout` FIRST — before `journal_mode = WAL` and every
//      other statement — so the busy handler is armed for the WAL switch and all
//      subsequent lock acquisitions.
//   2. Every per-boot write (lib/migrations/boot-tasks.ts) runs inside the retrying
//      IMMEDIATE-tx wrapper (runBootTx) so a lost race waits + retries, never surfaces.
//
// ROUND 2 (the residual — the failure recurred WITH round 1 merged): busy_timeout
// bounds ONE lock acquisition, but N parallel workers each make ~30 sequential
// IMMEDIATE acquisitions on a cold boot, and SQLite's busy poll is unfair (no FIFO
// — peers barge). On a CPU-starved CI runner an unlucky worker's single wait can
// outlast any per-acquisition timeout. The fix:
//   3. The whole boot (WAL switch + migrations + boot tasks) is serialized
//      cross-process by an ADVISORY BOOT LOCK — a sidecar SQLite DB
//      (`<dbPath>.boot-lock`) held under BEGIN EXCLUSIVE (see
//      lib/migrations/schema-utils.acquireBootLock). First worker boots alone;
//      peers wait on the sidecar, then replay the boot as a version-gated no-op.
//   4. The boot phase runs under a 60s busy_timeout (BOOT_LOCK_TIMEOUT_MS),
//      restored to the 10s runtime value after boot — a cold boot is a one-time
//      cost, and waiting beats dying.
//
// This test pins the runtime mechanisms with a REAL file DB and TWO genuinely
// concurrent OS threads (a worker_thread holding the write lock), the shape of the
// parallel build workers — plus source guards on the pragma ordering and the
// boot-lock placement that fail on the pre-fix code paths. Runs via `npm run test:db`.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireBootLock,
  BOOT_LOCK_TIMEOUT_MS,
} from "@/lib/migrations/schema-utils";

// Worker body (eval'd raw JS, no TS transform): optionally take the advisory boot
// lock (the cooperating-booter shape), then open the main file, establish WAL, take
// the write lock at BEGIN IMMEDIATE, announce "locked", hold it synchronously for
// `holdMs` (Atomics.wait, so the lock genuinely stays held across the sleep), then
// commit and release everything. This is the peer worker mid-boot that the
// connection under test must wait out.
const WORKER_SRC = `
const Database = require("better-sqlite3");
const { workerData, parentPort } = require("worker_threads");
const { file, holdMs, takeBootLock } = workerData;
let lock = null;
if (takeBootLock) {
  lock = new Database(file + ".boot-lock");
  lock.pragma("busy_timeout = 5000");
  lock.exec("BEGIN EXCLUSIVE");
}
const db = new Database(file);
db.pragma("busy_timeout = 5000");
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, n INTEGER)");
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO t (n) VALUES (1)").run();
parentPort.postMessage("locked");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
db.exec("COMMIT");
db.close();
if (lock) { lock.exec("ROLLBACK"); lock.close(); }
parentPort.postMessage("released");
`;

function withHeldLock<T>(
  file: string,
  holdMs: number,
  onLocked: () => T,
  takeBootLock = false
): Promise<{ result: T; err?: unknown }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { file, holdMs, takeBootLock },
    });
    let fired = false;
    worker.on("message", (msg) => {
      if (msg === "locked" && !fired) {
        fired = true;
        // The worker now holds the write lock and will hold it for holdMs. Run the
        // caller's probe on THIS thread while the lock is held — a blocking native
        // call here waits on the worker's lock (a real cross-thread contention).
        let result: T | undefined;
        let err: unknown;
        try {
          result = onLocked();
        } catch (e) {
          err = e;
        }
        worker.once("exit", () => resolve({ result: result as T, err }));
      }
    });
    worker.on("error", reject);
  });
}

// A boot-style write in the sanctioned shape: BEGIN IMMEDIATE + write, the runBootTx
// discipline. Returns how long it blocked so we can prove it WAITED rather than
// raced through.
function bootWrite(db: Database.Database): number {
  const t0 = Date.now();
  db.transaction(() => {
    db.prepare("INSERT INTO t (n) VALUES (99)").run();
  }).immediate();
  return Date.now() - t0;
}

describe("cold-boot lock race is busy-tolerant (issue #581)", () => {
  it("a boot write with busy_timeout set FIRST waits out a peer's lock and succeeds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-boot-"));
    const file = path.join(dir, "allos.db");
    try {
      // A generous hold: the floor below proves "it WAITED (real contention)", and the
      // one flake surface is worker→main message latency eating the overlap before the
      // probe starts. A 1000ms hold leaves ~880ms of slack over the 120ms floor even on
      // a starved CI runner, where a 400ms hold once did not.
      const HOLD = 1000;
      const { result: waited, err } = await withHeldLock(file, HOLD, () => {
        // Mirror the FIXED createDb pragma order: busy_timeout BEFORE journal_mode.
        const b = new Database(file);
        b.pragma("busy_timeout = 5000");
        b.pragma("journal_mode = WAL");
        const ms = bootWrite(b);
        b.close();
        return ms;
      });
      expect(err).toBeUndefined();
      // It blocked on the peer's lock rather than failing, so it took most of the
      // hold window (floor well under HOLD to stay CI-robust).
      expect(waited).toBeGreaterThanOrEqual(120);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the same write with busy_timeout DISABLED throws the raw SQLITE_BUSY the bug reported", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-boot-"));
    const file = path.join(dir, "allos.db");
    try {
      // 1000ms hold so the probe reliably overlaps it even if worker→main message
      // latency delays the probe start on a starved runner (busy_timeout=0 throws
      // instantly on contention, so it only needs the lock to still be held).
      const { err } = await withHeldLock(file, 1000, () => {
        const b = new Database(file);
        b.pragma("busy_timeout = 0"); // the pre-fix hazard: no wait
        b.pragma("journal_mode = WAL");
        try {
          bootWrite(b);
        } finally {
          b.close();
        }
      });
      expect(err).toBeDefined();
      expect(String((err as { code?: string }).code)).toMatch(/SQLITE_BUSY/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE RESIDUAL (round 2): a peer holding the write lock LONGER than the busy
  // timeout still kills the boot — busy_timeout alone is bounded, so on a starved
  // CI runner where a worker queues behind every peer's whole boot, it expires and
  // the raw SQLITE_BUSY surfaces. This is the recurrence seen on PR #586 with
  // round 1 merged, reproduced with the timeout scaled down (150ms) against a
  // longer hold (700ms).
  it("RESIDUAL: a peer holding the lock LONGER than busy_timeout still throws SQLITE_BUSY without the boot lock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-boot-"));
    const file = path.join(dir, "allos.db");
    try {
      const { err } = await withHeldLock(file, 1000, () => {
        const b = new Database(file);
        b.pragma("busy_timeout = 150"); // expires before the peer's 1000ms hold
        b.pragma("journal_mode = WAL");
        try {
          bootWrite(b);
        } finally {
          b.close();
        }
      });
      expect(err).toBeDefined();
      expect(String((err as { code?: string }).code)).toMatch(/SQLITE_BUSY/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The round-2 fix: with boot serialized on the advisory boot lock, the same
  // hold-longer-than-timeout scenario succeeds — the booting connection first waits
  // on the SIDECAR lock (60s-class window) until the peer's ENTIRE boot is done,
  // and only then touches the main DB, where there is no contention left, so even
  // the short 150ms busy_timeout never comes into play.
  it("the advisory boot lock rescues the hold-longer-than-timeout case", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-boot-"));
    const file = path.join(dir, "allos.db");
    try {
      const HOLD = 1000;
      const { result, err } = await withHeldLock(
        file,
        HOLD,
        () => {
          // The real production helper — this parks on <file>.boot-lock until the
          // peer's boot (write lock INCLUDED) is fully released.
          const t0 = Date.now();
          const bl = acquireBootLock(file);
          const waitedForLock = Date.now() - t0;
          expect(bl).not.toBeNull();
          const b = new Database(file);
          b.pragma("busy_timeout = 150"); // same short timeout as the failing case
          b.pragma("journal_mode = WAL");
          try {
            // The write under test — uncontended by construction (the peer's whole boot,
            // write lock included, is done before acquireBootLock returned) — plus a
            // second identical write as this runner's disk-speed BASELINE.
            const writeMs = bootWrite(b);
            const baselineMs = bootWrite(b);
            return { waitedForLock, writeMs, baselineMs };
          } finally {
            b.close();
            bl!.release();
          }
        },
        /* peer takes the boot lock too */ true
      );
      expect(err).toBeUndefined();
      // It serialized on the sidecar (blocked most of the peer's hold window)…
      expect(result.waitedForLock).toBeGreaterThanOrEqual(300);
      // …and then wrote with no meaningful contention on the main DB. The bound
      // distinguishes "uncontended" from "burned a lock wait": a write that raced a
      // still-held lock waits a HOLD-class (1000ms) window, an uncontended one is
      // disk-speed. An ABSOLUTE ceiling was the wrong tool — a loaded runner inflates
      // even an uncontended write (150→156ms lost #1192, then 400), so this compares to
      // a same-runner baseline instead: the guarded write must land within HOLD/2 of a
      // plain uncontended write, which scales with runner speed while a HOLD-class
      // regression (boot lock released before the write lock) still blows past it.
      expect(result.writeMs).toBeLessThan(result.baselineMs + HOLD / 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquireBootLock is mutually exclusive in-process, releasable, and skips :memory:", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-boot-"));
    const file = path.join(dir, "allos.db");
    try {
      expect(acquireBootLock(":memory:")).toBeNull();

      const first = acquireBootLock(file);
      expect(first).not.toBeNull();
      // A second taker conflicts while the first holds…
      const second = new Database(`${file}.boot-lock`);
      second.pragma("busy_timeout = 100");
      expect(() => second.exec("BEGIN EXCLUSIVE")).toThrowError(/locked|busy/i);
      // …and succeeds once released.
      first!.release();
      expect(() => second.exec("BEGIN EXCLUSIVE")).not.toThrow();
      second.exec("ROLLBACK");
      second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("createDb source: boot-phase busy_timeout first, boot lock around the boot, runtime timeout restored after", () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL("../db.ts", import.meta.url)),
      "utf8"
    );
    // Round 1 guard: the boot-phase busy_timeout PRAGMA precedes the WAL switch —
    // the WAL switch takes a database lock, and issuing it before busy_timeout is
    // armed is exactly what threw the transient "database is locked" (#581). The
    // boot phase uses the generous BOOT_LOCK_TIMEOUT_MS window, not the runtime
    // value.
    const bootBusyIdx = src.indexOf(
      "pragma(`busy_timeout = ${BOOT_LOCK_TIMEOUT_MS}`)"
    );
    const walIdx = src.indexOf('pragma("journal_mode = WAL');
    expect(bootBusyIdx).toBeGreaterThan(-1);
    expect(walIdx).toBeGreaterThan(-1);
    expect(bootBusyIdx).toBeLessThan(walIdx);
    expect(BOOT_LOCK_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);

    // Round 2 guard: the advisory boot lock is acquired BEFORE the migrations run
    // and the runtime busy_timeout is restored AFTER the boot completes.
    const lockIdx = src.indexOf("acquireBootLock(");
    const migrateIdx = src.indexOf("runMigrations(db)");
    const bootTasksIdx = src.indexOf("bootTasks(db)");
    const runtimeIdx = src.indexOf('pragma("busy_timeout = 10000")');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(migrateIdx).toBeGreaterThan(-1);
    expect(runtimeIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(migrateIdx);
    expect(lockIdx).toBeLessThan(walIdx); // WAL switch is serialized too
    expect(bootTasksIdx).toBeLessThan(runtimeIdx);
  });
});
