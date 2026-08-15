import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { MIGRATIONS } from "@/lib/migrations/versions";

function beforeRenames(): Database.Database {
  const db = new Database(":memory:");
  const target = MIGRATIONS.findIndex(
    (migration) => migration.name === "20260815-substance-recorded-at"
  );
  expect(target).toBeGreaterThan(0);
  runMigrations(db, MIGRATIONS.slice(0, target));
  db.prepare("INSERT INTO profiles(id, name) VALUES (1, 'Time grains')").run();
  return db;
}

function columns(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((row) => row.name);
}

describe("#2883 instant-column renames", () => {
  it("preserves both stored metric shapes, row identity, indexes, and high-water marks", () => {
    const db = beforeRenames();
    db.prepare(
      `INSERT INTO substance_daily_totals
         (id, profile_id, date, substance, units, logged_at, source)
       VALUES (41, 1, '2026-08-14', 'nicotine', 3,
               '2026-08-14T12:34:56Z', 'manual')`
    ).run();
    const insert = db.prepare(
      `INSERT INTO metric_samples
         (id, profile_id, source, origin, metric, date, start_time, end_time,
          value)
       VALUES (?, 1, 'health-connect', ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      51,
      "Fitbit",
      "steps",
      "2026-08-14",
      "2026-08-14T04:00:00.123Z",
      "2026-08-14T20:00:00.987Z",
      7000
    );
    insert.run(
      52,
      null,
      "waist_circumference_cm",
      "2026-08-13",
      "2026-08-13T00:00:00",
      "2026-08-13T00:00:00",
      81
    );
    db.prepare("UPDATE sqlite_sequence SET seq = 90 WHERE name = ?").run(
      "substance_daily_totals"
    );
    db.prepare("UPDATE sqlite_sequence SET seq = 99 WHERE name = ?").run(
      "metric_samples"
    );

    runMigrations(db);

    expect(columns(db, "substance_daily_totals")).toContain("recorded_at");
    expect(columns(db, "metric_samples")).toEqual(
      expect.arrayContaining(["started_at", "ended_at"])
    );
    expect(
      db
        .prepare(
          "SELECT id, recorded_at FROM substance_daily_totals WHERE id = 41"
        )
        .get()
    ).toEqual({ id: 41, recorded_at: "2026-08-14T12:34:56Z" });
    expect(
      db
        .prepare(
          `SELECT id, started_at, ended_at FROM metric_samples ORDER BY id`
        )
        .all()
    ).toEqual([
      {
        id: 51,
        started_at: "2026-08-14T04:00:00.123Z",
        ended_at: "2026-08-14T20:00:00.987Z",
      },
      {
        id: 52,
        started_at: "2026-08-13T00:00:00",
        ended_at: "2026-08-13T00:00:00",
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT name, seq FROM sqlite_sequence
            WHERE name IN ('metric_samples', 'substance_daily_totals')
            ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: "metric_samples", seq: 99 },
      { name: "substance_daily_totals", seq: 90 },
    ]);
    const indexes = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'metric_samples'`
      )
      .all() as { name: string; sql: string }[];
    expect(
      indexes.find((index) => index.name === "idx_metric_samples_natural")?.sql
    ).toContain("started_at");
    expect(
      indexes.find((index) => index.name === "idx_metric_samples_end")?.sql
    ).toContain("ended_at");
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  it.each([
    ["vendor ISO", "2026-08-14T04:00:00.123Z", "2026-08-14T20:00:00.987Z"],
    ["day anchor", "2026-08-14T00:00:00", "2026-08-14T00:00:00"],
  ])("keeps a %s re-push on the renamed natural key", (_, start, end) => {
    const db = beforeRenames();
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, start_time, end_time, value)
       VALUES (1, 'health-connect', 'Fitbit', 'steps', '2026-08-14', ?, ?, 100)`
    ).run(start, end);
    runMigrations(db);

    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, started_at, ended_at, value)
       VALUES (1, 'health-connect', 'Fitbit', 'steps', '2026-08-14', ?, ?, 250)
       ON CONFLICT DO UPDATE SET value = excluded.value,
         ended_at = excluded.ended_at`
    ).run(start, end);

    expect(
      db
        .prepare("SELECT id, started_at, ended_at, value FROM metric_samples")
        .all()
    ).toEqual([{ id: 1, started_at: start, ended_at: end, value: 250 }]);
    db.close();
  });
});
