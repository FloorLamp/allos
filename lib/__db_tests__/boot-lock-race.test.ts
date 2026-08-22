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
//
// WHAT IT ASSERTS, AND WHAT IT NO LONGER ASSERTS (#3470). The property is
// SERIALIZATION — that a booting connection reaches the main database only after
// a peer's entire boot has let go of it — never speed. It used to be checked with
// a CEILING on elapsed wall time, which fails on a busy machine for a reason that
// has nothing to do with the lock: at load average ~16 on 4 cores it produced
// "expected 554 to be less than 500", a wrong-number-against-an-expected-number
// that reads exactly like a real regression and cost a diagnosis every time.
// Serialization is now read off the DATA instead — a peer's row is visible only
// after that peer commits — and freedom from contention off a busy_timeout of
// ZERO, which turns "did it have to wait?" into an instant yes/no. The only clock
// readings left are FLOORS, derived from the hold window, and a floor cannot be
// broken by a slow box: load can only make a wait longer.

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
// discipline.
function bootWrite(db: Database.Database): void {
  db.transaction(() => {
    db.prepare("INSERT INTO t (n) VALUES (99)").run();
  }).immediate();
}

// HOW MANY OF THE PEER'S ROWS THIS CONNECTION CAN SEE — the ordering fact these
// tests used to approximate with a stopwatch (#3470).
//
// The peer worker writes `n = 1` inside a transaction it holds open for the whole
// hold window, and a transaction's rows are invisible to every other connection
// until it COMMITs. So a 1 here is not a duration and not a guess: this connection
// observed the peer's write lock ALREADY RELEASED. A 0 means the probe ran while
// the peer was still mid-transaction, which is precisely the serialization failure
// these tests exist to catch. Neither answer moves when the box is busy.
function peerWrites(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM t WHERE n = 1").get() as { n: number }
  ).n;
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
      const { result, err } = await withHeldLock(file, HOLD, () => {
        // Mirror the FIXED createDb pragma order: busy_timeout BEFORE journal_mode.
        const b = new Database(file);
        b.pragma("busy_timeout = 5000");
        b.pragma("journal_mode = WAL");
        const startedAt = Date.now();
        bootWrite(b);
        const blockedMs = Date.now() - startedAt;
        const peers = peerWrites(b);
        b.close();
        return { blockedMs, peers };
      });
      expect(err).toBeUndefined();
      // It WAITED for the peer instead of failing: the peer's row is committed and
      // visible from this connection, so its write lock was gone before this write
      // took one. An outcome, not a duration — a busy box cannot change it.
      expect(result.peers).toBe(1);
      // THE ONE REMAINING CLOCK READING, and it is a FLOOR (#3470). Its job is to
      // keep the test from going vacuous: if worker->main message latency ever ate
      // the whole hold window, the probe would run against no contention at all and
      // the assertion above would pass without having tested anything. A floor
      // cannot be broken by a slow machine — load only makes a wait longer — which
      // is the entire reason the CEILING that used to sit in this file had to go.
      // Derived from HOLD rather than hardcoded, so it scales with the window it is
      // a fraction of.
      expect(result.blockedMs).toBeGreaterThanOrEqual(HOLD / 8);
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
  // and only then touches the main DB, where there is no contention left, so a
  // busy_timeout of ZERO never comes into play.
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
          // ZERO TOLERANCE, where the failing case above used 150 ms (#3470).
          // busy_timeout = 0 makes SQLite throw SQLITE_BUSY the INSTANT a lock is
          // held rather than waiting for it, so this write succeeding is a direct
          // statement that there was nothing to wait for. That is the same claim
          // the deleted duration bound was making, asked as a yes/no the machine's
          // load cannot influence — and it is strictly stronger than 150 ms, which
          // it subsumes.
          b.pragma("busy_timeout = 0");
          b.pragma("journal_mode = WAL");
          try {
            // The write under test — uncontended by construction, because the peer's
            // whole boot (write lock included) is done before acquireBootLock returned.
            bootWrite(b);
            return { waitedForLock, peers: peerWrites(b) };
          } finally {
            b.close();
            bl!.release();
          }
        },
        /* peer takes the boot lock too */ true
      );
      // THE PROPERTY, stated three ways and not one of them a stopwatch reading
      // (#3470). What this test protects is that acquireBootLock SERIALIZES: it
      // does not return until the peer's entire boot — write lock included — is
      // released. The regression it guards against is a boot lock released before
      // the write lock, and each of these goes red on it.
      //
      // 1. The write did not fail, at a busy_timeout of ZERO. If the peer still
      //    held the write lock, SQLite would refuse instantly.
      expect(err).toBeUndefined();
      // 2. The peer's transaction is COMMITTED and visible here, so this connection
      //    reached the main DB strictly after the peer let go of it. A boot lock
      //    that released early would put this at 0.
      expect(result.peers).toBe(1);
      // 3. And the serialization was real rather than a peer that finished early:
      //    a FLOOR on the sidecar wait, derived from HOLD. Floors are safe on a
      //    loaded box in the way the deleted ceiling was not — contention can only
      //    make a wait longer. This was the assertion that fired at load ~16
      //    ("expected 554 to be less than 500"); nothing above it can now.
      expect(result.waitedForLock).toBeGreaterThanOrEqual(HOLD / 3);
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
