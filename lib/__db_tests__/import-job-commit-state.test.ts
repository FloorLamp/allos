// DB INTEGRATION TIER (issue #323).
//
// The import_jobs.status CHECK must admit the transient 'committing' state that
// commitImportJob flips a ready job into while it writes rows. The baseline CHECK
// only allowed ('processing','ready','failed','skipped'), so the claim UPDATE threw
// `CHECK constraint failed` on every save — the whole feature was broken. Migration
// 015 rebuilds import_jobs with the grown enum; this pins:
//   1. after the full schema apply, a 'ready' → 'committing' flip is accepted,
//   2. the rebuild preserves existing rows (create → copy → drop → rename),
//   3. an unknown status is still rejected (the CHECK wasn't dropped entirely),
//   4. the boot reaper reclaims a job a crash stranded in 'committing' → 'failed'.
//
// Deterministic: :memory: only, no network.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { migrate } from "@/lib/db";
import { MIGRATIONS } from "@/lib/migrations/versions";
import { bootTasks } from "@/lib/migrations/boot-tasks";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

function newDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  return db;
}

function checkSql(db: Database.Database): string {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_jobs'"
    )
    .get() as { sql: string };
  return row.sql;
}

describe("import_jobs 'committing' state — migration 015", () => {
  it("admits 'committing' after the full schema apply", () => {
    const db = newDb();
    migrate(db); // baseline + all numbered migrations + boot tasks (profile 1 exists)

    expect(checkSql(db)).toContain("'committing'");

    const id = Number(
      db
        .prepare(
          "INSERT INTO import_jobs (profile_id, type, status) VALUES (1, 'workouts', 'ready')"
        )
        .run().lastInsertRowid
    );

    // This is the exact claim commitImportJob performs — it threw before #323.
    expect(() =>
      db
        .prepare(
          "UPDATE import_jobs SET status = 'committing' WHERE id = ? AND status = 'ready' AND profile_id = 1"
        )
        .run(id)
    ).not.toThrow();

    const status = (
      db.prepare("SELECT status FROM import_jobs WHERE id = ?").get(id) as {
        status: string;
      }
    ).status;
    expect(status).toBe("committing");
    db.close();
  });

  it("still rejects an unknown status (the CHECK is grown, not dropped)", () => {
    const db = newDb();
    migrate(db);
    db.prepare(
      "INSERT INTO import_jobs (id, profile_id, type, status) VALUES (7, 1, 'biomarkers', 'ready')"
    ).run();
    expect(() =>
      db.prepare("UPDATE import_jobs SET status = 'bogus' WHERE id = 7").run()
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("preserves existing rows across the rebuild (create → copy → drop → rename)", () => {
    const db = newDb();
    db.pragma("foreign_keys = OFF");
    // Apply everything BEFORE 015 (baseline still has the old CHECK), seed a profile
    // + a ready job, then apply only 015 and confirm the row survives the rebuild.
    for (const m of MIGRATIONS) {
      if (m.id >= 15) break;
      m.up(db);
    }
    expect(checkSql(db)).not.toContain("'committing'");
    db.prepare(
      "INSERT INTO profiles (id, name) VALUES (1, 'Test Patient')"
    ).run();
    db.prepare(
      "INSERT INTO import_jobs (id, profile_id, type, status, summary, source_text) VALUES (42, 1, 'workouts', 'ready', '1 workout', 'raw paste')"
    ).run();

    MIGRATIONS[14].up(db); // migration 015 (0-based index 14)

    expect(checkSql(db)).toContain("'committing'");
    const row = db
      .prepare(
        "SELECT id, profile_id, type, status, summary, source_text FROM import_jobs WHERE id = 42"
      )
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      id: 42,
      profile_id: 1,
      type: "workouts",
      status: "ready",
      summary: "1 workout",
      source_text: "raw paste",
    });
    db.close();
  });
});

describe("boot reaper — a crash-stranded 'committing' job", () => {
  it("is reclaimed to 'failed' on the next boot with an explanatory error", () => {
    const db = newDb();
    migrate(db);
    // Simulate a crash between the atomic claim and the row-delete: a job wedged in
    // 'committing', plus one wedged in 'processing' (both reaped), and a healthy
    // 'ready' job that must be left untouched.
    db.prepare(
      "INSERT INTO import_jobs (id, profile_id, type, status) VALUES (1, 1, 'workouts', 'committing')"
    ).run();
    db.prepare(
      "INSERT INTO import_jobs (id, profile_id, type, status) VALUES (2, 1, 'biomarkers', 'processing')"
    ).run();
    db.prepare(
      "INSERT INTO import_jobs (id, profile_id, type, status) VALUES (3, 1, 'workouts', 'ready')"
    ).run();

    bootTasks(db); // re-runs the per-boot stuck-state cleanup

    const rows = db
      .prepare("SELECT id, status, error FROM import_jobs ORDER BY id")
      .all() as { id: number; status: string; error: string | null }[];
    expect(rows[0]).toMatchObject({ id: 1, status: "failed" });
    expect(rows[0].error).toMatch(/interrupted/i);
    expect(rows[1]).toMatchObject({ id: 2, status: "failed" });
    expect(rows[2]).toMatchObject({ id: 3, status: "ready" }); // untouched
    db.close();
  });
});
