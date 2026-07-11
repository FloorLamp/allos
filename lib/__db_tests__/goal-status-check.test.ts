// DB INTEGRATION TIER (issue #328, part 1).
//
// Migration 016 shrinks the goals.status CHECK to ('active','achieved'), dropping the
// never-written 'archived' value (archiving is the independent goals.archived
// boolean). This pins:
//   1. after the full schema apply, 'active' and 'achieved' are accepted,
//   2. 'archived' and any other status are rejected (the CHECK was tightened, not
//      dropped),
//   3. a pre-migration row carrying the legacy status='archived' is folded into
//      (status='active', archived=1) so the tighter CHECK admits the copied row,
//   4. the rebuild is a pure no-op on an already-converged DB (sentinel-guarded), so
//      the non-version-gated migrate() replay is safe.
//
// Deterministic: :memory: only, no network.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { migrate } from "@/lib/db";
import { MIGRATIONS } from "@/lib/migrations/versions";
import { up as up016 } from "@/lib/migrations/versions/016-goal-status-drop-archived";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

function bootedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  migrate(db); // baseline + all migrations (incl. 016) + boot tasks; profile 1 exists
  return db;
}

function goalsSql(db: Database.Database): string {
  return (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'goals'"
      )
      .get() as { sql: string }
  ).sql;
}

describe("goals.status CHECK — migration 016", () => {
  it("accepts every valid status ('active', 'achieved')", () => {
    const db = bootedDb();
    for (const status of ["active", "achieved"]) {
      expect(() =>
        db
          .prepare(
            "INSERT INTO goals (profile_id, title, status) VALUES (1, ?, ?)"
          )
          .run(`goal-${status}`, status)
      ).not.toThrow();
    }
    db.close();
  });

  it("rejects the dropped 'archived' status and any unknown value", () => {
    const db = bootedDb();
    expect(goalsSql(db)).not.toContain("'archived'");
    for (const bad of ["archived", "paused", ""]) {
      expect(() =>
        db
          .prepare(
            "INSERT INTO goals (profile_id, title, status) VALUES (1, 'g', ?)"
          )
          .run(bad)
      ).toThrow(/CHECK constraint failed/);
    }
    db.close();
  });

  it("folds a legacy status='archived' row into (active, archived=1)", () => {
    // Simulate a pre-016 DB: baseline schema (old CHECK still admits 'archived'),
    // seed a legacy row, then apply ONLY migration 016's up().
    const db = new Database(":memory:");
    db.pragma("foreign_keys = OFF"); // no profiles row needed for this targeted test
    MIGRATIONS[0].up(db); // 001-baseline
    expect(goalsSql(db)).toContain("'archived'"); // pre-migration CHECK

    db.prepare(
      "INSERT INTO goals (id, profile_id, title, status, archived) VALUES (7, 1, 'old', 'archived', 0)"
    ).run();
    db.prepare(
      "INSERT INTO goals (id, profile_id, title, status, archived) VALUES (8, 1, 'live', 'active', 0)"
    ).run();

    up016(db);

    expect(goalsSql(db)).not.toContain("'archived'");
    const folded = db
      .prepare("SELECT status, archived FROM goals WHERE id = 7")
      .get() as { status: string; archived: number };
    expect(folded).toEqual({ status: "active", archived: 1 });
    const untouched = db
      .prepare("SELECT status, archived FROM goals WHERE id = 8")
      .get() as { status: string; archived: number };
    expect(untouched).toEqual({ status: "active", archived: 0 });
    db.close();
  });

  it("replays as a pure no-op on an already-converged DB", () => {
    const db = bootedDb();
    const before = goalsSql(db);
    db.prepare(
      "INSERT INTO goals (id, profile_id, title, status) VALUES (42, 1, 'keep', 'achieved')"
    ).run();

    expect(() => up016(db)).not.toThrow(); // sentinel: CHECK no longer lists 'archived'

    expect(goalsSql(db)).toBe(before);
    const row = db.prepare("SELECT status FROM goals WHERE id = 42").get() as {
      status: string;
    };
    expect(row.status).toBe("achieved");
    db.close();
  });
});
