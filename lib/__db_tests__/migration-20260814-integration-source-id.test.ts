import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { migrationsBefore } from "@/lib/migrations/versions";

function tableColumns(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map(({ name }) => name);
}

function indexColumns(db: Database.Database, index: string): string[] {
  return (
    db.prepare(`PRAGMA index_info(${index})`).all() as { name: string }[]
  ).map(({ name }) => name);
}

function seedUpgradeDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db, migrationsBefore("20260814-integration-source-id"));
  db.prepare(
    "INSERT INTO profiles(id, name) VALUES (1, 'Source rename')"
  ).run();
  db.prepare(
    `INSERT INTO integration_connections
       (profile_id, provider, status, config, last_sync_at, last_sync_summary,
        created_at, updated_at, refresh_claimed_at)
     VALUES (1, 'strava', 'connected', '{"token":"kept"}',
             '2026-08-01T01:02:03Z', '{"inserted":4}',
             '2026-07-01 00:00:00', '2026-08-01 01:02:03',
             '2026-08-01T01:02:00Z')`
  ).run();
  db.prepare(
    `INSERT INTO integration_sync_events
       (id, profile_id, provider, at, ok, inserted, updated, unchanged, details)
     VALUES (10, 1, 'strava', '2026-08-01T01:02:03Z', 1, 4, 2, 8,
             '{"shape":"kept"}')`
  ).run();
  db.prepare(
    `INSERT INTO integration_sync_rows
       (event_id, target_table, target_id, disposition)
     VALUES (10, 'activities', 77, 'inserted')`
  ).run();
  db.prepare(
    `INSERT INTO integration_backfill_jobs
       (id, profile_id, provider, kind, label, item_noun, status, total_items,
        completed_items, request_count, active_seconds, started_at, updated_at)
     VALUES (12, 1, 'strava', 'streams', 'Ride details', 'rides', 'running',
             20, 7, 3, 4.5, '2026-08-01T01:00:00Z', '2026-08-01 01:03:00')`
  ).run();
  db.prepare(
    `INSERT INTO stream_frontiers
       (id, profile_id, provider, stream, frontier_at, advanced_at, observed_at,
        syncs_since_advance)
     VALUES (14, 1, 'health-connect', 'heart-rate',
             '2026-08-01T01:00:00Z', '2026-08-01T01:01:00Z',
             '2026-08-01T01:02:00Z', 2)`
  ).run();
  for (const [table, seq] of [
    ["integration_sync_events", 110],
    ["integration_backfill_jobs", 112],
    ["stream_frontiers", 114],
  ] as const) {
    db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(
      seq,
      table
    );
  }
  return db;
}

describe("migration 20260814-integration-source-id", () => {
  it("renames persisted source identity without changing rows or links", () => {
    const db = seedUpgradeDb();

    runMigrations(db);

    for (const table of [
      "integration_connections",
      "integration_sync_events",
      "integration_backfill_jobs",
      "stream_frontiers",
    ]) {
      expect(tableColumns(db, table)).toContain("source_id");
      expect(tableColumns(db, table)).not.toContain("provider");
    }
    expect(
      db.prepare("SELECT * FROM integration_connections").get()
    ).toMatchObject({
      profile_id: 1,
      source_id: "strava",
      status: "connected",
      config: '{"token":"kept"}',
      last_sync_summary: '{"inserted":4}',
      refresh_claimed_at: "2026-08-01T01:02:00Z",
    });
    expect(
      db.prepare("SELECT * FROM integration_sync_events").get()
    ).toMatchObject({
      id: 10,
      profile_id: 1,
      source_id: "strava",
      inserted: 4,
      updated: 2,
      unchanged: 8,
      details: '{"shape":"kept"}',
    });
    expect(
      db.prepare("SELECT * FROM integration_backfill_jobs").get()
    ).toMatchObject({
      id: 12,
      profile_id: 1,
      source_id: "strava",
      completed_items: 7,
      request_count: 3,
      active_seconds: 4.5,
    });
    expect(db.prepare("SELECT * FROM stream_frontiers").get()).toMatchObject({
      id: 14,
      profile_id: 1,
      source_id: "health-connect",
      stream: "heart-rate",
      syncs_since_advance: 2,
    });
    expect(
      db.prepare("SELECT event_id FROM integration_sync_rows").get()
    ).toEqual({ event_id: 10 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(indexColumns(db, "idx_sync_events_profile_source_at")).toEqual([
      "profile_id",
      "source_id",
      "at",
    ]);
    expect(
      indexColumns(db, "idx_integration_backfill_jobs_profile_source")
    ).toEqual(["profile_id", "source_id", "updated_at"]);
    expect(
      db
        .prepare(
          `SELECT name, seq FROM sqlite_sequence
            WHERE name IN ('integration_sync_events', 'integration_backfill_jobs', 'stream_frontiers')
            ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: "integration_backfill_jobs", seq: 112 },
      { name: "integration_sync_events", seq: 110 },
      { name: "stream_frontiers", seq: 114 },
    ]);
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  it("fresh schema keys and sequences use source_id", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.prepare(
      "INSERT INTO profiles(id, name) VALUES (1, 'Fresh source')"
    ).run();
    db.prepare(
      "INSERT INTO integration_connections(profile_id, source_id, status) VALUES (1, 'oura', 'connected')"
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO integration_connections(profile_id, source_id, status) VALUES (1, 'oura', 'connected')"
        )
        .run()
    ).toThrow();
    const eventId = Number(
      db
        .prepare(
          "INSERT INTO integration_sync_events(profile_id, source_id, at, ok) VALUES (1, 'oura', '2026-08-01T00:00:00Z', 1)"
        )
        .run().lastInsertRowid
    );
    expect(eventId).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
