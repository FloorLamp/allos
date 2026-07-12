// DB INTEGRATION TIER — the concurrency mechanism behind issue #468.
//
// This pins the exact SQLite behavior the writeTx (BEGIN IMMEDIATE) conversion
// relies on, using two REAL connections to one WAL file (the shape of the three
// processes that write allos.db: the web app, the notify tick, the poll sidecar):
//   1. A DEFERRED transaction that READS, loses a cross-connection commit, then
//      WRITES throws SQLITE_BUSY *immediately* — NOT covered by busy_timeout. That
//      is the trap every deferred read-then-write app transaction sat in.
//   2. An IMMEDIATE transaction takes the write lock at BEGIN, so its read sees
//      committed state that no other writer can invalidate before it writes — the
//      read-then-write commits cleanly. That is what writeTx guarantees.
//
// Runs via `npm run test:db`; deterministic (statements are issued in a fixed order,
// and the snapshot conflict is immediate, so nothing races on wall-clock timing).

import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function open(file: string): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  // Short timeout: a genuine lock wait would surface fast, but the snapshot-upgrade
  // BUSY under test is thrown immediately regardless of this value — that's the point.
  db.pragma("busy_timeout = 200");
  return db;
}

describe("DEFERRED read-then-write trap vs IMMEDIATE (issue #468)", () => {
  let dir: string;
  let file: string;
  let a: Database.Database;
  let b: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-tx-"));
    file = path.join(dir, "t.db");
    a = open(file);
    b = open(file);
    a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)");
    a.prepare("INSERT INTO t (id, n) VALUES (1, 10)").run();
  });

  afterEach(() => {
    a.close();
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("DEFERRED read → lost commit → write throws SQLITE_BUSY immediately (the trap)", () => {
    // Conn A opens DEFERRED and READS: it now holds a read snapshot at n = 10.
    a.exec("BEGIN DEFERRED");
    expect(
      (a.prepare("SELECT n FROM t WHERE id = 1").get() as { n: number }).n
    ).toBe(10);

    // Conn B commits a write in between, advancing the DB past A's snapshot.
    b.exec("BEGIN IMMEDIATE");
    b.prepare("UPDATE t SET n = 20 WHERE id = 1").run();
    b.exec("COMMIT");

    // A now attempts to upgrade its stale read snapshot to a write → SQLITE_BUSY
    // (SQLITE_BUSY_SNAPSHOT), thrown IMMEDIATELY — busy_timeout does not cover it.
    let err: unknown;
    try {
      a.prepare("UPDATE t SET n = 99 WHERE id = 1").run();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String((err as { code?: string }).code)).toMatch(/SQLITE_BUSY/);
    a.exec("ROLLBACK");
  });

  it("IMMEDIATE reads the fresh value under the write lock and commits (the fix)", () => {
    // The writeTx shape: take the write lock at BEGIN, THEN read-decide-write. While
    // A holds the write lock, B cannot commit, so A's read can't be invalidated.
    a.exec("BEGIN IMMEDIATE");
    const seen = (
      a.prepare("SELECT n FROM t WHERE id = 1").get() as { n: number }
    ).n;
    expect(seen).toBe(10);
    a.prepare("UPDATE t SET n = ? WHERE id = 1").run(seen + 5);
    expect(() => a.exec("COMMIT")).not.toThrow();

    // The committed value is visible to the other connection — no snapshot trap.
    expect(
      (b.prepare("SELECT n FROM t WHERE id = 1").get() as { n: number }).n
    ).toBe(15);
  });
});
