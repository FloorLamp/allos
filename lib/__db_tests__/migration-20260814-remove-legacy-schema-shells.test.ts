import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/migrations/runner";
import { MIGRATIONS } from "@/lib/migrations/versions";
import { registerSqlFunctions } from "@/lib/sql-functions";

function databaseBeforeMigration(): Database.Database {
  const db = new Database(":memory:");
  registerSqlFunctions(db);
  db.pragma("foreign_keys = ON");
  runMigrations(db, MIGRATIONS.slice(0, -1));
  return db;
}

function names(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((row) => row.name);
}

describe("20260814-remove-legacy-schema-shells", () => {
  it("preserves live rows, links, behavior, and high-water marks on upgrade", () => {
    const db = databaseBeforeMigration();
    db.exec(`
      INSERT INTO profiles (id, name) VALUES (1, 'Schema fixture');
      INSERT INTO intake_items
        (id, profile_id, name, obligation, product, cadence_kind)
        VALUES (10, 1, 'Fixture item', 'must', 'Capsule', 'weekly');
      INSERT INTO intake_item_doses (id, item_id, amount, time_of_day)
        VALUES (20, 10, '1', '08:00');
      INSERT INTO intake_item_logs
        (id, dose_id, item_id, date, recorded_at, occurred_at, product)
        VALUES (30, 20, 10, '2026-08-01', '2026-08-01T12:00:00Z',
                '2026-08-01T11:58:00Z', 'Capsule');
      INSERT INTO food_log_events
        (id, profile_id, group_key, date, recorded_at, occurred_at, time_source)
        VALUES (40, 1, 'berries', '2026-08-01', '2026-08-01T12:01:00Z',
                '2026-08-01T11:30:00Z', 'stated');
      INSERT INTO illness_episodes
        (id, profile_id, situation, start_date, end_date, note)
        VALUES (50, 1, 'Illness', '2026-07-01', '2026-07-03', 'resolved');
      UPDATE sqlite_sequence SET seq = 60 WHERE name IN
        ('intake_items','intake_item_logs','food_log_events','illness_episodes');
    `);

    runMigrations(db);

    expect(names(db, "food_log_events")).toEqual([
      "id",
      "profile_id",
      "group_key",
      "date",
      "recorded_at",
      "created_at",
      "meal_slot",
      "occurred_at",
      "time_source",
      "notify_message_id",
      // #3087: which surface a person logged from. Additive and nullable, appended
      // by 20260822-logged-via-provenance.
      "logged_via",
    ]);
    expect(names(db, "intake_item_logs")).toEqual([
      "id",
      "dose_id",
      "item_id",
      "date",
      "recorded_at",
      "occurred_at",
      "amount",
      "status",
      "skip_reason",
      "product",
      "supply_adjusted",
      "notify_message_id",
      // #3087, as above.
      "logged_via",
    ]);
    expect(names(db, "illness_episodes")).toEqual([
      "id",
      "profile_id",
      "situation",
      "start_date",
      "end_date",
      "note",
      "outcome",
    ]);
    expect(names(db, "intake_items")).toContain("obligation");
    expect(names(db, "intake_items")).toContain("cadence_kind");

    expect(
      db
        .prepare(
          "SELECT recorded_at, occurred_at FROM intake_item_logs WHERE id = 30"
        )
        .get()
    ).toEqual({
      recorded_at: "2026-08-01T12:00:00Z",
      occurred_at: "2026-08-01T11:58:00Z",
    });
    expect(
      db
        .prepare(
          "SELECT recorded_at, occurred_at, time_source FROM food_log_events WHERE id = 40"
        )
        .get()
    ).toEqual({
      recorded_at: "2026-08-01T12:01:00Z",
      occurred_at: "2026-08-01T11:30:00Z",
      time_source: "stated",
    });
    expect(
      db
        .prepare(
          "SELECT obligation, cadence_kind FROM intake_items WHERE id = 10"
        )
        .get()
    ).toEqual({ obligation: "must", cadence_kind: "weekly" });
    expect(
      db
        .prepare(
          "SELECT start_date, end_date, note FROM illness_episodes WHERE id = 50"
        )
        .get()
    ).toEqual({
      start_date: "2026-07-01",
      end_date: "2026-07-03",
      note: "resolved",
    });

    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, recorded_at)
       VALUES (20, 10, '2026-08-02', '2026-08-02T12:00:00Z')`
    ).run();
    expect(
      db
        .prepare(
          "SELECT id, product FROM intake_item_logs ORDER BY id DESC LIMIT 1"
        )
        .get()
    ).toEqual({ id: 61, product: "Capsule" });
    expect(db.pragma("foreign_key_check")).toEqual([]);

    const schema = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name"
      )
      .all();
    runMigrations(db);
    expect(
      db
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name"
        )
        .all()
    ).toEqual(schema);
    db.close();
  });
});
