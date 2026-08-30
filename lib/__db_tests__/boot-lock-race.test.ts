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
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireBootLock,
  BOOT_LOCK_TIMEOUT_MS,
} from "@/lib/migrations/schema-utils";
import { makeTmpDir } from "../__tests__/tmp-dir";

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

type BootWriteProbe = {
  before: number;
  after?: number;
  error?: unknown;
};

function probeBootWrite(file: string, busyTimeout: number): BootWriteProbe {
  const db = new Database(file);
  db.pragma(`busy_timeout = ${busyTimeout}`);
  db.pragma("journal_mode = WAL");
  const before = peerWrites(db);
  try {
    bootWrite(db);
    return { before, after: peerWrites(db) };
  } catch (error) {
    return { before, error };
  } finally {
    db.close();
  }
}

describe("cold-boot lock race is busy-tolerant (issue #581)", () => {
  it("distinguishes disabled, bounded, and sufficient busy timeouts under one real peer lock", async () => {
    const dir = makeTmpDir("boot");
    const file = path.join(dir, "allos.db");
    try {
      const HOLD = 1000;
      const { result, err } = await withHeldLock(file, HOLD, () => {
        // Round 1's pre-fix path failed immediately with no busy handler. Round 2's
        // residual exhausted one bounded acquisition. The fixed round-1 path waits
        // out the SAME peer after both negative probes, without paying for three
        // independent worker threads and hold windows.
        const disabled = probeBootWrite(file, 0);
        const bounded = probeBootWrite(file, 150);
        const sufficient = probeBootWrite(file, 5000);
        return { disabled, bounded, sufficient };
      });
      expect(err).toBeUndefined();
      expect(
        [
          result.disabled.before,
          result.bounded.before,
          result.sufficient.before,
        ],
        "VACUOUS RUN, NOT A PRODUCT DEFECT: the peer committed before every " +
          "contention probe started; rerun this file alone"
      ).toEqual([0, 0, 0]);
      expect(
        String((result.disabled.error as { code?: string } | undefined)?.code)
      ).toMatch(/SQLITE_BUSY/);
      expect(
        String((result.bounded.error as { code?: string } | undefined)?.code)
      ).toMatch(/SQLITE_BUSY/);
      expect(result.sufficient.error).toBeUndefined();
      expect(result.sufficient.after).toBe(1);
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
    const dir = makeTmpDir("boot");
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
            // BEFORE the write, so this says something the write's own success does
            // not: the peer's transaction was already committed at the moment
            // acquireBootLock returned. A boot lock that let go before the peer's
            // write lock puts this at 0 whatever the busy_timeout is.
            const peers = peerWrites(b);
            bootWrite(b);
            return { waitedForLock, peers };
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
      // 2. The peer's transaction was already COMMITTED when acquireBootLock
      //    returned — read before this connection wrote anything, so it is a
      //    statement about the LOCK's timing, not about the write's. This is the
      //    assertion that catches the regression the deleted ceiling was for:
      //    demonstrated red ("expected +0 to be 1") with the peer's boot lock
      //    removed and a generous busy_timeout, where the write still succeeds.
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
    const dir = makeTmpDir("boot");
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
