import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/119-practice-sync-provenance";

describe("migration 119 — wellness-practice sync provenance", () => {
  it("preserves existing rows and admits practice_logs targets", () => {
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE integration_sync_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT
      );
      INSERT INTO integration_sync_events DEFAULT VALUES;

      CREATE TABLE integration_sync_rows (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id     INTEGER NOT NULL REFERENCES integration_sync_events(id) ON DELETE CASCADE,
        target_table TEXT NOT NULL CHECK (target_table IN ('activities','body_metrics','metric_samples','medical_records')),
        target_id    INTEGER NOT NULL,
        disposition  TEXT NOT NULL CHECK (disposition IN ('inserted','updated')),
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_integration_sync_rows_event
        ON integration_sync_rows(event_id);
      INSERT INTO integration_sync_rows
        (id, event_id, target_table, target_id, disposition, created_at)
      VALUES
        (7, 1, 'activities', 41, 'inserted', '2026-07-28 12:00:00');
    `);

    up(mem);
    up(mem);

    expect(
      mem
        .prepare(
          `SELECT id, event_id, target_table, target_id, disposition, created_at
             FROM integration_sync_rows ORDER BY id`
        )
        .all()
    ).toEqual([
      {
        id: 7,
        event_id: 1,
        target_table: "activities",
        target_id: 41,
        disposition: "inserted",
        created_at: "2026-07-28 12:00:00",
      },
    ]);

    expect(() =>
      mem
        .prepare(
          `INSERT INTO integration_sync_rows
             (event_id, target_table, target_id, disposition)
           VALUES (1, 'practice_logs', 52, 'updated')`
        )
        .run()
    ).not.toThrow();
    expect(() =>
      mem
        .prepare(
          `INSERT INTO integration_sync_rows
             (event_id, target_table, target_id, disposition)
           VALUES (1, 'unknown', 53, 'inserted')`
        )
        .run()
    ).toThrow(/CHECK constraint failed/);

    mem.close();
  });
});
