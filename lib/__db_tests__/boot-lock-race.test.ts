// DB INTEGRATION TIER — the concurrency mechanism behind issue #581.
//
// Parallel `next build` workers each import lib/db.ts and race the cold-boot path
// against the SAME on-disk file. The observed failure was a transient
// `SqliteError: database is locked` during page-data collection: a boot statement
// issued BEFORE `busy_timeout` was installed on that connection did not wait on a
// competing worker's lock — it threw a raw SQLITE_BUSY to the caller and failed the
// build. The two-part fix:
//   1. lib/db.ts sets `busy_timeout` FIRST — before `journal_mode = WAL` and every
//      other statement — so the busy handler is armed for the WAL switch and all
//      subsequent lock acquisitions.
//   2. Every per-boot write (lib/migrations/boot-tasks.ts) runs inside the retrying
//      IMMEDIATE-tx wrapper (runBootTx) so a lost race waits + retries, never surfaces.
//
// This test pins the runtime mechanism with a REAL file DB and TWO genuinely
// concurrent OS threads (a worker_thread holding the write lock), the shape of the
// parallel build workers — plus a source guard on the pragma ORDERING that fails on
// the pre-fix code path. Runs via `npm run test:db`.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Worker body (eval'd raw JS, no TS transform): open the file, establish WAL, take
// the write lock at BEGIN IMMEDIATE, announce "locked", hold it synchronously for
// `holdMs` (Atomics.wait, so the lock genuinely stays held across the sleep), then
// commit and release. This is the peer worker mid-boot-write that the connection
// under test must wait out.
const WORKER_SRC = `
const Database = require("better-sqlite3");
const { workerData, parentPort } = require("worker_threads");
const { file, holdMs } = workerData;
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
parentPort.postMessage("released");
`;

function withHeldLock<T>(
  file: string,
  holdMs: number,
  onLocked: () => T
): Promise<{ result: T; err?: unknown }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { file, holdMs },
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
      const HOLD = 400;
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
      const { err } = await withHeldLock(file, 500, () => {
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

  it("createDb installs busy_timeout BEFORE journal_mode = WAL (fails on the pre-fix order)", () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL("../db.ts", import.meta.url)),
      "utf8"
    );
    const busyIdx = src.indexOf('pragma("busy_timeout');
    const walIdx = src.indexOf('pragma("journal_mode = WAL');
    expect(busyIdx).toBeGreaterThan(-1);
    expect(walIdx).toBeGreaterThan(-1);
    // The WAL switch takes a database lock; issuing it before busy_timeout is armed
    // is exactly what threw the transient "database is locked" (#581).
    expect(busyIdx).toBeLessThan(walIdx);
  });
});
