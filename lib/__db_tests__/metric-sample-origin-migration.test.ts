// DB INTEGRATION TIER — migration 081 repairs moving-end snapshot pileups while
// adding nullable Health Connect origin provenance (#1101/#1102).

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/083-metric-sample-origin";

describe("migration 081 — metric sample origin/start identity", () => {
  it("keeps the latest end per legacy start and preserves disjoint buckets", () => {
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO profiles (id, name) VALUES (1, 'M81');
      CREATE TABLE metric_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        metric TEXT NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        value REAL NOT NULL,
        activity_external_id TEXT,
        UNIQUE (profile_id, metric, source, start_time, end_time)
      );
      CREATE TABLE integration_sync_events (id INTEGER PRIMARY KEY);
      CREATE TABLE import_tombstones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL,
        target_table TEXT NOT NULL,
        natural_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (profile_id, target_table, natural_key)
      );
    `);
    const insert = mem.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (1, 'health-connect', 'steps', '2026-07-20', ?, ?, ?)`
    );
    insert.run("2026-07-20T04:00:00Z", "2026-07-20T12:00:00Z", 3000);
    insert.run("2026-07-20T04:00:00Z", "2026-07-21T01:14:33Z", 7990);
    insert.run("2026-07-20T12:00:00Z", "2026-07-20T13:00:00Z", 500);

    const sep = String.fromCharCode(0x1f);
    const oldTombstone = [
      "steps",
      "health-connect",
      "2026-07-20T04:00:00Z",
      "2026-07-21T01:14:33Z",
    ].join(sep);
    mem
      .prepare(
        `INSERT INTO import_tombstones (profile_id, target_table, natural_key)
         VALUES (1, 'metric_samples', ?)`
      )
      .run(oldTombstone);

    up(mem);

    expect(
      mem
        .prepare(
          `SELECT start_time, end_time, value, origin FROM metric_samples
            ORDER BY start_time`
        )
        .all()
    ).toEqual([
      {
        start_time: "2026-07-20T04:00:00Z",
        end_time: "2026-07-21T01:14:33Z",
        value: 7990,
        origin: null,
      },
      {
        start_time: "2026-07-20T12:00:00Z",
        end_time: "2026-07-20T13:00:00Z",
        value: 500,
        origin: null,
      },
    ]);
    const expectedTombstone = [
      "steps",
      "health-connect",
      "",
      "2026-07-20T04:00:00Z",
    ].join(sep);
    expect(
      (
        mem
          .prepare(
            "SELECT natural_key FROM import_tombstones WHERE profile_id = 1"
          )
          .get() as { natural_key: string }
      ).natural_key
    ).toBe(expectedTombstone);
    expect(
      (
        mem.prepare("PRAGMA table_info(integration_sync_events)").all() as {
          name: string;
        }[]
      ).some((column) => column.name === "details")
    ).toBe(true);
    expect(() => up(mem)).not.toThrow();
    mem.close();
  });
});
